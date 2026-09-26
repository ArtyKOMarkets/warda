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
 *   reconcile   the record follows the COIN, whatever the vendor decided
 *
 * The last line was wrong for one release, and the mistake is worth keeping
 * written down because it is a plausible one. It used to advance only on a
 * delivered purchase, reasoning that a payment which settled and was never
 * served is a debt rather than a spend. That is true of the accounting and
 * irrelevant to the address: a v2 vendor broadcasts and then decides, so by
 * the time it refuses, the grant has already moved and a record left behind
 * points at an address holding nothing — the unaddressable-coin failure this
 * package exists to prevent, produced by the rule meant to prevent it.
 *
 * Nothing is lost by writing it forward. What proves the payment happened is
 * the header on the `paid` event, which is a separate artifact and is still
 * handed back.
 */
import {
  assertTemplateForManifest,
  openChain,
  type Chain,
  type CovenantTemplate,
  type GrantState,
  type NetworkPrefix,
} from "@warda_protocol/kaspa";
/* `Signer` comes from x402 rather than from the SDK: it is the SDK's type, but
   the SDK's index does not re-export it and x402 does. Importing it from the
   package that actually publishes it beats adding an export to fix a caller. */
import { randomUUID } from "node:crypto";
import {
  WardaPayer,
  wardaFetch,
  type PaymentResult,
  type ResumableProof,
  type Signer,
  type WardaFetchEvent,
} from "@warda_protocol/x402";
/**
 * Resolved from the manifest, never defaulted.
 *
 * This line used to be `import covenantTemplate from ".../covenant-template.json"`
 * and the template below used to be `options.template ?? covenantTemplate`. That
 * default is what stopped a live agent on 25 September 2026: the packaged
 * template became v5 the same day, this agent held a v4 grant, and the pair
 * derived an address that exists, holds nothing and is indistinguishable from a
 * grant that was drained. Six passes failed over twenty-one hours reporting "no
 * UTXO" about a grant sitting untouched at the address its own manifest names.
 *
 * A wrong template is not a wrong answer that looks wrong. The SDK already knew
 * this — `templateForManifest` exists, and its comment named the three tools
 * that had not adopted it. It did not name this one, which is the only one that
 * spends.
 */
import { templateFor } from "@warda_protocol/kaspa/templates";
import { toGrant, type LoadedGrant } from "./grant.ts";
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
  /**
   * Pin the template, for a test with a covenant that is not on disk.
   *
   * CHECKED against the manifest's `covenant` field, not trusted: pinning the
   * wrong one is the same failure as defaulting to the wrong one, and a test
   * that pins is exactly where a stale fingerprint survives unnoticed. A
   * manifest with no `covenant` field accepts whatever is passed, because
   * manifests predate the field.
   */
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
  private readonly grant: LoadedGrant;
  private manifestState: Manifest;
  readonly chain: Chain;

  private constructor(o: {
    payer: WardaPayer;
    store: Store;
    chain: Chain;
    ownsChain: boolean;
    manifest: Manifest;
    grant: LoadedGrant;
  }) {
    this.payer = o.payer;
    this.store = o.store;
    this.chain = o.chain;
    this.ownsChain = o.ownsChain;
    this.manifestState = o.manifest;
    this.grant = o.grant;
  }

  static async open(options: AgentOptions): Promise<Agent> {
    const manifest = await options.store.load();
    const template = options.template ?? templateFor(manifest, "this agent's grant");
    if (options.template) assertTemplateForManifest(options.template, manifest, "this agent's grant");
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

    return new Agent({ payer, store: options.store, chain, ownsChain, manifest, grant });
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

  /** Where the grant's coin is now. It moves after every spend. */
  get address(): string {
    return this.payer.address;
  }

  /** The chain this agent reads, for a caller that needs the tip or the coin. */
  get chainAccess(): Chain {
    return this.chain;
  }

  /**
   * Pay an allowlisted address straight from the grant — no invoice.
   *
   * The same covenant spend an x402 purchase makes, addressed by the caller
   * rather than by a vendor's 402. The record is written forward in a
   * `finally` for the reason `fetch` gives: once broadcast, the grant has
   * moved whatever happens next.
   */
  async pay(payTo: string, amountSompi: bigint): Promise<PaymentResult> {
    try {
      return await this.payer.pay({
        scheme: "exact",
        network: "kaspa",
        asset: "KAS",
        payTo,
        amountSompi,
        nonce: randomUUID(),
      });
    } finally {
      await this.reconcile();
    }
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
    /**
     * Pay through a single-use key rather than straight from the grant.
     *
     * Required by an x402 v2 vendor and ignored by a v1 one: their `exact`
     * scheme takes only a version-0 transaction with a key-controlled input
     * and no covenant, so a covenant spend cannot BE the payment.
     *
     * It costs the allowlist for that one hop — the covenant stops
     * constraining who is ultimately paid — which is why it is asked for
     * explicitly rather than inferred from the vendor announcing v2.
     */
    relay?: boolean;
    /** The relay hop's fee. Fixed by the funding transaction, so it cannot be
     *  corrected afterwards; measure it rather than guessing. */
    relayFeeSompi?: bigint;
    /**
     * A proof from an EARLIER purchase that was paid and never delivered.
     *
     * Re-presents the header and pays nothing — `wardaFetch` cannot reach the
     * payer down this path at all, which is what makes it safe to do
     * automatically. No `paid` event fires, so the record is not advanced
     * either, and that is correct: a resume spent nothing.
     */
    resume?: ResumableProof;
  }): Promise<Purchase> {
    if (opts?.relay) this.assertCanRelay();

    let paid: Purchase["paid"];
    try {
      const response = await wardaFetch(input, init, {
        payer: this.payer,
        ...(opts?.maxSettleAttempts !== undefined ? { maxSettleAttempts: opts.maxSettleAttempts } : {}),
        ...(opts?.relay !== undefined ? { relay: opts.relay } : {}),
        ...(opts?.relayFeeSompi !== undefined ? { relayFeeSompi: opts.relayFeeSompi } : {}),
        ...(opts?.resume ? { resume: opts.resume } : {}),
        onEvent: (e) => {
          if (e.type === "paid") {
            paid = { txid: e.result.txid, amountSompi: e.result.amountSompi, header: e.header };
          }
          opts?.onEvent?.(e);
        },
      });
      return paid ? { response, paid } : { response };
    } finally {
      await this.reconcile();
    }
  }

  /**
   * Write the record forward to wherever the payer says the grant now is.
   *
   * In a `finally`, because the record's job is to FIND THE COIN and the coin
   * does not care whether the vendor served. This used to advance only on a
   * 2xx, on the reasoning that a payment which settled and was never delivered
   * is a debt rather than a spend — which is true of the accounting and false
   * of the address. A v2 vendor broadcasts and then refuses; the grant has
   * moved by then, and a record left behind points at an address holding
   * nothing. Agent #005's first purchase did exactly that: `WardaPayer.settled`
   * ran, the spend was accepted on chain, the request came back 402, and the
   * manifest on disk still read `spent_total: 0`. The error text even said the
   * grant had been advanced to match. It had not.
   *
   * Nothing about the debt is lost by writing it: the proof that the payment
   * happened is the `paid` event's header, which is a separate artifact and
   * still returned.
   *
   * The amount comes from the payer's own counters rather than from the
   * invoice. On a relayed payment the covenant is charged the invoice PLUS the
   * relay hop's fee, so a record advanced by the invoice alone drifts by that
   * fee every purchase — the same slow divergence `grant_value` has already
   * been corrected by hand once.
   *
   * Idempotent: the delta is zero on a second call.
   */
  private async reconcile(): Promise<boolean> {
    const state = this.payer.state;
    const spent = state.spentTotal - BigInt(this.manifestState.spent_total);
    if (spent <= 0n) return false;
    this.manifestState = advanced(this.manifestState, state, spent, this.payer.fee);
    await this.store.save(this.manifestState);
    return true;
  }

  /**
   * Can this grant relay at all? Answerable with no network and no signature.
   *
   * A relayed payment goes grant -> the agent's own key -> the vendor, so the
   * agent's key has to be on the allowlist. An allowlist is fixed at genesis,
   * which makes this the one failure in the flow that CANNOT be fixed after
   * the fact — and it was being discovered late, after a quote, a node round
   * trip and a UTXO lookup, by a proof lookup throwing. Agent #005's first
   * grant was built that way and had to be abandoned and rebuilt.
   *
   * So it is checked here, before the vendor is even asked for a price.
   */
  private assertCanRelay(): void {
    const agentKey = this.grant.state.agentKey;
    if (this.grant.recipients.has(agentKey)) return;
    throw new Error(
      `this grant cannot pay through a relay: its allowlist does not contain the agent's ` +
        `own key (${agentKey.slice(0, 16)}\u2026).\n\n` +
        `x402 exact requires the payer's input to be an ordinary key-controlled coin, so a ` +
        `covenant spend can never be the payment itself \u2014 the grant has to pay the agent ` +
        `first, and that hop has to be on the allowlist. An allowlist is fixed at genesis, so ` +
        `this grant will never be able to do it:\n\n` +
        `  warda grant --payees payees.txt --relay\n\n` +
        `Nothing has been quoted, signed or spent. See x402/RELAY.md for what that hop costs.`,
    );
  }

  /** Releases the chain connection, but only if this opened it. */
  async close(): Promise<void> {
    if (this.ownsChain) await this.chain.close();
  }
}
