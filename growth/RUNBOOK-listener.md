# Listener

An agent that finds conversations on X where Warda has something to say, pays
for the reads, and sends you the ones worth your attention. You decide what to
post. Nothing is ever sent on your behalf.

It is Scout's sibling and shares its shape. The difference is the unit: Scout
finds projects, which stay findable for months, and this finds posts, which
are dead in a day or two.

---

## The grant

```
budget          2.1 KAS          42 searches over the term
maxPerSpend     0.05 KAS         one search
epochLimit      0.15 KAS         three searches per epoch
epochLength     432,000 DAA      12 hours at 10 DAA/s
term            6,048,000 DAA    7 days
payees          the X-reads address, and nobody else
delegationDepth 0                it hires no one
```

**Where those numbers come from.** X charges $0.005 per post read, pay-per-use.
One search reads up to 10 posts, so it costs the operator $0.05, and the KAS
price covers that. Twice daily is 14 passes a week; three searches a pass is 42
searches, which is $2.10 of real money a week against a 2.1 KAS budget.

**Why the epoch is 12 hours.** So that it matches a pass. An epoch shorter than
the cadence makes the limit unreachable; one longer lets a single broken pass
spend the day's allowance and the next pass's too. Matched to the cadence, the
allowance refills exactly when the next pass needs it, and a pass that burns
through it is visibly a pass that went wrong.

**These numbers live in `src/shape.ts`,** and both tools take their defaults
from it. The table above is checked against that file by
`ops/check-listener.mjs`, in CI — along with a grant, once one exists. A grant's
terms are fixed at genesis, so if they ever disagree the grant is the truth and
`shape.ts` is what moves.

**The limit is the backstop, not the budget.** `src/rotate.ts` decides what a
pass can afford and buys that; the covenant's epoch limit exists for the case
where that file is wrong. Which is also the only arrangement where the limit
firing tells you something — if the chain refused, the software miscounted, and
you want to know.

---

## First: is the ranking any good?

Do this before the grant, the tunnel and the signed listing, because if the
posts coming back are not worth tapping then none of the rest is worth
building.

Get an X bearer token — <https://developer.x.com>, pay-per-use, $0.005 per post
read — and run a trial pass on your own card:

```
export X_BEARER_TOKEN=…
node --experimental-strip-types growth/tools/listen.ts --direct
```

It calls X directly, with no grant and no payment, prints every candidate with
its score broken down, and **sends nothing**. A rule still being tuned should
not be interrupting anybody.

Default cap is 60 reads a pass, about $0.30. `--max-reads` moves it. Run it a
few times over a day — the rotation advances, so a day covers every query — and
read the rejected ones as carefully as the kept ones. A ranking is judged by
what it threw away.

What you are looking for: the top of the list should be people with the problem
Warda solves, not people with opinions about the category. If the takes are
outranking the builders, the weights in `src/listen.ts` are wrong, and that is
a ten-line change rather than a redesign.

**This is the one path here with no covenant behind it.** The cap is in
`tools/listen.ts` and nothing but that file stops it — which is precisely the
arrangement the rest of this repo exists to argue against. It is fine for a
trial you are watching. It is not how this runs.

---

## Then: make it an agent

**1. Keys, the allowlist and the grant — one command.**

```
growth/tools/first-listener-grant.sh --dry-run
growth/tools/first-listener-grant.sh
```

It creates both keys without ever overwriting one, writes the allowlist from
the seller key's own address rather than from anything typed, refuses if the
funder has no single coin big enough (genesis takes one input), submits genesis
with the numbers from `src/shape.ts`, and finishes by checking the chain and
the code agree.

Genesis is the irreversible step here. A grant's terms are fixed the moment it
lands and can only be ended, never edited.

**2. The seller's environment.** `growth/listener.env` needs `QUOTE_SECRET`
(`openssl rand -hex 32`, and the same value across restarts) alongside the
`X_BEARER_TOKEN` already there.

**3. The seller, always up.**

```
ops/install-cron.sh --listener
curl -s http://127.0.0.1:8788/ | head -20
```

`--listener` installs two lines: the pass at 08:13 and 20:13, and
`ops/xreads-up.sh` every five minutes, which starts the seller if it is not
answering. The `curl` is the check — it prints the seller's terms, or nothing,
and `~/Library/Logs/warda-xreads.log` says why.

**Not a LaunchAgent, and this is worth knowing before you try one.** launchd
spawns outside cron's Full Disk Access grant, so it cannot read a script in
`~/Desktop` at all — the log fills with `Operation not permitted` and nothing
starts. Granting Full Disk Access to `/bin/bash` to fix one daemon is a wide
permission for a narrow problem. Cron already has the grant, and this repo
already keeps a process alive this way in `ops/proxy-up.sh`.

(The same applies to the kaspad and tunnel plists in `ops/` — they were never
loaded, and would hit the same wall.)

To start it once, by hand, before cron gets to it: `ops/xreads-up.sh`.

**No tunnel, and no hostname.** The grant's allowlist fixes who gets paid —
the seller's address — not what URL it answers at, and both ends are on one
machine, so `127.0.0.1:8788` is all the payment needs. Given X forbids
redistributing post content to third parties, an endpoint strangers cannot
reach is the strongest compliance available rather than a compromise. There is
no signed listing and no registry entry, deliberately.

It must be running before 08:13 or the pass finds nothing to buy from. The pass
checks and says so on Telegram if it is down — a seller that is not answering
produces refusals that look exactly like the covenant refusing, and that is the
one misreading worth preventing.

**4. Hand the pass to the grant.** In `ops/listener-pass.sh`, drop
`--direct --send` and add `--grant growth/listener-grant.json`. One attended
run first:

```
node --experimental-strip-types growth/tools/listen.ts --grant growth/listener-grant.json
```

Nothing else changes — same cadence, same three searches, same cost. The only
difference is that the limit stops being a number in a file and becomes a rule
the network enforces. That is why it ran at the covenant's budget from the
first day: the switch should be invisible except on chain.

---

## Every pass

```
source ops/node.env
node --experimental-strip-types growth/tools/listen.ts
```

`--dry-run` prints the searches it would buy and spends nothing. Run that
first: it is the only way to see the queries against the real rotation without
paying for the answer.

### Launched before the grant

The discovery half runs now; the payment half does not exist yet. That is a
deliberate split — the ranking is reversible and the value is immediate, while
a grant's terms are fixed at genesis and the payment path has never run.

```
ops/install-cron.sh --listener
```

08:13 and 20:13, twelve hours apart to match the epoch the grant will have, and
off the hour so it is not queued behind the jobs that touch the chain.
`--no-listener` removes it.

Each pass runs `--direct --send`: X on your own token, messages to Telegram,
and **no covenant behind it**. The cap is three searches — the same three the
grant will allow — enforced by `tools/listen.ts` and by nothing else. Running
at the budget the covenant will enforce means switching to the grant changes
nothing except where the limit lives; if the two disagreed, the switch would
look like a regression and the covenant would get the blame.

Every pass saves its run, and the files prune themselves after a day.

**It spends dollars, not testnet KAS.** About $0.15 a pass, $2.10 a week, on
the card behind the X developer account. That is the one thing here that is
not play money, and it is why this job is opt-in.

Exit 3 means the covenant refused — the epoch's allowance is spent. That is the
limit working, it is reported to Telegram, and the next pass is twelve hours
away with a fresh allowance.

---

## What reaches you

One message per opportunity: the handle, the follower count, how old the thread
is, the post itself, why it was picked, and a suggested angle. Then the link.

The angles are **written down in `src/alert.ts` and chosen by which query found
the post** — not generated. A generated suggestion would be fluent every time
and true most of the time, and the times it was not would be public, under your
name, in a thread you were trying to join. When no written angle fits, the
message says so and suggests nothing.

The message carries the reasons and not the score. A number invites tuning the
number; the reasons are what tell you whether to tap.

A pass that found nothing sends nothing. A twice-daily "nothing today" is how a
feed teaches you to stop reading it.

---

## X's terms, and what they decided

Two things here are shaped by [X's Developer Policy](https://docs.x.com/developer-terms/policy)
rather than by preference, and both were found after the code was written.

**The X-reads service is never listed.** The policy lets you distribute Post
IDs to third parties and not Post objects. A service handing out post text and
metrics, automatically, to whoever pays, is redistribution. So it is not in
`site/src/services.json`, not in the registry's sources, and serves no
`.well-known` listing — the 404 there says why. The on-chain demonstration is
unchanged: one operator's agent paying that same operator's endpoint under
limits the network enforces is exactly what was always claimed.

**Saved runs keep their text for a day.** Post objects stored offline carry a
24-hour obligation to reflect deletions on X; Post IDs carry none. Refreshing a
tuning fixture forever would cost a read per post forever, so a saved run keeps
its content for a day and then keeps only what is ours — the IDs, the URLs, why
we looked. `src/retain.ts`, run at the top of every pass rather than written
down here, because a retention rule somebody has to remember holds until the
week they are busy.

**Nothing is posted, replied, liked, reposted, followed or messaged
automatically**, which is what the developer application says and what the
design has to keep true.

---

## Honest limits

**Both ends are ours.** The buyer is our agent and the seller is us. The coin is
testnet KAS and is worth nothing. What the chain proves here is that a grant's
limits were enforced — not that a market exists. `src/xsearch.ts` says this in
the response body, not only here, so an agent reading the service is told.

**The dollars are real and the KAS is not.** X bills us per read in USD. The KAS
payment mirrors that bill; it does not settle it. This is the first service in
the fleet where the price covers a cost somebody invoices us for, which is worth
something — and it is still not a market.

**The score is a rule, not a judgement.** Every component is printed beside the
post. When the reasons stop matching the posts, the rule is wrong and you can
see that it is. That is the whole design: it is checkable by reading, which is
the property a model-written score would not have.

**Nothing is posted automatically, and there is no plan to change that.** The
agent handles discovery. The decision to speak stays with you.
