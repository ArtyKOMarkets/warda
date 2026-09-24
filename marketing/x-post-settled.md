# Post — the round trip, 24 September 2026

Third and last of the day, and the only one that closes something. The
/one-job post said the atomic part needed the covenant to change; the atomic
post said `delegate2` had changed it, and listed what it was NOT claiming:

> **Not settled.** The harness proves v4's `reabsorb` settles what `delegate2`
> creates; nothing has done it against the network yet. No draft claims a round
> trip, and the next post can — once it has happened.

It has happened. This is that post.

**Image:** none yet. The page's own reserve chart is the graphic —
wardaprotocol.com/one-job, bottom section — so the link carries it. If one is
wanted, shoot that `<figure>`.

Rules carried: links in the first reply, every number on chain or in
`site/src/one-job-atomic.json` (which the site build checks against
`v5-demo/*.json`), nothing rounded, **no claim to be first**, and the covenant
is still unaudited and still says so.

The figures:

    0.80 KAS         coordinator, one grant
      0.47 reserved  two children, one transaction   1387b839…
      0.25 back      settle B, hired last, home first 01973e8f…
      0.22 back      settle A                         d54690e3…
    0.690192 KAS     what it holds now, reserved 0, chain empty
    0.109808 KAS     the whole difference, and all of it fees
    back at the address it was born at — a grant's address is a hash of its state

---

## Option A — the money came back  (recommended)

The strongest thing here is not that two agents were hired. It is that nobody
spent anything and the coordinator got its capacity back, which is the part a
spending limit cannot do.

**Post** (249)

> An AI hired two other agents this morning, in one transaction.
>
> This afternoon both of them handed the unspent budget back — not to me, to
> the coordinator, mid-task. It can hire again with it.
>
> 0.8 KAS out, 0.690192 KAS home. The difference is fees.

**Reply 1**

> Four transactions, all on testnet-10, all linked from the page:
> wardaprotocol.com/one-job

**Reply 2**

> Why it matters more than a budget: a limit that simply expires returns the
> coin to the human who issued it. Settling returns it to the agent that lent
> it, while the job is still running. One is an allowance. The other is a
> balance sheet.

**Reply 3**

> Covenant v5, 157b64e3eeea9c01, unaudited. Two children and not three, because
> Kaspa's storage mass refuses 1:3 — 770,994 against a ceiling of 500,000.

---

## Option B — the caveat closed

Mirrors the atomic post's structure, which worked. Weaker hook, and it only
lands for people who read that one.

**Post** (222)

> Yesterday's post listed what we were not claiming. Top of the list:
>
> "Not settled. Nothing has done it against the network yet. The next post can
> — once it has happened."
>
> Both children settled today. Reserve back to zero.

**Reply 1**

> The two transactions, and the page that renders all four:
> wardaprotocol.com/one-job

---

## Option C — the ordering

For the people who will ask why it is not arbitrary. Narrowest audience,
highest respect from it.

**Post** (273)

> Settling two hired agents has exactly one legal order, and it is not a
> preference.
>
> The parent's record of its children is a hash chain. You pop it from the end.
> So the worker hired LAST comes home FIRST, and the other order is refused by
> the covenant — we ran it to check.

**Reply 1**

> Both settlements, the refusal, and the run they came from:
> wardaprotocol.com/one-job

---

## What is NOT claimed

- **Not "the first".** Nothing here establishes it, and one counter-example
  would destroy the account.
- **Not audited.** v5 is a draft with a passing probe suite. The page says so
  in the section itself, not only in the footer.
- **Not an open market.** The third limit on that page still stands: a
  coordinator can only hire from the cast its grant was created with. That is
  the honest distance between this and the thing people imagine, and it is
  bigger than the two that were removed today.
- **Not "agents earned money".** Nobody was paid in this round trip. The two
  workers were funded and then handed it back unspent; the paying happens in
  the v4 run above it on the same page.
- **Not free.** 0.109808 KAS in fees on 0.8 KAS is 13.7%, on testnet, at a
  fee the node named twice because our default was measuring the old covenant.
