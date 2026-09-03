import {
  attachSignature,
  buildUnsignedSpend,
  claimedDaaFor,
  decodeAddress,
  fromHex,
  signDigest,
  verifyDigest,
  scriptHashFor,
  scriptHashToAddress,
  payToPubkeyScript,
  serializedScriptPublicKey,
  successorState,
  toHex,
  toSafeJson,
  type CovenantTemplate,
  type GrantAuthority,
  type GrantState,
  type NetworkPrefix,
  type NodeClient,
  type RecipientSet,
  type SpendPlan,
} from "@warda_protocol/kaspa";

import { X402Error, type PaymentRequirement } from "./protocol.ts";
import {
  amountOf,
  assertPayeeScriptMatches,
  GRANT_INPUT_INDEX,
  PAYEE_OUTPUT_INDEX,
  type BuildV2Input,
  type Outstanding,
  type PendingPayment,
} from "./pay-v2.ts";
import { buildPayment, paymentSignatureHeader } from "./v2.ts";

/**
 * Paying an x402 invoice out of a Warda grant instead of a hot wallet.
 *
 * The two protocols answer different questions and compose almost exactly.
 * x402 says HOW an agent pays for one call: here is the price, here is the
 * address, come back with proof. Warda says WHAT the agent is allowed to pay
 * — in total, per call, per epoch, and to whom — and puts that answer in
 * consensus rather than in the process holding the key.
 *
 * The join is the payment step. A stock x402 client builds a plain transfer
 * from a private key it was handed; this builds a covenant spend from a grant.
 * Everything above and below is unchanged, which is the point: the vendor sees
 * an ordinary Kaspa payment and never learns the difference.
 *
 * ## What this buys, concretely
 *
 * The reference client caps spending with an environment variable, and its own
 * documentation says the server "refuses further calls until restarted". That
 * cap is bypassed by a crash, a redeploy, a second instance, or anyone who can
 * read the key. Backed by a grant, the same agent cannot exceed its budget
 * even if the key is stolen outright: the thief inherits the limits, because
 * the limits are in the script that unlocks the coin.
 *
 * ## Two constraints x402 does not know about
 *
 * A Warda grant can only pay a payee it committed to at genesis, and the
 * covenant requires the payee output to be P2PK. So a vendor's `payTo` must be
 * a P2PK address whose key is in the grant's `recipientsRoot`. Neither is a
 * limitation of this adapter — they are the authority model working — but both
 * fail at broadcast in a way that reads like a chain error, so both are
 * checked here first and reported in words.
 *
 * In practice the allowlist IS the vendor list: a marketplace that validates
 * services before listing them is describing the same set.
 */

export interface Grant {
  template: CovenantTemplate;
  authority: GrantAuthority;
  /** The grant's CURRENT state. It moves after every spend. */
  state: GrantState;
  /** The full member list. A root cannot produce an inclusion proof. */
  recipients: RecipientSet;
}

export type Signer = (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;

export interface PayerOptions {
  grant: Grant;
  node: NodeClient;
  /**
   * The agent's key, or a function that signs with it.
   *
   * A function is the better shape for anything real: the key can live in an
   * HSM, a remote signer, or another process, and this module never sees it.
   * Raw bytes are accepted because a script or a test should not have to build
   * a signer to try the thing out.
   */
  sign: Signer | Uint8Array;
  prefix?: NetworkPrefix;
  /** Network fee per payment, in sompi. */
  fee?: bigint;
  computeBudget?: number;
  /**
   * How far behind the tip to claim. The covenant proves the chain reached
   * `claimedDaa` via a CLTV lock, so a value at or above the current score is
   * not yet final and the transaction is rejected as non-final — for reasons
   * that have nothing to do with the grant.
   */
  daaBackoff?: bigint;
}

/**
 * A covenant spend is not an ordinary transfer, and it is not priced like one.
 *
 * Kaspa charges by MASS, which is proportional to serialized size, and a Warda
 * spend carries the whole 5.7 KB redeem script in its signature script — so a
 * transaction that moves 0.2 KAS is about 6 KB on the wire and prices near
 * 1,511,400 sompi. The 1,000,000 that suffices for a plain payment is rejected
 * as non-standard, by a node that has already accepted the SIGNATURE: the
 * covenant is satisfied and the transaction still will not relay.
 *
 * v3 fitted under 1,000,000; v4 does not, because settlement and the subset
 * witness made the script bigger. Any future entrypoint moves this again, which
 * is why the underpayment rejection below is translated rather than passed
 * through — the node names the exact figure it wants, and that is worth
 * surfacing instead of a raw RPC error.
 */
const DEFAULT_FEE = 2_000_000n;
const DEFAULT_COMPUTE_BUDGET = 16;
const DEFAULT_DAA_BACKOFF = 100n;

export interface PaymentResult {
  txid: string;
  /** The address the payment came from — the grant's address BEFORE it moved. */
  payer: string;
  amountSompi: bigint;
  /** Where the grant lives now. Its address changed with its state. */
  state: GrantState;
  address: string;
}

/**
 * The payee's x-only key, or a refusal that says which rule was missed.
 *
 * Kaspa addresses carry a version inside the payload: 0 is pay-to-pubkey and 8
 * is pay-to-script-hash. The covenant builds the payee output as
 * `P2PK(recipient)` and nothing else, so a P2SH vendor cannot be paid from a
 * grant at all — not "rejected", but genuinely unrepresentable.
 */
export function payeeKey(payTo: string): Uint8Array {
  let decoded;
  try {
    decoded = decodeAddress(payTo);
  } catch (e) {
    throw new X402Error(`the server's payTo address is not a valid Kaspa address: ${payTo} (${(e as Error).message})`);
  }
  if (decoded.version !== 0) {
    throw new X402Error(
      `${payTo} is a pay-to-script-hash address (version ${decoded.version}), and a Warda ` +
        `grant can only pay pay-to-pubkey. The covenant builds the payee output as ` +
        `P2PK(recipient) — there is no transaction shape that pays a script hash from a ` +
        `grant, so this is not something a larger budget or a different grant would fix.`,
    );
  }
  if (decoded.payload.length !== 32) {
    throw new X402Error(`${payTo} decodes to ${decoded.payload.length} bytes; an x-only key is 32`);
  }
  return decoded.payload;
}

/**
 * Everything that must hold before a payment is worth building, checked in the
 * covenant's own order so the limit reported is the one the chain would report.
 *
 * None of this is a permission decision — the covenant makes those, on chain,
 * and it re-derives every one of these itself. The point is that a caller
 * learns *which* rule binds, in a sentence, instead of reading a script error.
 */
export function explainRefusal(
  req: PaymentRequirement,
  grant: Grant,
  opts: { fee: bigint; coin?: bigint } = { fee: DEFAULT_FEE },
): string | null {
  const { state } = grant;
  const amount = req.amountSompi;

  let key: Uint8Array;
  try {
    key = payeeKey(req.payTo);
  } catch (e) {
    return (e as Error).message;
  }

  if (!grant.recipients.has(toHex(key))) {
    return (
      `${req.payTo} is not on this grant's allowlist, so no inclusion proof places it in ` +
      `the recipients tree. There is no valid transaction that pays them — not one the ` +
      `network would reject, none at all. A grant's payees are fixed at genesis: to pay ` +
      `this vendor you need a grant that committed to them.`
    );
  }

  if (amount > state.maxPerSpend) {
    return (
      `this invoice is ${amount} sompi and the grant's per-payment cap is ${state.maxPerSpend}. ` +
      `The cap exists to bound what a single decision can do, so it binds here regardless of ` +
      `how much budget remains.`
    );
  }

  const committed = state.spentTotal + state.reserved;
  const uncommitted = state.budgetTotal - committed;
  if (amount > uncommitted) {
    return (
      `this invoice is ${amount} sompi and only ${uncommitted} of the grant's lifetime budget ` +
      `is uncommitted (${state.budgetTotal} total, less ${state.spentTotal} spent and ` +
      `${state.reserved} reserved for delegated children).`
    );
  }

  if (opts.coin !== undefined && amount + opts.fee > opts.coin) {
    return (
      `the grant's coin holds ${opts.coin} sompi, which will not cover ${amount} plus a fee of ` +
      `${opts.fee}. Budget accounting and coin diverge over a grant's life because fees leave ` +
      `the coin without being charged against the budget.`
    );
  }

  // The epoch allowance is checked against the epoch the payment will land in,
  // which is not knowable until the DAA score is read. `payInvoice` re-checks
  // it there; a caller passing no coin figure gets the static checks only.
  return null;
}

/**
 * A payer bound to one grant.
 *
 * It owns the grant's state and advances it after every payment, because a
 * grant's address IS its state: spend once and the old address is empty. A
 * caller that kept its own stale copy would aim the next payment at a UTXO
 * that no longer exists.
 *
 * Payments are serialised. A grant is a single UTXO, so two concurrent spends
 * would build on the same coin and one of them would be rejected as a double
 * spend — arriving as a confusing chain error rather than an obvious
 * concurrency bug. The queue makes the serialisation explicit instead.
 */
export class WardaPayer {
  private grant: Grant;
  private readonly node: NodeClient;
  private readonly signer: Signer;
  private readonly prefix: NetworkPrefix;
  private readonly fee: bigint;
  private readonly computeBudget: number;
  private readonly daaBackoff: bigint;
  /** Tail of the payment queue. See the class comment. */
  private queue: Promise<unknown> = Promise.resolve();
  /** v2 only: a signed spend somebody else is holding. See pay-v2.ts. */
  private held: Outstanding = { status: "none" };

  constructor(opts: PayerOptions) {
    this.grant = opts.grant;
    this.node = opts.node;
    const sign = opts.sign;
    this.signer = typeof sign === "function" ? sign : (digest: Uint8Array) => signDigest(digest, sign);
    this.prefix = opts.prefix ?? "kaspatest";
    this.fee = opts.fee ?? DEFAULT_FEE;
    this.computeBudget = opts.computeBudget ?? DEFAULT_COMPUTE_BUDGET;
    this.daaBackoff = opts.daaBackoff ?? DEFAULT_DAA_BACKOFF;
  }

  /** The grant as it stands now. Persist this if the process may restart. */
  get state(): GrantState {
    return this.grant.state;
  }

  /** Where the grant currently lives. */
  get address(): string {
    return scriptHashToAddress(
      scriptHashFor(this.grant.template, { authority: this.grant.authority, state: this.grant.state }),
      this.prefix,
    );
  }

  /** What this grant could pay right now, ignoring the coin. */
  get headroom(): bigint {
    const s = this.grant.state;
    const uncommitted = s.budgetTotal - s.spentTotal - s.reserved;
    return uncommitted < s.maxPerSpend ? uncommitted : s.maxPerSpend;
  }

  /** Why a given invoice cannot be paid, or null. Does not touch the network. */
  refusalFor(req: PaymentRequirement): string | null {
    return explainRefusal(req, this.grant, { fee: this.fee });
  }

  /**
   * Whether a v2 payment is out of this payer's hands.
   *
   * `none` is the ordinary state. `pending` means a signed spend exists that
   * this payer did not broadcast. `unresolved` means one was abandoned without
   * ever being accounted for, and the grant's position must be re-established
   * from the chain before this payer is used again.
   */
  get outstanding(): Outstanding {
    return this.held;
  }

  /**
   * Refuses to build anything while a previous v2 payment is unaccounted for.
   *
   * Both refusals name the way out, because both are recoverable and neither
   * is obvious: a pending payment needs `settled()` or `abandoned()`, and an
   * unresolved payer needs the grant found on chain and a fresh payer built
   * around what was found.
   */
  private assertFree(): void {
    if (this.held.status === "pending") {
      throw new X402Error(
        `this grant already has a signed payment of ${this.held.payment.amountSompi} sompi in ` +
          `a vendor's hands (expires ${this.held.payment.expiresAt}). Building another would ` +
          `spend the same coin twice, and at most one of them can land — so both vendors ` +
          `would be holding a transaction one of them cannot cash. Call settled() once the ` +
          `vendor confirms, or abandoned() if it did not.`,
      );
    }
    if (this.held.status === "unresolved") {
      throw new X402Error(
        `this payer no longer knows where its grant is: ${this.held.why} It is at one of ` +
          `${this.held.candidates[0]} or ${this.held.candidates[1]}, and one query per ` +
          `candidate settles it (tools/follow-grant.ts does exactly that). Build a fresh ` +
          `payer around whichever state was found.`,
      );
    }
  }

  /** Pays one invoice and returns once it is broadcast. */
  pay(req: PaymentRequirement): Promise<PaymentResult> {
    // Rejected, not thrown. This method returns a promise, and a caller
    // written as `payer.pay(x).catch(handle)` would never see a synchronous
    // throw — it would escape as an unhandled exception from a call the caller
    // believed it had handled.
    try {
      this.assertFree();
    } catch (e) {
      return Promise.reject(e);
    }
    const run = this.queue.then(
      () => this.payNow(req),
      () => this.payNow(req),
    );
    // The queue must not reject, or one failed payment poisons every later one.
    this.queue = run.catch(() => undefined);
    return run;
  }


  // ---- kaspa-x402 v2 ------------------------------------------------------

  /**
   * Build a v2 payment: everything a vendor needs to take the money, and
   * nothing broadcast.
   *
   * The checks are the same ones `pay` makes and in the same order, because
   * they are the covenant's order and the point is that the limit reported is
   * the limit the chain would report. What differs is the ending: instead of
   * submitting and advancing, this hands back a `PendingPayment` and holds the
   * grant until the caller says what happened to it.
   */
  async buildPaymentV2(input: BuildV2Input): Promise<PendingPayment> {
    this.assertFree();

    const amountSompi = amountOf(input.accepted);
    const req: PaymentRequirement = {
      scheme: "exact",
      network: input.accepted.network,
      asset: "KAS",
      payTo: input.accepted.payTo,
      amountSompi,
      // v2 replaced the per-invoice nonce with the request binding, which the
      // authorization carries. Nothing downstream of here reads this field.
      nonce: "",
      maxTimeoutSeconds: input.accepted.maxTimeoutSeconds,
    };

    const key = payeeKey(req.payTo);
    assertPayeeScriptMatches(input.accepted, serializedScriptPublicKey(payToPubkeyScript(key)));

    const fromAddress = this.address;
    const [dag, utxo] = await Promise.all([
      this.node.getBlockDagInfo(),
      this.node.grantUtxo(fromAddress),
    ]);

    const refusal = explainRefusal(req, this.grant, { fee: this.fee, coin: utxo.entry.value });
    if (refusal) throw new X402Error(refusal);

    const claimedDaa = claimedDaaFor(this.grant.state, dag.virtualDaaScore, this.daaBackoff);
    const s = this.grant.state;
    const epochIndex = (claimedDaa - s.notBefore) / s.epochLength;
    const usedThisEpoch = epochIndex === s.epochIndex ? s.epochSpent : 0n;
    if (usedThisEpoch + amountSompi > s.epochLimit) {
      throw new X402Error(
        `this invoice is ${amountSompi} sompi and only ${s.epochLimit - usedThisEpoch} remains ` +
          `in the current epoch (${epochIndex}). The allowance refreshes as the chain advances — ` +
          `and cannot be refreshed by claiming an earlier epoch, which the covenant refuses.`,
      );
    }

    const plan: SpendPlan = {
      template: this.grant.template,
      authority: this.grant.authority,
      state: this.grant.state,
      utxo: {
        outpointTransactionId: utxo.outpoint.transactionId,
        outpointIndex: utxo.outpoint.index,
        value: utxo.entry.value,
        blockDaaScore: utxo.entry.blockDaaScore,
        isCoinbase: utxo.entry.isCoinbase,
        covenantId: utxo.entry.covenantId!,
      },
      amount: amountSompi,
      recipient: key,
      proof: this.grant.recipients.proof(toHex(key)),
      claimedDaa,
      fee: this.fee,
      computeBudget: this.computeBudget,
    };

    // The entry the SDK derived, not the one the node reported. They describe
    // the same UTXO, and if they ever disagreed the SDK's is the one that
    // matters: the sighash committed to it, so it is the entry under which the
    // signature verifies. Sending the node's copy would mean handing a vendor
    // a transaction whose signature was made over something else.
    const { tx, entry } = await this.signPlan(plan);
    const safe = toSafeJson(tx, [entry]);

    const next = successorState(this.grant.state, amountSompi, claimedDaa);
    const successorAddress = scriptHashToAddress(
      scriptHashFor(this.grant.template, { authority: this.grant.authority, state: next }),
      this.prefix,
    );

    const payment = await buildPayment(
      {
        accepted: input.accepted,
        request: input.request,
        transaction: JSON.stringify(safe),
        transactionId: safe.id,
        paymentOutputIndex: PAYEE_OUTPUT_INDEX,
        inputIndex: GRANT_INPUT_INDEX,
        payerAddress: fromAddress,
        nowMs: input.nowMs,
      },
      this.signer,
    );

    const pending: PendingPayment = {
      header: paymentSignatureHeader(payment),
      payment,
      txid: safe.id,
      payer: fromAddress,
      amountSompi,
      successor: next,
      successorAddress,
      expiresAt: payment.payload.authorization.expiresAt,
    };
    this.held = { status: "pending", payment: pending };
    return pending;
  }

  /**
   * The vendor took it. Advance the grant to where the spend put it.
   *
   * "Confirmed" means the vendor answered 200 with a settlement response, or
   * the transaction was seen on chain. Not "the request was sent" — an
   * unanswered request is exactly the case `abandoned()` exists for.
   */
  settledV2(): PaymentResult {
    if (this.held.status !== "pending") {
      throw new X402Error(
        `there is no payment outstanding to settle (status: ${this.held.status}).`,
      );
    }
    const { payment } = this.held;
    this.grant = { ...this.grant, state: payment.successor };
    this.held = { status: "none" };
    return {
      txid: payment.txid,
      payer: payment.payer,
      amountSompi: payment.amountSompi,
      state: payment.successor,
      address: payment.successorAddress,
    };
  }

  /**
   * It did not settle — as far as we know.
   *
   * This does NOT roll back. The transaction was signed and handed over, and
   * "the vendor did not confirm" is not evidence that it was not broadcast: a
   * vendor that crashed after submitting looks identical to one that never
   * tried. So the payer stops rather than picking one, and names the two
   * addresses the grant can be at so the question can be settled against the
   * chain instead of assumed.
   */
  abandonedV2(why = "a signed payment was abandoned without a settlement response."): Outstanding {
    if (this.held.status !== "pending") {
      throw new X402Error(
        `there is no payment outstanding to abandon (status: ${this.held.status}).`,
      );
    }
    const { payment } = this.held;
    this.held = {
      status: "unresolved",
      candidates: [payment.payer, payment.successorAddress],
      why:
        `${why} Transaction ${payment.txid} was signed and handed to the vendor, and whether ` +
        `it was broadcast is not knowable from here.`,
    };
    return this.held;
  }

  private async payNow(req: PaymentRequirement): Promise<PaymentResult> {
    const key = payeeKey(req.payTo);
    const fromAddress = this.address;

    const [dag, utxo] = await Promise.all([
      this.node.getBlockDagInfo(),
      this.node.grantUtxo(fromAddress),
    ]);

    const refusal = explainRefusal(req, this.grant, { fee: this.fee, coin: utxo.entry.value });
    if (refusal) throw new X402Error(refusal);

    /* Backing off from the tip keeps the CLTV final; clamping up to notBefore
       keeps a grant spendable in the first seconds of its life. Without the
       clamp, an agent handed a freshly created grant fails with "claimedDaa …
       is before the grant opens", which sounds like a clock problem and is
       actually "wait ten seconds". */
    const claimedDaa = claimedDaaFor(this.grant.state, dag.virtualDaaScore, this.daaBackoff);

    // The epoch allowance, checked against the epoch this payment lands in.
    // successorState refuses a backwards claim outright; this catches the
    // forwards case where the allowance is simply used up.
    const s = this.grant.state;
    const epochIndex = (claimedDaa - s.notBefore) / s.epochLength;
    const usedThisEpoch = epochIndex === s.epochIndex ? s.epochSpent : 0n;
    if (usedThisEpoch + req.amountSompi > s.epochLimit) {
      throw new X402Error(
        `this invoice is ${req.amountSompi} sompi and only ${s.epochLimit - usedThisEpoch} remains ` +
          `in the current epoch (${epochIndex}). The allowance refreshes as the chain advances — ` +
          `and cannot be refreshed by claiming an earlier epoch, which the covenant refuses.`,
      );
    }

    const plan: SpendPlan = {
      template: this.grant.template,
      authority: this.grant.authority,
      state: this.grant.state,
      utxo: {
        outpointTransactionId: utxo.outpoint.transactionId,
        outpointIndex: utxo.outpoint.index,
        value: utxo.entry.value,
        blockDaaScore: utxo.entry.blockDaaScore,
        isCoinbase: utxo.entry.isCoinbase,
        covenantId: utxo.entry.covenantId!,
      },
      amount: req.amountSompi,
      recipient: key,
      proof: this.grant.recipients.proof(toHex(key)),
      claimedDaa,
      fee: this.fee,
      computeBudget: this.computeBudget,
    };

    const { tx } = await this.signPlan(plan);

    let txid: string;
    try {
      txid = await this.node.submitTransaction(tx);
    } catch (e) {
      // Kaspa prices by mass and states the figure it wants. Passing that
      // through as a raw RPC error hides an entirely actionable number.
      const msg = (e as Error).message ?? "";
      const need = /required amount of (\d+)/.exec(msg);
      if (need) {
        throw new X402Error(
          `this spend paid a fee of ${this.fee} sompi and the network requires ${need[1]} for a ` +
            `transaction this size. A covenant spend carries the whole redeem script in its ` +
            `signature script, so it is roughly 6 KB on the wire and costs far more than a plain ` +
            `transfer — the signature was fine, the fee was not. Construct the payer with ` +
            `fee: ${need[1]}n or higher. Nothing was spent.`,
        );
      }
      /**
       * Storage mass: there is a floor under how small a payment can be.
       *
       * KIP-9 charges a transaction for the small outputs it creates, roughly
       * in proportion to the reciprocal of each output's value. A payment of
       * 0.01 KAS massed 1,000,000 against a 500,000 ceiling and was refused —
       * so an x402 endpoint priced at a penny cannot be paid at all, however
       * much budget the grant has.
       *
       * Worth translating rather than passing through, because the raw message
       * says "storage mass" and the actionable fact is "this amount is too
       * small". Measured, not derived: 0.01 KAS is refused, 0.05 and 0.1 go
       * through, so the floor sits near 0.02 KAS. The exact constant is
       * consensus's to state, which is why the node's own numbers are quoted
       * back rather than a threshold of ours.
       */
      const storage = /storage mass of (\d+) is larger than max allowed size of (\d+)/.exec(msg);
      if (storage) {
        throw new X402Error(
          `this payment of ${req.amountSompi} sompi is too SMALL to broadcast. Kaspa charges ` +
            `storage mass for the small outputs a transaction creates: this one massed ` +
            `${storage[1]} against a ceiling of ${storage[2]}. Nothing about the grant was ` +
            `exceeded and nothing was spent — the amount itself is below what the network will ` +
            `carry. In practice payments under about 0.02 KAS cannot be made, whatever the ` +
            `budget allows.`,
        );
      }
      throw e;
    }

    // Advance only after the network has taken it. Moving first would leave
    // the payer pointing at a successor that does not exist if submission
    // failed, and every later payment would fail at an empty address.
    const next = successorState(this.grant.state, req.amountSompi, claimedDaa);
    this.grant = { ...this.grant, state: next };

    return {
      txid,
      payer: fromAddress,
      amountSompi: req.amountSompi,
      state: next,
      address: this.address,
    };
  }

  private async signPlan(plan: SpendPlan) {
    // The two-step form, not signSpend: signSpend takes raw key bytes, and the
    // whole point of accepting a signer is that the key can stay elsewhere.
    const unsigned = buildUnsignedSpend(plan);
    const signature = await this.signer(unsigned.sighash);
    if (signature.length !== 65) {
      throw new X402Error(
        `the signer returned ${signature.length} bytes; a Kaspa signature is 64 plus a ` +
          `sighash-type byte. A signer that omits the trailing byte produces a transaction ` +
          `the engine rejects without saying why.`,
      );
    }

    // Is this actually the grant's agent?
    //
    // The covenant checks `checkSig(agentSig, pubkey(agentKey))`, and a
    // signature from any other key fails it. On chain that arrives as
    // "script ran, but verification failed" — which is true, useless, and
    // costs a round trip to a node to discover.
    //
    // The SDK's own signSpend refuses a key that is not the agent's, but this
    // path deliberately does not use it: accepting a signer function is what
    // lets the key live in an HSM, and a signer cannot be checked before it
    // signs. So the check moves to after, where it costs one verification and
    // catches the same mistake.
    //
    // This is not hypothetical. The first live run of the x402 demo signed
    // with the FUNDER's key, because that is what WARDA_SK holds and the agent
    // key is derived from it — see `resolveSigner` in @warda_protocol/kaspa.
    if (!verifyDigest(signature, unsigned.sighash, fromHex(plan.state.agentKey))) {
      throw new X402Error(
        `this signature does not verify against the grant's agent key ` +
          `(${plan.state.agentKey.slice(0, 16)}…), so the covenant will refuse it as a bad ` +
          `signature and say only that verification failed.\n` +
          `The commonest cause is signing with the FUNDER's key: the funder pays for genesis, ` +
          `and the agent key is usually DERIVED from it rather than equal to it. If the grant's ` +
          `manifest records an \`agent_key_derived\` block, resolveSigner() from ` +
          `@warda_protocol/kaspa will find the right secret from the one you hold.`,
      );
    }
    return { tx: attachSignature(plan, unsigned, signature), entry: unsigned.entry };
  }
}
