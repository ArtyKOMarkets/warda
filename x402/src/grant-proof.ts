/**
 * The grant proof a payer attaches, and a provider reads.
 *
 * ## Why this exists at all
 *
 * A provider never sees a covenant. x402 `exact` requires the payer's input to
 * be a bare key-controlled coin with no covenant on any output, so a grant
 * spend can never BE the payment — the grant funds a single-use relay key and
 * that key pays. What arrives at a vendor is an ordinary version-0 transaction,
 * indistinguishable from any other.
 *
 * Everything that makes Warda worth anything to the person being paid is
 * therefore invisible to them. This is the envelope that makes it visible.
 *
 * ## Why the PAYER has to send it, rather than the provider fetching it
 *
 * Not a preference. Kaspa's node RPC answers "what is unspent at this address"
 * and never "what spent this outpoint", and a stock node carries no transaction
 * index — the constraint `follow-grant.ts` exists because of, and the reason
 * `recover-grant.ts` asks for a transaction rather than looking one up. A
 * provider holding a transaction id cannot turn it into a transaction.
 *
 * So the proof travels with the payment. The forced design is the better one:
 * the provider needs no node, no indexer, and nothing of ours.
 *
 * ## Why it is a header and not an x402 extension
 *
 * The payload's `extensions` object is validated by the vendor's own schema,
 * inside `paymentSignatureHeader`. Putting this there would risk a live payment
 * path that currently works against a third party — and agent #005 makes one
 * every morning. A separate header is additive: a vendor that has never heard
 * of Warda ignores it, and no schema of theirs has an opinion about it.
 *
 * ## What it does NOT prove
 *
 * That the payer was allowed to pay THIS recipient. The allowlist stops binding
 * at the relay hop; the covenant constrained the funding spend and not where
 * the relay key sent the money afterwards. A provider learns that the
 * counterparty is BOUNDED, not that it was authorised to pay them. The
 * verifier's verdict says so in a field rather than by omission.
 */
import type { WireTransaction } from "@warda_protocol/kaspa";

export const GRANT_PROOF_HEADER = "WARDA-GRANT";

/** The version of this envelope, so a reader can refuse one it does not know. */
export const GRANT_PROOF_VERSION = 1;

export interface GrantProof {
  warda: number;
  /**
   * The covenant spend that funded the relay key — the transaction whose
   * signature script carries the grant's redeem script in the clear.
   *
   * Wire form, not `kaspa-sdk-safe-json`: that encoding has no field for an
   * output's covenant binding and is lossy for exactly these transactions,
   * which is recorded in x402/INTEROP-KASPA-X402.md and pinned by a test. The
   * wire form is this repository's own and carries the signature script, which
   * is the whole point of sending it.
   */
  funding: WireTransaction;
  /** Which output of the funding transaction paid the relay key. */
  relayOutputIndex: number;
}

/** base64 of the envelope, for the `WARDA-GRANT` request header. */
export function encodeGrantProof(funding: WireTransaction, relayOutputIndex: number): string {
  const doc: GrantProof = { warda: GRANT_PROOF_VERSION, funding, relayOutputIndex };
  return Buffer.from(JSON.stringify(doc), "utf8").toString("base64");
}

/**
 * Read one, or say why not.
 *
 * Returns null for absent rather than throwing: a request with no proof is the
 * ordinary case — most payers are not Warda payers — and a provider must not
 * have to try/catch around normal traffic. A proof that is PRESENT and
 * unreadable throws, because that is a claim that failed rather than a claim
 * nobody made.
 */
export function decodeGrantProof(header: string | null | undefined): GrantProof | null {
  if (!header) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    throw new Error(
      `the ${GRANT_PROOF_HEADER} header is present and is not base64 of JSON. A payer that ` +
        `sends one is making a claim; this one cannot be read.`,
    );
  }
  const d = doc as Partial<GrantProof>;
  if (d.warda !== GRANT_PROOF_VERSION) {
    throw new Error(
      `this ${GRANT_PROOF_HEADER} is version ${String(d.warda)} and this reader knows ` +
        `version ${GRANT_PROOF_VERSION}. Refusing rather than guessing at a shape that may ` +
        `have moved.`,
    );
  }
  if (!d.funding || typeof d.relayOutputIndex !== "number") {
    throw new Error(
      `this ${GRANT_PROOF_HEADER} is missing the funding transaction or the output index. ` +
        `Both are needed: the transaction carries the grant's terms, and the index says ` +
        `which of its outputs became the coin that paid you.`,
    );
  }
  return d as GrantProof;
}
