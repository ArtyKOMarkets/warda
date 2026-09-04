# Draft: interop report for kaspahttp402/kaspa-x402

Send as a GitHub issue on their repo, or wherever they prefer. Facts only, no
ask beyond the one question, and nothing about Warda that they need to care
about to answer it.

---

**Title:** `exact` / `standard-native`: `invalid_transaction_state` on an accepted on-chain payment

I've been building an x402 v2 client against `demo.kaspa-x402.org/exact` using
your published `@kaspa-x402/core`, and I'm stuck on a refusal I can't diagnose
from outside. Five attempts, all `402 {"error":"invalid_transaction_state"}`.

What works:

- your `PAYMENT-REQUIRED` header parses; I select the `exact` /
  `standard-native` requirement
- the `payToScriptPublicKey` you advertise matches the P2PK script I build for
  your `payTo`, byte for byte
- `encodePaymentSignatureHeader` accepts the payload, so it passes
  `validatePaymentPayload`
- the authorization digest comes from your `exactRequestAuthorizationDigest`
  over your `stableStringify`
- the transaction is broadcast and **accepted on chain**, paying your quoted
  address the quoted 20000000 sompi

Ruled out across attempts:

| | change | result |
|---|---|---|
| 1–2 | not broadcast | refused |
| 3 | broadcast, accepted before presenting | refused |
| 4 | fresh `requestHash` (different URL) | refused |
| 5 | `payerAddress` omitted | refused |

Latest txid on testnet-10: `38006e773f49b3c7cf1437f609f40a95c1dfafc5f3c60b97568d7996bc2b5962`

`toX402ErrorReason` maps eight internal codes onto `invalid_transaction_state`,
so from the client side those eight are one message, and the check that fails
lives in the injected `exactTransactionVerifier` rather than in the published
packages.

**The question:** which internal code does that attempt raise?

**A guess, in case it saves you the lookup.** My payer is a covenant, not a
wallet. Its spend has two outputs:

- output 0 — the successor covenant (P2SH), carrying the remaining budget
- output 1 — your payee (P2PK), the exact invoiced amount

I set `paymentOutputIndex: 1` and you carry it faithfully. But if the verifier
constrains outputs other than the payment one — for instance expecting them to
return to the payer — an output owned by a script rather than a key would fail
that, and no client-side change can fix it.

If that's what's happening, it's worth knowing whether `exact` is intended to
admit non-wallet payers at all. Happy to test any change against it; I can
reproduce this on demand.
