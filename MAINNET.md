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

**The audit target is v6, frozen at the end of this work.**

The alternative was to freeze now and harden around a fixed covenant. We chose
not to, for one reason: hardening will find things in the covenant, and a
version frozen before the looking is a version that gets audited with the
findings still in it.

The cost is not hidden. `covenant/V5.md:21` — *"Every change strands every live
grant. The script is P2SH-committed, so the address is the template."* Freezing
v6 means one deliberate migration of everything that exists — the fourteen
manifests, the demo grant behind /attack, the agent fleet, the registry
listings, the coordinator on /one-job — at a moment we pick rather than one
that happens to us. v4 stays live throughout. v5 is a draft that proved
`delegate2` works on chain and is not a migration target.

**Done means:** one covenant fingerprint, every live grant carrying it,
`covenant/versions.json` recording the rest as history, and no entry in
`GUARANTEES.md` marked *draft, unaudited*.

---

## 1. The covenant

### 1.1 Extend the oracle that reads no specification

The most valuable instrument in this repo is `covenant/AUDIT.md:268`: generate
spend attempts structurally, discard everything the engine refused, and assert
one property of what is left — an accepted spend must not leave the agent able
to do more than it could before, minus what it just paid. 768 generated, 61
accepted, authority grew in 0. With the epoch ratchet deliberately removed it
fires on 8, which is how we know it can.

It covers `spend`. It does not cover `delegate`, `delegate2`, `reabsorb`,
`settle` or the exits — which is to say it does not cover delegation, the newest
and least-reviewed surface in the protocol.

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
for all of them.

### 1.2 The one claim that is not covered

`covenant/AUDIT.md:86` — `settle`, *"output 0 is that grant's single authorised
continuation"*, marked **not covered**. `covenant/AUDIT.md:286` explains: the baseline
builds exactly that shape, so no transaction in the run has it as the only
thing wrong, and the refusals that would prove it are indistinguishable from
the co-input check firing first.

**Done means:** a transaction that violates only this claim, refused, with the
construction carrying the meaning rather than the engine's message — the same
discipline as every other flip test.

### 1.3 One grant shape is not a specification

`covenant/AUDIT.md:286` — every case runs against a single parameterisation:
100 KAS, a 2 KAS per-spend cap, delegation depth 2, a four-member allowlist,
maxProofDepth 4. Whether the boundaries hold at a one-sompi budget, or another
depth, is untested. Two of the axes are already environment variables, so this
is a matrix to run rather than an argument to have.

**Done means:** the claims suite green across the shape matrix, and AUDIT.md's
"what this run did not test" no longer listing grant shape.

### 1.4 The PENDING cases in `c1`

`covenant/harness/src/bin/c1.rs` lists twelve conservation cases for 1:N
delegation and reports seven as PENDING: they are refused today by the fanout
arity, before the rule they name is reached, which is a refusal for the wrong
reason. v5's `delegate2` answers some of them at N=2. The rest are a
specification with no instrument behind it.

**Done means:** no case in `c1` reported as PENDING, or each remaining one
carrying a written argument for why it cannot exist.

### 1.5 The compute-budget line that never ran

`LIMITS.md:38` — the corrected compute-budget figures *"[have] not yet run —
[they were] added in a commit that did not compile"*, and 15/16/16 were computed
by hand. A number in a limits document that has never been produced by the
machine is a number that is probably wrong.

**Done means:** produced by a run, printed by the harness, and the hand
calculation deleted rather than annotated.

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

**Done means:** a principal generated offline, on a machine that has never run
an agent and never will; genesis refusing a principal that equals the funder,
everywhere and not only on mainnet; and `ops/known-keys.json` carrying no `shouldBe`
that names custody.

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

**Done means:** the node and the tunnel on a host that survives a laptop lid,
and a health check that goes red when `/v1/verify` is failing — on 16 September
it returned `internal` for an unknown length of time while `/health` stayed
green, which is the failure mode that matters.

### 3.2 The verifier promises nothing

`site/protocol.html:2566` describes `/v1/verify` as carrying *"no uptime promise and no authentication"*, which is accurate and is not a thing to put in
front of real money.

**Done means:** a stated availability target somebody is on the hook for, or the
service withdrawn and the page saying verification is something you run
yourself.

### 3.3 The runner holds the deposit

`runner/DESIGN.md:30` — *"between the deposit arriving and the genesis
confirming — usually under a minute — the runner controls the deposit
outright."* Honest, disclosed on every page that offers it, and still a custody
window.

**Done means:** either the window closed, or a written bound on what can sit in
it and a check that enforces the bound.

### 3.4 The Turnkey key is broader than the design says

`runner/DESIGN.md:61` — *"Before mainnet: a Turnkey policy restricting the
runner's API key to `SIGN_RAW_PAYLOAD` on agent wallets only, so a leaked runner
credential cannot create, export or delete anything."* `runner/tools/turnkey-lockdown.ts`
currently creates a user with `CREATE_WALLET` as well.

**Done means:** the deployed policy matching the design, or the design changed
with the reason written down.

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

**Done means:** an inventory that says, for each secret, what it can do, where
it lives, how it is rotated and what breaks while it is being rotated; the two
leaked tokens rotated; and a check that fails when a secret file is older than
its stated rotation interval.

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
