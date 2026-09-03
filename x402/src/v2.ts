/**
 * The kaspa-x402 v2 wire protocol, as an alternative dialect to `protocol.ts`.
 *
 * ## Why there are now two
 *
 * `protocol.ts` implements the v1 spec — `X-PAYMENT`, `amountSompi`, `nonce` —
 * which is what `docs/HTTP-402-PROTOCOL.md` described when this adapter was
 * written. The reference implementation has since moved to v2, and v2 is not a
 * superset: the header names changed, `amountSompi` became `amount`, the
 * per-invoice `nonce` was replaced by a request binding, and the payment is now
 * an authorization signed over a digest rather than a bare txid.
 *
 * A server speaking one does not understand the other. So both live here, and
 * `dialect()` decides from what the server actually said rather than from
 * configuration, because the answer is in the response and asking the operator
 * to know it is how a client ends up misconfigured against half the network.
 *
 * ## Why this file imports their package instead of reimplementing it
 *
 * Every value below is a hash over a canonical JSON encoding. Re-deriving that
 * encoding from the specification would produce something that looks right,
 * passes our tests, and is rejected by their facilitator over a key ordering
 * nobody thought to check — the exact failure this repository keeps meeting at
 * every boundary it does not actually cross in a test.
 *
 * `@kaspa-x402/core` is MIT, pure, and imports only `node:crypto` at runtime:
 * no wallet, no RPC, no filesystem. Depending on it means the canonical
 * encoder, the schema validators and the digest preimages are THEIRS, and the
 * only thing this file supplies is the part that is actually ours — a covenant
 * spend from a Warda grant, and the agent signature over their digest.
 *
 * The two hash rules below are the exception. They are not exported by their
 * package, so they are reproduced here from the reference server, with the
 * source of each named, and `test/v2.test.ts` checks them against values their
 * own code produces.
 */
import {
  EXACT_REQUEST_AUTHORIZATION_VERSION,
  X402_VERSION,
  exactAuthorizationExpiresAt,
  exactRequestAuthorizationDigest,
  encodePaymentSignatureHeader,
  sha256Hex,
  stableStringify,
  validatePaymentRequired,
  type ExactPaymentRequirements,
  type ExactRequestAuthorization,
  type NetworkId,
  type ExactTransactionPayload,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
} from "@kaspa-x402/core";

import { X402Error } from "./protocol.ts";

/** v2 renamed all three. A v1 server sends none of them. */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/**
 * Where a v2 server puts its quote.
 *
 * In the reference server it is the `PAYMENT-REQUIRED` header, base64 of their
 * canonical JSON, and the BODY is a stub — `{"ok":false,"error":"payment_required"}`
 * with `content-type: text/plain`. A client that reads the body finds valid
 * JSON with no `x402Version` in it, concludes the server speaks v1, and says so
 * to a server that is unambiguously v2.
 *
 * That is not a hypothetical: it is what this client did the first time it was
 * pointed at demo.kaspa-x402.org, and nothing in their specification made it
 * obvious, because a header is where the quote has always been and the body is
 * a courtesy.
 *
 * So the header wins and the body is the fallback, which also covers a server
 * that sends the quote both ways.
 */
export function readPaymentRequired(header: string | null, body: unknown): unknown {
  if (!header) return body;
  let decoded: string;
  try {
    decoded = Buffer.from(header, "base64").toString("utf8");
  } catch {
    throw new X402Error(`the ${PAYMENT_REQUIRED_HEADER} header is not base64`, 402);
  }
  try {
    return JSON.parse(decoded);
  } catch {
    throw new X402Error(
      `the ${PAYMENT_REQUIRED_HEADER} header decoded to something that is not JSON: ` +
        `${decoded.slice(0, 120)}`,
      402,
    );
  }
}

/**
 * Which dialect a 402 body is written in.
 *
 * v2 states its version in the body; v1 never carried one. So an absent
 * `x402Version` is a positive signal for v1 rather than a missing field, and a
 * version this client does not implement is neither — it is a server we cannot
 * pay, and saying which version it asked for is more use than "unsupported".
 */
export function dialect(body: unknown): "v1" | "v2" | { unsupported: number } {
  if (typeof body !== "object" || body === null) return "v1";
  const v = (body as Record<string, unknown>).x402Version;
  if (v === undefined) return "v1";
  if (v === X402_VERSION) return "v2";
  return { unsupported: Number(v) };
}

/**
 * Read a v2 402 body and pick the one requirement a Warda grant can satisfy.
 *
 * Their validator runs first, so a malformed body fails with their error and
 * their vocabulary rather than ours. Only the SELECTION is ours, and it is
 * narrow on purpose: of the two schemes and two profiles they define, exactly
 * one is a single on-chain payment of an exact amount to a named address,
 * which is what a covenant spend is.
 */
export function selectRequirement(body: unknown): ExactPaymentRequirements {
  const result = validatePaymentRequired(body);
  if (!result.ok) {
    throw new X402Error(`this 402 body is not valid kaspa-x402 v2: ${result.error.message}`, 402);
  }
  const required: PaymentRequired = result.value;

  const usable = required.accepts.find(
    (a: PaymentRequirements): a is ExactPaymentRequirements =>
      a.scheme === "exact" && (a.extra as { profile?: string }).profile === "standard-native",
  );
  if (usable) return usable;

  /**
   * Both refusals below name what the server offered AND what satisfying it
   * would take, because neither is a bug — they are two coherent designs this
   * client has not implemented, and the difference matters to whoever reads
   * the error.
   */
  const offered = required.accepts.map((a) => {
    const profile = (a.extra as { profile?: string } | undefined)?.profile;
    return profile ? `${a.scheme}/${profile}` : a.scheme;
  });

  if (offered.some((o) => o.startsWith("batch-settlement"))) {
    throw new X402Error(
      `this server settles in batches over a payment channel (offered: ${offered.join(", ")}). ` +
        `That is an escrow covenant naming one server key, funded once and then drawn down ` +
        `by signed vouchers — a different shape from a grant, which pays many payees under a ` +
        `budget and holds no channel. Paying it needs a channel opened from the grant, not a ` +
        `spend from it.`,
      402,
    );
  }
  throw new X402Error(
    `this server offers ${offered.join(", ") || "nothing"}, and this client pays ` +
      `exact/standard-native — one on-chain transaction of an exact amount to a named address. ` +
      `The "additive" profile reserves against a KIP-10 threshold template instead, which a ` +
      `covenant spend does not produce.`,
    402,
  );
}

// ---- the two hashes their package does not export -------------------------

/**
 * `sha256Hex(stableStringify(accepted))`, over the requirement EXACTLY as the
 * server sent it.
 *
 * Reproduced from `paymentRequirementsHash: sha256Hex(stableStringify(accepted))`
 * in @kaspa-x402/server. "Exactly as sent" is the whole subtlety: this must
 * hash the object that came off the wire, not a copy this client rebuilt from
 * the fields it happens to care about, because any key it dropped or added
 * changes the hash and the server has no way to tell us which one it was.
 */
export function paymentRequirementsHash(accepted: ExactPaymentRequirements): string {
  return sha256Hex(stableStringify(accepted));
}

export interface PaidRequest {
  method?: string;
  url: string;
  /** The request body, or null for a GET. Hashed as sent. */
  body?: unknown;
}

/**
 * The request binding: which HTTP request this payment is for.
 *
 * Reproduced from `fingerprintRequest` in @kaspa-x402/server. v1 bound a
 * payment to an invoice with a server-issued nonce; v2 binds it to the request
 * itself, so the same payment cannot be replayed against a different URL or a
 * different body even by the server that issued the quote.
 *
 * Their facilitator refuses an exact request that does not carry one of these
 * computed independently — it will not derive it for us — which is why this
 * rule has to live on the client side at all.
 */
export function requestHash(request: PaidRequest, accepted: ExactPaymentRequirements): string {
  return sha256Hex(
    stableStringify({
      method: request.method ?? "GET",
      url: request.url,
      body: (request.body ?? null) as never,
      paymentRequirementsHash: paymentRequirementsHash(accepted),
    }),
  );
}

// ---- the payment ---------------------------------------------------------

export interface AuthorizeInput {
  accepted: ExactPaymentRequirements;
  request: PaidRequest;
  /** The signed covenant spend's id. */
  transactionId: string;
  /** Which output of it pays the vendor. */
  paymentOutputIndex: number;
  /** Which input spends the grant. The authorization is signed by that input's key. */
  inputIndex: number;
  /**
   * The vendor's script public key, hex.
   *
   * Defaults to the one on the requirement, which is where it comes from: the
   * digest binds it, so a value derived independently here could only ever
   * disagree with the server and produce a payment it refuses. Their schema
   * requires the field even though their TypeScript type marks it optional, so
   * a valid v2 quote always carries one; the override exists for a server that
   * sends a valid quote some future version stops requiring it in.
   */
  payToScriptPublicKey?: string;
  /** Present only when the server issued a challenge. */
  challengeId?: string;
  /** Now, in ms. Injectable so the expiry arithmetic is testable. */
  nowMs?: number;
}

/**
 * The digest the agent key signs, and the authorization built around it.
 *
 * The signing function is passed in rather than a key: this module never holds
 * key material, and the agent key that signs this is the same one that signed
 * the covenant spend the digest commits to. Binding both to one key is what
 * makes the authorization mean "the party that made this payment intends it for
 * this request" rather than "someone observed a payment".
 */
export type AuthorizationSigner = (digest: Uint8Array) => Uint8Array | Promise<Uint8Array>;

/**
 * A Kaspa TRANSACTION signature is 64 bytes of Schnorr plus a trailing
 * sighash-type byte; this digest is not a sighash, and their schema wants the
 * 64 alone.
 *
 * Trimming is exact rather than lenient: `signDigest` appends that byte to a
 * signature the first 64 bytes of which are already a complete Schnorr
 * signature over the digest, so bytes 0..64 are not a truncation of anything —
 * they are the signature. Anything that is neither 64 nor 65 bytes is a signer
 * doing something else entirely and is refused rather than sliced to fit.
 */
function authorizationSignature(signature: Uint8Array): Uint8Array {
  if (signature.length === 64) return signature;
  if (signature.length === 65) return signature.subarray(0, 64);
  throw new X402Error(
    `the signer returned ${signature.length} bytes. An authorization carries a 64-byte ` +
      `Schnorr signature; a signer that also appends Kaspa's sighash-type byte returns 65 ` +
      `and is trimmed. Neither describes this.`,
  );
}

export async function authorize(
  input: AuthorizeInput,
  signDigest: AuthorizationSigner,
): Promise<ExactRequestAuthorization> {
  const { accepted } = input;
  const expiresAt = exactAuthorizationExpiresAt(
    accepted.maxTimeoutSeconds,
    (accepted.extra as { challengeExpiresAt?: string }).challengeExpiresAt,
    input.nowMs ?? Date.now(),
  );

  const payToScriptPublicKey =
    input.payToScriptPublicKey ??
    (accepted.extra as { payToScriptPublicKey?: string }).payToScriptPublicKey;
  if (!payToScriptPublicKey) {
    throw new X402Error(
      `this quote carries no payToScriptPublicKey, and the authorization digest commits to ` +
        `one. Deriving it from the address here would produce a digest the server disagrees ` +
        `with, so this refuses instead.`,
      402,
    );
  }

  const digest = exactRequestAuthorizationDigest({
    network: accepted.network as NetworkId,
    profile: "standard-native",
    transactionId: input.transactionId,
    paymentOutputIndex: input.paymentOutputIndex,
    amount: accepted.amount,
    payTo: accepted.payTo,
    payToScriptPublicKey,
    paymentRequirementsHash: paymentRequirementsHash(accepted),
    requestHash: requestHash(input.request, accepted),
    challengeId: input.challengeId,
    inputIndex: input.inputIndex,
    expiresAt,
  });

  const signature = authorizationSignature(await signDigest(hexToBytes32(digest)));
  return {
    version: EXACT_REQUEST_AUTHORIZATION_VERSION,
    inputIndex: input.inputIndex,
    expiresAt,
    digest,
    signature: toHex(signature),
  };
}

export interface PaymentInput extends AuthorizeInput {
  /** The signed spend, in their `kaspa-sdk-safe-json-v2.0.0` encoding. */
  transaction: string;
  /** The grant address the payment came from. Optional in their schema. */
  payerAddress?: string;
}

/**
 * The payload that goes in `PAYMENT-SIGNATURE`.
 *
 * The return type narrows `payload` to the exact-transaction member of their
 * union. Their `PaymentPayload` covers five payload shapes and a caller that
 * has just built one of them should not have to re-narrow it to read back the
 * expiry of the authorization it just made.
 */
export type ExactPayment = PaymentPayload & { payload: ExactTransactionPayload };

export async function buildPayment(
  input: PaymentInput,
  signDigest: AuthorizationSigner,
): Promise<ExactPayment> {
  const authorization = await authorize(input, signDigest);
  return {
    x402Version: X402_VERSION,
    accepted: input.accepted,
    payload: {
      type: "exact-transaction",
      profile: "standard-native",
      ...(input.challengeId ? { challengeId: input.challengeId } : {}),
      ...(input.payerAddress ? { payerAddress: input.payerAddress } : {}),
      transaction: input.transaction,
      transactionEncoding: "kaspa-sdk-safe-json-v2.0.0",
      paymentOutputIndex: input.paymentOutputIndex,
      requestHash: requestHash(input.request, input.accepted),
      authorization,
    },
  };
}

/**
 * base64 of their canonical JSON — and their schema validator runs inside this,
 * so a payload this client assembles wrongly fails here rather than at their
 * facilitator with a paid transaction already broadcast.
 */
export function paymentSignatureHeader(payment: PaymentPayload): string {
  return encodePaymentSignatureHeader(payment);
}

// ---- small helpers -------------------------------------------------------

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
