# Draft: interop report for kaspahttp402/kaspa-x402

Send as a GitHub issue on their repo, or wherever they prefer. Facts only, no
ask beyond the one question, and nothing about Warda that they need to care
about to answer it.

---

**Title:** `exact` / `standard-native`: `invalid_transaction_state` on an accepted on-chain payment

> **This file has been sent, and then corrected.** The version that went out
> claimed the transaction id was underivable for a covenant payment and that
> this was the cause. The first half of that is true; the conclusion was wrong,
> because the safe-JSON document carries its own `id` field and the reference
> parser returns it verbatim. The correction is posted as a comment on the
> issue and is reproduced at the bottom. What follows is the report as it
> should have been written.

I've been paying `demo.kaspa-x402.org/exact` from a Kaspa covenant using your
published packages, and I cannot diagnose the refusal from outside. Six
attempts, all `402 {"error":"invalid_transaction_state"}`, four of them
accepted on chain paying your quoted address the quoted amount.

**It reproduces on a second vendor.** `kaspa-402-summarize.kaspadev.workers.dev/exact`,
listed on kaspa-402.org, is hosted separately and refused identically — with a
grant minted fresh for it, its own covenant id, its own payee and a different
amount (146802739 sompi). `3cb85aa8226bac1297ffd6db4c6f48f77cb8e483222834a7c736eadb0effd254`
was accepted on chain paying their quoted address their quoted amount.

So it is not one server's configuration, one grant, one amount or one
deployment.

What works:

- your `PAYMENT-REQUIRED` header parses; I select the `exact` /
  `standard-native` requirement
- the `payToScriptPublicKey` you advertise matches the P2PK script I build for
  your `payTo`, byte for byte
- `encodePaymentSignatureHeader` accepts the payload, so it passes
  `validatePaymentPayload`
- the authorization digest comes from your `exactRequestAuthorizationDigest`
  over your `stableStringify`
- the transaction is broadcast and accepted on chain

Ruled out across attempts:

| | change | result |
|---|---|---|
| 1–2 | not broadcast | refused |
| 3 | broadcast, accepted before presenting | refused |
| 4 | fresh `requestHash` (different URL) | refused |
| 5 | `payerAddress` omitted | refused |
| 6 | `payerAddress` = the successor address | refused |
| 7 | a different vendor entirely, fresh grant | refused |

**The question:** which internal code does `toX402ErrorReason` see for these?
Eight map onto `invalid_transaction_state`, so from out here they are one
message, and the check that fails is in the injected verifier rather than in
the published packages.

**What is unusual about my payer, in case it points somewhere.** It is a
covenant, not a wallet. The spend has two outputs — output 0 is the successor
covenant (P2SH) carrying the remaining budget, output 1 is your payee (P2PK)
for the exact invoiced amount — and `paymentOutputIndex: 1` says so. The
authorizing input is unlocked by a covenant redeem script rather than a
plain P2PK signature script, so a verifier that recovers the payer's public
key from the input script would not find one where it expects.

One encoding note that is true but, I now believe, not the cause: a
version-1 transaction id commits to each output's covenant binding, and
`kaspa-sdk-safe-json-v2.0.0` has no field for it (with the binding the id is
`7dbc957f…` and matches the chain; without it, `747315c5…`). Any receiver that
RECOMPUTES an id from the parsed fields will therefore be wrong about a
covenant transaction. The document's own `id` field carries the right one, and
your reference parser returns it, so this only bites a derivation — but it may
be worth knowing about regardless.

Happy to test any change on demand; everything above is on testnet-10 and
checkable.
