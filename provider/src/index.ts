/**
 * @warda_protocol/provider — for the side being PAID.
 *
 * Every other package here serves the payer. This one serves the person who
 * receives the money and, until now, could see nothing about the authority
 * behind it: x402 `exact` cannot carry a covenant, so a grant-funded payment
 * arrives looking like any other.
 *
 * It is offline. No node, no indexer, and nothing of ours in the request path —
 * a provider who has to call wardaprotocol.com to verify a payment has a single
 * host in front of a guarantee that is supposed to live in consensus.
 */
export {
  verifyGrantProof,
  verifyProof,
  type Verdict,
  type VerifyOptions,
  type HeaderBearing,
} from "./verify.ts";
