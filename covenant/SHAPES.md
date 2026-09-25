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

**No covenant defect at any shape.** Every shape that can express the suite's
cases reports 40 of 40 claims covered, zero violations and zero over-refusals —
including v5's `delegate2`, which is measured here for the first time.

| shape | claims | violations | over-refusals | `delegate2` |
|---|---:|---:|---:|---|
| default — 100 KAS, 2 KAS cap, depth 2 | 40 of 40 | **0** | 0 | baseline + 11 flips |
| budget 10^15, cap 10^13, epoch 10^14 | 40 of 40 | **0** | 0 | baseline + 11 flips |
| delegation depth 1 | 40 of 40 | **0** | 0 | baseline + 11 flips |
| delegation depth 4 | 40 of 40 | **0** | 0 | baseline + 11 flips |
| epoch length 1 | 40 of 40 | **0** | 0 | baseline + 11 flips |
| epoch limit == budget | 40 of 40 | **0** | 0 | baseline + 11 flips |
| window 8× longer | 40 of 40 | **0** | 0 | baseline + 11 flips |
| allowlist 2, proof depth 2 | 40 of 40 | **0** | 0 | baseline + 11 flips |
| allowlist 256, proof depth 16 | 40 of 40 | **0** | 0 | baseline + 11 flips |
| budget 1,000 sompi | *incoherent* | — | — | baseline + 11 flips |
| epoch length 100,000 | *incoherent* | — | — | baseline + 11 flips |
| one-block window | *incoherent* | — | — | baseline + 11 flips |
| per-spend cap 1 sompi | 14 of 40 | 0 | 16 | baseline + 11 flips |

`delegate2` has an accepted baseline and eleven refused flips at **every** shape
in the table, including the three the spend suite cannot express — it delegates
rather than pays, so a budget smaller than the baked `maxFee` does not stop it
being asked the question. Its settlement through v4's unchanged `reabsorb`
works at every shape too, in order, and is refused out of order at every shape.

The generative oracle (`bin/fuzz-delegate2`) agrees: 92 attempts generated at
each shape, 18 accepted (28 at budget 10^15, where more of them fit), and
**authority grew in zero** at every one.

### "Incoherent" is now the instrument's word, not the reader's

The previous version of this table had four rows with no accepted baseline, and
it decided that by hand — somebody noticed the baseline was refused and wrote
*"reports nothing"* in the margin. That is not good enough, and one shape
proved it: at a 1,000-sompi budget the delegation baseline IS accepted, so the
suite runs to the end and reports **two violations** — the covenant accepting
what the guarantees forbid, which is the serious direction.

Both were arithmetic. `maxFee` is 5,000,000 sompi and it is *baked into the
bytecode*, so it cannot follow `WARDA_BUDGET`: a different fee is a different
covenant. The two exit-conservation cases are written as "one sompi more than
`maxFee` burned", which at that shape is more money than the grant has ever
held. The case cannot express what it means, so its verdict means nothing.

`shape_incoherence()` says so itself now, before the run rather than after, and
names the arithmetic. Three shapes trip it. The fourth — per-spend cap 1 sompi
— is left in the table with its real figures because its problem is different
and is listed under *still welded* below.

## What it found was the instrument, nine times

Three literals were found the first time this matrix was run. Six more were
found the second time, when the suite reached `delegate` and `delegate2` at
shapes it had never been asked about. Every one is the same mistake:

> **a relationship expressed as a literal is a relationship that holds at one
> shape.**

1. **The epoch position** was a fixed DAA offset — `notBefore + e*epochLength +
   500` — which is "inside epoch e" only while an epoch is 1,000 long. At
   length 1 the case labelled *"an EARLIER epoch"* was claiming a later one.
   Now `mid_epoch(e)`, derived from the length.
2. **The coin in the spend builder** was pinned at 10^10 while the budget moved.
3. **A delegation case's arithmetic** — *"spent 60 and reserved 15 of 100 has 25
   left"* — was written with 60, 15 and 25 as KAS literals.
4. **`Child::narrower()`** was seven literals: 25 KAS, a 1 KAS cap, `depth: 1`.
   They are a quarter, a half and one-less of the *default* parent and nothing
   in particular of any other — so at `WARDA_DELEGATION_DEPTH=1` the "narrower"
   child was not narrower at all and every delegation was refused. This is the
   whole of the eleven over-refusals the previous table recorded at depth 1 and
   filed under *"almost certainly more of the same, in cases nobody has walked
   through yet."* It was exactly that. Depth 1 is now 0.
5. **The child's `epochLength` was the literal 1,000 in six places** across
   `lib.rs`, `v5.rs` and `bin/c1.rs` — in the state, in the constructor and in
   the child-identity hash. The covenant refuses a child wider than its parent,
   so at epoch length 2, 10, 100 or 7,000 **every delegation was refused** and
   only the default passed. That is the fifteen over-refusals the previous
   table recorded at epoch length 1. It is now 0, and 40 of 40.
6. **The v5 flip suite's money cases** were KAS literals against a 100 KAS
   parent — *"60 KAS already reserved, 5 + 5"*, two 30 KAS children, a 500 KAS
   cap "above the parent's 2 KAS". At budget 10^15 three of them reported
   violations. Fractions of the budget now.
7. **The coin in the DELEGATION builder** was a second copy of number 2, pinned
   at 10^10, and it was missed when the first was fixed. It is why every v4
   delegation case over-refused above a budget of 4×10^10 — which is precisely
   where a child taking a quarter of the budget stops fitting inside a parent
   holding ten billion sompi whatever it claims. The covenant was refusing an
   impossible transaction, correctly, twelve times.

None of the nine was visible while there was only one shape to run. The default
shape's output is byte-identical before and after all of them, which is how we
know none of them moved the thing being measured: the fractions produce the
same numbers at the shape they were written for.

## What is still welded

Being specific, because a list that says "fixed" and means "mostly" is worse
than no list:

- **`bin/audit.rs`'s spend amounts are literals.** The baseline pays 0.5 KAS
  and the budget cases use `room = 150_000_000` — 1.5 KAS — with a comment
  saying it is "inside the per-spend cap", which it is only while the cap is
  2 KAS. This is the whole of the `per-spend cap 1 sompi` row: sixteen
  over-refusals, none of them the covenant. It is a real gap and it is not
  flagged as incoherent, because "the cap is below 1.5 KAS" describes plenty of
  grants a person would actually issue.
- **`maxFee` cannot be a shape variable.** It is a constructor argument baked
  into the bytecode, so varying it is varying the covenant. Every shape below
  5,000,000 sompi therefore cannot express a conservation case, and
  `shape_incoherence()` says so rather than reporting.
- **The golden vector refuses to be written at a non-default shape.** That is
  deliberate: a suite may run anywhere, a fixture pinned to the deployed
  template may not. `bin/c1.rs`'s `emit_golden` exits 2 and says why.
- **`Settle`'s parent holds half the budget by construction** rather than by
  the case saying what it needs.

## Running it

    cd covenant/harness
    WARDA_DELEGATION_DEPTH=1 cargo run --bin audit
    WARDA_EPOCH_LENGTH=1     cargo run --bin c1
    WARDA_BUDGET=1000000000000000 WARDA_MAX_PER_SPEND=10000000000000 \
      WARDA_EPOCH_LIMIT=100000000000000 cargo run --bin fuzz-delegate2 --no-mutants

`--no-mutants` is for the matrix only: the mutants prove the oracle can fire,
which is not a property of the shape, and each one is a different source and so
a full recompile. CI runs without it.
