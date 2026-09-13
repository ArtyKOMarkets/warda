# The first loop

One agent hires another, the second does work a buyer can check, and the money
moves on Kaspa under limits the network enforces. Every step names the covenant
operation it exercises — this is the first time several of them run outside a
test.

Run it in order. Nothing before step 3 touches the chain.

---

## 0 · What exists already

```
growth/keys/growth.key         funder · principal · revocation   (fund this)
growth/keys/orchestrator.key   the batch grant's agent — it delegates
growth/keys/scout.key          the child grant's agent — it spends
growth/keys/researcher.key     the seller's key — it receives
growth/payees.txt              the allowlist: Researcher, and nobody else
```

Secrets are gitignored. Each `*.key.pub` holds the public half.

**The principal key — two ways, and the second needs no faucet.**

*Either* fund the new key, which keeps this tree's principal separate from
every other grant in the repo:

```
kaspatest:qre9azmma5a30xvna0agenzqjstmluylmz82w67gx0lwys60q0l5cqcafsdu0
```

*Or* use the key that is already funded, which is `warda-testnet.key` at
`kaspatest:qqpexyeaam7yer0kgn69z2tcce663gysscrhpkx70vkswlev9he57gs7vy506`.
A new GRANT does not need a new KEY. The cost is that this tree then shares
its principal and revocation with the repo's other grants — already true of
everything here, and fine on testnet.

Check what is actually spendable before choosing a budget:

```
warda wallet --key ../covenant/deploy/warda-testnet.key
```

Genesis takes a **single input**, so the grant is bounded by the largest coin
at that address, not the total. Several faucet drips need merging first:

```
node --experimental-strip-types ../sdk/tools/consolidate.ts \
  --key ../covenant/deploy/warda-testnet.key --submit
```

---

## 1 · Create the batch grant  → `genesis`

The orchestrator gets a budget it may subdivide, and one address it may pay.

```
cd ~/Desktop/warda/sdk
# FUNDER: growth/keys/growth.key once the faucet lands, or the already-funded
# ../covenant/deploy/warda-testnet.key to start now.
WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key) \
node --experimental-strip-types tools/genesis.ts \
  --agent      $(cat ../growth/keys/orchestrator.key.pub) \
  --recipients ../growth/payees.txt \
  --budget     300000000 \
  --max-per-spend 10000000 \
  --epoch-limit   50000000 \
  --depth      2 \
  --window     200000 \
  --out        ../growth/batch-grant.json \
  --submit
```

3 KAS total, 0.1 KAS the most any one payment may be, 0.5 KAS per epoch, and
**depth 2** so the orchestrator can hire a child at depth 1.

The `--agent` is the orchestrator's PUBLIC key. The principal and revocation
default to **the funder** — whichever key signed this — and that is the key
that can end all of it. It is the one the console should hold.

---

## 2 · Open the batch  → nothing on chain

```
cd ~/Desktop/warda/growth
node --experimental-strip-types tools/batch.ts open \
  --manifest batch-grant.json --payees payees.txt --name first-loop
```

Prints what can be committed and how deep a child may be. Everything after
this is checked against those numbers before it is built.

---

## 3 · Hire Scout  → `delegate`

One input, two authorized outputs: the parent continues, the child is created.
The parent **reserves** exactly what the child receives — authority is
subdivided, never created.

```
WARDA_SK=$(cat keys/orchestrator.key) \
node --experimental-strip-types tools/batch.ts hire scout \
  --payees    payees.txt \
  --agent-key $(cat keys/scout.key.pub) \
  --payee     $(cat keys/researcher.key.pub) \
  --budget    0.5 \
  --max-per-spend 0.05 \
  --window    50000
```

Look at it, then add `--submit`.

**The orchestrator's key signs**, not the principal's: only a grant's agent may
delegate. And Scout's allowlist is one address — not because we trust it, but
because a single-payee child is the only narrowing that is reliably
expressible, and it happens to be the right shape.

---

## 4 · Start Researcher  → it sells, it does not spend

```
cd ~/Desktop/warda/growth
QUOTE_SECRET=$(openssl rand -hex 32) \
WARDA_RPC_JSON=wss://warda-node.tailc0c0ec.ts.net \
node --experimental-strip-types tools/researcher.ts \
  --pay-to $(node -e 'console.log(require("child_process").execSync("node --experimental-strip-types ../sdk/tools/which-key.ts --help").toString())' 2>/dev/null || echo kaspatest:qqj58pd2qw47lg2wn97srt27dwxp8jj2hfasxrt8tjjeytpelzh5sa2mpucwy)
```

Simply:

```
QUOTE_SECRET=$(openssl rand -hex 32) \
WARDA_RPC_JSON=wss://warda-node.tailc0c0ec.ts.net \
node --experimental-strip-types tools/researcher.ts \
  --pay-to kaspatest:qqj58pd2qw47lg2wn97srt27dwxp8jj2hfasxrt8tjjeytpelzh5sa2mpucwy
```

Check it quotes before paying anything:

```
curl "http://127.0.0.1:8790/verify?url=https://github.com/kaspanet/rusty-kaspa"
```

A 402 naming Researcher's address and 0.05 KAS. **Keep `QUOTE_SECRET` for the
life of the process** — a quote signed by one secret is unverifiable by a
process holding another, and that failure lands after the money is spent.

---

## 5 · Scout buys  → `spend`

The child grant pays for the work. The proof is against the CHILD's allowlist,
which has one member, so its payees file is one line.

```
echo $(cat keys/researcher.key.pub) > scout-payees.txt

warda pay "http://127.0.0.1:8790/verify?url=https://github.com/kaspanet/rusty-kaspa" \
  --grant  grant-child-$(cut -c1-8 keys/scout.key.pub).json \
  --payees scout-payees.txt \
  --key    keys/scout.key \
  --id     SCOUT \
  --out    records
```

What must be true for this to work, and all of it is consensus rather than
code: the amount is under Scout's per-spend cap, the epoch has room, the term
has not expired, and the payee is the one address in its allowlist. Over any of
them there is no transaction to sign — not a rejected one, none.

The record lands in `records/`, and it is the deliverable: facts with the URL
each came from, and a named list of what could not be established.

---

## 6 · Settle Scout  → `reabsorb` + `settle`

One transaction, two covenants, two signatures. The parent runs `reabsorb`
signed by its agent; the child runs `settle` signed by the **revocation** key,
so an unresponsive child can never lock its parent's budget.

```
WARDA_SK=$(cat keys/orchestrator.key) \
WARDA_REVOCATION=$(cat ../covenant/deploy/warda-testnet.key) \
node --experimental-strip-types tools/batch.ts settle scout --submit
```

The reserve is released and the parent is charged what Scout actually spent.
Settlement is **LIFO** — with more than one child outstanding, the newest goes
first, and `batch.ts status` prints the order.

---

## 7 · Close

```
node --experimental-strip-types tools/batch.ts status
node --experimental-strip-types tools/batch.ts close
```

The parent grant is untouched by closing a batch. End it deliberately:

```
warda revoke --grant batch-grant.json --key ../covenant/deploy/warda-testnet.key
```

…or leave it: the window in step 1 ends it at DAA `not_before + 200000`, with
nobody online.

---

## What to write down when it works

The transaction ids, in order: genesis, delegation, spend, settlement. Four
transactions, and together they are the first time on Kaspa that one agent
hired another, the second was paid for work, and the budget came home — with
every limit enforced by the network rather than by the program that ran it.

## What to expect to break

Everything here has run in tests and most of it has never run against a chain
in this order. The repo's own record is six covenant vulnerabilities found, none
by reading code. Read the refusal reason, not just the verdict.
