# Consensus limits — measured

Every number here was read out of the running script engine or out of
rusty-kaspa's own constants. None is estimated. This closes the last open
concern in the project.

## The three limits

| Limit | Constant | Warda uses | Headroom |
|---|---|---|---|
| Script size | `MAX_SCRIPTS_SIZE_POST_TOCCATA` = **1,000,000** bytes | 8,616 (depth 16) | **116×** |
| Compute budget | `ComputeBudget` is a **u16** → 65,535 units | **16** units | **4,096×** |
| Stack depth | `MAX_STACK_SIZE` = **244** slots | **118** | 2.07× |

**Re-measured 15 September 2026, against v4.** Every figure below it had gone
stale: the harness that produces them had not compiled the covenant since v2,
so the previous table described a covenant two versions old. The covenant grew
— it roughly doubled in bytes and gained eleven stack slots — and none of that
was visible while the suite was broken.

Measured with `used_script_units()` and by taking the peak combined stack depth
from a per-opcode trace of an accepted spend.

## Detail

| maxProofDepth | bytes | script units | budget units | peak stack |
|---:|---:|---:|---:|---:|
| 4 | 6,912 | 47,234 + 100,000 | 15 | 118 / 244 |
| 8 | 7,480 | 50,650 + 100,000 | 16 | 118 / 244 |
| 16 | 8,616 | 57,482 + 100,000 | 16 | 118 / 244 |

Produced by `report_compute_budget_consumption` in
`covenant/harness/tests/spend.rs`, which **asserts** them now rather than
printing them. A printed number is a number nobody reads, and this table proved
it: the figures above replace 6,976 / 7,544 / 8,680 bytes and 47,618 / 51,034 /
57,866 units — out by sixty-four bytes and three hundred and eighty-four units,
consistently, at every depth. The deployed template's own `baselineHex` is
6,912 bytes, so the old table was describing a build nobody has.

**The `+ 100,000` in this table is the signature, and it is most of the cost.**
`report_compute_budget_consumption` used to print `budget_units` from script
units alone — the same `sigop_script_units: 0` mistake corrected below, giving
5 and 6 where the real figures are 15 and 16. It now prints `budget_units_REAL`
with the signature included and `bare_no_sigop` beside it, named.

**15, 16, 16.** These were computed by hand, because the line that prints them
directly had never run — it was added in a commit that did not compile, one
commit after the run that produced everything above.

It has run now, and the hand arithmetic was right. The measurements printed
beside it were not, which is the opposite of the failure anybody was watching
for: the derived figures survived and the raw ones went stale. All four columns
are pinned in the test as of 25 September, so the next time any of them moves
the suite fails and names this file.

Only at the default grant shape. The constructor bakes the budget and the caps,
and an integer of another width is a different bytecode — a run under
`WARDA_BUDGET` is measuring a different covenant, correctly, and the pins skip
rather than fail. See `covenant/SHAPES.md`.

**The on-chain cross-check now agrees.** This file already recorded that a
covenant spend needs 16 units on chain, against a harness that said 13 — a
discrepancy nobody chased. At v4 the harness gives 16. The chain was right, and
the gap was the stale suite.

## What this changes

**The size worry was misplaced.** DELEGATION.md flagged 3,320 bytes as risky
because it exceeded the 2,184-byte covenant KOMarkets runs on-chain. That
comparison was the wrong yardstick: 2,184 was a known-good *datapoint*, never a
ceiling. The actual ceiling is a million bytes, so the covenant uses 0.86% of it.

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

**Stack depth is the tightest constraint, and it is flat.** 118 of 244 slots,
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
