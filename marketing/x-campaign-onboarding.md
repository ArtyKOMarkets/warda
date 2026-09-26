# Campaign — "Ten minutes. The last one is the point."

Eight **standalone posts**, one per step of `/start`, publishable one a day in
order or out of it. The campaign *is* the walkthrough: each post carries one real
command and its real output, so a reader who never clicks has still watched
somebody do it.

One CTA: **wardaprotocol.com/start**. What changes every day is the step.

## The rule this keeps

From `x-threads.md`: *every post lands on one thing that actually happened here,
with a transaction id, a quote, or a failure.* Onboarding copy is where that rule
is hardest to keep, because the honest version of "try it" is a list of commands
and the tempting version is a promise about how it will feel. Every command below
was run — the published CLI, `npm install -g @warda_protocol/cli`, in a clean
container on 26 September 2026 — and every output is pasted rather than composed.

Three of the eight are about something that does not work, or that we got wrong.
That ratio is the reason this reads as an invitation rather than an advert, and
posts 6 and 7 are the two a competitor would never publish.

## What is promised, and can be delivered

- `/start` says eight steps and about ten minutes. Verified as far as a container
  can: the install is one command and finished in under a second; `warda key`
  writes a 0600 secret and a `.pub` beside it; the commands in the quickstart are
  the commands the CLI has.
- `/grant` funds **5 testnet KAS, 0.5 per payment, 2 per ~100 seconds, 30 days**,
  usually within a day, with no faucet and no account. That is what the page says
  and what `ops/grants.ts` issues.
- Everything is testnet-10. The coins are free and worth nothing, which is the
  correct amount to risk on a protocol that has not been audited. Said in the
  footer of every card, and in post 1.

**No number of slots, no countdown, no "spots remaining."** There is nothing here
that stops being true next week.

---

### 1. The offer, and the shape of the ten minutes  *(272)*

> From nothing to a payment the network bounded: eight steps, about ten minutes,
> no prior knowledge of Kaspa.
>
> Minutes one to eight are setup. Minute nine is the one worth staying for — the
> payment that gets refused.
>
> Testnet. Free coins. Unaudited.
>
> wardaprotocol.com/start

<!-- "Minute nine" is a figure of speech about an eight-step walkthrough and not a
     measurement; it is deliberately not written as data. The eight steps and the
     ten minutes are /start's own words. -->

### 2. Step one is one line  *(239)*

> The whole install:
>
> npm install -g @warda_protocol/cli
>
> That is the entire surface. No SDK to wire up, no account, no key of ours on
> your machine, nothing to register.
>
> Then `warda` on its own lists what it can do.
>
> wardaprotocol.com/start

### 3. The two keys, which is the whole model  *(279)*

> $ warda key --out wallet.key
>   address : kaspatest:qrs3tpmwc2da56rvardh8eqpqp4pcm3a87f3nnf229x25tvcgtejkwz266th8
>   secret  : wallet.key
>
> That one can pay anyone. It funds the grant and the agent never sees it.
>
> The agent gets a different key that cannot.
>
> wardaprotocol.com/start

### 4. The limits go in at creation, not into a config  *(272)*

> $ warda grant --key wallet.key --payees payees.txt --budget 10 --max-per-spend 1
>   ✔ grant.json  10 KAS · 1 per payment · 1 payee, fixed at creation
>
> "Fixed at creation" is literal. Not editable by me, by the agent, or by whoever
> takes the laptop.
>
> wardaprotocol.com/start

### 5. Minute nine  *(261)*

> $ warda pay https://warda-demo-api.vercel.app/fact
>   ✔ 0.04 KAS · 200 · fa7ad66b6b17…
>
> $ warda pay https://somewhere-else.example/thing
>   ✗ that address is not on this grant's allowlist. There is nothing to sign.
>
> No transaction exists.
>
> wardaprotocol.com/start

<!-- The strongest post in the campaign and the reason for the arc. The second
     output is the quickstart's, verbatim. "There is nothing to sign" is the whole
     product: the address is committed into the script that unlocks the coin, so
     there is no valid transaction to build — not one the network would reject,
     none at all. -->

### 6. What it told you to do, and why that did not work  *(272)*

> No Kaspa node? Step 0 told you:
>
>   npm install @warda_protocol/borsh @kluster/kaspa-wasm
>
> Do exactly that and the same message comes back, unchanged. A global CLI cannot
> see a project's node_modules. It needed -g.
>
> Found by following our own page.
>
> wardaprotocol.com/start

<!-- Fixed in 4634d5d. Publishing it is the point: an onboarding bug at step 0 is
     the most expensive bug a project has, and "we walked our own walkthrough and
     it was wrong" is a better advert for the walkthrough than the walkthrough. -->

### 7. Our own limits stopped our own agents  *(261)*

> We froze a new covenant version on 25 September. Every grant we have on chain was
> the old one.
>
> For 21 hours our agents derived the wrong address, found nothing, and reported
> empty grants. 8 attempts, 0 payments.
>
> The money never moved.
>
> wardaprotocol.com/start

<!-- MAINNET.md §3.3e, and the numbers are from growth/listener/purchases and
     agent-003/ and agent-005/. The reason this belongs in an ONBOARDING campaign:
     the thing a newcomer is deciding is whether to trust a protocol nobody has
     audited, and the only evidence available is what we say when it breaks. -->

### 8. No faucet, if you would rather not  *(271)*

> Don't want to find testnet coins? Send us your agent's public key.
>
> We fund a grant for it: 5 KAS, 0.5 per payment, 2 per ~100 seconds, 30 days,
> an allowlist fixed at creation. Usually within a day.
>
> Your agent's secret never leaves your machine.
>
> wardaprotocol.com/grant

<!-- The one post with a different CTA, deliberately last: it is the door for
     somebody who has read the other seven and wants the short version. The terms
     are /grant's own, word for word. -->

---

## The card

One card, for post 5, because that is the post the campaign exists to get people
to. The other seven carry a terminal paste, which is already a picture.

    marketing/cards/onboarding.html          the source
    marketing/cards/shoot-onboarding.mjs     node shoot-onboarding.mjs
    marketing/img/post-onboarding-minute-nine.png   the render, 1600×900 at 2x

The source is committed and the render beside it is not — `marketing/cards/*.png`
is gitignored for the reason `cards.html`'s own header gives: a graphic that cannot
be regenerated goes stale the first time a figure in it changes. What ships sits in
`marketing/img/` with the other post images.

Its `<style>` is imported verbatim from `cards.html` rather than restated. Two
files describing the same design tokens is how the second one drifts, and these
have to read as one system.

## What this campaign must not become

A funnel. There is no drip, no sequence that only makes sense in order, and no
post that exists to set up the next one. If somebody reads post 6 first — the one
about our instruction being wrong — that is a perfectly good introduction to this
project, arguably the best one, and it must stand on its own.
