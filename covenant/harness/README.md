# warda-harness — covenant execution proof

Runs `warda_grant.sil` through `TxScriptEngine`, the **same script engine a
Kaspa node uses** to validate a transaction. No node, no RPC, no testnet
round-trip — a verdict in milliseconds.

```bash
cd covenant/harness
cargo test --test spend -- --nocapture   # the 33 flip tests
cargo run  --bin audit                   # the auditor, writing covenant/AUDIT.md
```

First build takes a few minutes (it fetches rusty-kaspa); after that it is
sub-second.

## Why this exists

`@warda_protocol/core` proves the **semantics** — what the rules mean. This proves the
**bytecode** — that the compiled covenant actually enforces them inside the
engine that matters. Between the two there is no room left for "submit to
testnet and see what happens".

The method is lifted directly from KOMarkets' bug #6 postmortem, which is the
technique that cracked a bug that testnet round-trips could not.

## Deliberate dependency choice

Depends on `kaspa-txscript` but **not** `kaspa-consensus`. The full consensus
crate pulls `librocksdb-sys`, which takes minutes to build and OOM-killed this
harness on the first attempt. The script engine is all we need.

Both kaspa and silverscript deps are **pinned by revision**. The Silverscript
repo states it "may introduce breaking changes without notice" — unpinned, a
compiler change could silently alter our bytecode between runs and we would be
debugging the wrong thing.

## Proven at bytecode level

Every one runs the compiled covenant through the node engine.

| Test | Verdict |
|---|---|
| covenant compiles, ABI as expected | the test prints the size; the assertion guards bloat at 4,200 bytes |
| harness reaches a real engine verdict | `UnsatisfiedLockTime` from reclaim CLTV |
| **overspend — 20 KAS against a 2 KAS cap** | rejected |
| zero amount | rejected |
| spend before `not_before` | rejected |
| **per-spend cap fires before the DAA lock** | proven by distinguishable verdicts |
| **a fully valid signed spend** | **ACCEPTED** — `Ok(())` |
| prompt injection to an unlisted payee | rejected |
| six single-field flips from that baseline | see below |

**33 tests.** The count is `grep -c '#\[test\]' tests/spend.rs`, and it is written
that way because the last two numbers in this file went stale without anyone
noticing — it said six tests, then fifteen, and both were a snapshot of an
afternoon. A figure nobody can re-derive is a figure that decays.

## It was dead for two covenant versions

**15 September 2026.** Run to collect figures for the site's evidence page, this
suite returned `constructor argument count mismatch` on 32 of 33 tests. Its
`ctor()` still declared itself *"v2 constructor order"* and passed 17
arguments; the covenant takes 21. v4 inserted `genesisTemplateId`,
`templatePrefixLen` and `templateSuffixLen` at 12..14, moving `maxProofDepth`
to 15 and every init field down by three, and added `initReserveRoot` at 20.

`covenant/deploy` was updated at the time and carries comments recording the
insertion. This file was not. Two copies of one argument list, and only one of
them was maintained — which is this repo's most expensive recurring shape,
now on its sixth appearance.

The covenant was never broken: every live grant was produced by the deploy
tool, against the current constructor. What was broken is the only thing that
proves the covenant at the bytecode level, and it was broken silently, because
a test suite nobody runs fails in a way nobody sees.

**So the rule this directory exists to serve now has a second half.** The first
was: prove the bytecode, not the semantics. The second is: a proof that is not
re-run is not a proof.

Both suites now run in CI — `.github/workflows/check.yml`, on every push and
pull request, plus a weekly schedule. The weekly run is not decoration: this
decayed across two covenant versions with nobody pushing to the covenant in
between, and the thing that moves underneath a pinned build is usually
somewhere else.

The overspend rejection is the product claim, now demonstrated in the same
engine a node runs — not reasoned about, not simulated.

## How the assertions are made meaningful

The engine collapses every failed `require` into one opaque `VerifyError` — it
never says which rule rejected. So `assert!(is_err())` against a baseline that
never passed proves nothing: the transaction might be refused for any reason at
all, a malformed sigscript included.

The suite closes that gap with **flip tests**. `flip_baseline_is_accepted`
establishes a spend the engine returns `Ok(())` for. Every other flip starts
from that exact transaction and changes **one field**:

| Flip | Field changed | Verdict |
|---|---|---|
| baseline | — | **accepted** |
| overspend | amount 0.5 → 20 KAS | rejected |
| unlisted recipient | payee absent from the allowlist tree | rejected |
| payment diverted | proof names an API, money goes elsewhere | rejected |
| successor not advanced | spend the money, do not record it | rejected |
| successor reserved tampered | reserved moved independently of the spend | rejected |

Because the baseline passes, a rejection can only be caused by the changed
field. That is what turns "the covenant refused this" into "the covenant
refused this **because of that rule**".

## Two gotchas already paid for

**Signatures are 65 bytes, not 64.** A 64-byte `sig` argument is rejected at
sigscript-build time with a type mismatch. This is KOM bug #1, and Silverscript
catches it at build time rather than on-chain — strictly better than finding it
in a rejected transaction.

**`TransactionInput::new` is the wrong constructor.** It sets a `SigopCount`
commit; a v1 covenant input needs a `ComputeBudget` commit via
`new_with_compute_budget`. This is KOM bug #5, and the trap is that the
obvious-looking function is the wrong one.

## Three type traps in the argument builders

Each cost a build cycle and none is documented:

- **`sig` is 65 bytes** — 64 is rejected as a type mismatch at sigscript-build
  time (KOM bug #1, caught early instead of on-chain)
- **`TransactionInput::new` sets a SigopCount commit** — v1 covenant inputs need
  `new_with_compute_budget` (KOM bug #5; the obvious constructor is wrong)
- **`byte[32][]` has no working helper.** `inferred_array` yields `byte[][]`;
  `TryFrom<Vec<Vec<u8>>>` yields `byte[32][N]` with a FIXED outer dimension.
  The parameter is dynamic-outer, so the `TypeRef` must be built by hand —
  see `byte32_array` in the test.

Plain `entry` functions use `build_sig_script`; `#[covenant]` policy functions
use `build_sig_script_for_covenant_decl`. Passing a plain entry to the covenant
builder panics.

## Three things live here now

| | |
|---|---|
| `src/lib.rs` | the builders — constructor lists, state, the Merkle tree, signing, the engine call |
| `tests/spend.rs` | 33 tests: an accepted baseline per entrypoint, then single-field flips |
| `src/bin/audit.rs` | the auditor — every claim in `GUARANTEES.md`, at its boundary |
| `src/bin/fuzz.rs` | the oracle that reads no claim at all |
| `src/bin/scan.rs` | the one pass that needs no builder, so it runs on anybody's `.sil` |
| `src/audit.rs` · `src/oracle.rs` | both instruments with the covenant taken out — see [PORTING.md](PORTING.md) |

The builders were inside `tests/spend.rs` until the auditor needed them. Copying
them would have been the eleventh instance of this repo's most expensive shape,
and this file has already paid for it once: `ctor()` declared itself "v2
constructor order" for two covenant versions while `covenant/deploy` moved on,
and 32 of 33 tests failed to compile with nobody watching. There is one copy.

## The auditor

```bash
cd covenant/harness
cargo run --bin audit          # exits 1 the moment a guarantee is violated
```

Three files, one run:

| | |
|---|---|
| `covenant/AUDIT.md` | the report in prose, for the repo |
| `covenant/AUDIT.html` | the printed report — one self-contained file, no network, no script |
| `covenant/audit.json` | the same run, for anything that reads rather than looks |

`AUDIT.html` is the one to send somebody. Open it and print to PDF, or:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf=covenant/AUDIT.pdf covenant/AUDIT.html
```

The PDF is not committed: it is derived from a run, and a binary that changes
on every run is a diff nobody can read.

**What it adds over the flip tests.** A flip proves a rule is *present* by
moving a field far outside it — 20 KAS against a 2 KAS cap. It cannot prove the
rule is in the *right place*. An off-by-one on a spending cap passes every test
in `tests/spend.rs` and is a defect with money behind it.

So every numeric rule is exercised one sompi either side of its boundary: the
tightest value that must be accepted and the loosest that must be refused. A
rule is reported `enforced` at *boundary* grade only when both land. Rules whose
refusal is attributable only because the case is one field from the accepted
baseline are reported at *flip* grade and named as such.

**What it does not do.** It does not declare the covenant secure. It reports
what was tested, where the bytecode and `GUARANTEES.md` disagree, and which
claims no constructed transaction could reach. The last list is in the report,
not omitted from it.

**The oracle is the published claim.** Each case quotes the sentence from
`GUARANTEES.md` it is checking, rather than a paraphrase. A paraphrase is where
an auditor starts agreeing with the thing it is auditing — the same shape as
"a fake written from an assumption agrees with the bug it was meant to catch".

**Where each boundary actually is** is the section worth printing. For every
numeric rule it draws the tightest value the engine accepted and the loosest it
refused, on one axis, ascending left to right — a lower bound mirrors rather
than relabels, so a larger number is never drawn to the left of a smaller one.
Both marks were executed; neither is inferred.

**The denominator is the published claims, not the cases.** `CLAIMS` in
`audit.rs` lists every enforcement row in `GUARANTEES.md` plus every `require`
in the two exits, and a claim nothing covers is printed as uncovered rather
than left out of the count. The first version said "15 of 15 rules enforced",
where the 15 in the denominator meant "rules I wrote cases for" — a figure that
can never go down, printed beside a paragraph honestly listing what was not
tested.

Current run: **118 cases, 38 of 39 published claims covered, 13 rules at a
measured boundary, 18 boundaries drawn, 0 violations, 0 over-refusals.**

The denominator went UP and the ratio went DOWN when settlement was added,
which is the whole point of having one: a figure that only ever improves is a
figure nobody should read.

## The oracle that reads no specification

```bash
cargo run --bin fuzz            # ~2 min; writes covenant/oracle.json
```

The auditor's ceiling is that its oracle is a document. This one has no
document. It generates spend attempts structurally — no rule consulted —
hands each to the engine, throws away everything refused, and asserts one
property of what is left:

> An accepted spend must not leave the agent able to do more than it could
> before, minus what it just paid.

Nobody has to have written that down for it to be true, and it is the shape of
three of the five recorded vulnerabilities: the covenant checked WHAT
something was and not HOW MUCH of it there was.

**Then it checks itself, and that part is not optional.** An oracle that has
never fired is indistinguishable from one that cannot, so the run ends by
deleting `require(currentEpoch >= prevState.epochIndex)` from the covenant —
vulnerability 1, `a048b13e95125ad1`, put back — and requires the same oracle to
catch it. It exits 2 if it does not, because a silent oracle makes every clean
result above worthless.

Current run: **768 generated, 61 accepted by the engine, 0 grew. Against the
mutant: 69 accepted, 8 grew** — an agent whose epoch allowance is exhausted
claims an earlier epoch and the whole allowance comes back, which is the
historical bug, found without consulting a single rule.

**A clean run of the CLAIMS suite is not a safety statement, and the report says why.** This
instrument checks bytecode against a written claim, so it cannot notice a rule
that should exist and does not — the document it reads its claims from is the
same one that would have omitted it. Of the five vulnerabilities this covenant
has had, none would have been caught by it.

## The pass that needs no builder

```bash
cargo run --bin scan -- path/to/covenant.sil
```

The claims suite and the oracle both need per-covenant code. This does not. It
parses the contract, synthesises a constructor from the declared parameter
types, compiles it, and reports what is true of the artefact: the ABI, the
state layout, the size against the consensus ceiling, and **every condition it
refuses on, taken from the AST and grouped by the entrypoint that enforces
it** — 113 of them for this covenant, against the 39 its documentation names.
The difference is what nobody has written down. Not necessarily a defect, and
not necessarily not.

It also reports **which constructor arguments move the script size**, by
doubling each integer in turn and recompiling. For this covenant exactly one
does: `maxProofDepth`. A size or headroom figure quoted without its
constructor is not a figure about the covenant.

**This pass reports that cost as "+568 bytes per doubling", and that phrasing
is a trap it laid for itself.** The scan doubles each integer once, from 4 to
8, and +568 is what that step costs. The cost is not per doubling, it is
**linear in depth — 142 bytes a level** — so the next doubling, 8 to 16, costs
+1,136 and the one after +2,274. Anyone reasoning "depth 16 is two doublings,
so +1,136" is out by a third; it is +1,704. `cargo run --release --bin size`
prints the table this was measured from.

`PHASE0.md` measured ~71 bytes a level, on the pre-v4 covenant. This is 142.
The factor of two is **not explained here** — it is recorded so that whoever
needs the real number measures it rather than inheriting either figure.

| depth | payees | cost over depth 4 |
|---:|---:|---:|
| 4 | 16 | — |
| 8 | 256 | +568 |
| 16 | 65,536 | +1,704 |
| 32 | 4.3B | +3,978 |

The first version of this pass reported 148,634 bytes, because its placeholder
for every integer was 1,000 and `maxProofDepth` is a loop bound. The number was
not wrong; it was the size of a covenant nobody asked about, which is worse
than wrong, because it looks like an answer.

## Auditing something other than Warda

`src/audit.rs` and `src/oracle.rs` know nothing about Warda: boundaries,
grading, claim coverage, the three reports, the mutation self-check and the
verdict are all generic. `src/bin/audit.rs` and `src/bin/fuzz.rs` are the
covenant-specific half and the worked example of it.

What cannot be config is building a valid transaction for a covenant's
entrypoints — that is the covenant's design, not a parameter of it.
[PORTING.md](PORTING.md) names the five things a second covenant supplies and
is honest about that one.

## What is still not proven here

- One `settle` claim — that output 0 is the co-input grant's single authorised
  continuation. The baseline builds exactly that shape, so no transaction here
  has it as the only thing wrong.
- The subset witness — a child narrowing its allowlist to a subtree.
- Anything above the script engine: mempool policy, relay rules, or what a
  wallet does with a transaction before it is broadcast.

Each vector in `vectors/vectors.json` asserted against the engine is the next
piece, and it is now a small one: the auditor already builds and runs cases.
