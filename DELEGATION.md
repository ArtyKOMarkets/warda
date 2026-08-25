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

## DONE — delegation is proven

`delegate` is a `#[covenant.fanout(to = 2)]`: parent continuation at auth
output 0, child grant at auth output 1. **31/31 against the engine.**

### Conservation

The spec's strongest structural claim, now demonstrated rather than asserted:

| Test | Attempt | Verdict |
|---|---|---|
| baseline | properly attenuated child | **accepted** |
| no reserve | child gets 25 KAS, parent reserves 0 | rejected |
| under-reserve | parent reserves child.budget − 1 | rejected |
| over-reserve | parent reserves child.budget + 1 | rejected |

The first attack is the one that would break the protocol outright: a tree
holding 125 KAS of authority against 100 KAS of budget. The other two prove the
covenant uses an equality, not an inequality — over-reserving is *safe* for the
principal, and still rejected, because a covenant that tolerates it has a sloppy
comparison somewhere that a subtler attack will find.

**Real value moves with authority.** A child holding authority but no coins
could not pay anyone; a child holding coins with no reserve against the parent
would double the tree's authority. `reserved` is what keeps the state and the
UTXO split aligned.

### Attenuation

Eight flips, each narrowing one axis the wrong way: per-spend cap, epoch limit,
expiry, not-before, delegation depth, recipient root, pre-spent accounting, and
a budget larger than the parent still holds. All rejected.

### Allowlist inheritance only

The covenant enforces `child.recipientsRoot == recipientsRoot`. Set inclusion
is not decidable from a Merkle root, so equality is the only relation
enforceable on roots alone. Narrowing a child's allowlist needs the per-member
subset witness `@warda/core` already implements — that is not in the covenant
yet, and it is the obvious next increment.

## SIZE RISK — the one open concern

| maxProofDepth | spend only | with delegation |
|---:|---:|---:|
| 4 | 1,526 | 3,036 |
| 8 | 1,810 | **3,320** |
| 16 | 2,378 | 3,888 |

Delegation costs a flat ~1,510 bytes. That puts the full covenant **well above
the 2,184-byte covenant KOMarkets is proven to run on-chain.**

Script size and compute-budget limits are still undocumented, so this headroom
is *assumed, not known* — the one place in the project where a claim rests on
something unmeasured. Depth 8 is the safer default. Establishing the real
ceiling is now the highest-value unknown left, above any further feature work.

## Next

1. **Measure the actual script size / compute budget limit.** Everything else
   is guessing until this exists.
2. Subset witness in the covenant, so a child can genuinely narrow its allowlist
3. Multi-level delegation: grandchild attenuating against a child
4. Revocation semantics with live descendants
