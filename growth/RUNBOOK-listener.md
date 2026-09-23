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

**1. Keys and the allowlist.**

```
npx warda key --out growth/keys/listener.key
npx warda key --out growth/keys/xreads.key
```

Put the X-reads address — the one `warda key` printed for `xreads.key` — in
`growth/listener-payees.txt`, one line, nothing else. That file is the
allowlist, fixed at genesis; the grant can pay that address and no other, and
no edit to any file here changes it afterwards.

**2. The seller.**

```
export X_BEARER_TOKEN=…
export QUOTE_SECRET=$(openssl rand -hex 32)
export XREADS_ADDRESS=kaspatest:…
node --experimental-strip-types growth/tools/xreads.ts
```

`QUOTE_SECRET` must be the same across restarts — a secret generated per
process makes every quote issued before a restart unverifiable after it, and a
buyer who paid against one is refused having paid. Keep it in
`growth/listener.env`, which is gitignored.

**3. A public hostname**, so the listing can be checked and so the buyer is not
talking to localhost. Tailscale Funnel, third port:

```
/Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg --https=10000 localhost:8788
```

Then sign the listing against the X-reads key and serve it from that origin —
same two steps as `covenant/auditor-service/README.md`.

**4. The grant.** `sdk/tools/genesis.ts`, with the numbers in the table above.

---

## Every pass

```
source ops/node.env
node --experimental-strip-types growth/tools/listen.ts
```

`--dry-run` prints the searches it would buy and spends nothing. Run that
first: it is the only way to see the queries against the real rotation without
paying for the answer.

Cron, twice daily:

```
13 8,20 * * *  cd ~/Desktop/warda && node --experimental-strip-types growth/tools/listen.ts
```

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
