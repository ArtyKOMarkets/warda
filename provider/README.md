# @warda_protocol/provider

For the side being **paid**.

Every other package here serves the payer. This one tells you, the vendor, what
the agent that just paid you is bounded by — offline, with no node, no indexer,
and nothing of ours in your request path.

```js
import { wardaProvider } from "@warda_protocol/provider";

const warda = wardaProvider();

// paymentInput is the outpoint the payment spends. Your x402 verifier has
// already parsed the payment transaction; this is inputs[0].previousOutpoint.
const v = warda.verify(request, paymentInput);

if (v.warda && v.bounded) {
  v.maxPerPayment;      // this payment could not have been larger
  v.budgetRemaining;    // what this agent can still ever spend
  v.expiresAt;          // when its authority ends
  v.agentKey;           // stable across payments — an identity
}
```

## What it proves

**This counterparty is bounded.** The payment could not have exceeded the
per-payment cap. The agent cannot ever spend more than its budget. Its authority
expires at a stated DAA score. None of that is a promise by whoever holds the
key — it is enforced by Kaspa consensus, and the transaction that paid you is
the proof.

It is a credit limit the network keeps.

## What it does not prove

**That the payer was allowed to pay *you*.**

x402 `exact` cannot take a covenant spend, so a grant funds a single-use relay
key and that key pays. The covenant constrained the funding spend; it did not
constrain where the relay key sent the money afterwards. The allowlist stops
binding at that hop.

`v.authorisedToPayMe` is therefore the string `"unknown"` — present rather than
omitted, because an absent field reads as *not applicable* and a present one
that says it does not know gets read.

## What it assumes

That **you** have established the payment is on chain. Your x402 verifier does
this already.

A payment on chain spent a real coin; that coin is the output the proof names;
so consensus accepted the funding transaction, and consensus checked the
covenant. Without that step nothing here is proven, because a transaction nobody
accepted can claim anything. The verdict carries the assumption in `v.assumes`
rather than leaving it implicit.

## Why the payer sends the proof

Not a design preference. Kaspa's node RPC answers *"what is unspent at this
address"* and never *"what spent this outpoint"*, and a stock node has no
transaction index — so a provider holding a transaction id cannot turn it into a
transaction. The funding transaction travels with the payment, in a `WARDA-GRANT`
header.

It is a header and not part of the x402 payload because the payload is validated
by your schema, and a field you have never seen should not be able to fail your
validator.

## The check that makes it mean anything

`paymentInput` is required, and it is the binding: the coin the payment spent
must be the output the proof names.

Without it, a payer could attach any covenant spend in the DAG — someone else's,
with a large budget — and every field above would be true about a grant that has
nothing to do with the money that arrived.

## What a refusal looks like

```js
{ warda: false, reason: "no proof" }          // ordinary. Most payers are not Warda payers.
{ warda: true, bounded: false, reason: "…" }  // a claim was made and could not be believed.
```

A missing header is not an error. A header that is present and unreadable is:
a payer sending one is making a claim, and a claim that cannot be read is not
the same as no claim.

## No policy

This returns a verdict. It does not reject requests, price differently, or log.
What to do about an unbounded payer is your business decision and it cannot be
made by a library that cannot see your business.
