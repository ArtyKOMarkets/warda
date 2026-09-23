# Auditing a covenant that is not this one

Two instruments live here, and both are covenant-neutral except for one thing
each. This file says exactly which thing, because a tool that claims to be
general and is not wastes more of your time than one that never claimed it.

| | Generic | Yours |
|---|---|---|
| `src/audit.rs` | boundaries, grading, coverage, the three reports | the claims, the cases, the `Subject` |
| `src/oracle.rs` | "authority never grows", the mutation self-check, the verdict | a `Capacity` reading of your state |
| `src/lib.rs` | the engine call, the compile cache, `source_without` | how to build a transaction for your entrypoints |

`src/bin/audit.rs` and `src/bin/fuzz.rs` are the worked example of the right
column. They are 455 and 190 lines, and most of that is prose.

## What cannot be config, and why

Building a valid transaction for an arbitrary covenant's entrypoints is code.
Not because nobody has written the config format yet — because the shape of a
covenant's transaction IS its design: how many outputs, which one carries the
continuation, what its address commits to, which arguments the sigscript takes
and in what order. A TOML file pretending to describe that would be a lie that
falls apart on the second covenant to try it.

So: you write a builder. Everything downstream of the builder is already here.

## The five things you supply

**1. A builder.** One function that takes the levers you want to move and
returns `Result<(), TxScriptError>` from `execute()`. `Spend::run` in
`src/lib.rs` is the example: every field the covenant reads is a field on the
struct, and `valid()` returns a transaction the engine accepts. That last part
is load-bearing — a refusal only means something when the transaction it was
flipped from is accepted.

**2. Claims.** A `&[Claim]`, one per enforcement claim your documentation
makes, each naming the rule family that exercises it. This is your report's
denominator. Quote the sentence rather than paraphrasing it: a paraphrase is
where an auditor starts agreeing with the thing it is auditing.

**3. Cases.** `case(...)` for a single-field flip from the accepted baseline,
`probed(...)` when the rule has a number line and you can stand one unit either
side of it. Probed pairs on the same axis are what become the boundary marks;
two rules sharing an axis name is an assertion failure, not a silent merge.

**4. A `Subject`.** The identifying line, the document the claims came from,
where the three files go, and — the part worth taking seriously — `untested`
and `caveat`. Those are the sections a reader trusts the rest of the report
because of. Leave them thin and you have a sales sheet.

**5. A `Capacity`.** For the oracle: `spendable` (what the holder may still
cause to be paid) and any other named figure where HIGHER means "can do more".
Negate anything where higher means less — Warda passes `-epoch_index`, so
"epochs not yet consumed grew" is the ratchet failing, in the library's own
words.

Anything your accounting needs beyond those two rules is a predicate you write
yourself and append. Warda has three, all about epochs, all in `fuzz.rs` rather
than in the library — because a library that claimed to know every covenant's
accounting would be guessing.

## The self-check is not optional

`oracle::verdict` exits **2** if the mutant run comes back clean, and that is a
harder failure than a finding against the real covenant. Pick a `require` your
covenant genuinely depends on, hand it to `source_without`, and make sure your
oracle catches its absence. An oracle that has never fired is indistinguishable
from one that cannot, and every green number beside it is then worth nothing.

Warda deletes `require(currentEpoch >= prevState.epochIndex)`, which
reintroduces a vulnerability it actually had. If your covenant has a history,
use it. If it does not, delete the check that would hurt most.

## What this will not tell you

It checks bytecode against a written claim, and it checks one property that
needs no claim. It cannot notice a rule that should exist and was never
written, unless that rule's absence lets authority grow. Of the five
vulnerabilities Warda's covenant has had, the claims suite would have caught
none and the oracle catches one.

Say that in your own report. The tool prints the sections for it; what goes in
them is yours.
