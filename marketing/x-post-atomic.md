# Post — the atomic delegation, 24 September 2026

**Image:** `marketing/img/post-atomic-delegation.png` (1600×900, from
`marketing/cards/atomic.html` — regenerate with `node shoot-atomic.mjs`)

Follows the /one-job post from this morning, whose reply 2 said the atomic part
"needs the covenant to change, not the tooling". It did, the same day. That is
the whole post: a caveat with a date on it, and then the date.

Rules carried: links in the first reply, every number in
`v5-demo/grant-child-*.json` or on chain, nothing rounded, **no claim to be
first** — nothing in this repo establishes that and one counter-example
destroys it.

The figures:

    coordinator   0.80 KAS, keeps 0.306, reserves 0.47
    child A       0.25 KAS, settles last
    child B       0.22 KAS, settles first
    one input, three outputs, one signature
    1387b839f03b588256b1b1727a3ba774eb423b62eb985598a17a960866d8cf74
    covenant v5, 157b64e3eeea9c01 — unaudited

---

## Option A — the caveat, dated  (recommended)

**Post** (271)

> This morning we said hiring two agents at once wasn't possible on our
> covenant, and that fixing it needed the covenant to change rather than the
> tooling.
>
> It changed. Two agents hired in one transaction — one input, three outputs,
> one signature.

**Reply 1**

> The covenant, what it refuses, and the transaction: wardaprotocol.com/one-job

**Reply 2**

> Two and not more, and that is consensus rather than a choice. Kaspa's storage
> mass counts 1/value over a transaction's outputs, so each extra child costs a
> whole term: 1:2 masses 420,435 against a ceiling of 500,000 and 1:3 masses
> 770,994 and is refused.

---

## Option B — the mechanism

**Post** (266)

> Hiring two agents one at a time is two transactions, because the second one's
> input is the first one's output. It does not exist until the first confirms.
>
> These two exist from the same moment, out of one coordinator's budget, and
> each is its own coin from that moment.

**Reply 1**

> 0.8 KAS in, 0.25 and 0.22 delegated, 0.306 kept and 0.47 reserved. One
> signature authorised all of it: wardaprotocol.com/one-job

---

## Option C — the honest cost

Opens on what it cost rather than on what shipped. Weakest hook, strongest
credibility with anyone who has tried this.

**Post**

> New covenant entrypoint today. What it cost:
>
> Two children in one transaction needs a sequential budget bound, distinct
> agent keys, and a reserve chain pushed in output order. Get the second one
> wrong and you have issued one authority twice.

**Reply 1**

> Every rule, the ten cases that check them, and the transaction:
> wardaprotocol.com/one-job

---

## What is NOT claimed

- **Not "the first".** Nothing here establishes it.
- **Not audited.** v5 is a draft with a passing suite. The card says so.
- **Not settled.** The harness proves v4's `reabsorb` settles what `delegate2`
  creates; nothing has done it against the network yet. No draft claims a round
  trip, and the next post can — once it has happened.
- **Not an agent economy.** Two agents, on testnet.
