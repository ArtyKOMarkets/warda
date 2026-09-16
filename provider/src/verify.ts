/**
 * What a provider may conclude about the agent that just paid them.
 *
 * ## The claim, and the claim this must never make
 *
 * A grant bounds what an agent can spend: a total budget, a cap per payment, an
 * allowance per epoch, a window it is alive for, and a list of who it may pay.
 * The network enforces all of it, which is the whole of Warda's argument.
 *
 * A provider paid through x402 sees none of that. Their scheme cannot take a
 * covenant spend, so the grant funds a single-use relay key and that key pays;
 * what arrives is an ordinary transaction. `WARDA-GRANT` carries the covenant
 * spend that funded it, and this reads the grant out of that.
 *
 * **What it proves: this counterparty is bounded.** The payment could not have
 * been larger than the cap. It cannot ever spend more than the budget. Its
 * authority expires.
 *
 * **What it does not prove: that the payer was allowed to pay YOU.** The
 * allowlist stops binding at the relay hop — the covenant constrained the
 * funding spend, not where the relay key sent the money afterwards. So
 * `authorisedToPayMe` is the string `"unknown"`, present rather than omitted,
 * because an absent field reads as "not applicable" and a present one that says
 * it does not know gets read and asked about.
 *
 * ## Why this needs no node
 *
 * The provider's own x402 verifier already establishes that the PAYMENT is on
 * chain. A payment on chain means its input was a real coin; that coin is the
 * output this proof names; so the funding transaction was accepted by
 * consensus, and consensus checked the covenant. The terms read below are the
 * terms the network enforced.
 *
 * That chain of reasoning is the reason `verify()` takes no node and asks for
 * nothing. It depends on the provider having done what they already do, and it
 * is stated in `assumes` on the verdict so that nobody inherits it silently.
 */
import {
  fromWire,
  grantFromSignatureScript,
  toHex,
  transactionId,
  type CovenantTemplate,
} from "@warda_protocol/kaspa";
import { decodeGrantProof, GRANT_PROOF_HEADER, type GrantProof } from "@warda_protocol/x402";

export interface VerifyOptions {
  /**
   * The outpoint the payment you received spends. **Required, and it is the
   * check that makes everything else mean anything.**
   *
   * Without it the proof is worthless. A payer could attach any covenant spend
   * in the DAG — someone else's, with a fifty-KAS budget — and claim its terms
   * as their own, and every field below would be true about a grant that has
   * nothing to do with the money that arrived. Binding the proof to the coin
   * this payment actually spent is what makes it a proof rather than an
   * assertion.
   *
   * Your x402 verifier has already parsed the payment transaction to check it;
   * this is `inputs[0].previousOutpoint` from the same object.
   */
  paymentInput: { transactionId: string; index: number };
}

export type Verdict =
  | {
      warda: false;
      /** Not an error. Most payers are not Warda payers. */
      reason: "no proof";
    }
  | {
      warda: true;
      bounded: false;
      /** Why the proof it sent could not be believed. */
      reason: string;
    }
  | {
      warda: true;
      bounded: true;
      /** Sompi. What this payment could not have exceeded. */
      maxPerPayment: bigint;
      /** Sompi. What this agent can ever spend, and what is left of it. */
      budgetTotal: bigint;
      budgetRemaining: bigint;
      /** Sompi per epoch, and how long an epoch is in DAA score. */
      epochLimit: bigint;
      epochLength: bigint;
      /** DAA scores. Before the first and after the second, it cannot spend. */
      notBefore: bigint;
      expiresAt: bigint;
      /** The agent this grant names. Stable across payments; an identity. */
      agentKey: string;
      /** The covenant spend that funded this payment. Look it up if you like. */
      fundingTxid: string;
      /**
       * Always `"unknown"`. The relay hop means the chain did not constrain
       * who was ultimately paid. Present on purpose — see the note above.
       */
      authorisedToPayMe: "unknown";
      /**
       * What this verdict rests on, stated rather than assumed: that YOU have
       * established the payment is on chain. Your x402 verifier does this. If
       * it did not, nothing here is proven — a transaction nobody accepted can
       * say anything at all.
       */
      assumes: string;
    };

/** Anything with a header lookup: a Request, or `{ headers }` from a framework. */
export interface HeaderBearing {
  headers: { get(name: string): string | null } | Record<string, string | string[] | undefined>;
}

function headerOf(req: HeaderBearing, name: string): string | null {
  const h = req.headers as { get?: (n: string) => string | null };
  if (typeof h.get === "function") return h.get(name) ?? h.get(name.toLowerCase()) ?? null;
  const bag = req.headers as Record<string, string | string[] | undefined>;
  const raw = bag[name] ?? bag[name.toLowerCase()];
  /* An array is a repeated header. Treated as absent rather than joined: a
     payer sending two different proofs is not making one claim. */
  return typeof raw === "string" ? raw : null;
}

export function verifyGrantProof(
  req: HeaderBearing,
  template: CovenantTemplate,
  options: VerifyOptions,
): Verdict {
  let proof: GrantProof | null;
  try {
    proof = decodeGrantProof(headerOf(req, GRANT_PROOF_HEADER));
  } catch (e) {
    return { warda: true, bounded: false, reason: (e as Error).message };
  }
  if (!proof) return { warda: false, reason: "no proof" };
  return verifyProof(proof, template, options);
}

/** The same, for a caller that already has the decoded envelope. */
export function verifyProof(
  proof: GrantProof,
  template: CovenantTemplate,
  options: VerifyOptions,
): Verdict {
  let funding;
  try {
    funding = fromWire(proof.funding);
  } catch (e) {
    return { warda: true, bounded: false, reason: `the funding transaction will not parse: ${(e as Error).message}` };
  }

  const out = funding.outputs[proof.relayOutputIndex];
  if (!out) {
    return {
      warda: true,
      bounded: false,
      reason:
        `the proof names output ${proof.relayOutputIndex} and the funding transaction has ` +
        `${funding.outputs.length}. It cannot be describing this payment.`,
    };
  }

  /**
   * The binding, and there is no verdict without it.
   *
   * The coin this payment spent must be the output this proof names. Anyone
   * can attach a covenant spend they found in the DAG and claim its terms; the
   * only thing that makes these terms THIS payer's is that the money in front
   * of you came out of that transaction, at that index.
   */
  const fundingTxid = toHex(transactionId(funding));
  if (
    fundingTxid !== options.paymentInput.transactionId.toLowerCase() ||
    proof.relayOutputIndex !== options.paymentInput.index
  ) {
    return {
      warda: true,
      bounded: false,
      reason:
        `this proof describes ${fundingTxid}:${proof.relayOutputIndex}, and the payment ` +
        `spends ${options.paymentInput.transactionId}:${options.paymentInput.index}. The ` +
        `grant it names did not fund the coin that paid you, so its terms say nothing ` +
        `about this payment.`,
    };
  }

  /**
   * The grant, read out of the signature script.
   *
   * Kaspa's P2SH requires the redeem script to be pushed in the clear by every
   * transaction that spends the address — the network cannot check the hash
   * otherwise. So a spending transaction publishes the grant it spent whether
   * the spender meant to or not.
   *
   * A script that is not this covenant throws here, which is the right answer:
   * the terms below are only meaningful if the thing enforcing them was Warda.
   */
  let grant;
  try {
    grant = grantFromSignatureScript(funding.inputs[0]!.signatureScript, template);
  } catch (e) {
    return {
      warda: true,
      bounded: false,
      reason:
        `no Warda covenant in the funding transaction's signature script: ${(e as Error).message}`,
    };
  }

  const s = grant.state;
  return {
    warda: true,
    bounded: true,
    maxPerPayment: s.maxPerSpend,
    budgetTotal: s.budgetTotal,
    budgetRemaining: s.budgetTotal - s.spentTotal - s.reserved,
    epochLimit: s.epochLimit,
    epochLength: s.epochLength,
    notBefore: s.notBefore,
    expiresAt: s.expiresAt,
    agentKey: s.agentKey,
    fundingTxid,
    authorisedToPayMe: "unknown",
    assumes:
      "that you have established this payment is on chain. Your x402 verifier does that. " +
      "A payment on chain spent a real coin; that coin is the output this proof names; so " +
      "consensus accepted the funding transaction and checked the covenant. Without that " +
      "step, a transaction nobody accepted can claim anything.",
  };
}
