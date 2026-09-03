# @warda_protocol/x402

Pay HTTP 402 invoices out of a Warda grant, so an agent's spending limits are
enforced by consensus instead of by the process holding the key.

```
npm install @warda_protocol/x402
```

## The problem this replaces

The usual way to let an agent pay per call is a hot wallet plus a counter. A
real agent-payments library shipping today caps spending with an environment
variable, and its own documentation says the server *"refuses further calls
until restarted."*

So the cap resets when the process does. It is bypassed by a crash, a redeploy,
a second instance, or anyone who can read the key out of `env`. The wallet
balance is the only limit that actually holds.

Backed by a grant, the same agent cannot exceed its budget even if the key is
stolen outright — the thief inherits the limits, because the limits are in the
script that unlocks the coin.

## How the two protocols compose

They answer different questions and meet at exactly one point.

**x402** says *how* to pay for one call: here is the price, here is the address,
come back with proof.

**Warda** says *what this agent may pay* — in total, per call, per epoch, and to
whom.

The join is the payment step. A stock x402 client builds a plain transfer from a
key it was handed; this builds a covenant spend from a grant. Everything above
and below is unchanged. The vendor sees an ordinary Kaspa payment and never
learns the difference.

## Two dialects: v1 and v2

kaspa-x402 has moved to v2, and v2 is not a superset of v1. The header names
changed, `amountSompi` became `amount`, the per-invoice nonce was replaced by a
binding to the request itself, and the payment is now an authorization signed
over a digest rather than a bare txid. A server speaking one does not
understand the other.

Both are implemented. `dialect()` reads which one a server speaks from what the
server actually answered, because the answer is in the response and asking an
operator to configure it is how a client ends up wrong against half the
network.

```ts
import { wardaFetchV2 } from "@warda_protocol/x402";

const res = await wardaFetchV2("https://vendor/infer", {
  method: "POST",
  body: JSON.stringify({ prompt: "..." }),
}, { payer });
```

The v2 path depends on [`@kaspa-x402/core`](https://www.npmjs.com/package/@kaspa-x402/core)
rather than reimplementing it. Every value on that wire is a hash over a
canonical JSON encoding, and a plausible reimplementation of a canonical
encoder is one that passes its own tests and is rejected by somebody else's
facilitator over a key ordering. Their package is MIT, pure, and imports only
`node:crypto`, so the encoder, the schema validators and the digest preimages
are theirs; the covenant spend and the agent's signature are ours.

### The vendor broadcasts

This is the one difference that changes how a grant is book-kept. In v1 the
payer submits the transaction and hands over a txid. In v2 the payer hands over
the whole signed transaction and the **vendor** submits it.

For an agent that is an improvement: paying no longer needs a node, only a
signer. For the grant it is a problem, because a grant's address *is* its
state — after a spend the old address is empty and the payer must move with it,
and here it never finds out unless somebody says so.

So a v2 payment holds the grant. `buildPaymentV2` returns a `PendingPayment`
and the payer refuses to build another until it is told what happened:

```ts
const pending = await payer.buildPaymentV2({ accepted, request });
// ... hand pending.header to the vendor as PAYMENT-SIGNATURE ...
payer.settledV2();   // they confirmed: advance the grant
payer.abandonedV2(); // they did not: stop, and resolve against the chain
```

`abandonedV2()` does not roll back. A vendor that crashed after broadcasting
looks exactly like one that never tried, so the payer marks itself unresolved
and names the two addresses the grant can be at. One query per candidate
settles it — `sdk/tools/follow-grant.ts` does exactly that.

Rolling back optimistically would mean spending from a coin that is already
gone, which surfaces much later as an inexplicable chain error. Stopping is
more disruptive and it is the only honest option.

## Usage

```ts
import { NodeClient, RecipientSet } from "@warda_protocol/kaspa";
import { WardaPayer, wardaFetch } from "@warda_protocol/x402";
import template from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };

const payer = new WardaPayer({
  grant: {
    template,
    authority: { principalKey, revocationKey },
    state,                                   // the grant as it stands now
    recipients: new RecipientSet(vendors),   // the full list, not just the root
  },
  node: await NodeClient.connect({ url: "ws://127.0.0.1:18210" }),
  sign: agentSecret,                          // or a signer function
  prefix: "kaspatest",
});

const res = await wardaFetch("https://vendor.example/compute", {
  method: "POST",
  body: JSON.stringify({ prompt: "explain GHOSTDAG" }),
}, { payer });

const result = await res.json();
```

That is the whole surface. Call a paid endpoint as you would a free one; the
402, the payment and the proof are handled underneath.

### Keeping the key out of this process

`sign` takes a function as readily as bytes, so the key can live in an HSM, a
remote signer, or another process:

```ts
sign: async (digest) => myRemoteSigner.sign(digest),   // returns 65 bytes
```

## Two constraints x402 does not know about

A grant can only pay a payee it committed to at genesis, and the covenant
requires that payee output to be **P2PK**. So a vendor's `payTo` must be a P2PK
address whose key is on the grant's allowlist.

Neither is a limitation of this adapter — they are the authority model working —
but both would otherwise fail at broadcast as an opaque script error. Both are
checked before anything is signed, and reported in words:

```ts
const why = payer.refusalFor(requirement);
// "kaspatest:qq… is not on this grant's allowlist, so no inclusion proof
//  places it in the recipients tree. There is no valid transaction that pays
//  them — not one the network would reject, none at all."
```

In practice the allowlist *is* the vendor list. A marketplace that validates
services before listing them is describing the same set.

## Things worth knowing before you deploy this

**It never pays twice.** When a server answers 402 a second time it means the
payment is still settling, and the spec says re-present the same proof. This
does exactly that. If the server never settles, it reports that the money is
spent rather than paying again — the one bug in this design capable of draining
a budget through nobody's fault.

**Payments are serialised.** A grant is a single UTXO, so two concurrent spends
would build on the same coin and one would be rejected as a double spend. The
payer queues them rather than letting that surface as a confusing chain error.
If you need real concurrency, delegate: *N* children are *N* independent UTXOs
and therefore *N* parallel lanes.

**The grant moves after every payment.** A grant's address *is* its state, so
spending changes where it lives. The payer owns and advances that state; read
`payer.state` if the process may restart and you need to resume.

**`maxAmountSompi` is not a security control.** It refuses a call quoted above a
ceiling, which is useful against a mis-typed price. But it lives in your
process, which is precisely the kind of limit Warda exists to replace. The
grant's `maxPerSpend` is the one that holds.

## What it does not do

It does not verify the facilitator's signature on the 402, and it does not
implement any scheme other than `exact`. It also does not decide whether a spend
is allowed — the covenant does that, on chain, and it is the only thing that
can. Everything here refuses *earlier* than the chain would, never later, and
never permits something the chain would not.

## Licence

MIT
