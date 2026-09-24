# Quote-post — /one-job, 24 September 2026

Quoting a post asking for "a small working example on Kaspa. A few agents, one
task, an agreed payment. Something we can follow from start to finish."

**It answers the last paragraph and nothing else.** The post being quoted
characterises what Sutton argued in his reply to BlackRock; that reply has not
been read here, so nothing below restates it. Rule from `x-series.md`: a claim
about what a third party said needs the source or a timestamp, and an
unverifiable quote puts words in somebody's mouth.

Rules carried: links in the first reply, never the post. No number that is not
in `site/src/one-job.json`. Nothing rounded.

The figures, all from the trace:

    coordinator   0.80 KAS, two allowed payees, may delegate 2 deep
    RESEARCH      0.25 KAS, narrowed to ONE of the two, paid 0.05
    VERIFY        0.22 KAS, narrowed to the OTHER, paid 0.04
    7 transactions   genesis, 2 delegations, 2 payments, 2 settlements
    paid 11:50:29 → delivered 11:57:35 UTC, same proof, nothing paid twice

---

## Option A — the direct answer

Answers the ask in its own terms. Safest, least memorable.

**Post**

> A coordinator hired two agents and gave each a slice of its own budget,
> narrowed to one address each could pay.
>
> RESEARCH could not pay the auditor. VERIFY could not pay the researcher.
> Not policy — the covenant refuses the transaction.
>
> Seven transactions, start to finish.

**Reply 1**

> Every step, every txid, both sellers, and the storage-mass ceiling that
> refused a payment the covenant allowed: wardaprotocol.com/one-job

**Reply 2**

> What it does not do is the atomic part. The covenant fixes the shape at
> parent plus one child, so two workers is two transactions — and a grant is
> one UTXO, so they cannot even be concurrent. Both workers had to exist
> before the job did.

---

## Option B — the limit first

Opens by conceding the thing the quoted post cares most about. Honest, and a
weaker hook: it spends the first line on what is missing.

**Post**

> Built it. The limit first: it is not atomic.
>
> The covenant fixes the shape at parent plus one child, so hiring two agents
> is two transactions, and a grant is one UTXO so they cannot overlap.
>
> What it does do: each worker could pay exactly one address, and the chain
> enforced it.

**Reply 1**

> A coordinator with 0.8 KAS and two allowed payees, delegating 0.25 to one
> agent and 0.22 to another, each narrowed to ONE of the two. Seven
> transactions, start to finish. wardaprotocol.com/one-job

---

## Option C — the failure  (recommended)

The repo's own convention: the failure posts are the ones that land, because
nobody else's demo has one. It is also the only part of this run that is
genuinely novel — every x402 demo shows a payment that works.

**Post**

> One of the two payments settled and delivered nothing.
>
> The agent did not pay again. It kept the proof it was issued, we fixed the
> seller, and it re-presented the same proof seven minutes later.
>
> A coordinator, two hired agents, seven transactions, start to finish.

**Reply 1**

> The run: a coordinator with 0.8 KAS and two allowed payees, delegating 0.25
> to one agent and 0.22 to another — each narrowed to ONE of the two, enforced
> by the chain. wardaprotocol.com/one-job

**Reply 2**

> Not atomic, and that is the covenant rather than the tooling: parent plus one
> child per transaction, one UTXO per grant, and every payee fixed before the
> job existed. That is the honest distance between this and an open market.

---

## What is NOT claimed, and why

- **Nothing about what Sutton said.** Not read here. See the note at the top.
- **No agent economy.** Two agents, two purchases, on testnet. `x-series.md`:
  the authority layer is ready and the market is not.
- **Not "the first".** Nothing in the repo establishes that, and it is the
  kind of claim one counter-example destroys.
- **"we fixed the seller"** is ours to say — the seller is Warda's own Covenant
  Auditor, and the bug and the fix are both in the repo.

---

## Option D — "you asked, it already works"  (chosen register)

Warm and confident rather than defensive. The distinction that keeps it honest:
the CAPABILITY already shipped — delegation landed in v4 and the subset witness
in `6b7e355`, both before the post being answered — while the RUN happened on
24 September. "It already works, so we ran it this morning" says both. "We
already had this" would say the second thing falsely, and it is the kind of
sentence one screenshot of a commit date undoes.

**Post**

> Good news: this already works.
>
> We ran it this morning. A coordinator hired two agents, gave each a slice of
> its own budget, and each one could pay exactly one address — enforced by
> Kaspa, not by their code.
>
> Two jobs, two sellers, seven transactions, start to finish.

**Reply 1**

> The whole run, every txid, both sellers: wardaprotocol.com/one-job

**Reply 2**

> One caveat worth saying out loud: it is not atomic. The covenant allows
> parent plus one child per transaction, so hiring two agents is two of them,
> and every payee has to exist before the job does. That part needs the
> covenant to change, not the tooling.

### D2 — same register, the refusal instead of the summary

**Post**

> You asked. It already works — so we ran it this morning.
>
> A coordinator hired two agents and gave each a slice of its own budget.
> RESEARCH could only pay the researcher. VERIFY could only pay the auditor.
> The chain refuses anything else.
>
> Seven transactions, start to finish.
