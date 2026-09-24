# Campaign — "Bring your agent. We'll fund it."

Fourteen **standalone posts**, not a thread. Publish one a day, in any order
that suits the week; each stands on its own and none depends on the one
before it.

One CTA throughout. What changes every day is the evidence.

## The rule this keeps

From `x-threads.md`: *every post lands on one thing that actually happened
here, with a transaction id, a quote, or a failure.* A campaign is the easiest
place in the world to drift into selling by day four — so none of these
fourteen is an argument. Each is a thing that happened, and the ask is the
last line rather than the point.

Six of them are about something that went wrong, or something Warda cannot do.
That ratio is deliberate and it is the reason this reads as an invitation
rather than an advert.

## What is promised, and can be delivered

`/grant` already funds exactly what these posts describe: 5 testnet KAS, 0.5
per payment, 2 per ~100 seconds, an allowlist fixed at genesis, 30 days. No
number of slots is named anywhere — there is no promise to miss, and no
"9 remaining" that stops being true.

**If somebody breaks it, we publish it in full.** Stated in post 1 and again
in post 14. It costs nothing that has not already been spent, and it is the
most credible thing an unaudited project can say.

---

### 1. Launch — the offer and the dare  *(262 chars)*

> We'll fund your AI agent with 5 testnet KAS and limits it cannot exceed.
>
> Then try to break them.
>
> Exceed the cap. Pay an address that isn't on the list. Outrun the rate limit.
>
> If you succeed we publish it in full, with the transaction.
>
> wardaprotocol.com/grant

### 2. The published key  *(273 chars)*

> An agent's complete private key is published on our site. Not a hash of it. The key.
>
> It has held funded testnet money since 2 September. Anyone can take it.
>
> All it can buy is one vendor's API, 0.1 KAS at a time — the limits aren't in our server.
>
> wardaprotocol.com/attack

<!-- The earlier draft claimed "the most anyone has managed is buying one
vendor's API a few more times". Nothing supports that: the only spends from
that grant are the four we made ourselves on 2-3 September (git log on
site/src/demo-grant.json), and the balance has not been read since. The line
now claims only what the covenant enforces, which the page itself shows. -->

### 3. The engine  *(273 chars)*

> We ran 118 transactions through the same script engine a Kaspa node validates with. One field changed at a time; the numeric limits tested one sompi either side.
>
> Forbidden cases accepted: 0.
> Permitted cases refused: 0.
>
> It is not a security audit.
>
> wardaprotocol.com/audit

Figures from `covenant/audit.json` (generated 2026-09-23 09:41 UTC). The last
line is the report's own disclaimer, kept because dropping it would make this
post claim more than the report does. This is the one post whose CTA is
`/audit` rather than `/grant`.

<!-- This slot was "The refusal", quoting agent #012's covenant refusal of
2026-09-23 12:55 under the line "The network answered". The quote is verbatim
and real (growth/listener/purchases/2026-09-23T12-55-07-110Z.json, txid null),
but the network never saw it: that message is thrown by payNow() in the SDK
before a transaction is built or broadcast. Every recorded refusal across
agents #001-#012 is client-side in the same way, so there is no live node
rejection to substitute. The audit is the enforcement evidence that survives
the question "who decided?" - its verdicts come from TxScriptEngine itself. -->

### 3b. Credit  *(269 chars)*  — not one of the fourteen

> 596 lines of Silverscript compile to a rate limit counted in blocks, not seconds. 1,000 blocks ≈ 100 seconds, because Kaspa makes 10 a second.
>
> No cron, no clock, no server — the DAG is the timer.
>
> Thank you @OriNewman @MichaelSuttonIL @hashdag and the Kaspa core devs.

Figures: `wc -l covenant/warda_grant.sil` is 596; `epochLength` is 1000 in
`site/src/demo-grant.json`, which `site/src/grant.html` renders as "every 1000
blocks" and states as "at most 2 in any ~100 seconds". 1000 blocks ≈ 100
seconds only because testnet-10 runs at 10 BPS after Crescendo — that identity
IS the post. The Listener's 432,000-block epoch is the same arithmetic at 12
hours. No CTA link: a thank-you that ends in a funnel is not a thank-you.

Handles verified before use, because a mistagged credit post is worse than no
credit post: @OriNewman designed Silverscript, @MichaelSuttonIL wrote the
Toccata covenants++ outlook and is Kaspa core R&D, @hashdag is Yonatan
Sompolinsky.

An earlier draft of this praised Silverscript in the abstract ("the clearest
thing I've built on"). This one names a thing the chain does that our covenant
could not be written without, which is the same compliment with evidence
attached.

### 4. A vendor that has never heard of us  *(276 chars)*

> Agent #005 buys from demo.kaspa-x402.org every morning. We don't run it. They have never heard of Warda.
>
> 9 attempts since 16 September, 6 served, 0.2 KAS each, unattended.
>
> A bounded agent transacting with software that knows nothing about the bound.
>
> wardaprotocol.com/grant

Counted from `agent-005/purchases/` on the morning it was posted: 9 files,
6 `bought`, 1 `paid-then-failed` (18 September, post 5), 2 `failed`, every
quote 0.2 KAS. The draft said "5 of 8" and was a week stale — these figures
move every morning, so recount before posting rather than trusting the file.

### 5. The failure we published  *(273 chars)*

> On 18 September agent #005 paid 0.2 KAS and was never served.
>
> 285057ed… settled on chain. Nothing came back for it.
>
> It's published on the agent's page beside the purchases that worked, because an agent that shows you only its successes is a demo.
>
> wardaprotocol.com/grant

### 6. An agent hired by an agent  *(275 chars)*

> Agent #004 wasn't issued by a person. Agent #003 hired it.
>
> It held a piece of its parent's authority — which could only ever shrink, never grow — spent 0.04 KAS, and settled the rest back.
>
> Delegation enforced by the chain, not by a policy document.
>
> wardaprotocol.com/grant

### 7. The key nobody holds  *(270 chars)*

> Agent #011's key was created inside a signing enclave and has never been on a machine of ours.
>
> First purchase: fa5dfe72…
>
> The custodian can sign for it. What it cannot do is sign for more than the grant allows — that part isn't ours to enforce.
>
> wardaprotocol.com/grant

### 8. Refused by its own start time  *(241 chars)*

> Before agent #002 could spend anything, it was refused twice — by its own start time.
>
> Not a scheduler. Not a feature flag.
>
> A transaction that could not be built yet, because the network would not count it as valid.
>
> wardaprotocol.com/grant

### 9. The audit number we didn't round up  *(268 chars)*

> We ran 118 transactions through the same script engine a Kaspa node validates with.
>
> 38 of 39 published claims exercised. 0 violations.
>
> The 39th is named on the page as uncovered, because leaving it out would have made the number look better.
>
> wardaprotocol.com/audit

### 10. What our own tool cannot find  *(253 chars)*

> We built a tool that checks a covenant against its own claims.
>
> Then we checked it against the five real vulnerabilities we've found in ours.
>
> It would have caught zero of them. A claims test can't find the rule you never wrote.
>
> wardaprotocol.com/audit

### 11. The limit we can't enforce  *(268 chars)*

> Honest limit: x402's exact scheme cannot take a covenant spend.
>
> So agent #005 pays a single-use key, and that key pays the vendor.
>
> Budget, cap and rate limit all still hold. The allowlist does not reach past that hop. It says so on the page.
>
> wardaprotocol.com/grant

### 12. A fleet that runs itself  *(252 chars)*

> Every Monday an agent is given a budget, hires a second agent with part of it, takes back what's unspent, and ends itself.
>
> Nobody presses anything.
>
> Neither one can spend more than it was handed. That isn't a rule in our code.
>
> wardaprotocol.com/grant

### 13. The terms, plainly  *(233 chars)*

> What a Warda grant gives your agent:
>
> 5 testnet KAS
> 0.5 max per payment
> 2 payments per ~100 seconds
> an allowlist fixed when it is created
> 30 days, then it stops
>
> Your agent's secret never leaves your machine.
>
> wardaprotocol.com/grant

### 14. The reason we're asking  *(245 chars)*

> No third party has audited this covenant. It has never held real money.
>
> Which is exactly why we'd rather your agent attacked it than ours kept proving it works.
>
> Bring one. We'll fund it. If you break it, we publish it.
>
> wardaprotocol.com/grant

---

## Posting notes

- Any order. Lead with 1, close with 14; the middle twelve are interchangeable
  and can be reshuffled around whatever happens that week.
- If a real external agent arrives, stop the schedule and post that instead.
  It beats all fourteen.
- Posts 5, 10, 11 and 14 are the ones about failure and limits. Do not drop
  them to make room — they are why the rest is believed.
- Replies matter more than these do. These give a reason to look; a useful
  reply in somebody else's thread is what gets looked at.
