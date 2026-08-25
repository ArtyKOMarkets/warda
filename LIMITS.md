# Consensus limits — measured

Every number here was read out of the running script engine or out of
rusty-kaspa's own constants. None is estimated. This closes the last open
concern in the project.

## The three limits

| Limit | Constant | Warda uses | Headroom |
|---|---|---|---|
| Script size | `MAX_SCRIPTS_SIZE_POST_TOCCATA` = **1,000,000** bytes | 3,888 (depth 16) | **257×** |
| Compute budget | `ComputeBudget` is a **u16** → 65,535 units | **3** units | **21,845×** |
| Stack depth | `MAX_STACK_SIZE` = **244** slots | **107** | 2.3× |

Measured with `used_script_units()` and by taking the peak combined stack depth
from a per-opcode trace of an accepted spend.

## Detail

| maxProofDepth | bytes | script units | budget units | peak stack |
|---:|---:|---:|---:|---:|
| 4 | 3,036 | 22,602 | 3 | 107 / 244 |
| 8 | 3,320 | 24,314 | 3 | 107 / 244 |
| 16 | 3,888 | 27,738 | 3 | 107 / 244 |

## What this changes

**The size worry was misplaced.** DELEGATION.md flagged 3,320 bytes as risky
because it exceeded the 2,184-byte covenant KOMarkets runs on-chain. That
comparison was the wrong yardstick: 2,184 was a known-good *datapoint*, never a
ceiling. The actual ceiling is a million bytes, so the covenant uses 0.4% of it.

**Compute budget is a rounding error.** ~24,000 script units at 10,000 units per
budget unit is 3 units against a u16 max. KOM's `compute_budget = 1000` was
~300× more than needed, which is harmless but explains why nobody noticed the
real figure.

**Stack depth is the tightest constraint, and it is flat.** 107 of 244 slots,
and — the useful part — **it does not grow with proof depth.** The Merkle fold
reuses slots, so a 65,536-entry allowlist costs the same stack as a 4-entry one.
Depth is bounded by bytes and units, both of which have enormous headroom.

## Consequence

`maxProofDepth = 16` is comfortable, not marginal. The earlier recommendation to
stay at depth 8 was based on the wrong ceiling and can be dropped.

The remaining room is best spent on the covenant subset witness, which lets a
child genuinely narrow its allowlist rather than only inherit it. At ~2.3× stack
headroom that is the number to watch when adding it — not script size, and not
compute budget.
