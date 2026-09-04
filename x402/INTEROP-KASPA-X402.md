# Paying a kaspa-x402 v2 vendor from a Warda grant

A record of what happens when a covenant-bounded payer meets the reference
kaspa-x402 implementation, written while it was still failing. Every txid below
is real, on testnet-10, and checkable.

## What was tried

A Warda grant funded with 5 KAS, capped at 0.3 KAS per payment and 1 KAS per
epoch, whose allowlist commits to exactly one payee: the address
`https://demo.kaspa-x402.org/exact` quotes. Four attempts to buy from it.

| # | txid | broadcast | vendor |
|---|---|---|---|
| 1 | `2f7cb8bb…` | no | 402 `invalid_transaction_state` |
| 2 | `f2e2213b…` | no | 402 `invalid_transaction_state` |
| 3 | `73f34306…` | yes, accepted | 402 `invalid_transaction_state` |
| 4 | `0bbc7254…` | yes, accepted, fresh requestHash | 402 `invalid_transaction_state` |

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
attempt 4 raised. Failing that: whether the verifier constrains outputs other
than `paymentOutputIndex`, and whether it decodes `payerAddress` expecting a
pay-to-pubkey address.

## Why this is worth publishing either way

Every payment this repository had made before today went to an endpoint it also
wrote. That makes the money real and the market imaginary. These four went to a
vendor built by the people who specified the protocol, encoded with their own
published packages, from a budget the network enforces — and the disagreement
that surfaced is more interesting than the success would have been.
