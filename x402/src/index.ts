/**
 * @warda_protocol/x402 — pay HTTP 402 invoices out of a Warda grant.
 *
 * x402 answers HOW an agent pays for one call. Warda answers WHAT it is
 * allowed to spend — in total, per call, per epoch, and to whom — and puts
 * that answer in consensus rather than in the process holding the key.
 *
 * They meet at exactly one point: the payment step. A stock x402 client builds
 * a transfer from a private key it was handed; this builds a covenant spend
 * from a grant. The vendor sees an ordinary Kaspa payment either way.
 */
export {
  parsePaymentRequired,
  encodeProof,
  decodeProof,
  settleDelayMs,
  X402Error,
  PAYMENT_HEADER,
  SCHEME_EXACT,
  type PaymentRequirement,
  type PaymentProof,
} from "./protocol.ts";

export {
  WardaPayer,
  payeeKey,
  explainRefusal,
  type Grant,
  type PayerOptions,
  type PaymentResult,
  type Signer,
} from "./payer.ts";

export {
  wardaFetch,
  type WardaFetchOptions,
  type WardaFetchEvent,
} from "./fetch.ts";
