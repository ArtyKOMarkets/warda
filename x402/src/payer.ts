import {
  attachSignature,
  buildUnsignedSpend,
  claimedDaaFor,
  decodeAddress,
  fromHex,
  signDigest,
  verifyDigest,
  scriptHashFor,
  pubkeyToAddress,
  scriptHashToAddress,
  payToPubkeyScript,
  serializedScriptPublicKey,
  successorState,
  toHex,
  toSafeJson,
  toWire,
  type CovenantTemplate,
  type GrantAuthority,
  type GrantState,
  type NetworkPrefix,
  type NodeClient,
  type RecipientSet,
  type SpendPlan,
  type Transaction,
} from "@warda_protocol/kaspa";

/**
 * What paying needs from a chain connection.
 *
 * `NodeClient` satisfies it and so does `BorshReader`. Keeping it to the four
 * methods that are actually called is what makes the transport a decision the
 * caller makes rather than one this module makes for them.
 */
export type ChainAccess = Pick<
  NodeClient,
  | "getBlockDagInfo"
  | "getUtxosByAddresses"
  | "grantUtxo"
  | "submitTransaction"
  /* Only a relayed payment needs this, and only some clients have it — so it
     is optional here and its absence is a legible refusal rather than a crash
     on a property that is not there. */
  | "submitOrdinaryPayment"
>;

import { X402Error, type PaymentRequirement } from "./protocol.ts";
import { buildRelayPayment, relayFeeFor, relayFunding, type RelayPayment } from "./relay.ts";
import { encodeGrantProof } from "./grant-proof.ts";
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
 * The x402 documentation describes the standard control: the client "applies a
 * $1 USD spend cap unless you override spendControls". The ceiling is a default
 * in the process that pays, so it is bypassed by a redeploy with a different
 * value, a second instance, or anyone who can read the key. Backed by a grant,
 * the same agent cannot exceed its budget
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
  /**
   * The chain, as four methods rather than as a class.
   *
   * It was `NodeClient` until there was a second thing that could do this:
   * `BorshReader` reaches a public resolver over the encoding they actually
   * serve, which is how a buyer stops needing a node of their own. Naming the
   * class here would have made that a type error rather than a choice.
   */
  node: ChainAccess;
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
  private readonly node: ChainAccess;
  private readonly signer: Signer;
  private readonly prefix: NetworkPrefix;
  /** Network fee per payment. Readable because a caller reconciling a manifest
   *  needs it: the coin loses payment + fee, the budget only the payment. */
  readonly fee: bigint;
  private readonly computeBudget: number;
  private readonly daaBackoff: bigint;
  /** Tail of the payment queue. See the class comment. */
  private queue: Promise<unknown> = Promise.resolve();
  /** v2 only: a signed spend somebody else is holding. See pay-v2.ts. */
  private held: Outstanding = { status: "none" };
  /** The same spend in its internal form, so broadcasting need not re-parse it. */
  private heldTx: Transaction | null = null;
  /** The relayed payment, when there is one. Broadcast immediately after it. */
  private heldRelay: RelayPayment | null = null;

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

    const payee = payeeKey(req.payTo);
    assertPayeeScriptMatches(input.accepted, serializedScriptPublicKey(payToPubkeyScript(payee)));

    /**
     * Where the COVENANT SPEND pays, which is not always the vendor.
     *
     * On a relayed payment the grant pays the agent's own key and an ordinary
     * transaction carries it the rest of the way, so the covenant is charged
     * the invoice PLUS the relayed transaction's fee. That is correct rather
     * than unfortunate: the fee is part of what buying the thing costs, and a
     * budget that did not count it would mean less than it says.
     */
    /* Computed from the amount unless overridden, because the right figure
       depends on it — and refused out loud when there is no figure that
       settles, which is what a small invoice produces. Either way this happens
       BEFORE the covenant spend is built: the fee cannot be corrected once
       that is broadcast. */
    const relayFee = input.relay
      ? (input.relayFeeSompi ?? relayFeeFor(amountSompi, fromHex(this.grant.state.agentKey), payee))
      : 0n;
    const key = input.relay ? fromHex(this.grant.state.agentKey) : payee;
    const spendAmount = input.relay ? relayFunding(amountSompi, relayFee) : amountSompi;


    const fromAddress = this.address;
    const [dag, utxo] = await Promise.all([
      this.node.getBlockDagInfo(),
      this.node.grantUtxo(fromAddress),
    ]);

    /* Checked against the SPEND amount, not the invoice: a relayed payment
       charges the grant the fee too, and a cap or epoch limit that only saw
       the invoice would approve a spend the covenant then refuses. */
    /**
     * On a relay, the allowlist refusal has to say something different — and
     * the difference is not cosmetic.
     *
     * `explainRefusal` says "there is no valid transaction that pays them —
     * not one the network would reject, none at all". That is exactly true of
     * a direct spend and FALSE of a relayed one: the covenant pays the agent,
     * and the agent can pay anybody. This client refuses anyway, because a
     * payee nobody committed to is far more often a typo or a swapped vendor
     * than an intention — but it must not claim the covenant is doing it.
     *
     * The honest version says which it is. Telling somebody the chain forbids
     * what only this process forbids is the kind of claim that gets believed
     * and then discovered, and this protocol's whole value is that its
     * refusals are the first kind.
     */
    if (input.relay && !this.grant.recipients.has(toHex(payee))) {
      throw new X402Error(
        `${req.payTo} is not on this grant's allowlist, and this client will not relay to a ` +
          `payee that is not on it.\n\n` +
          `That refusal is THIS CLIENT's, not the covenant's. A relayed payment pays the ` +
          `agent's own key and the agent pays the vendor, so the chain does not constrain who ` +
          `ultimately receives it — which is the price of reaching an x402 exact vendor at ` +
          `all, and why --relay is typed rather than inferred.\n\n` +
          `What the covenant still enforces, here and always: the budget, the per-payment ` +
          `cap, the epoch limit and the window.\n\n` +
          `To buy from this vendor, commit to them when the grant is created — an allowlist ` +
          `is fixed at genesis:\n\n` +
          `  echo ${req.payTo} >> payees.txt\n` +
          `  warda grant --payees payees.txt --relay`,
      );
    }

    const refusal = explainRefusal(
      { ...req, amountSompi: spendAmount },
      this.grant,
      { fee: this.fee, coin: utxo.entry.value },
    );
    if (refusal) throw new X402Error(refusal);

    const claimedDaa = claimedDaaFor(this.grant.state, dag.virtualDaaScore, this.daaBackoff);
    const s = this.grant.state;
    const epochIndex = (claimedDaa - s.notBefore) / s.epochLength;
    const usedThisEpoch = epochIndex === s.epochIndex ? s.epochSpent : 0n;
    if (usedThisEpoch + spendAmount > s.epochLimit) {
      throw new X402Error(
        `this spend is ${spendAmount} sompi and only ${s.epochLimit - usedThisEpoch} remains ` +
          `in the current epoch (${epochIndex}). The allowance refreshes as the chain advances — ` +
          `and cannot be refreshed by claiming an earlier epoch, which the covenant refuses.`,
      );
    }

    /* Taken AFTER the refusal and epoch checks, not before.
       `explainRefusal` is what turns "this payee is not on the allowlist" into
       the sentence that is this protocol's product; reaching for the proof
       first replaced it with the recipient set's internal complaint about a
       key not being in a tree. The order is the message. */
    let proof;
    try {
      proof = this.grant.recipients.proof(toHex(key));
    } catch (e) {
      if (!input.relay) throw e;
      /* The allowlist is fixed at genesis, so this cannot be fixed here and
         must not be reported as a transient failure. It means the grant was
         created without --relay. */
      throw new X402Error(
        `this grant cannot pay through a relay: its allowlist does not contain the agent's ` +
          `own key.\n\n` +
          `x402 exact requires the payer's input to be an ordinary key-controlled coin, so a ` +
          `covenant spend can never be the payment itself — the grant has to pay the agent ` +
          `first. That has to be allowed when the grant is CREATED, because an allowlist is ` +
          `fixed at genesis:\n\n` +
          `  warda grant --payees payees.txt --relay\n\n` +
          `It costs the allowlist for that one hop and nothing else. See x402/RELAY.md.\n\n` +
          `  (${(e as Error).message})`,
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
      amount: spendAmount,
      recipient: key,
      proof,
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

    const next = successorState(this.grant.state, spendAmount, claimedDaa);
    const successorAddress = scriptHashToAddress(
      scriptHashFor(this.grant.template, { authority: this.grant.authority, state: next }),
      this.prefix,
    );

    /**
     * The second transaction, built before the first is broadcast.
     *
     * A version-0 transaction id excludes signature scripts, and so does a
     * version-1 one — which is what makes this possible at all: the covenant
     * spend's id is known the moment it is signed, so the relayed payment can
     * name an outpoint that does not exist yet. Both go out back to back and
     * there is ONE wait for acceptance rather than two.
     *
     * `safe.id` is the funding transaction; `PAYEE_OUTPUT_INDEX` is the output
     * it pays the relay key at. Those two are the outpoint.
     */
    let relayed: RelayPayment | undefined;
    if (input.relay) {
      relayed = await buildRelayPayment(
        {
          source: {
            outpoint: { transactionId: fromHex(safe.id), index: PAYEE_OUTPUT_INDEX },
            value: spendAmount,
            publicKey: key,
          },
          accepted: input.accepted,
        },
        this.signer,
      );
    }

    /**
     * The grant proof, built only for a relayed payment.
     *
     * Only then is it needed and only then is it true: a direct spend IS the
     * covenant transaction and a vendor who can read it needs nothing extra,
     * while a relayed one arrives as an ordinary payment with the grant
     * nowhere in sight. `tx` is the covenant spend and `entry` is the grant
     * UTXO it consumed, which `toWire` needs because each input's digest
     * commits to its own entry.
     *
     * Wire form rather than the safe JSON that travels in the payload: safe
     * JSON has no field for an output's covenant binding and is lossy for
     * exactly these transactions. What a provider reads is the SIGNATURE
     * SCRIPT, which carries the redeem script in the clear, so an encoding
     * that drops anything is the wrong one on principle even where it would
     * have survived.
     */
    const grantProof = relayed
      ? encodeGrantProof(toWire(tx, entry), PAYEE_OUTPUT_INDEX)
      : undefined;

    const payment = await buildPayment(
      {
        accepted: input.accepted,
        request: input.request,
        /* The RELAYED transaction travels, not the covenant spend. The
           covenant spend is what the grant did; this is what the vendor is
           asked to verify, and their scheme cannot read the other one. */
        transaction: relayed ? relayed.safeJson : JSON.stringify(safe),
        transactionId: relayed ? toHex(relayed.signed.id) : safe.id,
        paymentOutputIndex: relayed ? relayed.paymentOutputIndex : PAYEE_OUTPUT_INDEX,
        inputIndex: relayed ? relayed.inputIndex : GRANT_INPUT_INDEX,
        // Which address to declare as the payer.
        //
        // `fromAddress` is where the coin is being spent FROM, which is what a
        // wallet would say. But a covenant spend does not leave change at the
        // address it spent from — it leaves a successor at a new one. If their
        // verifier checks that non-payment outputs return to `payerAddress`,
        // the address that actually receives is the successor, and declaring
        // the spent-from address fails a check a wallet would pass.
        //
        // Untested when this was written. It is one flag and one payment, and
        // the alternative is guessing at a verifier we cannot read.
        /* A relayed payment has an ordinary answer to this: the coin really
           is spent from a key-controlled address, and that address really does
           belong to the payer. The whole `payerIsSuccessor` question was an
           artefact of a covenant spend having no such address. */
        ...(input.omitPayerAddress
          ? {}
          : {
              payerAddress: relayed
                ? pubkeyToAddress(key, this.prefix)
                : input.payerIsSuccessor
                  ? successorAddress
                  : fromAddress,
            }),
        nowMs: input.nowMs,
      },
      this.signer,
    );

    const pending: PendingPayment = {
      header: paymentSignatureHeader(payment),
      payment,
      /* The id the VENDOR will look for. On a relayed payment that is the
         second transaction; the covenant spend is recorded beside it, because
         a recovery that looks at the wrong one finds nothing and concludes the
         money never moved. */
      txid: relayed ? toHex(relayed.signed.id) : safe.id,
      payer: fromAddress,
      amountSompi,
      successor: next,
      successorAddress,
      expiresAt: payment.payload.authorization.expiresAt,
      ...(grantProof ? { grantProof } : {}),
      ...(relayed
        ? {
            relay: {
              fundingTxid: safe.id,
              feeSompi: relayed.signed.fee,
              relayAddress: pubkeyToAddress(key, this.prefix),
            },
          }
        : {}),
    };
    this.held = { status: "pending", payment: pending };
    this.heldTx = tx;
    this.heldRelay = relayed ?? null;
    return pending;
  }

  /**
   * Put the pending spend on chain, and wait until the network accepts it.
   *
   * ## Why the payer broadcasts after all
   *
   * The first reading of kaspa-x402 v2 here was that the VENDOR broadcasts:
   * the payload carries the whole signed transaction, and their server
   * interface has `sendTransaction`. Both true, and the conclusion wrong.
   * Their verifier requires the payment to have reached the finality the quote
   * names — `accepted`, in the quote their own demo serves — and nothing can
   * require accepted finality of a transaction it is about to submit itself.
   * Their `sendTransaction` is a REbroadcast for a payment already verified,
   * which their own error text says out loud: "pending trusted chain
   * reconciliation and will not be rebroadcast".
   *
   * So the transaction travels for VERIFICATION, not for submission.
   *
   * Waiting is not a courtesy. Presenting before acceptance is what produced
   * `invalid_transaction_state` from their facilitator: a payment that exists
   * only in our process is, from their side, a payment that does not exist.
   *
   * Acceptance is observed at the SUCCESSOR address. A coin there is the
   * covenant's own proof that the spend was accepted — the successor cannot
   * exist unless the transaction that creates it did.
   */
  async broadcastPendingV2(
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<{ txid: string; accepted: boolean }> {
    if (this.held.status !== "pending" || !this.heldTx) {
      throw new X402Error(
        `there is no payment outstanding to broadcast (status: ${this.held.status}).`,
      );
    }
    const pending = this.held.payment;
    const fundingTxid = await this.node.submitTransaction(this.heldTx);

    /**
     * The relayed payment goes out IMMEDIATELY, spending a coin the network
     * has not accepted yet.
     *
     * Kaspa allows that — a transaction may spend an unconfirmed output — and
     * it is the difference between one wait and two. It is also the only
     * ordering that is safe: the funding coin sits at a key the agent holds,
     * so any gap between the two is a window in which the invoice is funded
     * and unpaid, and a crash in that window leaves money at an address no
     * record points at.
     *
     * `allowOrphan` because the parent may not have propagated yet. Without
     * it a node that has not seen the funding transaction rejects this one as
     * an orphan, which is a race rather than a refusal.
     */
    let txid = fundingTxid;
    if (this.heldRelay) {
      try {
        txid = await this.node.submitOrdinaryPayment(this.heldRelay.signed, true);
      } catch (e) {
        /* The funding transaction is already out. Saying so is the whole point
           of this branch: the grant has moved, the money is at the relay
           address, and a caller told only "submit failed" would reasonably
           conclude nothing happened and pay again. */
        throw new X402Error(
          `the covenant spend was broadcast (${fundingTxid}) and the relayed payment was ` +
            `refused: ${(e as Error).message}\n\n` +
            `${pending.amountSompi + (pending.relay?.feeSompi ?? 0n)} sompi is now at ` +
            `${pending.relay?.relayAddress}, which the agent's key controls. The grant has ` +
            `moved to ${pending.successorAddress}. Nothing is lost and nothing is paid.`,
        );
      }
    }

    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    const pollMs = options.pollMs ?? 1_000;

    /**
     * Wait for the transaction the VENDOR will look at, which is not always
     * the one the grant made.
     *
     * A direct spend is observed at the successor address: a coin there is the
     * covenant's own proof that the spend was accepted, because the successor
     * cannot exist unless the transaction creating it did.
     *
     * A relayed payment is a SECOND transaction, and the successor proves
     * nothing about it. It can only be accepted after the funding spend — it
     * spends its output — but "after" is not "at the same time", and their
     * verifier requires the payment itself to have reached accepted finality.
     * So this watched the wrong transaction and then reported `accepted: true`
     * about it, which was a false claim in our own output before it was a
     * failure at their server.
     *
     * The relayed one is observed at the PAYEE's address, matched by
     * transaction id — that address may hold coins from anywhere, so the id is
     * what makes the observation mean something.
     */
    const payeeAddress = this.heldRelay ? pending.payment.accepted.payTo : undefined;
    while (Date.now() < deadline) {
      if (payeeAddress) {
        const at = await this.node.getUtxosByAddresses([payeeAddress]);
        if (at.some((u) => toHex(u.outpoint.transactionId) === txid)) {
          return { txid, accepted: true };
        }
      } else {
        const at = await this.node.getUtxosByAddresses([pending.successorAddress]);
        if (at.length > 0) return { txid, accepted: true };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    // Submitted and not seen. Reported rather than thrown: the transaction is
    // on the network either way, and the caller may still want to present it.
    return { txid, accepted: false };
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
    this.heldTx = null;
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
