# The payment router — decisions before the first line of it exists

17 September 2026. Rewritten the same day it was first written, because the
first version was shaped around bridging value per payment and that is the
wrong shape. What was argued down is kept at the bottom; this repo's habit is
that a decision reversed in private gets made again in six months.

## The problem, stated properly

Most agents that want to buy things hold stablecoins. Most services that want
to sell things want stablecoins. **Kaspa L1 has no stablecoin a covenant can
hold** — see the verified state below — so an agent holding USDC cannot buy
bounded authority today, and that is the whole addressable market sitting on
the other side of a currency mismatch.

Warda solves the two edges and changes nothing in the middle.

    USDC (anywhere)                                        USDC (anywhere)
         │                                                        ▲
         │  once, per funding relationship                        │  when the
         ▼                                                        │  seller chooses
    ┌─────────────────────────── KASPA L1 ───────────────────────────┐
    │                                                                │
    │   genesis ──▶ grant ──spend──▶ seller's Kaspa address          │
    │                      ×1000, sub-cent, covenant-enforced        │
    └────────────────────────────────────────────────────────────────┘

## Why KAS is in the middle

Not for settlement efficiency. A USDC-to-USDC payment is a solved problem with
a thousand rails, and not one of them produces a payment whose ceiling, budget,
epoch, expiry and payee were **refused by a network rather than promised by
software**. The KAS leg is not a routing hop. It is the enforcement hop, and it
is the product.

The sentence this architecture exists to make true:

> USDC in, USDC out, and in between, limits a network keeps instead of a
> promise someone made.

## Why the conversions sit at the edges of a relationship, not inside a payment

The tempting version converts per payment: swap USDC to KAS, spend, swap back.
It fails on arithmetic long before it fails on principle. A ten-dollar payment
that way carries a Uniswap swap, a bridge crossing in, the covenant spend, a
crossing out and another swap — four operations on expensive chains, two
crossings of minutes each, against a bridge whose minimum exit is 1,000 KAS.
**Twenty to thirty dollars of friction and ten minutes of latency on a ten
dollar payment.** For a thirty-seven cent API call it is not a rail, it is a
demonstration.

So the grant is a **standing balance, not a conversion**. Fund it once at a
size that clears the bridge comfortably, make a thousand covenant-enforced
payments out of it at sub-cent Kaspa fees, and let the seller convert on their
own schedule. The buyer's experience is unchanged — *I hold USDC, I spend
USDC*. The seller's is unchanged — *I get paid, I end up with USDC*. The
conversion cost amortises across every payment instead of being paid twice per
payment, which is about three orders of magnitude.

## What this preserves, and why that is the point

Converting per payment costs the **payee** constraint: the grant pays whoever
does the swap-back, so `recipientsRoot` binds the converter and
`authorisedToPayMe` is `"unknown"` for the seller forever. That is the x402
relay hop, which this repo already ships and already discloses — but it is the
one constraint a seller actually reads, and paying it as a standing cost is
different from paying it where no alternative exists.

Converting at the edges **gives it back**. A seller who receives KAS and
converts later holds a Kaspa address, so they sit in the allowlist, so
`authorisedToPayMe` is `"yes"`. All six constraints, including the payee.

| | per payment | per relationship |
|---|---|---|
| budget, cap, epoch, window, depth | enforced | enforced |
| **payee** | **unknown** | **enforced** |
| cost of a $10 payment | $20–30 | fractions of a cent |
| latency | ~10 minutes | sub-second |

## The state this was decided from, verified rather than recalled

- **Kaspa L1 has no covenant-holdable stablecoin.** Chainge has bridged
  `$CUSDC` and `$CUSDT` onto Kaspa as **KRC-20**, pre-minted against a vault
  they custody under DCRM, at 0.06% bridging. But KRC-20 is a Kasplex *indexer*
  convention, not something kaspad validates — so **a covenant cannot enforce
  anything over a KRC-20 balance.** A grant secures native KAS in a UTXO and
  nothing else. Chainge also state that KRC-20 DEXs do not yet exist, so there
  is no on-Kaspa venue to trade them at either.
- **KCC-20** — covenant-native fungible tokens — is **Draft**, and in a fork:
  `kaspanet/kccs`, the canonical repository, has an empty proposals table. It
  is the expiry condition for this whole design (see below), not a foundation.
- **Wrapped Kaspa is liquid on EVM.** wKAS trades on Uniswap on Ethereum
  (`0x112b0862…`) and BNB, bridged by Chainge. This is the buyer-side on-ramp
  and it is somebody else's infrastructure, which is correct.
- **Igra is a based rollup**, Zealous runs on it, USDC there is USDC.e via
  Hyperlane, and `KasExitBridge.requestExit` has a **1,000 KAS minimum exit**
  with `msg.value == (unlockAmountSompi + feeAmountSompi) * 1e10`. Treasury-
  sized funding clears that floor; per-payment crossing never could.

## Three zones, named on every field

`authorisedToPayMe: "unknown"` already exists in `provider/src/verify.ts`,
present rather than omitted. The router inherits that answer and generalises it.
Every field of a router receipt is one of:

| zone | meaning | who can be wrong |
|---|---|---|
| **enforced** | Kaspa consensus refused every alternative | nobody — there is no transaction |
| **attested** | a named party signed a statement and can be held to it | that party |
| **assumed** | nobody proved it; it is a belief about the world | everyone |

A word that sounds like an answer is worse than the absence of one, so the
vocabulary is exactly these three and `ops/check-router.mjs` refuses a fourth.

## Authority is KAS. Pricing may be dollars. These are not the same field.

A covenant compares sompi, because that is what consensus can see. It cannot
compare dollars: L1 has no oracle, and a covenant trusting a signed price would
have moved the limit back into a process that can be captured. **There is no
`$20 grant` and there will not be one.**

What there is: `pricing: { asset, amount, unit }` in the registry manifest
already carries an asset, so a seller may price in `USD`. That is a **quote
unit**. `quote()` converts at a rate somebody stated and everything it returns
is `attested`. `maxPerSpend`, `budgetTotal` and `epochLimit` stay in sompi and
stay `enforced`.

If a rate move puts a dollar-priced service over the cap, **the payment
refuses**. That is the covenant working. Widening the cap to fit the new rate
would be the first vulnerability in this system designed in rather than found.

`fitsUnderCap` therefore compares `maxSompi`, not `sompi`: a quote with
slippage is a range and the covenant enforces a point.

**KIP-9 has a floor and dollars do not know about it.** Storage mass puts about
0.02 KAS under any payment, so a USD-priced listing has a KAS floor that moves
with the market and must carry a stated minimum.

## The two edges

### Input: getting KAS into a grant

Pre-authority, so a failure is a failed purchase — nobody is mid-payment and no
grant is half-spent. `genesis` is the **last** step, so `verdict()` derives
`recipientEnforced: true` from the shape rather than the code asserting it.

Who converts is a vendor choice, not an architecture choice: a centralised
exchange the buyer withdraws KAS from, a bridge, or a third-party market maker.
Whoever it is gets named in the receipt and sits in `assumed`. **Warda does not
need to be the filler and should not become one** — the day it holds the float
its security argument becomes a balance sheet.

### The relationship's second and every later grant

A grant is a fixed budget, so a funding relationship is not one crossing of the
input edge — it is one crossing followed by many renewals. The renewal needs no
price, no venue and nobody's word for anything: the KAS is already at the
funder's key, and the only questions are whether the agent is near the end of
what it may spend and whether a single coin can pay for the next grant.
`renewVerdict()` answers both, `sdk/tools/topup.ts` does the reading, and
`warda grant` creates the successor unchanged.

Two things are load-bearing there. **What is left is the smaller of two
numbers** — the authority the covenant would still permit, and the coin that is
actually at the grant's address — because a grant that has paid for anything at
all has spent fees out of the second and not the first, and either number alone
reports an agent as healthy in a state where it cannot pay. And **the successor
does not end its predecessor.** Revocation's key is worth something precisely
because it is not online; a schedule that fires it on the most routine event in
an agent's life is that key online, daily. The remainder is named and the
command is printed, and a person decides.

This is also where the asymmetry with `warda fund` is deliberate. The rare step
— selling an asset, withdrawing the proceeds — is printed rather than performed,
because automating it means an exchange key with withdrawal permission living in
a cron job, which is a worse thing to own than the problem it solves. The
frequent step is the one worth automating, and it is the one that needs no
custody at all.

### Output: the seller getting back to USDC

**This needs no protocol at all, and must not have one.** The seller receives
KAS under the covenant — the one hop in the entire system with no counterparty
— and converts afterwards with their own key on their own schedule. Routing it
would insert a counterparty into the only hop that does not have one, and would
cost the payee constraint that the buyer just paid for.

It is a manifest field and a paragraph of documentation. Warda may sell the
seller a conversion *convenience*; it must sit after the payment, never inside
it.

The honest residual cost is that the seller carries KAS price exposure between
receipt and conversion. The window is theirs to choose, it is the same exposure
any merchant taking crypto accepts, and it is a decision left to them rather
than a risk imposed inside the payment.

### Two seller tiers, published

Make the distinction a field in the listing rather than a footnote:

- **settled** — holds a Kaspa address, sits in the allowlist, full covenant proof
- **relayed** — paid through a hop, `authorisedToPayMe: "unknown"` (what every
  x402 vendor is today)

Buyers filter on it; sellers who want the stronger claim get a concrete reason
to hold a Kaspa address. It turns a disclosure into a sellable property and
stops the weak tier being averaged in with the strong one.

## The expiry condition

When **KCC-20** ships and a real issuer deploys a covenant-native stablecoin, a
grant can hold the stablecoin directly and both edges disappear. That is the
end state, and it means **the conversion layer is temporary infrastructure**.
Build it thin. Anything here that would be painful to delete is over-built.

## What was argued down, and why it is recorded

**"Grant: $20 spending authority."** Impossible; the covenant has no price. The
most attractive idea in the original proposal and it will be proposed again.

**Converting per payment.** Fails on arithmetic first and on the payee
constraint second. See the table above.

**Routing the seller's output.** Costs `authorisedToPayMe` to save the seller a
step they can take themselves.

**"Use Uniswap instead of Igra, then we need no bridge."** Uniswap sells wKAS
on Ethereum; it cannot deliver a KAS UTXO on L1, and Kaspa L1 has no DEX
because Toccata brought covenants and not an EVM. The bridge does not go away,
it changes vendor.

**Both ends on Ethereum with authority on Kaspa.** A seller with no Kaspa key
cannot be in `recipientsRoot`, so `authorisedToPayMe` is permanently
`"unknown"`. If the money must live on an EVM, the honest answer is an
implementation of the same three-key model deployed there — a different and
much larger build — not a message from Kaspa that an EVM contract is asked to
believe.

**Warda as the bridge, or as the filler.** Adapters wrap venues that already
exist. Holding the float turns a security argument into a balance sheet.

**A single hosted endpoint every payment depends on.**
`warda-network-registry.md` settled the general case: *"Warda was down so my
agent couldn't pay" is the one sentence that destroys the differentiator.* That
was about discovery, which is not even in the payment path.

## Build order

1. **Quote engine.** Done. Signed quotes, USD→sompi, KIP-9 floor, the refusal
   when a rate move breaks the cap.
2. **Route and hop model.** Done. `verdict()` derives what may be claimed;
   `assertClaimSupported` refuses a receipt that overstates it.
3. **Funding edge.** Plan model done and holds no key; the venue adapter needs
   a verified address, and the vendor is now a choice rather than a dependency.
4. **Seller tiers** in the registry manifest, and the output-edge documentation.
5. **Guards.** Done: no baked addresses, no literal claims, no dollars in a
   sompi field, zone vocabulary closed.
6. **Renewal.** Done. `renewVerdict()` decides; `warda topup` reads the chain,
   refuses a manifest the chain does not confirm, and falls through to `warda
   grant` with the predecessor's limits. genesis and quickstart now refuse to
   write over a manifest, because a successor's path being new is a habit until
   something says no.

## Open

- **Which input vendor to name first.** A CEX withdrawal is the least
  infrastructure and the most custodial; a bridge is the reverse. Both get the
  same receipt treatment, so this is a go-to-market question.
- **Quote signing key and its custody.** A quote is attested, which means
  somebody's key. Whose, held where, and what a wrong quote costs them.
- **Seller conversion convenience.** Real product, must sit after the payment.
  Worth scoping only once a seller asks for it.
- **Slippage as an authority question.** A quote with 1% slippage is a range
  and the covenant enforces a point; `maxSompi` binds the worst case.
