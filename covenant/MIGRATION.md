# Moving onto the frozen covenant

A grant's address is the hash of its script. A different covenant is a
different script, so nothing here migrates in place — there is no upgrade
transaction, no in-flight conversion, and no way to move a live grant onto a
new template while keeping its address. `covenant/V5.md:21` says it in one
line: *"Every change strands every live grant. The script is P2SH-committed, so
the address is the template."*

So "migrate" means one of exactly two things, per grant:

- **revoke and reissue** — end it under the old covenant, create its
  replacement under the new one, at a new address, and update everything that
  names the old one; or
- **let the term run out** — `expiresAt` is baked in at genesis, so every grant
  already has a date after which it holds nothing anybody can spend.

The second is free. Most of the work below is deciding which grants are worth
the first.

## What exists, and when it stops existing

Twenty-two distinct v4 grants, counted by `covenant` fingerprint across every
manifest committed here. Four have already expired. The rest are listed by the
only figure that decides whether they need a decision — how long they have
left — at a DAA score of 579,999,731, about one second per unit.

| days left | sompi left | grant |
|---:|---:|---|
| — | 46,000,000 | `x402/demo/grant-child-5a0684c6.json` *(expired)* |
| — | 45,000,000 | `growth/grant-child-6476d3dc.json` *(expired)* |
| — | 295,000,000 | `growth/batch-grant.json` *(expired)* |
| — | 45,000,000 | `growth/batches/2026-W39/grant-child-6476d3dc.json` *(expired)* |
| 0.4 | 10,000,000 | `one-job/grant-child-ff72918c.json` |
| 0.4 | 12,000,000 | `one-job/grant-child-384439bd.json` |
| 0.4 | 20,000,000 | `one-job-2/grant-child-757169df.json` |
| 0.4 | 18,000,000 | `one-job-2/grant-child-ff95e813.json` |
| 20 | 45,000,000 | `one-job/grant.json` |
| 20 | 71,000,000 | `one-job-2/grant.json` |
| 39 | 197,000,000 | `x402/demo/agent-011-grant.json` |
| 40 | 100,000,000 | `runner/agents/first-hosted-grant.json` |
| 51 | 150,000,000 | `growth/listener-grant.json` |
| 57 | 300,000,000 | `covenant/deploy/grant-v4.json` |
| 65 | 4,967,000,000 | `covenant/deploy/grant-demo.json` *(and 3 published copies)* |
| 76 | 420,000,000 | `x402/demo/kaspa-x402-grant.json` |
| 116 | 1,353,197,261 | `x402/demo/kaspa-402-grant.json` |
| 118 | 192,000,000 | `x402/demo/agent-002-grant.json` |
| 120 | 72,000,000 | `x402/demo/agent-003-grant.json` |
| 197 | 300,000,000 | `x402/demo/agent-005-grant-v1.json` |
| 197 | 98,051,200 | `x402/demo/agent-005-grant.json` |
| 216 | 297,000,000 | `agent-006/grant-006.json` |

Four of the eighteen live ones expire within a day. Thirteen expire within four
months. **Six outlive a hundred-and-twenty-day horizon**, and those six are the
only grants for which "migrate" and "wait" are different plans.

That is the number worth knowing before any of this is scheduled, and it is
smaller than the decision section of `MAINNET.md` assumed when it said the
freeze would cost "one deliberate migration of everything that exists."

## The order, and why it is that order

1. **Archive the outgoing template before anything overwrites it.**
   `covenant/versions.json`'s v3 entry states the rule and the reason:
   *"Archived BEFORE v4 overwrote covenant-template.json, which is the only
   order that works: the live v3 grant is addressable only through this file,
   and it is the sole copy."* A live grant whose template is gone is a grant
   nobody can build a transaction for, including its own principal.

2. **Make the tools refuse a mismatched pair.** Done, ahead of the flip:
   `sdk/src/template.ts`'s `assertTemplateForManifest` and
   `ops/check-template-guard.mjs`. Until the packaged template changed meaning
   this was theory; the moment it changes, a v4 manifest read with the packaged
   template derives a valid address holding nothing, and the tool reports the
   grant as empty rather than reporting itself as wrong.

3. **Flip the template**, so nothing new is issued under the old covenant.
   Every grant created after this point is one that does not need migrating,
   which is the only part of this list that gets cheaper by being done sooner.

4. **Let the short-lived grants die.** Thirteen of eighteen, no work, no
   transaction, no key. The four `one-job` children are gone within a day.

5. **Reissue the six long-lived ones** — and reissue them under **separated
   keys**, because doing it twice is the only thing worse than doing it once:
   `MAINNET.md` §2.1 records that the principal cannot be retrofitted, so a
   grant reissued today under the funder key carries that collapse for its
   whole new term. This step is therefore blocked on the offline principal, and
   deliberately so.

6. **Regenerate what publishes an address.** The demo grant behind `/attack`,
   the agent cards the site builds from `site/src/agent-0NN.json`, the registry
   listings and the `/one-job` coordinator all name addresses derived from a
   template. `ops/check-links.mjs` and `site/build.py` will catch a page that
   loses its data; neither will catch a page that still renders, with an
   address nothing is at.

## What blocks it

**The offline principal** (`MAINNET.md` §2.1, `ops/PRINCIPAL.md`). Steps 1–4
need nothing from anybody. Step 5 needs a key generated on a machine that has
never run an agent, and reissuing before that exists would spend the one
opportunity this migration creates — every grant reissued under the funder key
is a grant that has to be reissued again.

Nothing else. In particular the covenant itself is not a blocker: the frozen
source is `covenant/warda_grant_v5.sil`, whose existing entrypoints are the
same source text as v4's, and whose new one is additive.

## Done means

- `covenant/versions.json` names one `current` fingerprint, and it is the one
  `sdk/covenant-template.json` produces — checked by `ops/check-versions.mjs`.
- Every archived version has a template file that re-derives, so every grant
  ever issued is still addressable.
- No entry in `GUARANTEES.md` marked *draft, unaudited*.
- Every grant that is still inside its window carries the frozen fingerprint,
  and `test/key-separation.test.ts`'s pinned counts are 0 rather than 29 and 17.
