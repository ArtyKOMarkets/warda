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
  private live: (Live & { client: NodeClient }) | null = null;
  private opening: Promise<Live & { client: NodeClient }> | null = null;
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
  async acquire(): Promise<Live & { client: NodeClient }> {
    const now = Date.now();
    if (this.live && now - this.live.checkedAt < this.recheckMs) return this.live;
    if (this.opening) return this.opening;

    this.opening = this.open().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async open(): Promise<Live & { client: NodeClient }> {
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
          this.live.client.close();
        } catch {
          // Already gone; the reconnect below is what matters.
        }
        this.live = null;
      }
    }

    let opened: { client: NodeClient; health: NodeHealth };
    try {
      opened = await NodeClient.open({
        ...(this.options.url ? { url: this.options.url } : {}),
        ...(this.options.networkId ? { networkId: this.options.networkId } : {}),
        tolerate: true,
      });
    } catch (e) {
      throw new NodeUnusable(
        `cannot reach a Kaspa node: ${(e as Error).message}. This service answers only ` +
          `from a node it has checked, so it has nothing to say until one is reachable.`,
        null,
      );
    }
    this.assertUsable(opened.health);
    this.live = { ...opened, checkedAt: Date.now() };
    return this.live;
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
      this.live.client.close();
      this.live = null;
    }
  }
}

/** Re-run the checks on an existing connection, without opening a new one. */
async function inspectOnly(client: NodeClient, networkId?: string): Promise<NodeHealth> {
  return inspect(client, networkId ? { networkId } : {});
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
