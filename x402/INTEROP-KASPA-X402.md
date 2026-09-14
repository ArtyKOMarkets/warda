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

## It is not the covenant either

Attempt 8 paid from an ORDINARY WALLET. One P2PK input the funder's key
unlocks, the payee at output 0, change back to the payer at output 1 — the
shape a wallet produces and the one `exact` was presumably written against. No
covenant anywhere in it.

`29726ba017ba1880709c6ea6214edfb19d662f8ef745b1c91c04cad1a8cd7e74` was accepted
on chain, paying the quoted address the quoted 20000000 sompi.
`402 {"error":"invalid_transaction_state"}`.

That is the control that should have been run first, and it removes Warda from
the question entirely. Seven covenant attempts were spent distinguishing
between hypotheses that a single wallet payment separates: the vendor does not
reject covenant-shaped payments, because it rejects wallet-shaped ones too.

What remains is that this client cannot get a payment accepted by this server,
for a reason neither the covenant nor the encoding explains, and which cannot
be narrowed further from outside: their validator checks only the quote, their
client's funding adapter is not published, and no known-good payload exists to
diff against.

## A lossy encoding, which is not the cause either

A version-1 transaction id commits to each output's covenant binding.
`kaspa-sdk-safe-json-v2.0.0` — the encoding the scheme pins — has no field for
it. And the `exact-transaction` payload schema forbids the client from
supplying `transactionId`.

So the verifier must derive an id it cannot derive correctly. Measured against
a recorded testnet-10 spend:

| | |
|---|---|
| recorded txid | `7dbc957fbf87ca26bc9b83ec81849f4f713c255fa6d39f44a53301813ceb86ba` |
| id with the covenant binding | `7dbc957f…` — matches |
| id with it stripped | `747315c5…` — does not |

Pinned by `sdk/test/safe-json-covenant.test.ts`, which runs offline.

For a while this looked like the whole answer. It is not, and the correction is
worth keeping because the mistake was a reasoning one rather than a measurement
one.

The safe-JSON document carries its own `id` field, and the reference parser
returns it verbatim: `Transaction.deserializeFromSafeJSON` in
kaspa-wasm32-sdk 0.15.2 hands back a deliberately false id unchanged. So it
trusts rather than derives, and the correct id IS available to any verifier
using it. The payload schema forbidding `transactionId` stops the client
asserting the id a second time; it does not force anybody to recompute.

So the encoding is genuinely lossy for covenant transactions, and a receiver
who recomputes will be wrong — but nothing establishes that this receiver
recomputes. The cause is still unknown.

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

## Answered, 14 September 2026

`kaspa-x402` v1.0.0-rc.1 (13 September) publishes four packages to npm under
the `rc` tag and the whole repository is public, **including the
`exactTransactionVerifier` that was previously injected and unreadable**. The
rule is in `packages/demo-gateway/src/adapters.ts`,
`assertStandardNativeTransactionEnvelope`:

```ts
if (transaction.version !== 0)
  throw invalidTransaction("standard-native transaction version must be 0");
...
if (input.computeBudget !== undefined && input.computeBudget !== 0)
  throw invalidTransaction(`standard-native input ${index} cannot carry a non-zero compute budget`);
if (input.sigOpCount !== 1)
  throw invalidTransaction(`standard-native input ${index} sigOpCount must be 1`);
...
if (output.covenant !== null)
  throw invalidTransaction(`standard-native output ${index} cannot carry a covenant`);
```

Three of those exclude a Warda spend before anything about the payment is
examined. It is **version 1**; its inputs carry a `computeBudget` where a v0
input carries a `sigOpCount`; and its output 0 is the successor grant, which is
a covenant output. `invalid_kaspa_transaction` is the code all three raise, and
it is one of the eight that collapse to the public `invalid_transaction_state`.

**And the same rule explains the wallet control.** Attempt 8 paid from an
ordinary key with no covenant anywhere in it — and it was still built by this
SDK, which emits version-1 transactions with `computeBudget` on every input.
It failed on the very first line, for a reason that has nothing to do with
covenants. That is why removing Warda from the question did not narrow
anything: the control shared the disqualifying property with the thing it was
controlling for.

The other profile does not help. `additive` requires version 1 — and rejects
covenant outputs identically, computing storage mass with `hasCovenant: false`
hardcoded. So **both profiles of the `exact` scheme exclude covenant-carrying
transactions**, consistently rather than by oversight.

## The retraction above was the mistake

Worth keeping, because the shape of the error is more useful than the fact.

This document measured that the scheme's encoding cannot represent a covenant
binding, that a recomputed id therefore comes out wrong, and pinned it in a
test. Then it retracted the conclusion, on the grounds that safe-JSON carries
its own `id` field and the reference parser returns it verbatim — so nothing
established that this receiver recomputes.

Both halves of that are true, and the conclusion still did not follow. The
verifier trusts the document's id *and* recomputes, in order to compare them:

```ts
const transactionId = exactV0TransactionId(reference);
if (transaction.id !== transactionId)
  throw invalidTransaction("standard-native transaction id does not match canonical fields");
```

"It returns the id verbatim" was evidence about the parser and was read as
evidence about the verifier. **The measurement was right; the reasoning
correction was the error** — which inverts the note this file used to carry
about it.

## What is actually blocked, and what is not

Not a bug on either side, and not something one line from an operator would
have fixed. **x402 `exact` is specified for version-0 wallet transactions
whose outputs belong to keys.** A bounded payer is not a wallet: the coin that
funds the next payment is the same coin, moved, and the thing that moves it is
a covenant output. There is no way to satisfy `exact` from a grant without
ceasing to be a grant.

Three doors, in order of how open they are:

1. **Their `batch-settlement` binding already uses covenants** —
   `@kaspa-x402/covenant`, `kaspa-x402-escrow-v4`, a stateful KIP-20 template
   compiled with SilverScript v1.0.0. Covenant-shaped payment is not foreign to
   this protocol; it is foreign to `exact`. Whether a Warda grant can act as a
   payer there is the question worth reading next.
2. **Propose a profile.** They have shipped two (`standard-native`,
   `additive`), so the extension point exists, and the ask is now a spec
   question with a citable line rather than a request for debugging help.
3. **Accept the boundary.** `@warda_protocol/vendor` sells fine and a Warda
   buyer pays it fine. That keeps the money real and the market ours, which is
   the state this document was written to escape.

## Why this is worth publishing either way

Every payment this repository had made before today went to an endpoint it also
wrote. That makes the money real and the market imaginary. These five went to a
vendor built by the people who specified the protocol, encoded with their own
published packages, from a budget the network enforces — and the disagreement
that surfaced is more interesting than the success would have been.
