/**
 * Paying a kaspa-x402 v2 vendor from a Warda grant.
 *
 * ## The one difference that changes everything
 *
 * In v1 the payer broadcasts and hands the vendor a txid. In v2 the payer
 * hands the vendor the whole signed transaction and the VENDOR broadcasts it:
 * their server interface has `sendTransaction`, and the payload carries the
 * transaction rather than a reference to one.
 *
 * For an agent that is a straight improvement — paying no longer needs a node
 * of its own, only a signer. For the grant's bookkeeping it is a genuine
 * problem, because a grant's address IS its state. After a spend the old
 * address is empty and the payer must move with it. In v1 the payer learns the
 * spend happened by doing it. Here it does not learn at all unless somebody
 * says so.
 *
 * ## Why this refuses to guess
 *
 * Three positions are defensible and two of them are wrong.
 *
 *   advance immediately    If the vendor never broadcasts, the payer now
 *                          points at a successor that does not exist and every
 *                          later payment fails at an empty address.
 *
 *   advance never          Then a second payment builds a CONFLICTING spend of
 *                          the same coin. Two vendors each hold a signed
 *                          transaction, both believe they will be paid, and at
 *                          most one can be. That is issuing a bad cheque, and
 *                          it is worse than either error above because the
 *                          damage lands on someone else.
 *
 *   hold the grant         Which is what this does. A built payment makes the
 *                          payer OUTSTANDING: it will not build another until
 *                          the caller says what became of the first.
 *
 * Holding is not a limitation invented here. It is the true state of affairs:
 * a signed transaction someone else is holding either lands or does not, you
 * cannot tell which from your side, and until you know, the coin it spends is
 * not yours to spend again.
 *
 * ## And abandoning does not roll back
 *
 * `abandoned()` does not quietly restore the old state, because the payer
 * cannot know the vendor did not broadcast — only that it did not say so. The
 * grant may have moved. So abandoning marks the payer UNUSABLE and names both
 * candidate addresses, which is what `tools/follow-grant.ts` resolves against
 * the chain in one query per candidate.
 *
 * A wrong answer here is a payer that silently spends from a coin that is
 * already gone, which surfaces much later as an inexplicable chain error. An
 * honest stop is worth more than an optimistic guess.
 */
import {
  buildUnsignedSpend,
  attachSignature,
  claimedDaaFor,
  scriptHashFor,
  scriptHashToAddress,
  successorState,
  toHex,
  toSafeJson,
  type GrantState,
  type SpendPlan,
} from "@warda_protocol/kaspa";
import type { ExactPaymentRequirements } from "@kaspa-x402/core";

import { X402Error } from "./protocol.ts";
import type { ExactPayment, PaidRequest } from "./v2.ts";

/** What a v2 payment looks like before anyone has broadcast it. */
export interface PendingPayment {
  /** Ready for the `PAYMENT-SIGNATURE` request header. */
  header: string;
  payment: ExactPayment;
  /** The id the transaction will have if it lands. */
  txid: string;
  /** The grant's address now — where the coin still is. */
  payer: string;
  amountSompi: bigint;
  /** The state the grant takes IF this lands, and where that puts it. */
  successor: GrantState;
  successorAddress: string;
  /** After this the vendor's facilitator will refuse the authorization. */
  expiresAt: string;
}

export type Outstanding =
  | { status: "none" }
  | { status: "pending"; payment: PendingPayment }
  /**
   * The payer is out of the loop and must be resynced before it is used again.
   * `candidates` are the two addresses the grant can be at: the one it was at,
   * and the one the abandoned payment would have moved it to.
   */
  | { status: "unresolved"; candidates: [string, string]; why: string };

export interface BuildV2Input {
  accepted: ExactPaymentRequirements;
  /** The request being paid for. Its method, url and body are hashed into the
   *  authorization, so this must be the request that will actually be sent. */
  request: PaidRequest;
  /** Now, in ms. Injectable so expiry arithmetic is testable. */
  nowMs?: number;
  /** Leave `payerAddress` out of the payload. See WardaFetchV2Options. */
  omitPayerAddress?: boolean;
}

/**
 * The amount, as a bigint, or a refusal naming what arrived.
 *
 * v2 quotes an amount as a decimal STRING and v1 called the same field
 * `amountSompi`. A client that reached for the wrong one would read
 * `undefined`, and `BigInt(undefined)` throws something unrelated to the
 * actual problem.
 */
export function amountOf(accepted: ExactPaymentRequirements): bigint {
  const raw = accepted.amount;
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new X402Error(
      `this v2 quote's amount is ${JSON.stringify(raw)}, and v2 states amounts as a decimal ` +
        `string of sompi. (v1 called this field amountSompi — a quote carrying that instead ` +
        `is a v1 quote, and belongs on the v1 path.)`,
    );
  }
  const amount = BigInt(raw);
  if (amount <= 0n) throw new X402Error(`a quote's amount must be positive, got ${amount}`);
  return amount;
}

/**
 * A covenant spend puts the payee at output 1.
 *
 * Output 0 is the successor grant, carrying the covenant binding and the
 * remaining coin; output 1 is `P2PK(recipient)` for exactly the invoiced
 * amount. The order is the covenant's, not a convention of this file, so it is
 * named here once rather than counted at each use.
 */
export const PAYEE_OUTPUT_INDEX = 1;

/** One input, spending the grant, authorized by the agent key. */
export const GRANT_INPUT_INDEX = 0;

/**
 * The vendor's own statement of the script it expects to be paid, checked
 * against the script a covenant spend actually builds.
 *
 * Worth checking before signing rather than after broadcasting: the
 * authorization digest commits to this value, so a mismatch produces a payment
 * their facilitator rejects — after the transaction is in their hands and
 * possibly on the chain. Every cause is something a person can act on, and
 * none of them is visible in the failure their server would report.
 */
export function assertPayeeScriptMatches(
  accepted: ExactPaymentRequirements,
  builtScriptPublicKey: string,
): void {
  const quoted = (accepted.extra as { payToScriptPublicKey?: string }).payToScriptPublicKey;
  if (!quoted) return; // absent is handled where the digest is built
  if (quoted.toLowerCase() === builtScriptPublicKey.toLowerCase()) return;

  throw new X402Error(
    `this vendor expects to be paid to the script ${quoted}, and a covenant spend to ` +
      `${accepted.payTo} builds ${builtScriptPublicKey}. The authorization commits to the ` +
      `vendor's value, so signing this would produce a payment they refuse. Most likely the ` +
      `quote's payTo and its payToScriptPublicKey describe different things, or the vendor ` +
      `wants a script type a grant cannot pay — the covenant builds P2PK for the payee and ` +
      `nothing else.`,
  );
}
