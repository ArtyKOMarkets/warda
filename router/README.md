# @warda_protocol/router

Turning a price into an amount an agent can pay, and saying which parts of the
answer Kaspa consensus enforced and which parts somebody asserted.

The design decisions, and what was argued down to reach them, are in
[DESIGN.md](./DESIGN.md). Two of them govern everything here.

## A dollar price is a quote unit, never an authority unit

A covenant is a script validated by consensus. It compares sompi, because that
is what consensus can see. It cannot compare dollars — L1 has no price and no
oracle, and a covenant that trusted a signed price would have moved the limit
back into a process that can be captured, which is the arrangement Warda exists
to argue against.

So there is no `$20 grant`. There is a KAS grant and a dollar price, and this
package converts between them at a rate somebody stated:

```ts
import { quote, fitsUnderCap } from "@warda_protocol/router";

const q = quote({
  price: { asset: "USD", amount: "0.37" },
  rate:  { perKas: "0.05", asset: "USD", source: "…", observedAt: Date.now() },
  slippageBps: 100,
  expiresAt: Date.now() + 30_000,
});

q.zone;            // "attested" — always. Nothing here was enforced.
fitsUnderCap(q, grant.maxPerSpend);
```

`fitsUnderCap` compares `maxSompi`, not `sompi`. A quote with slippage is a
range and the covenant enforces a point, so the cap has to bind the worst case
— otherwise a payment quotes inside the limit and executes outside it.

**When a rate move puts a payment over the cap, it refuses. That is the
covenant working.** Widening the cap to fit the new rate would be the first
vulnerability in this system that was designed in rather than found.

## A route is no stronger than its weakest hop, and the receipt says so

`provider/src/verify.ts` already publishes `authorisedToPayMe: "unknown"`,
present rather than omitted, because the x402 relay hop means the chain did not
constrain who was ultimately paid. This package computes that answer instead of
remembering it:

```ts
import { verdict, assertClaimSupported } from "@warda_protocol/router";

verdict({ hops: [covenantHop] }).authorisedToPayMe;               // "yes"
verdict({ hops: [covenantHop, relayHop, swapHop] }).zone;         // "assumed"
assertClaimSupported(route, { recipientEnforced: true });         // throws
```

The rule is one sentence: **the covenant constrains the hop immediately after
it and nothing further.** So a recipient is enforced only when the covenant
spend is the last thing that happens.

That produces an asymmetry worth knowing before building on either side:

| | shape | recipient |
|---|---|---|
| **funding** | asset → bridge → KAS → `genesis` | **enforced** — the grant is last |
| **payment** | grant → relay → swap → seller | **unknown** — hops follow the covenant |

Funding-side routing changes nothing about what Warda claims. Payment-side
routing inherits the relay hop's cost, which `x402/RELAY.md` states plainly:
once the coin sits at a key the agent holds, the agent chooses the destination.

Everything else the covenant enforces still enforces, on both sides, however
many hops follow — budget, per-payment cap, epoch limit, window, delegation
depth. `verdict()` returns that list and it does not shrink.

## A relationship is one funding and many renewals

A grant is a fixed budget, so funding an agent is not one crossing of the
conversion edge — it is one crossing followed by many renewals. The renewal
needs no price, no venue and nobody's word for anything: the KAS is already at
the funder's key, and the only questions are whether the agent is near the end
of what it may spend and whether a single coin can pay for the next grant.

```ts
import { renewVerdict } from "@warda_protocol/router";

renewVerdict({
  grant:  { budgetTotal: 2000n, spentTotal: 350n, reserved: 0n, held: 1640n, expiresAt: 900n },
  funder: { largest: 5000n, total: 9000n },
  below:  100n,          // its own per-payment cap, by default
  needed: 2001n,         // the successor's budget plus the genesis fee
  now:    500n,
});
// { due: false, left: 1640n, stranded: 1640n, expired: false }
```

Two things in there are load-bearing. **What is left is the smaller of two
numbers** — the authority the covenant would still permit (`budget - spent -
reserved`) and the coin actually at the grant's address — because a grant that
has paid for anything has spent fees out of the second and not the first, and
either number alone reports an agent as healthy in a state where it cannot pay.
And **enough is not enough in one coin**: `genesis` takes a single input, so a
funder rich in small coins gets `obstacle: "not-in-one-coin"` and a different
fix from one that is simply short.

`warda topup` is this function with a chain reading in front of it and `warda
grant` behind it.

## Status

Quote engine, route model and the renewal decision, with 85 tests. No liquidity
adapters yet: the venue
integrations (Igra, Zealous, Hyperlane) plug in behind `Hop` so that nothing
here is coupled to a venue, and nothing is built on KCC-20, which is a draft in
a fork and not a foundation.

testnet-10 · unaudited · no real money
