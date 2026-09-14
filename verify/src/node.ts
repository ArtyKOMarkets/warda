/**
 * The node this service reads, and the refusal to answer from one that would
 * answer wrongly.
 *
 * Three of the four ways a node can be wrong produce a plausible answer rather
 * than an error, and all three read as a problem with the grant:
 *
 *   not utxo-indexed   `getUtxosByAddresses` returns nothing, which is
 *                      indistinguishable from a grant that has moved.
 *   wrong network      every address derives perfectly and nothing is found.
 *   not synced         the DAA score is stale, so the epoch this service
 *                      computes is one the chain has already left.
 *
 * A verifier that passed those on would be worse than no verifier, because its
 * answers carry the authority of having checked. So the service refuses to
 * serve from an unusable node and says which check failed — a refusal that
 * produces an explanation, rather than a silence.
 *
 * The connection is cached and shared. Nothing here is per-caller: two
 * requests asking about the same grant must not be able to get different
 * answers because they landed on different nodes.
 */
import {
  NodeClient,
  inspect,
  type AddressUtxo,
  type DagInfo,
  type Inspectable,
  type NodeHealth,
} from "@warda_protocol/kaspa";
import type { ReadFrom } from "./report.ts";

/**
 * The two calls the routes make. Narrowed to an interface so a test can serve
 * a recorded chain: the routes are where the reasoning lives, and reasoning
 * that can only be exercised against a live node is reasoning that gets tested
 * once, by hand, on a good day.
 */
export interface ChainReader {
  getUtxosByAddresses(addresses: string[]): Promise<AddressUtxo[]>;
  getBlockDagInfo(): Promise<DagInfo>;
}

/**
 * A connection this service can both read and check.
 *
 * `Inspectable` is the reason the borsh transport costs almost nothing here:
 * the four health checks were deliberately written against an interface rather
 * than against `NodeClient`, precisely so an alternative transport could run
 * the same checks instead of skipping or copying them. A copied check drifts.
 */
export type Readable = ChainReader & Inspectable & { close(): void | Promise<void> };

/** `@warda_protocol/borsh`, as much of it as this file uses. */
export interface FallbackReader {
  BorshReader: {
    open(o: { networkId?: string }): Promise<Readable & { carriesCovenants: boolean }>;
  };
}

export interface Live {
  client: ChainReader;
  health: NodeHealth;
  checkedAt: number;
}

/** Anything that can hand back a node known good a moment ago. */
export interface ChainSource {
  acquire(): Promise<Live>;
}

export interface NodeOptions {
  /** An explicit node. Overrides the resolver. */
  url?: string;
  /** The network the operator intends to serve. Checked, not assumed. */
  networkId?: string;
  /** Milliseconds before a cached connection is re-inspected. */
  recheckMs?: number;
  /**
   * Whether to read a public node over borsh when no JSON node answers.
   *
   * `auto` (the default) is right for a hosted deployment, where the
   * alternative is no service at all. `none` is a legitimate position, not a
   * test seam: a verifier that answers from a stranger's node is making a
   * claim on that stranger's word, and an operator who would rather return 503
   * than do that should be able to say so.
   */
  fallback?: "auto" | "none";
  /**
   * The reader of last resort, injected.
   *
   * Borrowed from the vendor package, including the reason: the fall-through
   * this guards shipped broken there, because every test covered a single step
   * of the chain and none covered a step FAILING INTO the next — which is the
   * only behaviour a fallback has.
   */
  loadFallbackReader?: () => Promise<FallbackReader | null>;
}

export class NodeUnusable extends Error {
  readonly health: NodeHealth | null;
  constructor(message: string, health: NodeHealth | null) {
    super(message);
    this.name = "NodeUnusable";
    this.health = health;
  }
}

export class NodeSource implements ChainSource {
  private live: (Live & { client: Readable }) | null = null;
  private opening: Promise<Live & { client: Readable }> | null = null;
  private readonly options: NodeOptions;

  constructor(options: NodeOptions = {}) {
    this.options = options;
  }

  private get recheckMs(): number {
    return this.options.recheckMs ?? 30_000;
  }

  /**
   * A connection known good as of `recheckMs` ago.
   *
   * Sync state is the reason for the recheck: a node that was synced when the
   * service started can fall behind, and the failure is silent. Re-inspecting
   * costs two round trips and only happens once a window, whatever the request
   * rate, because a single in-flight open is shared.
   */
  async acquire(): Promise<Live & { client: Readable }> {
    const now = Date.now();
    if (this.live && now - this.live.checkedAt < this.recheckMs) return this.live;
    if (this.opening) return this.opening;

    this.opening = this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<Live & { client: Readable }> {
    // A cached client that has merely gone stale is re-inspected rather than
    // reconnected: reconnecting on every window would drop a working socket
    // for no reason, and a node that has fallen out of sync is still the node
    // the operator chose.
    if (this.live) {
      try {
        const health = await inspectOnly(this.live.client, this.options.networkId);
        this.live = { client: this.live.client, health, checkedAt: Date.now() };
        this.assertUsable(this.live.health);
        return this.live;
      } catch {
        try {
          void Promise.resolve(this.live.client.close()).catch(() => {});
        } catch {
          // Already gone; the reconnect below is what matters.
        }
        this.live = null;
      }
    }

    let opened: { client: Readable; health: NodeHealth };
    try {
      opened = await NodeClient.open({
        ...(this.options.url ? { url: this.options.url } : {}),
        ...(this.options.networkId ? { networkId: this.options.networkId } : {}),
        tolerate: true,
      });
    } catch (e) {
      /* The JSON attempt failing is EXPECTED when no url is configured: with
         no node named, `open` asks a resolver, and all sixteen public
         resolvers serve borsh and answer /wrpc/json with a 404. So this is
         the ordinary path for a hosted deployment, not the exceptional one,
         and the message below is only reached when borsh fails too. */
      opened = await this.openOverBorsh(e as Error);
    }
    this.assertUsable(opened.health);
    this.live = { ...opened, checkedAt: Date.now() };
    return this.live;
  }

  /**
   * A public node, over the encoding the public nodes actually serve.
   *
   * The covenant gate is the whole reason this is not a two-line fallback. A
   * WASM build that predates covenants deserializes a grant's UTXO entry
   * perfectly and drops `covenantId`, because borsh is positional and an
   * unknown struct is an ABSENT one. This service reports `covenantAware`
   * from whether that field was there — so read through a covenant-blind
   * build, every grant on chain comes back looking unbound, which is
   * indistinguishable from the one real finding this service exists to
   * report. Refusing is the only answer that is not a lie.
   */
  private async openOverBorsh(jsonFailure: Error): Promise<{ client: Readable; health: NodeHealth }> {
    const nowhereLeft = (detail: string): NodeUnusable =>
      new NodeUnusable(
        `cannot reach a Kaspa node: ${jsonFailure.message}\n${detail}\nThis service answers ` +
          `only from a node it has checked, so it has nothing to say until one is reachable.`,
        null,
      );

    if ((this.options.fallback ?? "auto") !== "auto") {
      throw nowhereLeft(`Reading a public node was refused by configuration (fallback: none).`);
    }

    const borsh = await (this.options.loadFallbackReader ?? loadBorsh)();
    if (!borsh) {
      throw nowhereLeft(
        `The public resolvers serve borsh, not JSON, so reaching one needs a transport this\n` +
          `service does not depend on by default — it ships a wasm binary, and an operator\n` +
          `running their own node should not have to download one to decline it.\n\n` +
          `    npm install @warda_protocol/borsh @kluster/kaspa-wasm`,
      );
    }

    let reader: Readable & { carriesCovenants: boolean };
    try {
      reader = await borsh.BorshReader.open({
        ...(this.options.networkId ? { networkId: this.options.networkId } : {}),
      });
    } catch (e) {
      throw nowhereLeft(`No public node answered over borsh either: ${(e as Error).message}`);
    }

    if (!reader.carriesCovenants) {
      await reader.close();
      throw nowhereLeft(
        `A public node answered, but the installed WASM build cannot carry a covenant id.\n` +
          `Borsh is positional: a field the deserializer does not know about is not unknown,\n` +
          `it is absent. Every grant would come back reading as unbound, which is exactly\n` +
          `what this service exists to be able to say truthfully.\n\n` +
          `    npm install @kluster/kaspa-wasm`,
      );
    }

    return { client: reader, health: await inspect(reader, this.options.networkId ? { networkId: this.options.networkId } : {}) };
  }

  private assertUsable(health: NodeHealth): void {
    if (health.usable) return;
    const failed = Object.entries(health.checks)
      .filter(([, c]) => !c.ok)
      .map(([name, c]) => `${name}: ${c.detail}`);
    throw new NodeUnusable(
      `the node at ${health.url} cannot be trusted with a grant:\n  ${failed.join("\n  ")}\n` +
        `Every one of these fails by returning a plausible answer rather than an error, ` +
        `which is why this service stops here instead of reporting a grant that may not ` +
        `be missing at all.`,
      health,
    );
  }

  close(): void {
    if (this.live) {
      /* Borsh's close is async and never rejects; NodeClient's is sync. Either
         way the connection is being discarded, so a failure to close it
         politely must not become this method's problem. */
      void Promise.resolve(this.live.client.close()).catch(() => {});
      this.live = null;
    }
  }
}

/** Re-run the checks on an existing connection, without opening a new one. */
async function inspectOnly(client: Inspectable, networkId?: string): Promise<NodeHealth> {
  return inspect(client, networkId ? { networkId } : {});
}

/**
 * `@warda_protocol/borsh` if it is installed, and nothing if it is not.
 *
 * A missing optional transport is a configuration fact, not an error: the
 * caller gets a message naming the install rather than a module-resolution
 * stack trace from inside a verification.
 */
async function loadBorsh(): Promise<FallbackReader | null> {
  try {
    return (await import("@warda_protocol/borsh")) as never;
  } catch {
    return null;
  }
}

export function readFrom(health: NodeHealth, covenantAware: boolean | null = null): ReadFrom {
  const notes = Object.entries(health.checks)
    .filter(([, c]) => !c.ok)
    .map(([name, c]) => `${name}: ${c.detail}`);
  return {
    url: health.url,
    network: health.network,
    serverVersion: health.serverVersion,
    synced: health.checks.synced.ok,
    utxoIndexed: health.checks.utxoIndexed.ok,
    covenantAware,
    virtualDaaScore: health.virtualDaaScore.toString(),
    usable: health.usable,
    notes,
  };
}
