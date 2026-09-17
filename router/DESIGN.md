# The payment router — decisions before the first line of it exists

17 September 2026. Written before the code, because the failure mode here is
not a bug: it is a router that quietly becomes a custodian, and a receipt that
claims consensus enforced something consensus never saw.

The positioning is *any asset in, KAS out*. The discipline is that every
sentence of that has to survive being checked.

## The state this was decided from, verified rather than recalled

- **Igra is a based rollup on Kaspa**, not a sidechain and not L1. KAS wraps
  1:1 to iKAS across a trust-minimised bridge backed by KAS locked on L1; gas
  is iKAS; ordering is delegated to Kaspa miners.
- **Zealous Swap runs on Igra.** Its own app addresses the network as `igra`.
  It is not an L1 venue.
- **USDC on Kaspa is USDC.e, bridged by Hyperlane**, and arrives on Igra.
- **KCC-20 is a draft in a fork.** `kaspanet/kccs` — the canonical repository —
  has an empty proposals table. The drafts, including KCC-20 "Fungible Token
  Covenant Specification", live in `Manyfestation/kccs` and are all Draft.

The load-bearing consequence: **the liquidity is not on the layer the covenant
is on.** A grant spend is an L1 transaction. It cannot touch an Igra pool, in
the same transaction or in any transaction. Every route crosses a bridge.

Nothing about the asset adapter layer may be built on the assumption that
KCC-20 exists. It is a possible future adapter, not a foundation.

## The rule that decides the shape

**The covenant spend can never be the swap.**

This is not a new finding; it is `x402/RELAY.md` restated. A Warda spend's
output 0 *is* the successor grant, so the spending transaction is
covenant-carrying by construction. An x402 `exact` vendor refuses it, and a DEX
refuses it for the same structural reason: it is not a bare key-controlled
payment. So a swap is always at least a second transaction, and across layers
it is a sequence.

Everything below follows from that one fact.

## Three zones, named on every field

`authorisedToPayMe: "unknown"` already exists in `provider/src/verify.ts`,
present rather than omitted, because the relay hop means the chain did not
constrain who was ultimately paid. The router is that problem with more hops,
so it inherits that answer and generalises it. Every field of a router receipt
is one of:

| zone | meaning | who can be wrong |
|---|---|---|
| **enforced** | Kaspa consensus refused every alternative | nobody — there is no transaction |
| **attested** | a named party signed a statement and can be held to it | that party |
| **assumed** | nobody proved it; it is a belief about the world | everyone |

Budget, per-payment cap, epoch limit, window, delegation depth and the
*immediate* recipient are **enforced**. A quote's rate is **attested** by
whoever signed it. Bridge solvency, pool depth at execution time, and the far
side of any relay are **assumed**.

A receipt that reports a route without these labels is the thing this document
exists to prevent. `authorisedToPayMe` stays `"unknown"` and does not become
`"routed"` — a word that sounds like an answer is worse than the absence of
one.

## Authority is KAS. Pricing may be dollars. These are not the same field.

A covenant is a script validated by Kaspa consensus. It compares sompi. It
cannot compare dollars, because L1 has no price and no oracle, and a covenant
that trusted a signed price would have moved the limit back into a process that
can be captured — which is the exact arrangement Warda exists to argue against.

So there is no such object as a `$20 grant`, and there will not be one.

What there is:

- `pricing: { asset, amount, unit }` in the registry manifest **already**
  carries an asset. A seller may set `asset: "USD"`. That is a **quote unit**.
- The router converts at request time and produces a quote. The quote is
  **attested**, never enforced.
- The grant's `maxPerSpend`, `budgetTotal` and `epochLimit` stay in sompi and
  stay **enforced**.

The consequence is a feature, not a gap: if the rate moves enough that a
dollar-priced service no longer fits under the cap, **the payment refuses**.
That is the covenant working. A router that "helpfully" widened the cap to fit
the new rate would be the first real vulnerability in this system that was
designed in rather than found.

**KIP-9 has a floor and dollars do not know about it.** Storage mass puts about
0.02 KAS under any payment. A dollar price therefore has a KAS floor that moves
with the market, and a cheap enough service becomes unpayable when KAS falls. A
USD-priced listing must carry a stated minimum, and the quote engine must
refuse below the floor rather than emit a transaction that cannot land.

## Two placements, and only one of them is clean

### Funding-side: asset → KAS → `genesis`

    USDC.e (Igra) ──bridge──▶ KAS (L1) ──▶ genesis ──▶ funded grant

This happens **before any authority exists**. A failure is a failed purchase:
nobody is mid-payment, no grant is half-spent, and the worst case is that the
buyer holds the asset they started with. A bad rate means fewer KAS in the
grant — a bounded, visible loss, priced at the moment of purchase.

Nothing about the covenant's claims changes here, because the covenant is not
involved until the last step. **This path is fully honest and should ship
first.**

### Payment-side: grant → relay key → swap → seller's asset

    tx A   covenant spend   grant ──▶ successor grant
                                  └─▶ relay key (P2PK, exactly amount + fee)
    tx B+  ordinary         relay key ──▶ swap ──▶ seller's preferred asset

This is `RELAY.md`, extended. The grant must be created with `--relay` and the
agent's own key on the allowlist, so the manifest says in as many words: *this
agent may pay itself*. The cost is stated there and is unchanged: **once the
coin sits at a key the agent holds, the agent chooses the destination.**

Everything else the covenant enforces still enforces. What must never happen is
the router describing this path as though the allowlist reached the seller.

### Seller-side preference needs no protocol

A seller who wants USDC can receive KAS under the covenant and convert it
afterwards, with their own key, on their own schedule, bearing their own
timing risk. Warda is not in that path and should not volunteer to be. It is a
provider-SDK and dashboard feature — a published preference and a convenience —
not a routing obligation.

## What was argued down, and why it is recorded

**"Grant: $20 spending authority."** Impossible as stated; see above. It is
recorded because it is the most attractive idea in the proposal and it will be
proposed again.

**"Warda doesn't necessarily care where the KAS comes from."** This is the
sentence that hides the bridge. The router cares, the receipt says, and the
buyer can read it.

**Warda as the bridge.** No. Adapters wrap venues that already exist. The day
Warda holds the float is the day its security argument becomes a balance sheet.

**A single hosted router endpoint every payment depends on.**
`warda-network-registry.md` already settled the general case: *"Warda was down
so my agent couldn't pay" is the one sentence that destroys the
differentiator.* That was written about a discovery service which is not even
in the payment path. It applies with more force to something that is. The
router must be a library first and a hosted convenience second, and an agent
that already holds KAS must never touch it.

## Addendum, 17 September: what the bridge actually says

Written after reading Igra's KasExitBridge developer guide rather than
inferring from the architecture. Three facts, one of which changes what the
funding path is for.

**The exit call is**

    requestExit(string kasPayoutAddress, uint64 unlockAmountSompi) payable
      returns (uint32 requestId, bytes32 messageId)

**and `msg.value` must equal exactly `(unlockAmountSompi + feeAmountSompi) * 1e10`
wei.** That `1e10` is `WEI_PER_SOMPI` — 18 decimals of iKAS over 8 of KAS. The
conversion this package already computed is the one the contract demands, which
is confirmation rather than coincidence, and `assertExitAmount` also refuses an
amount that will not fit the `uint64`.

**The minimum exit is 1,000 KAS**, or `ExitAmountBelowMinimum`.

This is the fact that decides what funding-side routing is *for*. The appealing
story — an agent holding five dollars of USDC pays for a thirty-seven cent
service without ever touching Kaspa — cannot be served by crossing the bridge
for it, because the smallest crossing is larger than the whole grant. So:

> **Funding-side routing is a treasury operation.** Cross once at treasury
> scale, then fund many grants from what arrived. It is not per-agent
> micro-funding, and the product should not be described as though it were.

The grants drawn from that KAS are as small as anyone likes; it is only the
*crossing* that has a floor. That is still a real product — a CFO topping up an
agent fleet from a stablecoin balance — but it is a different one from the
pitch, and the difference should be found here rather than by a user.

**The bridge does not checksum the payout address.** Their guide is explicit
that the contract "only checks prefix + charset". So a transposed character is
a valid call and an irrecoverable payout to an address nobody holds.
`assertPayoutAddress` runs the SDK's `decodeAddress`, which verifies the
checksum, and `planFunding` throws rather than producing a plan — a bad payout
address is not a plan with a problem, it is a plan that must not exist. This is
the highest-value line in the package.

**Addresses: mainnet published, Galleon not.** The KasExitBridge proxy on Igra
mainnet (chain 38833) is `0x4bb88C213d3eD9dc4bae694f1bc1bF745903b2d0`,
published in their contract-addresses page. No Galleon testnet addresses are
published anywhere, for the bridge or for Zealous. Both are recorded here as
documentation and neither is a constant in source: `ops/check-router.mjs`
refuses an address literal in `router/src`, because a testnet-only project one
typo away from a mainnet bridge is a bad arrangement even when the address is
correct.

## Build order

1. **Quote engine.** Signed quotes, expiry, USD→sompi, KIP-9 floor, and the
   refusal when a rate move puts a payment over the cap. Testable with no
   liquidity at all, and it is where the trust vocabulary gets fixed.
2. **Route and hop model.** `Route = Hop[]`, each hop declaring zone and
   counterparty; receipts derive their labels from the hops. Venues are
   adapters behind this, so nothing is hardwired to Zealous, Igra or KCC-20.
3. **Funding-side path**, with the first real adapter.
4. **Payment-side path**, built on the existing relay rather than beside it.
5. **Guards**: refuse a receipt that claims enforcement for a hop the covenant
   did not constrain; refuse a USD amount reaching a field that holds a sompi
   limit.

## Open

- **Quote signing key and its custody.** A quote is attested, which means
  somebody's key. Whose, held where, and what a wrong quote costs them.
- **Bridge failure recovery.** The funding path can strand value mid-route.
  What retries, what refunds, and who is out of pocket while it resolves.
- **Whether a hosted quote endpoint is a dependency in disguise.** It is not in
  the payment path for an agent holding KAS. It is for an agent holding USDC.
  That asymmetry should be stated on the page, not discovered.
- **Slippage as an authority question.** A quote with 1% slippage is a range,
  and the covenant enforces a point. The cap must bind the worst case, not the
  quoted case.
