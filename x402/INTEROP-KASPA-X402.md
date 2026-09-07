# Paying a kaspa-x402 v2 vendor from a Warda grant

A record of what happens when a covenant-bounded payer meets the reference
kaspa-x402 implementation, written while it was still failing. Every txid below
is real, on testnet-10, and checkable.

## What was tried

A Warda grant funded with 5 KAS, capped at 0.3 KAS per payment and 1 KAS per
epoch, whose allowlist commits to exactly one payee: the address
`https://demo.kaspa-x402.org/exact` quotes. Six attempts to buy from it, of
which four were broadcast and accepted on chain.

| # | txid | broadcast | vendor |
|---|---|---|---|
| 1 | `2f7cb8bb…` | no | 402 `invalid_transaction_state` |
| 2 | `f2e2213b…` | no | 402 `invalid_transaction_state` |
| 3 | `73f34306…` | yes, accepted | 402 `invalid_transaction_state` |
| 4 | `0bbc7254…` | yes, accepted, fresh requestHash | 402 `invalid_transaction_state` |
| 5 | `38006e77…` | yes, accepted, no `payerAddress` | 402 `invalid_transaction_state` |
| 6 | `7821fc2a…` | yes, accepted, `payerAddress` = SUCCESSOR | 402 `invalid_transaction_state` |

## It is not one vendor

Attempt 7 used a different vendor entirely: `kaspa-402-summarize.kaspadev.workers.dev/exact`,
listed on kaspa-402.org, the only entry in that directory settling on
testnet-10. Served from Cloudflare Workers rather than whatever runs
demo.kaspa-x402.org.

Everything else was different too. A grant minted fresh for it, with its own
covenant id `145b89b1…`, its own payee, its own caps. A different quoted amount
— 146802739 sompi rather than 20000000. The same client, unchanged.

`3cb85aa8226bac1297ffd6db4c6f48f77cb8e483222834a7c736eadb0effd254` was accepted
on chain, paying the address they quoted the amount they quoted. They answered
`402 {"error":"invalid_transaction_state"}`.

So this is not one server's configuration, not one grant, not one amount, and
not one deployment. Two independently hosted vendors on the same standard
refuse the same payment shape identically. Whatever the check is, it is in the
implementation both of them run.

## What works

Everything up to their verifier.

- Their `PAYMENT-REQUIRED` header parses, and the `exact` / `standard-native`
  requirement is the one a covenant spend can satisfy.
- Their payee is **P2PK**, and the `payToScriptPublicKey` they advertise is
  byte-for-byte the script a Warda covenant builds for that address. A P2SH
  payee would have been unpayable; this one is not.
- The spend passes their schema validators — `encodePaymentSignatureHeader`
  runs `validatePaymentPayload` and accepts what we assemble.
- The transaction is valid Kaspa: broadcast, accepted, paying the quoted
  address the quoted amount.
- The authorization digest is built by *their* `exactRequestAuthorizationDigest`
  over *their* canonical encoder, signed by the grant's agent key.

## What was ruled out

**Finality.** Attempts 1 and 2 were never broadcast — their quote requires
`accepted` finality, and a payment that exists only in the payer's process is,
from the verifier's side, absent. Fixed by broadcasting and waiting for a coin
to appear at the successor address. Attempts 3 and 4 were accepted on chain and
still refused.

**Replay.** `requestHash` is `sha256(method, url, body, paymentRequirementsHash)`
and their quote is static, so attempts 1–3 shared one fingerprint. Attempt 4
used a different URL and therefore a different fingerprint. Same refusal.

**`payerAddress`.** Optional in their schema, and their own client fills it from
a funding wallet, so every payment their verifier has seen carries a
pay-to-pubkey address there while a grant's is pay-to-script-hash. Attempt 5
omitted the field entirely. Same refusal.

Attempt 6 tried the other direction. A wallet's change returns to the address
it paid from, so for a wallet the spent-from address and the address that
receives are the same and nothing distinguishes them; a covenant spend
relocates, and the address that receives is the successor. If the unseen check
were "outputs that are not the payment return to the payer", the successor is
the only address that could satisfy it. Same refusal. That closes the field in
both directions: it is not about `payerAddress`.

## The open question

`invalid_transaction_state` is the public reason their `toX402ErrorReason` maps
**eight** internal codes onto: `invalid_kaspa_settlement_response`,
`invalid_kaspa_transaction`, `invalid_kaspa_outpoint`,
`invalid_kaspa_channel_id`, `kaspa_payment_identifier_conflict`,
`payment_identifier_conflict`, `exact_payment_replay`,
`invalid_kaspa_exact_replay`.

From outside, those eight are one message. The check that fails lives in the
`exactTransactionVerifier` adapter, which is injected rather than published, so
it cannot be read from the packages on npm.

## The hypothesis worth testing

**A covenant spend is not wallet-shaped.**

x402's `exact` scheme assumes the payer is a wallet: one output pays the payee,
the rest is change back to an address the payer controls as a key. A Warda
spend is not that. Its outputs are:

    output 0   the SUCCESSOR GRANT — a P2SH covenant address, carrying the
               remaining budget and the covenant binding
    output 1   the payee, P2PK, for exactly the invoiced amount

We declare `paymentOutputIndex: 1` and their protocol carries it faithfully.
But any verifier check shaped like *"every other output returns to the payer"*
fails on an output that belongs to a script rather than to a person — and
`payerAddress`, which their own client fills from a funding wallet's identity,
is here a pay-to-script-hash address.

If that is the cause, it is not a bug on either side. It is a real boundary:
**x402 exact was specified for wallets, and a bounded payer is not a wallet.**
The fix is not in either implementation but in the spec's assumptions about
what a payment transaction may look like.

## What would settle it

One line from whoever runs that verifier, naming which of the eight codes
attempt 5 raised. Failing that: whether the verifier constrains outputs other
than `paymentOutputIndex`, and whether it decodes `payerAddress` expecting a
pay-to-pubkey address.

## Why this is worth publishing either way

Every payment this repository had made before today went to an endpoint it also
wrote. That makes the money real and the market imaginary. These five went to a
vendor built by the people who specified the protocol, encoded with their own
published packages, from a budget the network enforces — and the disagreement
that surfaced is more interesting than the success would have been.
