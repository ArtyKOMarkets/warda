# Freezing a covenant

Written on 26 September 2026, the day after the v5 freeze took the agent fleet
down for twenty-one hours. There was no procedure; this is the one the failure
argues for.

A freeze is not a deploy. Nothing is replaced, nothing migrates, and no live
grant changes — `covenant/MIGRATION.md:3` says why in one line: *"A grant's
address is the hash of its script."* What a freeze does is change what the word
"current" resolves to, and that is a change in **meaning**, in a data file, with
no diff in any code path that reads it.

That is the whole difficulty. A covenant change cannot break a test that pins the
covenant, because both sides of the pin move together.

---

## What actually happened, in one paragraph

`sdk/covenant-template.json` became v5 at 25 September 14:25 UTC. `Agent.open`
read `options.template ?? covenantTemplate`. Every grant on chain was v4, so
every agent derived a v5 address for a v4 grant — valid, well-formed, empty — and
reported "no UTXO". Eight purchase attempts across three agents, none successful,
for twenty-one hours. CI was green: 251 SDK tests, a thirteen-shape covenant
matrix, and an end-to-end buy test that funded its fake node from the same pinned
template the wallet was using. `MAINNET.md` §3.3e has the rest.

---

## The procedure

**1. Archive the outgoing template before anything else.**
Copy `sdk/covenant-template.json` to `sdk/covenant-template-v<N>.json` and add
its entry to `covenant/versions.json`, naming the file. Do this as a separate
commit, before the flip. `ops/check-versions.mjs` re-derives every fingerprint
from the file rather than trusting the entry, and `ops/check-template-guard.mjs`
fails if any manifest in the repo names a covenant whose file is not on disk.

**2. Add the new archive name to the loader.**
`sdk/src/templates.ts` holds `TEMPLATE_NAMES`, current first. It is the one place
that decides what "current" means for every caller downstream. One line.

**3. Flip `sdk/covenant-template.json`, then read the failures rather than
fixing them.**
Run `npm test` at the root and in every workspace. What fails is the map of what
was pinned, and each failure is one of three things:

- *a fixture that pins* — it must resolve from its own manifest instead. A test
  that pins the current template on both sides of its assertion cannot detect a
  template that disagrees with its manifest, which is the only thing a freeze can
  break.
- *a tool that refuses* — correct, and often useless: after the v5 flip
  `follow-grant` and `topup` refused every v4 manifest, which is the two recovery
  tools declining to operate the six long-lived grants they exist for.
- *a tool that says nothing* — the dangerous one. It did not fail; it derived a
  different address. Nothing will tell you.

**4. Run the guard.**
```
node ops/check-template-guard.mjs
```
Unattended code must resolve; operator tools may default if they compare;
fixtures may not pin alongside an archived covenant. It failed to catch the v5
flip because it scanned `sdk/tools` and the bug was in `wallet/src` — the roots
list is the part of that file worth re-reading before a freeze.

**5. Rebuild every `dist`.**
```
npm run build --workspaces --if-present
```
Not optional and easy to skip, because the flip itself needs no build: the
template is a data file. But `agents/tools/buy.ts` imports
`@warda_protocol/agent`, which resolves to `wallet/dist`, so the agents run built
code. `ops/check-dist.mjs` refuses a source newer than its build.

**6. Ask the chain. This is the step that did not exist.**
```
source ops/node.env
node --experimental-strip-types ops/check-located.ts
```
It takes the manifests the fleet actually spends from, resolves each one's
covenant the way the wallet does, derives the address, and asks whether the coin
is there. When it is not, it derives the address under every other template on
disk and names the one that holds it — so the answer is "this is reading the
wrong covenant", not "the grant is missing".

**Nothing in CI can do this**, and that is the point rather than a limitation. A
fixture's template travels with the code. `test/located.test.ts` drives this file
against the fake node and shows it the September state, which is what makes a
green run mean something; but the real answer needs the real chain and the real
manifests.

It runs hourly from cron through `ops/monitor.sh` as well. A freeze is done when
it has answered once, by hand, with the operator watching.

**7. Make one real payment.**
```
ops/listener-pass.sh
```
A pass buys three searches from a live grant. `check-located` proves the coin is
findable; this proves it is spendable, which is a different claim — the address
is only half of what a spend needs.

**8. Then the documents.**
`GUARANTEES.md`, `covenant/MIGRATION.md`'s table, `covenant/SHAPES.md`, and the
site's covenant card. Last, because until step 7 there is nothing true to write.

---

## What a freeze does NOT do

It does not migrate anything. Every live grant stays on the covenant it was
issued under, for its whole life, and is fully operable there — see
`covenant/MIGRATION.md`. After a freeze, "current" and "what our grants run" are
two different answers, and every tool that conflates them is a bug waiting for
the next freeze.

Deciding which grants are worth reissuing is a separate piece of work with its
own document. It is not part of this checklist and must not be attempted in the
same change.
