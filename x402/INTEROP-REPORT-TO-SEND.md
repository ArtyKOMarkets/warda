# Draft: interop report for kaspahttp402/kaspa-x402

Send as a GitHub issue on their repo, or wherever they prefer. Facts only, no
ask beyond the one question, and nothing about Warda that they need to care
about to answer it.

---

**Title:** `exact` / `standard-native`: `invalid_transaction_state` on an accepted on-chain payment

I've been building an x402 v2 client against `demo.kaspa-x402.org/exact` using
your published `@kaspa-x402/core`, and I'm stuck on a refusal I can't diagnose
from outside. Six attempts there, all `402 {"error":"invalid_transaction_state"}`;
four broadcast and accepted on chain.

**It reproduces on a second vendor.** `kaspa-402-summarize.kaspadev.workers.dev/exact`,
listed on kaspa-402.org and the only entry there settling on testnet-10, is
hosted separately — Cloudflare Workers — and refused identically. That attempt
used a grant minted fresh for it, with its own covenant id, its own payee and a
different quoted amount (146802739 sompi), and the same unchanged client.
`3cb85aa8226bac1297ffd6db4c6f48f77cb8e483222834a7c736eadb0effd254` was accepted
on chain, paying their quoted address their quoted amount, and came back
`402 {"error":"invalid_transaction_state"}`.

So it isn't one server's configuration, one grant, one amount or one
deployment. It is the same payment shape refused by the implementation both
vendors run — which is why I think this is worth your time rather than mine.

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
| 6 | `payerAddress` = the successor address | refused |

Attempt 6 is worth a sentence. A wallet's change returns to the address it paid
from, so for a wallet the spent-from address and the address that receives are
the same one. A covenant spend relocates — the address that receives is the
successor, at a script that did not exist before. If the check were "outputs
that are not the payment return to the payer", the successor is the only
address that could satisfy it. It did not, so `payerAddress` is closed in both
directions.

Latest txid on testnet-10: `7821fc2a554551af559a078626d9cc071205a97965b953334a6d8c7ba32e31bc`

`toX402ErrorReason` maps eight internal codes onto `invalid_transaction_state`,
so from the client side those eight arrive as one message. The
`ExactTransactionVerifier` interface is published; the implementation you
inject behind the demo endpoint is not, which is entirely normal — it just
means the failing check is the one thing I cannot read.

**The question:** which internal code does that attempt raise?

**A guess, in case it saves you the lookup.** My payer is a covenant, not a
wallet. Its spend has two outputs:

- output 0 — the successor covenant (P2SH), carrying the remaining budget
- output 1 — your payee (P2PK), the exact invoiced amount

I set `paymentOutputIndex: 1` and you carry it faithfully. But if the verifier
constrains outputs other than the payment one, an output owned by a script
rather than a key would fail that, and no client-side change fixes it.

**Which leads to the question I actually care about.** Reading your published
types, `exact` already has a notion of a non-wallet payer: `ExactHeadContinuation`
is documented as the "canonical KIP-10 continuation verified from the signed
transaction", and the `additive` profile is built on a reusable KIP-10 head
chain with its own redeem script. So a payer that continues into a successor is
not foreign to the design — it is how `additive` works.

The difference is order. `ExactHeadChallenge` types `paymentOutputIndex` as the
literal `0`: payment first, continuation after. My covenant is the reverse, and
that is not a choice I can make at the client — the script enforces
`outputs[0].value >= inValue - amount - maxFee`, so the continuation is output
0 or the transaction is invalid. Meanwhile `standard-native` carries
`paymentOutputIndex` as a free integer, which is why I assumed index 1 was
admissible.

So: **is `standard-native` intended to admit a continuation output belonging to
a covenant that isn't yours, given `paymentOutputIndex` says which output is
the payment?** If yes, this is a bug worth a code. If no, it's a scheme
boundary worth writing down, and I'd rather cite your answer than guess at it
in public.

Happy to test any change against it; I can reproduce on demand, and everything
above is on testnet-10 and checkable.
