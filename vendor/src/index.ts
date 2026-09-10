/**
 * Sell an API for Kaspa, over HTTP 402.
 *
 * The seller's half of what @warda_protocol/x402 buys. It quotes a price, and
 * then — before serving anything — looks in the UTXO set for a coin at its own
 * address, from the transaction the buyer named, for exactly the amount
 * quoted. It never trusts the payment header, because the header is written by
 * the party who benefits from lying.
 *
 * Nothing here knows what a covenant is. A Warda grant is one kind of buyer;
 * an ordinary wallet is another; this cannot tell them apart and does not try.
 * Whether a payment was ALLOWED is a question the buyer's side answered before
 * the transaction existed. All a seller needs to know is whether it arrived.
 */
export { priced, pricedFetch, type PricedOptions, type Deliver } from "./priced.ts";
export { settle, type SaleTerms, type SettleInput, type SettleResult } from "./settle.ts";
export { checkPayment, type PaymentClaim, type PaymentCheck } from "./verify.ts";
export { issueQuote, checkQuote, type QuoteTerms, type QuoteOptions } from "./quote.ts";
export { inMemorySpent, replayAllowed, type SpentStore } from "./spent.ts";
export { openNode, type NodeSource, type OpenedNode } from "./node.ts";
