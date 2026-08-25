# Delegation requires an architecture change

Status: **ADOPTED.** `covenant/warda_grant.sil` now carries authority in State
and passes **19/19** against the node engine — the original 15, plus four new
flips covering the attack surface the change created.

## The blocker

A child grant differs from its parent in budget, per-spend cap, epoch limit,
expiry, agent key and delegation depth. In the current covenant those are
**constructor parameters** — immutable, and baked into the scriptPubKey.

That makes a child a **different template** from its parent. And `DECL.md`
line 421 is explicit:

> `validateOutputStateWithTemplate` is available for manual cross-template
> routing, **not declaration lowering**.

So the `#[covenant]` declaration layer cannot validate a child output. Two ways
out:

1. **Write delegation manually** with raw `OpAuth*`/`OpCov*` plus
   `validateOutputStateWithTemplate` — giving up the declaration layer exactly
   where the docs say it exists to stop non-experts writing insecure covenants,
   on the most security-critical transition in the protocol.
2. **Move authority into `State`**, so parent and child are the same template
   with different state. Delegation becomes an ordinary 1:2 fanout.

(2) is the answer. (1) trades away the safety rail at the worst possible place.

## What it costs

Measured, not estimated:

| maxProofDepth | v1 (authority in ctor) | v2 (authority in state) | delta |
|---:|---:|---:|---:|
| 4 | 1,136 | 1,526 | +390 |
| 8 | 1,420 | 1,810 | +390 |
| 16 | 1,988 | 2,378 | +390 |
| 24 | 2,557 | 2,947 | +390 |

A flat **+390 bytes**, independent of proof depth — it is the nine
immutability assertions plus the wider state, not anything that scales.

Reference: KOMarkets runs a **2,184-byte** covenant on-chain. So v2 at depth 8
(1,810) is comfortably inside proven territory; depth 16 (2,378) is modestly
above it and probably still fine, but is no longer backed by a known-good
deployment.

**Recommendation: v2 at depth 8** — a 256-entry recipient allowlist, which is
far past any realistic agent, at a size smaller than something already running.

## What the change forces

Authority in state means `spend` must assert every authority field is
**unchanged** in the successor. That is not bookkeeping — without it an agent
rewrites its own per-spend cap in the successor state and every limit in the
protocol becomes decorative. It is the same class of hazard as the successor
budget check, and it did not exist while those fields were immutable ctor
params.

Nine new `require`s, all of the form `newState.X == X`.

## A consequence worth stating publicly

Since state is committed in the P2SH address (KOM bug #6), moving authority
into state means **the grant's address commits its authority as well as its
accounting**. The address *is* the grant.

That strengthens spec section 18: a counterparty verifying remaining budget is
not trusting an indexer, and not even reading a state blob — the address itself
is the commitment.

## Next

1. Port the harness ctor to v2 and re-prove all 15 tests
2. Add `delegate` as `#[covenant.fanout(to = 2)]`
3. Prove conservation on-chain: `parent.reserved += child.budgetTotal`, and no
   transaction that widens total authority
4. Then the honest version of `flip_successor_reserved_tampered` — a real
   delegated reserve that cannot be reclaimed


## Adopted — result

The port was mechanical for the harness (constructor order, a 13-field State)
and revealed nothing broken. All 15 original tests pass unchanged on v2.

Four tests were **added**, because v2 creates an attack that v1 made impossible
by construction: with authority in State, an agent can try to write *better*
authority into its own successor.

| New flip | Attempt | Verdict |
|---|---|---|
| cap raised | rewrite maxPerSpend to 100 KAS | rejected |
| allowlist swapped | replace recipientsRoot | rejected |
| expiry extended | push expiresAt out | rejected |
| budget inflated | raise budgetTotal | rejected |

Each spends a perfectly legal amount and only tampers with the successor's
authority half. Without the nine immutability guards every one of these would
succeed, and the protocol's entire claim would be false — an agent that can
raise its own cap has no cap.

Adopted at **maxProofDepth = 8, 1,810 bytes** — a 256-entry allowlist, smaller
than the 2,184-byte covenant KOMarkets already runs on-chain.

## Next

1. `delegate` as `#[covenant.fanout(to = 2)]` — parent continuation + child grant
2. Conservation proven on-chain: `parent.reserved += child.budgetTotal`, with no
   transaction that widens total authority
3. Attenuation flips: a child that raises any authority field above its parent
4. The honest `reserved` test — a real delegated reserve that cannot be reclaimed
