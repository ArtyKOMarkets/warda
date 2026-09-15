/**
 * An agent wallet: a grant, a signer, and the bookkeeping nobody wants.
 *
 * ## What this is for
 *
 * Every piece of paying an API out of a Warda grant already existed —
 * `WardaPayer` signs, `wardaFetch` handles the 402 dance, `openChain` reaches
 * a node over whichever encoding it speaks. What did not exist was anything
 * that held them together and took responsibility for the record, so every
 * integration re-derived the same orchestration from `agents/tools/buy.ts`,
 * which is six hundred lines of script.
 *
 * The one job that genuinely has no other home is the manifest. A grant's
 * address is a hash of its state; spend and the coin moves. `WardaPayer.state`
 * is documented "persist this if the process may restart", which correctly
 * describes the hazard and leaves it with the caller. Here it does not.
 *
 * ## What this deliberately does not do
 *
 * It does not decide whether a payment is allowed. `@warda_protocol/core` owns
 * the rules and every verdict in this project comes from there, so that a
 * second copy cannot drift from the first — and a convenience method here that
 * re-derived "what may I spend right now" from the state fields would be
 * exactly that second copy. Ask core, or the MCP server, which already exposes
 * it as a tool.
 *
 * The covenant is the real answer in any case: a payment outside the limits is
 * not refused, it is not a transaction.
 *
 * ## The ordering, which is the whole product
 *
 *   load        the record, and check the allowlist against its root
 *   pay         through WardaPayer, one at a time, queued inside it
 *   deliver     the vendor serves, or the purchase is a debt and not a spend
 *   advance     only then, and only on delivery
 *
 * A failure between pay and deliver leaves the record un-advanced ON PURPOSE.
 * The money moved and the grant moved with it, so the record is stale — but a
 * stale record is recoverable by following the chain, and a record advanced
 * past a payment that was never delivered loses the proof needed to collect
 * it. Of the two wrong states, only one of them is reversible.
 */
import {
  openChain,
  type Chain,
  type CovenantTemplate,
  type GrantState,
  type NetworkPrefix,
} from "@warda_protocol/kaspa";
/* `Signer` comes from x402 rather than from the SDK: it is the SDK's type, but
   the SDK's index does not re-export it and x402 does. Importing it from the
   package that actually publishes it beats adding an export to fix a caller. */
import { WardaPayer, wardaFetch, type Signer, type WardaFetchEvent } from "@warda_protocol/x402";
import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };
import { toGrant } from "./grant.ts";
import { advanced, type Manifest, type Store } from "./store.ts";

export interface AgentOptions {
  /** Where the grant's record lives. `fileStore(path)` for the ordinary case. */
  store: Store;
  /** The allowlist members, as addresses or hex payloads. Checked against the root. */
  recipients: string[];
  /** The agent's key, or a signer that holds it somewhere this process cannot read. */
  sign: Signer | Uint8Array;
  /**
   * A chain connection. Bring your own — a long-lived agent should not open
   * one per purchase — or let this open one from the options below.
   */
  chain?: Chain;
  /** Reach the chain over borsh, through a public resolver. No node of your own. */
  borsh?: boolean;
  /** An explicit node. For borsh this must be a borsh endpoint, not a JSON one. */
  url?: string;
  networkId?: string;
  resolver?: string;
  prefix?: NetworkPrefix;
  /** Network fee per payment, in sompi. */
  fee?: bigint;
  /** Overridden only by tests that pin a template. */
  template?: CovenantTemplate;
}

export interface Purchase {
  response: Response;
  /** Absent when nothing was bought — a free endpoint, or a resumed proof. */
  paid?: {
    txid: string;
    amountSompi: bigint;
    /** Present only so a caller that lost delivery can re-present it. */
    header: string;
  };
}

export class Agent {
  private readonly payer: WardaPayer;
  private readonly store: Store;
  private readonly ownsChain: boolean;
  private manifestState: Manifest;
  readonly chain: Chain;

  private constructor(o: {
    payer: WardaPayer;
    store: Store;
    chain: Chain;
    ownsChain: boolean;
    manifest: Manifest;
  }) {
    this.payer = o.payer;
    this.store = o.store;
    this.chain = o.chain;
    this.ownsChain = o.ownsChain;
    this.manifestState = o.manifest;
  }

  static async open(options: AgentOptions): Promise<Agent> {
    const manifest = await options.store.load();
    const template = options.template ?? (covenantTemplate as unknown as CovenantTemplate);
    const grant = toGrant(manifest, options.recipients, template);

    let chain = options.chain;
    let ownsChain = false;
    if (!chain) {
      const opened = await openChain({
        ...(options.url ? (options.borsh ? { borshUrl: options.url } : { url: options.url }) : {}),
        ...(options.resolver ? { resolver: options.resolver } : {}),
        ...(options.networkId ? { networkId: options.networkId } : {}),
        ...(options.borsh ? { borsh: true } : {}),
      });
      chain = opened.client;
      ownsChain = true;
    }

    const payer = new WardaPayer({
      grant,
      node: chain,
      sign: options.sign,
      ...(options.prefix ? { prefix: options.prefix } : {}),
      ...(options.fee !== undefined ? { fee: options.fee } : {}),
    });

    return new Agent({ payer, store: options.store, chain, ownsChain, manifest });
  }

  /** The grant as it stands now, including anything this process has spent. */
  get state(): GrantState {
    return this.payer.state;
  }

  /** The record as last written. Advanced after a delivered purchase, never before. */
  get manifest(): Manifest {
    return structuredClone(this.manifestState);
  }

  /** What one payment costs in network fee, which the budget is NOT charged. */
  get fee(): bigint {
    return this.payer.fee;
  }

  /**
   * Fetch a URL, paying for it out of the grant if it asks.
   *
   * A 200 costs nothing and is returned as-is: an endpoint that does not
   * charge is not an error, and a wallet that refuses to fetch a free thing is
   * a wallet with an opinion about your architecture.
   */
  async fetch(input: string | URL | Request, init?: RequestInit, opts?: {
    onEvent?: (e: WardaFetchEvent) => void;
    /**
     * How many times to re-present the same proof while the vendor reports the
     * payment still settling.
     *
     * Exposed because the default is measured in seconds and a caller with its
     * own deadline needs to say so — and because re-presenting is the ONLY
     * correct response to a purchase that settled and did not arrive. A client
     * that gave up by paying again would pay twice for one resource.
     */
    maxSettleAttempts?: number;
  }): Promise<Purchase> {
    let paid: Purchase["paid"];
    const response = await wardaFetch(input, init, {
      payer: this.payer,
      ...(opts?.maxSettleAttempts !== undefined ? { maxSettleAttempts: opts.maxSettleAttempts } : {}),
      onEvent: (e) => {
        if (e.type === "paid") {
          paid = { txid: e.result.txid, amountSompi: e.result.amountSompi, header: e.header };
        }
        opts?.onEvent?.(e);
      },
    });

    /* Advance only here. `wardaFetch` resolving means the vendor served, so
       this is the one moment the purchase is both paid AND delivered. Anything
       that threw above left the record stale, which is the recoverable half of
       the two ways to be wrong. */
    if (paid) {
      this.manifestState = advanced(this.manifestState, this.payer.state, paid.amountSompi, this.payer.fee);
      await this.store.save(this.manifestState);
    }

    return paid ? { response, paid } : { response };
  }

  /** Releases the chain connection, but only if this opened it. */
  async close(): Promise<void> {
    if (this.ownsChain) await this.chain.close();
  }
}
