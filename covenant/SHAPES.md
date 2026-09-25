# One shape, and what happened when it stopped being one

`covenant/AUDIT.md` has listed the same hole in its own "what this run did not
test" since the first report:

> **One grant shape per run.** Every case here runs against a single
> parameterisation — 100 KAS, a 2 KAS per-spend cap, delegation depth 2, a
> 4-member allowlist, `maxProofDepth` 4. Whether the same boundaries hold at
> another shape — a one-sompi budget, a different delegation depth — is
> untested by *this* run.

It was untested because it was untestable. Six of those numbers were `pub
const`, and the same seven values were written out twice more — as literals in
`ctor_full`, and a third time in `authority_fields`. Three copies of one shape,
which held only because nobody had ever changed it, which was itself the reason
nobody ever changed it.

Every axis is an environment variable now:

    WARDA_BUDGET  WARDA_MAX_PER_SPEND  WARDA_EPOCH_LIMIT  WARDA_EPOCH_LENGTH
    WARDA_NOT_BEFORE  WARDA_EXPIRES_AT  WARDA_DELEGATION_DEPTH
    WARDA_TREE_LEAVES  WARDA_PROOF_DEPTH

## The result

**No covenant defect at any shape.** Zero violations everywhere the suite has
an accepted baseline.

| shape | baseline | claims covered | violations | over-refusals |
|---|---|---:|---:|---:|
| default — 100 KAS, 2 KAS cap, depth 2 | yes | 39 of 40 | **0** | 0 |
| budget 10^15, cap 10^13 | yes | 38 of 40 | **0** | 1 |
| delegation depth 1 | yes | 34 of 40 | **0** | 11 |
| delegation depth 4 | yes | 39 of 40 | **0** | 0 |
| epoch length 1 | yes | 31 of 40 | **0** | 15 |
| epoch limit == budget | yes | 39 of 40 | **0** | 0 |
| window 8× longer | yes | 39 of 40 | **0** | 0 |
| allowlist 2 … 256, proof depth 2 … 16 | yes | 39 of 40 | **0** | 0 |
| budget 1,000 sompi | **no** | — | — | — |
| per-spend cap 1 sompi | **no** | — | — | — |
| epoch length 100,000 | **no** | — | — | — |
| one-block window | **no** | — | — | — |

A row with no accepted baseline reports nothing, and its counts are not in this
table even though the tool prints them. `AUDIT.md` opens by saying why: a
rejection means something only when something else was accepted. Four of these
shapes are internally incoherent rather than interesting — a grant whose epoch
is longer than its whole window, or whose per-spend cap is a sompi while its
cases pay half a KAS — and a suite that cannot build one valid transaction at a
shape has not tested that shape, whatever its output columns say.

## What it found was the instrument

Three shapes reported **violations** on the first run — the serious direction,
the covenant accepting what the guarantees forbid. Every one of them was the
harness.

**Three at `epoch length 1`.** The epoch cases place a spend with
`at(e) = notBefore + e * epochLength + 500`, which is "somewhere inside epoch
e" only while an epoch is 1,000 DAA long. At length 1 the same expression is
epoch 500, so the case labelled *"an EARLIER epoch — the v1 allowance reset"*
was claiming a LATER one, the ratchet correctly permitted it, and the suite
recorded the covenant accepting a replayed epoch. It is now `mid_epoch(e)`,
derived from the length.

**One at budget 10^15.** `IN_VALUE`, the coin in the grant's own UTXO, was
pinned at 10^10 while the budget was a hundred thousand times that. Every case
about money then built a transaction whose outputs the harness silently clamped,
so the covenant was handed something the case never meant. The coin follows the
budget now, which is the relationship a real grant has.

**One more at budget 10^15, and it survived both fixes.** The delegation-budget
case says *"a parent that has already spent 60 and reserved 15 of 100 has 25
left"* — and wrote 60, 15 and 25 as KAS literals. At a budget of ten million
KAS a 25-KAS child is nowhere near the remainder, the covenant accepted it
correctly, and the case's expectation had been computed from a budget the run
did not have. Written as fractions of the budget now.

The pattern is one thing three times: **a relationship expressed as a literal
is a relationship that holds at one shape.** None of the three was visible
while there was only one shape to run.

## What is still welded

Being specific, because a list that says "fixed" and means "mostly" is worse
than no list:

- `src/v5.rs` and `src/bin/c1.rs` carry their own `in_value` of 10^10, so the
  v5 suite and the golden vector run at the default budget whatever the
  environment says. The golden vector MUST — it is a fixture pinned to the
  deployed template — but the v5 suite need not.
- `Settle`'s parent holds `50 * KAS` by construction.
- The over-refusals at `depth 1` (11) and `epoch length 1` (15) are almost
  certainly more of the same, in cases nobody has walked through yet. They are
  the mild direction — the covenant refusing what the spec permits — and they
  have not been chased to zero.

## Running it

    cd covenant/harness
    WARDA_BUDGET=1000000000000000 cargo run --release --bin audit

The report prints the shape it ran in its subject line. A number from this
suite that does not come with its parameterisation cannot be compared to
anything, including to itself from last week.
