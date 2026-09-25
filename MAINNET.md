# Before mainnet

`test/key-separation.test.ts` has said, since the day it was written, that a
broken grant "was already on the before-mainnet list." There was no such list.
This is it.

It exists for three readers. For us, so that "are we ready" has an answer that
is not a feeling. For a reviewer, so that the hours we pay for go into the
covenant's logic rather than into working out what we claim. And for anyone
deciding whether to fund the review, because *here is precisely what stands
between this and real money* is a more honest pitch than a demo.

**Nothing here is invented.** Every item was already written down somewhere in
this repo, usually by the person who built the thing and knew what was wrong
with it. This file collects them and orders them. The citations are checked in
CI by `ops/check-mainnet-refs.mjs`: a reference that has drifted fails the
build, because a list whose pointers have rotted is worse than no list.

## How to read an item

Each one says what is wrong, where the repo already admits it, and **what done
means** — a condition somebody else could check, not an intention.

---

## The decision that orders everything

**The audit target is v5, and there is no v6.**

The plan was to freeze a v6 at the end of the hardening. The alternative had
been to freeze first and harden around a fixed covenant, and we chose not to
for one reason: hardening will find things in the covenant, and a version
frozen before the looking is a version that gets audited with the findings
still in it.

**The hardening found nothing in the covenant.** Every defect it turned up was
in the instruments measuring it — nine welded literals in the harness, an
audit suite reporting a rule it was not testing, a lockdown tool proving one
refusal and claiming four, a checker that ran after its own exit. The covenant
came through all of it unchanged, at thirteen grant shapes, across five
entrypoints under the generative oracle, with zero authority growth.

So there is no v6 to freeze. `covenant/harness/src/bin/frozen.rs` measures the
thing that decides it — three comment-only mutations of the source compile to
byte-identical bytecode, 10,375 bytes with the same state-region geometry — so
a covenant differing from v5 only in what its header says about itself has v5's
fingerprint, v5's template and v5's addresses. Naming it v6 would put a version
number in `covenant/versions.json` that no bytecode backs, in the one file
whose whole purpose is that every line of it re-derives.

The frozen covenant is **v5**, `157b64e3eeea9c01`, and the migration is real
regardless: v4 is 6,912 bytes and v5 is 10,375, so every live grant's address
moves. `covenant/MIGRATION.md` is the inventory and the order.

The cost is not hidden. `covenant/V5.md:21` — *"Every change strands every live
grant. The script is P2SH-committed, so the address is the template."* Freezing
v6 means one deliberate migration of everything that exists — the fourteen
manifests, the demo grant behind /attack, the agent fleet, the registry
listings, the coordinator on /one-job — at a moment we pick rather than one
that happens to us. v4 stays live throughout. v5 is a draft that proved
`delegate2` works on chain and is not a migration target.

The cost turned out smaller than this said, and the number is worth having
before any of it is scheduled. Twenty-two distinct v4 grants exist; four have
already expired; four more expire within a day; **six outlive a
hundred-and-twenty-day horizon**, and those six are the only ones for which
"migrate" and "wait" are different plans.

**The freeze is done** (25 September 2026). `sdk/covenant-template.json` is
v5's bytecode, v4's is archived under its own name, and `covenant/versions.json`
records v5 as current and v4 as superseded.

It took one thing that was not the covenant. Nothing here resolved a template
by the fingerprint in a manifest — the SDK, the hosted verifier, `site/build.py`
and the extension each loaded "the packaged template" and derived from it,
which is correct for exactly as long as one covenant has live grants under it.
The first attempt at the flip was reverted because `test/buy-e2e.test.ts`
failed, deriving a different address for the demo grant. That was the test
being right.

`templateForManifest` resolves it now, and every consumer that holds a manifest
uses it: the hosted verifier, the MCP bridge, the in-browser verifier on
`/verify`, the extension's vault, and the reference vectors — which now record
the covenant that compiled them, so the evidence that this SDK matched the Rust
compiler for v4 survives v4 being superseded. `ops/check-goldens.mjs` keeps
that field there and `ops/check-deploys.mjs` makes each deployed function carry
every archived template, because resolution the deployment cannot satisfy is
resolution that refuses grants it should answer for.

The vectors themselves were regenerated under v5 and the SDK reproduces every
one byte for byte, so the cross-implementation check covers the covenant that
is current. v4's are kept beside them as `sdk/golden-*-v4.json` and still
checked by `sdk/test/golden-v4.test.ts`: regeneration retires the old evidence
silently, and eighteen grants remain spendable only through v4's template for
another two hundred days.

**Done means:** one covenant fingerprint, every live grant carrying it,
`covenant/versions.json` recording the rest as history, and no entry in
`GUARANTEES.md` marked *draft, unaudited*. Three of those four are true. The
second is the migration.

**Still open:**

- **The migration itself** (`covenant/MIGRATION.md`), blocked on the offline
  principal (§2.1, yours) — reissuing before that exists spends the one
  opportunity this migration creates.

---

## 1. The covenant

### 1.1 Extend the oracle that reads no specification

The most valuable instrument in this repo is `covenant/AUDIT.md:268`: generate
spend attempts structurally, discard everything the engine refused, and assert
one property of what is left — an accepted spend must not leave the agent able
to do more than it could before, minus what it just paid. 768 generated, 61
accepted, authority grew in 0. With the epoch ratchet deliberately removed it
fires on 8, which is how we know it can.

It covered `spend` and nothing else — which is to say it did not cover
delegation, the newest and least-reviewed surface in the protocol.

**`delegate` is covered now** (`covenant/harness/src/bin/fuzz-delegate.rs`, in
CI). A delegation pays nobody, so the parent and its child together must not be
able to do anything the parent could do alone — and "anything" is the work:
money is one axis, and a bigger single payment, a wider epoch allowance, a
longer life, an earlier start and a deeper subtree are five more. An oracle
that counted only sompi would have watched every one of those go past. Three
holes are put back, one per axis, and all three are caught; against the
covenant as written, none of 31 accepted delegations left the tree better off.

**`settle` is covered too** (`covenant/harness/src/bin/fuzz-settle.rs`, in
CI), and it found something on the way in. Three cases in `covenant/harness/src/bin/audit.rs` claimed
to prove that everything about a parent stands still across a settlement, and
all three were being refused for the successor's ADDRESS rather than by the
rule they cite — delete `require(newState.maxPerSpend == maxPerSpend)` and
they still refused. A rejection that survives the removal of its own rule
proves nothing about it, which is the failure `covenant/AUDIT.md` opens by warning
about. The oracle found it by being unable to fire: its mutant could not get
one transaction past the address check. Fixed, and the same mutant now
produces three findings where it produced none.

**The exits are covered** (`covenant/harness/src/bin/fuzz-exit.rs`, in CI),
and there the question inverts. An exit ends the grant, so every axis goes to
zero and "authority never grows" is satisfied by construction — it would report
a clean sweep against a covenant with no rules in it at all. The danger on that
path is the opposite one, and the covenant's own comment on `revoke` states it
better than any specification could: *"a revoke paying 1 sompi to the principal
and burning the rest to fees was accepted by the engine. So the revocation key
was a DESTROY capability, not a STOP capability."* So the property there is
differential — whoever may end a grant must not thereby choose what it is worth
— and it is asked of the accepted exits as a SET, because one exit paying a
single sompi is indistinguishable from an honest exit of a nearly empty grant.
It is the spread that shows the signer was choosing.

**`delegate2` is covered** (`covenant/harness/src/bin/fuzz-delegate2.rs`, in
CI) — the entrypoint that is on chain, labelled *draft, unaudited*, and the
newest code here by a month. Two children is not one child twice: the budget
bound is SEQUENTIAL, B measured against what is left after A rather than
against the same headroom, and measuring both against the same figure is the
mistake a loop written carelessly makes. Remove that one rule and 23 of 41
accepted delegations leave the tree holding more than the parent's budget.

Making that visible needed a fix to the capacity reading itself: a parent
whose spent-plus-reserved exceeds its budget can cause nothing more to be paid,
and until the figure was clamped at zero the two sides cancelled exactly — an
over-committed tree subtracted from the parent precisely what it added to the
children and read as conserved. The whole sequential-budget family was
invisible. The clamp changes no number in `fuzz-delegate`, because v4 refuses
over-budget children anyway; it is the reason `fuzz-delegate2` can see
anything at all.

What the oracle does NOT see on this entrypoint, stated rather than implied
away: a duplicate child and a reversed reserve chain both conserve every figure
it reads. `c1`'s flip suite covers those. And it
reads four of its five figures as a MAXIMUM over the tree, which cannot see
breadth: a child born at its parent's own delegation depth does not raise the
deepest chain the tree can build, but it gives the tree two chains of that
depth where there was one. The file says so rather than implying coverage it
does not have.

This matters more than any other item here, and `covenant/AUDIT.md:293` says why:

> Of the five vulnerabilities this covenant has had, none would have been
> caught by the claims suite. […] Every one of the five was found the same way,
> and it was not this way: a person asked what an adversary supplies at each
> input, built it, and watched the engine accept it.

A claims suite checks the bytecode against a document we wrote. It cannot
notice a rule that should exist and does not, because the document that would
have omitted the rule is the same document it takes its claims from. The
generative oracle is the only thing here that escapes that circle.

**Done means:** every entrypoint under the generative oracle, each with its own
deliberate-hole self-check, and the accepted-but-authority-grew count at zero
for all of them. all four families are done — `spend` (since before this
list), `delegate`, `delegate2`, `settle` and the exits.

### 1.2 The one claim that is not covered

`covenant/AUDIT.md:86` — `settle`, *"output 0 is that grant's single authorised
continuation"*, marked **not covered**. `covenant/AUDIT.md:286` explains: the baseline
builds exactly that shape, so no transaction in the run has it as the only
thing wrong, and the refusals that would prove it are indistinguishable from
the co-input check firing first.

**Done.** The report says **40 of 40** now, across 132 cases, with no entry
under "what this run did not test" about it.

The reason it resisted for so long is the interesting part, and it is kept
rather than deleted with the entry: the parent's `reabsorb` requires the
identical predicate about the identical input, so the two are redundant by
construction. No whole transaction can violate the child's version without
violating the parent's, and the parent's input is verified first — a refusal of
the pair proves only that ONE of them fired. The two cases covering it now run
the CHILD'S SCRIPT ALONE, which is a claim about what the child's script
enforces rather than about what a node would do, and is the same per-input
execution every other case in the suite is built on.

That licence has to be earned, so `covenant/harness/src/bin/settle-continuation.rs`
earns it in CI: each case must be ACCEPTED when its own line is deleted and
still refused when the other one is. Displacing the continuation crosses over
with the index line and not the count line; the doubled output is the mirror.
If they ever stop separating, the cases are not testing the lines they cite and
the claim goes back to uncovered — reported by a binary rather than by a comment
saying somebody checked once.

### 1.3 One grant shape is not a specification

`covenant/AUDIT.md:286` — every case runs against a single parameterisation:
100 KAS, a 2 KAS per-spend cap, delegation depth 2, a four-member allowlist,
maxProofDepth 4. Whether the boundaries hold at a one-sompi budget, or another
depth, is untested. Two of the axes are already environment variables, so this
is a matrix to run rather than an argument to have.

**Done.** `covenant/SHAPES.md` has the matrix, and it now covers v5's
`delegate2` as well. **No covenant defect at any shape** — every shape that can
express the suite's cases reports 40 of 40 claims covered, zero violations and
zero over-refusals, across budgets from 10^3 to 10^15, delegation depths 1 to
4, epoch lengths 1 to 100,000, allowlists of 2 to 256 members and proof depths
2 to 16. `delegate2` has an accepted baseline and eleven refused flips at every
one of the thirteen, and the oracle finds zero authority growth at each.

What it found was the instrument, nine times. Three on the first run and six
more when the matrix reached `delegate` and `delegate2` at shapes they had
never been asked about — every one the same mistake, that a relationship
expressed as a literal is a relationship that holds at one shape. Two of them
account for the entire over-refusal column the first version of this table
carried: `Child::narrower()` hardcoded `delegation_depth: 1`, so at a parent of
depth 1 the "narrower" child was not narrower (eleven over-refusals, now zero);
and the child's `epochLength` was the literal 1,000 in six places, so at any
other epoch length **every delegation was refused** (fifteen, now zero).

The largest was a second copy of a bug SHAPES.md already recorded fixing: the
coin in the grant's own UTXO, pinned at 10^10, in the delegation builder rather
than the spend builder. It made every v4 delegation case over-refuse above a
budget of 4×10^10 — exactly where a child taking a quarter of the budget stops
fitting inside a parent holding ten billion sompi.

The default shape's output is byte-identical before and after all nine, which
is how we know none of them moved the thing being measured.

Three shapes report nothing, and now say so themselves rather than leaving it
to the reader: `shape_incoherence()` names the arithmetic that makes a grant
whose whole budget is below the baked `maxFee`, or whose epoch is longer than
its window, unable to express the cases at all. That check exists because a
shape with an accepted baseline still reported two violations, and both were
the case asking about more money than the grant had ever held.

### 1.4 The PENDING cases in `c1`

`covenant/harness/src/bin/c1.rs` lists twelve conservation cases for 1:N
delegation and reports seven as PENDING: they are refused today by the fanout
arity, before the rule they name is reached, which is a refusal for the wrong
reason. v5's `delegate2` answers some of them at N=2. The rest are a
specification with no instrument behind it.

**Done, and most of it was already true.** The section reported seven cases as
*"PENDING — needs C1"* right up to 25 September, and that stopped being true the
day v5 shipped: four of the seven were being answered by `delegate2` forty
lines below in the same output. The status was a bool — *can v4 test it* — and
a status that cannot express the state the project is in reports the state it
was written in.

Three more were expressible at N = 2 and simply unwritten, so they are written:
two children with only one reserved for; B created and its budget reserved but
its id never pushed onto the chain (the sum right and the chain wrong, which
matters because an unchained child can never be reabsorbed — nothing can
produce the preimage that pops it); and B claiming an allowlist root of its own
with no witness. All three refused, each one field from an accepted baseline.

**One is not expressible, which is different from pending.** *"Child 2 of 3
reserved twice, child 3 not at all"* needs three children:
`#[covenant.fanout(to = 3)]` fixes the authorised output count at parent-plus-two
exactly, and KIP-9 refuses 1:3 on chain anyway — 770,994 against a ceiling of
500,000. A shape consensus will not carry is not a gap in a suite. If the mass
ceiling ever moves, it comes back.

**11 of 12 answered at N = 2, 1 not expressible, 0 pending.**

### 1.5 The compute-budget line that never ran

`LIMITS.md:38` — the corrected compute-budget figures *"[have] not yet run —
[they were] added in a commit that did not compile"*, and 15/16/16 were computed
by hand. A number in a limits document that has never been produced by the
machine is a number that is probably wrong.

**Done, and the surprise was which half was wrong.** The line has run. The
budget units it was supposed to confirm — 15, 16, 16 — were right: the hand
arithmetic held. What had gone stale were the raw measurements printed in the
same table, by sixty-four bytes and three hundred and eighty-four script units,
consistently at every depth. `covenant/deploy/covenant-template.json`'s own
`baselineHex` is 6,912 bytes against the table's 6,976, so `LIMITS.md` was
describing a build nobody has — including the one on chain.

The derived figures survived and the raw ones rotted, which is the opposite of
what anyone was watching for, and it happened because the test PRINTED them and
asserted nothing. All four columns are pinned now, so the next move fails the
suite and names the file to update. They skip under a non-default grant shape,
because the constructor bakes the budget and an integer of another width is a
different bytecode.

---

## 2. Key custody

`GUARANTEES.md:410` — *"The demo collapses three keys into one. `agentKey`,
`revocationKey` and `principalKey` are three different powers — spend, stop,
receive — and a deployment should separate them. **Doing so is the first thing
to change.**"*

Half of that is done. Revocation was separated on 16 September and
`ops/grants.ts` passes `--revocation` on every path, so nothing issued from
/grant can add to the collapse — `test/key-separation.test.ts` pins the count at
17 and fails if it grows.

### 2.1 The principal is still the funder, and the clock is running

`ops/known-keys.json`, key `0393133d…`, `shouldBe`: *"three keys, not one. On
mainnet the principal must be generated offline on a machine that never runs an
agent."* Today that key funds genesis, receives on revoke and reclaim, and its
secret lives on the machine that runs the agents.

This one has a deadline that is not ours to set. A grant hashes its keys into
its address, so the separation **cannot be retrofitted** — every grant issued
between now and the fix carries the collapse for its whole life. The same file
records what that costs when it goes wrong: a key overwritten on 17 September
stranded coin at an address nobody holds any more.

**The clock is stopped, and it was bigger than the other one.** 29 grants here
name a funder key as their principal — against 17 for the principal/revocation
collapse, because that one had its default fixed in September and this one
never did. `--principal` defaults to the funder, which is the most comfortable
default in the tool: it is what happens when nobody types anything.

`sdk/tools/genesis.ts` refuses it on mainnet now, with no override flag, and
warns on testnet saying the thing that matters — this is the one role collapse
that **cannot be retrofitted**, because the address commits the keys and the
principal is therefore decided for the grant's whole life.
`sdk/tools/keys.ts` reports it per grant (a new `isFunder` marker in
`ops/known-keys.json` makes "which keys are funders" machine-readable instead of
a phrase in a label), and `test/key-separation.test.ts` pins the count at 29 so
it cannot grow quietly. `ops/PRINCIPAL.md` is the procedure.

**Still to do, and it is yours rather than the code's:** generate the principal
on a machine that has never run an agent and never will. PRINCIPAL.md says what
"offline" has to mean here — not a different file, but no path by which an
agent, a runner, a deploy or a web service could ever read the secret. An old
wiped laptop or a live USB session is enough; the key is 32 bytes and the
machine's only job is to print the public half.

**Done means:** that key generated and its public half in use;
`ops/known-keys.json` carrying no `shouldBe` that names custody; and the pinned
count at 0 rather than 29, which needs the existing grants reissued or expired.

### 2.2 The seventeen grants that cannot be repaired

`test/key-separation.test.ts:8` — *"the separation cannot be retrofitted […]
every grant that exists has the keys it was born with, forever."* The only
remedies are revoke-and-reissue or letting the term run out.

**Done means:** every live grant on the v6 migration issued under separated
keys, and the pinned count at zero rather than 17.

---

## 3. Operations

### 3.1 The node is on a laptop

`ops/README.md:22` — both services are macOS LaunchAgents, *"so they run while
you are logged in and stop when the machine sleeps. That is the honest limit of
hosting this here rather than on a small VPS, and it is fine for demos and
development. **It is not fine for anything that claims to be always-on.**"*

It has already cost something real: a restart made every paid request return 500
for days, and a customer's 0.04 KAS purchase settled against an HTML error page.

**Accepted for now, on testnet, deliberately** (25 September 2026). The laptop
stays. It is the right call while nothing here holds real money and the cost of
an outage is a demo that was down — which is what `ops/README.md` already says
the arrangement is *fine* for.

Recording it as accepted rather than leaving it looking unaddressed, because
the two are different things and a list that cannot tell them apart is a list
people stop reading. What it does not do is stop being a mainnet blocker: the
decision is about today, and the item is about the day somebody's real money is
on the other end of a request that returns 500 for a weekend.

**The health-check half is done** (25 September 2026), and was mostly done
already. `ops/check-verify.sh` probes `/v1/verify` with the published demo
manifest, asserts the address it derives matches the one the site publishes and
that it read a usable node, and it deliberately does not probe `/health`:
`ops/check-verify.sh:25` — *"`/health` answered perfectly throughout. It opens a
node and reports on it, which is a different code path from the one that derives
an address"*. It is scheduled every fifteen minutes by `ops/install-cron.sh:146`.

What was missing was not the check. It was that nobody was told. The monitor
wrote an honest status file and exited 1 into `~/Library/Logs/warda-verify.log`,
which is the September outage again with better records —
`ops/monitor.sh:13` — *"a log is a place failures go to be alone."* The same was
true of `ops/check-node.sh` and `ops/check-vendor.sh`.

All three now run through `ops/monitor.sh`, which sends on the CHANGE of state:
once after two consecutive failures, again every six hours while it stays down,
once on recovery, and nothing at all in between — a check that fires ninety-six
times a day cannot alert on every failure without teaching the reader to ignore
it. An alert it could not deliver is kept pending rather than counted as sent.
`ops/check-monitors.mjs` holds it there: it fails if a scheduled check is
installed without the wrapper, if a fifth copy of the Telegram send appears
instead of `ops/notify.sh`, and — by mutating the wrapper and requiring the
self-test to go red — if the self-test stops being able to fail.

Verified live on 25 September 2026: a failing check produced a Telegram
message, and the recovery produced another. Worth writing down, because until
that moment the whole path was three files whose only job was a message that
had never arrived.

The bot token this sends with is the one recorded compromised in
`ops/secrets.json` and not yet rotated, which now makes that rotation
load-bearing rather than merely overdue.

**Done means:** the node and the tunnel on a host that survives a laptop lid.
That is the whole of what is left here.

### 3.2 The verifier promises nothing

`site/protocol.html:2566` describes `/v1/verify` as carrying *"no uptime promise
and no authentication"*.

**Closed, and the position was already the right one** (25 September). The
choice was between promising an availability target and withdrawing the
promise, and the second is not a retreat — it is the architecture. A hosted
verifier with an SLA quietly makes us the oracle for our own grants, which is
the exact shape this protocol exists to avoid. The service holds no key, signs
nothing and broadcasts nothing; `sdk/tools/verify-grant.ts` does the same job
locally, and the site already says the part that matters:

> `npx warda-verify` runs the identical thing yourself — which is the version
> that matters, because a verifier you have to trust is not a verifier.

So there is nothing to promise. What there was, was a claim resting on a file
path with nothing checking it: `dist/` is gitignored, so a build that stops
emitting the entry point looks identical in the tree; a `files` array trimmed
to shrink a tarball drops it silently; a shebang lost in a refactor makes `npx`
hand the file to the shell. Each of those breaks the sentence above for
everyone who does not already have the repo — and `@warda_protocol/borsh@0.4.0`
is the precedent, published broken for everyone the moment it arrived.

`ops/check-releasable.mjs` now verifies every declared `bin` exists, starts with
a shebang and sits inside the package's `files` allowlist, and fails the build
rather than noting it — a package whose command does not run is not a judgement
call about timing. Its own first version ran after the block that prints and
exits, so it found nothing and said nothing, which is a checker with the defect
it checks for; and its second reported a false positive on `./dist/warda.js`,
which is how a check earns being switched off. Both fixed.

**Done means:** nothing further. The remaining half of this — a health check
that goes red when the endpoint is actually failing rather than staying green —
is 3.1's, and stands whatever the uptime promise is.

### 3.3 The runner holds the deposit

`runner/DESIGN.md:30` — *"between the deposit arriving and the genesis
confirming — usually under a minute — the runner controls the deposit
outright."* Honest, disclosed on every page that offers it, and still a custody
window.

**Bounded, not closed** (25 September). The window cannot be closed without
deleting the product: no phone wallet builds a covenant genesis, which is the
entire reason the deposit flow exists. Closing it means the owner builds the
genesis themselves, or an atomic construction covenants may not support.

What was missing was not the disclosure — every page offering the flow already
carried it — but the size. It was unlimited: quote a grant of any budget and
somebody sends that much to a key the runner holds alone for that minute. And
`runner/DESIGN.md`'s real bound, *a breach loses at most what the grants it
holds could still spend*, is about grants that EXIST. A deposit in flight is
not one of them yet.

So `maxDeposit()` caps it at 100 KAS, `checkLimits` refuses a quote above it,
and there is **no value that turns it off** — a zero or a negative throws
rather than meaning unlimited, on the same reasoning the genesis guards have no
override flag. `ops/check-runner.mjs` fails the build if `checkLimits` stops
consulting it, verified by breaking it on purpose. The cap is on the DEPOSIT
rather than the budget, because the deposit is what somebody actually sends:
budget plus genesis fee plus a spend buffer, so a budget just under the cap can
still ask for a deposit over it. The number is on the page that offers the flow.

**Done means:** the 100 KAS picked deliberately for mainnet rather than
inherited from a testnet placeholder, or the window closed for real.

### 3.4 The Turnkey key is broader than the design says

The design said the policy should restrict the runner's key to
`SIGN_RAW_PAYLOAD` on agent wallets only, so a leaked credential *"cannot
create, export or delete anything"*. Two things were wrong with that, in
opposite directions.

**`CREATE_WALLET` is in the deployed policy and should stay.** The runner
provisions an agent's wallet at signup; removing it moves that step to an
operator, which is a product decision rather than a hardening one. It is the
mildest verb available — a wallet created is an empty one, and a leaked key
that can make empty wallets has made nothing worth taking. `runner/DESIGN.md`
says so now instead of promising otherwise.

**The real gap is that the policy is scoped by ACTIVITY and not by RESOURCE.**
"On agent wallets only" was never implemented: the condition names activity
types and nothing else, so the key may sign with any wallet the organisation
holds. That the organisation holds only agent wallets makes the gap harmless
today and makes the property accidental, which is not the same as safe.

**Done in the meantime:** the lockdown tool proves the boundary instead of
asserting it. It probed one thing — creating a user tag — and reported it as
*"refused anything else"*, which is a different claim from the one it was
making. It now asks for each verb the design promises the key cannot do —
export, delete, write itself a wider policy, add a user tag — and requires a
refusal every time, with export first because it is the only one that turns a
leaked API key into the agents' private keys. Each probe is harmless if it were
ever approved, and the export probe is aimed at a REAL wallet id looked up with
the root key, because an export refused for a wallet that does not exist proves
nothing about the policy.

**The prescribed fix does not exist.** "Agent wallets tagged and the policy
conditioned on the tag" is not expressible: in Turnkey's policy language `tags`
is a field of the `PrivateKey` struct, and `Wallet` and `WalletAccount` have no
tags field at all. The runner creates wallets. This item said *done means*
about something that cannot be done, which is worth more than the fix itself —
a before-mainnet list whose remedies are impossible is a list that stalls
without ever saying why.

What a wallet does expose is `label`, string equality and range slicing, and
the runner names every wallet it creates `warda-<agent>`, so the prefix is the
resource scope. `runner/tools/turnkey-scope.ts` installs it and proves it in an
order that matters: it first creates a wallet the new condition excludes and
requires the runner to sign with it — a refusal means nothing unless you can
name what it is a refusal of — then narrows, requires the refusal, and requires
an agent wallet to STILL sign. That last one is why it is a tool rather than a
dashboard click: a condition that matches nothing denies everything and would
take the runner down, and nothing in Turnkey's documentation promises `wallet`
is populated for `SIGN_RAW_PAYLOAD_V2`. Any failure rolls the policy back.

It is weaker than a tag would have been, and the file says so: the runner may
create wallets, so it can mint a `warda-` label at will. What it closes is the
wallet somebody ELSE puts in that organisation — which is the whole of the
exposure, since the organisation is otherwise the runner's own.

**Done means:** `runner/tools/turnkey-scope.ts` run against the live
organisation, with its five proofs passing. It needs the root key back for one
run — the key `runner/tools/turnkey-lockdown.ts` told you to take offline — and it is yours
to run, not the repository's.

---

## 4. Secrets

About twenty live key and env files sit on the machine that runs this — six
under `covenant/deploy/`, six under `growth/keys/`, six under `one-job*/keys/`,
plus the revocation key, the unattended issuer's float, the auditor's key, the
site's agent and wallet keys, and five `.env.local` files in deploy directories.
None is tracked; `.gitignore` covers them all by name or by pattern.

**There is no rotation policy written anywhere.** The only rotation-shaped
document in the repo is `runner/deploy/README.md:43`, about the fee payee, and
it notes that older grants keep paying the old address because the allowlist is
fixed at genesis — which is the shape of the whole problem.

Two credentials are known to be compromised: the X bearer token and the Telegram
bot token, both leaked into a conversation on 23 September. Neither file's
modification time has changed since.

**The inventory exists.** `ops/secrets.json` lists every secret by path and by
role, never by value; `ops/SECRETS.md` is the policy; `ops/check-secret-age.mjs`
runs in CI.

Writing it down forced a distinction that was not being made: **three kinds of
secret, and only one of them rotates.** Credentials at somebody else's service
rotate the ordinary way. Shared secrets we mint ourselves rotate only at a
restart with nothing outstanding — `QUOTE_SECRET` has to be stable for the life
of its process, and regenerating it invalidates every quote in flight. And keys
committed to on chain **do not rotate at all**: a grant hashes its keys into
its address, so writing a new file makes a new key rather than moving the old
one's authority. `rotateDays: null` means that third kind — not "no policy" but
"rotation is not the operation you want here".

What fails the build is not the clock. It is a listed secret path that has
stopped being ignored by git, because that is not a policy problem, it is the
incident. The clock only prints: a rotation check that breaks CI gets its
interval raised rather than its secret rotated.

**Three secrets are recorded as compromised and none is rotated yet** — the
Telegram bot token and the X bearer (both 23 September, both mine, both from a
shell idiom that prints a value while looking like it tests for one), and the
Neon password (19 September). They stay overdue until `rotatedAt` is set in
`ops/secrets.json` **by hand**. Not when the file's mtime moves: `runner/.env`
was rewritten on 22 September for a fee-payee change, three days after its
database password went into a chat window, and a check keyed on mtime would
have called that rotated and gone quiet.

**Done means:** those three rotated and `rotatedAt` recorded. SECRETS.md has
the steps for each; the X one bills to your card, which makes it the one to do
first.

---

## 5. Legal

There is nothing. No terms of service, no privacy policy beyond the Chrome Web
Store data disclosure in `extension/PRIVACY.md`, no liability position, no
jurisdiction, no position on who the counterparty is when a grant pays a seller.
The licence is MIT and the only "do not use this" is a disclosure line:
`site/proof.html:702` — *"Unaudited. Testnet first. Do not put money on this yet."*

This is not engineering and it is not optional.

**Done means:** terms, a privacy policy, and a written answer to *who is liable
when an agent pays the wrong person* — even if that answer is "the user, and
here is where we say so before they start."

---

## What is deliberately not on this list

**The structural limits.** `GUARANTEES.md:76` documents six things the chain
cannot enforce — unused epoch allowance surviving `expiresAt`, LIFO-only
settlement, an epoch limit that bounds one grant rather than a subtree, an
allowlist fixed at genesis, serial payments from one UTXO, fees not charged
against the budget. These are properties of the design, correctly implemented.
They belong in the documentation a user reads, not in a list of things to fix.

**The unbuilt product.** `runner/DESIGN.md:129` lists a Postgres store, a real
worker, MCP auth, a console and NL→workflow. `README.md:154` lists multi-level
delegation and the hosted services. None of it blocks mainnet; all of it is
product.

**The audit itself.** It is not a preparation item, it is the gate. Everything
above exists to make it cheap and to make its findings interesting.

---

## How this file stays true

`ops/check-mainnet-refs.mjs` runs in CI. Every `file:line` citation above must
resolve, and the line it points at must still contain what this file says it
does. A citation that has drifted fails the build.

It cannot check the prose. That is on whoever moves an item to done, and the
rule is the same one the rest of this repo uses: **done means a condition
somebody else could check.**
