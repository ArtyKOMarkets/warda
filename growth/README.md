# Warda Growth

Agents hiring agents on Kaspa, under authority the network enforces. The first
product built on Warda — see `claude/warda-growth-architecture.md` in the
project for why the shape is what it is.

```
npm test          # the rules, and the orchestrator driven as a process
npm run typecheck
```

## What this is not

It does not re-implement a single covenant operation. `build-delegation.ts` and
`build-settlement.ts` in the SDK do the building, the fee correction against a
live node, and the manifest advancement, and this spawns them exactly as the
`warda` CLI does. Extracted-then-copied is the failure this repo has paid for
five times.

What it adds is the part the SDK deliberately does not have: **a plan, checked
before anything is built.**

## The two findings that decide the topology

**Only a single-payee child is reliably expressible.** A child may narrow its
parent's allowlist, but the witness covers a *subtree* — the members must be a
contiguous, power-of-two-aligned run. And `RecipientSet` sorts by the **hex of
the key**, discarding insertion order, so a caller cannot arrange which payees
sit together. One member aligns at any index; two is a coin flip. So: one child
grant per service. Which is the right security shape anyway — "may pay the
search API and nothing else" belongs in an address, not a config file.

**Settlement is LIFO.** `reserveRoot` is a hash chain, not a set. With children
A then B outstanding, B must settle before A, and no builder can be persuaded
otherwise. That is an operational constraint on how a tree is *run*, which is
why `checkSettle` lives here and not in the SDK.

## The fleet

| agent | holds | does |
|---|---|---|
| **Orchestrator** (#009) | a batch grant each week, one payee: Researcher | hires Scout with a piece of it, takes the rest back |
| **Scout** (#010) | a child grant: one payee, one record's price per spend, a quarter per epoch, one day | searches GitHub (free) and buys one record per candidate |
| **Researcher** | nothing to spend; it is paid | sells `/verify?url=…`: facts with sources, never a score — hosted at `warda-growth.vercel.app`, listed in the registry |
| **Outreach** | **no grant, no key, no send button** | turns records into drafts for a person to read |

Prospects are not only Kaspa projects: x402 sellers and buyers, paid MCP
servers, agent wallets, agents that hold stablecoins. `src/scout.ts` has the
searches; edit them there.

## The shape

| | |
|---|---|
| `src/scout.ts` | GitHub searches → a shortlist, each entry with the search that found it |
| `src/verify-project.ts` | what Researcher sells: facts with sources, what could not be established, and a channel only if the maintainer published one |
| `src/service.ts` | Researcher as one request handler, for the laptop and for Vercel — no quote when GitHub is refusing, so nobody pays for an empty record |
| `src/outreach.ts` | a draft only from what the record established, to a channel they published — or no draft, and why |
| `src/week.ts` | the week's plan, steps and report |
| `src/hiring.ts` | what a parent may hand over, and every reason it may not — all of them at once, not the first |
| `src/batch.ts` | one unit of work: one grant tree, one settlement stack, one log |
| `tools/week.ts` | the week, unattended and resumable — run by `ops/weekly-growth.sh` |
| `tools/batch.ts` | `open`, `hire`, `settle`, `status`, `close` |
| `tools/researcher.ts` | Researcher on a laptop |
| `tools/reading.ts` | the published readings for #009 and #010 |
| `deploy/` | Researcher on its own Vercel project; `deploy/sync.mjs` keeps its copy of `src/` honest |

Every refusal in `hiring.ts` is one the chain would also make — in a script
error, on chain, after a fee, usually about a hash. The value of the module is
that the same no arrives in English, in milliseconds, before money moves.

## The allowlist is not in the manifest

A grant manifest records the allowlist's **root**, not its members, and a
narrowed child is proved by a path through the parent's tree — which a root
alone cannot produce. So `hire` takes `--payees`, the same file the grant was
created with, and checks that it rebuilds the grant's root before building
anything. Lose that file and the grant can still be revoked, and never
delegated.

## Running a batch

```
export WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key)
node --experimental-strip-types tools/batch.ts open \
  --manifest ../covenant/deploy/grant.json --payees payees.txt --name w38

node --experimental-strip-types tools/batch.ts hire scout \
  --payees payees.txt --agent-key <the sub-agent's x-only key> \
  --payee <the one service it may pay> \
  --budget 0.5 --max-per-spend 0.05 --window 20000 --submit

node --experimental-strip-types tools/batch.ts status
node --experimental-strip-types tools/batch.ts settle scout --submit
```

Without `--submit` nothing is broadcast, which is the safer order the first few
times. The sub-agent generates its own key and hands over the public half;
nothing here ever holds it.

## Weekly

```
source ops/node.env
node --experimental-strip-types growth/tools/week.ts --dry-run   # the searches and the plan; nothing on chain
node --experimental-strip-types growth/tools/week.ts             # this week's batch, or resume it
ops/install-cron.sh --growth                                     # every Monday at 10:13
```

A week: genesis → open → scout → hire → buy → settle → close → revoke → drafts →
report. Each step is written to `batches/<week>/week.json` before the next
starts, so a run that stops resumes rather than paying twice. The drafts are in
`batches/<week>/drafts.md` (gitignored: they name people). Nothing is sent.
