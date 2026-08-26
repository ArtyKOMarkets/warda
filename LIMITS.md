# Consensus limits — measured

Every number here was read out of the running script engine or out of
rusty-kaspa's own constants. None is estimated. This closes the last open
concern in the project.

## The three limits

| Limit | Constant | Warda uses | Headroom |
|---|---|---|---|
| Script size | `MAX_SCRIPTS_SIZE_POST_TOCCATA` = **1,000,000** bytes | 3,888 (depth 16) | **257×** |
| Compute budget | `ComputeBudget` is a **u16** → 65,535 units | **13** units | **5,041×** |
| Stack depth | `MAX_STACK_SIZE` = **244** slots | **107** | 2.3× |

Measured with `used_script_units()` and by taking the peak combined stack depth
from a per-opcode trace of an accepted spend.

## Detail

| maxProofDepth | bytes | script units | budget units | peak stack |
|---:|---:|---:|---:|---:|
| 4 | 3,036 | 22,602 + 100,000 | 13 | 107 / 244 |
| 8 | 3,320 | 24,314 + 100,000 | 13 | 107 / 244 |
| 16 | 3,888 | 27,738 + 100,000 | 13 | 107 / 244 |

## What this changes

**The size worry was misplaced.** DELEGATION.md flagged 3,320 bytes as risky
because it exceeded the 2,184-byte covenant KOMarkets runs on-chain. That
comparison was the wrong yardstick: 2,184 was a known-good *datapoint*, never a
ceiling. The actual ceiling is a million bytes, so the covenant uses 0.4% of it.

**Compute budget — CORRECTED after deployment.** The first figures here were
measured wrong, and the error is worth recording.

The harness runs `TxScriptEngine` with `sigop_script_units: 0`, which zeroes the
signature charge. So the ~24,000 script units it reported were the covenant's
*arithmetic and Merkle fold only* — none of its cryptography.

**One signature verification costs 100,000 script units**
(`GRAMS_PER_SIGOP_COUNT_UNIT` 1000 × `SCRIPT_UNITS_PER_GRAM` 100), which dwarfs
everything else. Real total is ~124,000, or **13 budget units** against a u16
ceiling of 65,535. Still comfortable — ~5,000× rather than ~21,845× — but the
published number was wrong.

The lesson is not the arithmetic. It is that a measurement taken with a flag set
to a convenient value measures the flag, not the system. `sigop_script_units: 0`
was copied from the compiler's own test helpers without asking what it
suppressed. Confirmed on-chain: genesis needs 12 units, a covenant spend 16.

Compute budget is charged as MASS, so this cuts both ways — over-provisioning is
not a free safety margin. KOM's `compute_budget = 1000` demands a ~10 KAS fee
per covenant transaction.

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
