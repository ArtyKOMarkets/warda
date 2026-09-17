# Five posts for AI builders — 17 September 2026

Standalone, post over five days, strongest last or strongest first depending on the week.
Rules carried from `x-threads.md`: every number points at the repo or the chain, links go in
the first reply and not the post, no claim about a third party without a timestamp.

Kaspa is named once, in post 3, and never in an opening line. The audience is somebody
building agents who has no reason to care which chain this is.


---

## Post 1 — the failure

**Image:** `warda-post-1.png`

**Post** (250 chars)

> We overwrote a key this morning.
> >
> > 1,000 KAS is sitting at an address whose only key no longer exists. The coin never moved. The command that replaced it had no reason to refuse.
> >
> > It refuses now — and there's a check that makes sure it keeps refusing.

**First reply** (168 chars)

> The whole point of this project is that authority should be bounded by something other than good behaviour. Turns out that includes ours. github.com/ArtyKOMarkets/warda


---

## Post 2 — the mechanism

**Image:** `warda-post-2.png`

**Post** (249 chars)

> Your AI agent's spending limit is enforced by the same process that decides to spend.
> >
> > A redeploy moves it. A second instance ignores it. Whoever reads the key out of env never meets it at all.
> >
> > That isn't a constraint. It's a description of intent.

**First reply** (167 chars)

> Put the limits in the script that unlocks the coin instead, and nobody can edit them — not the agent, not the operator, not whoever issued the grant. wardaprotocol.com


---

## Post 3 — the funding edge

**Image:** `warda-post-3.png`

**Post** (265 chars)

> You think about an agent's budget in dollars. A chain can't enforce one — a script has no oracle.
> >
> > So: price in dollars, enforce in KAS. $100 becomes 2,000 KAS, and 2,000 KAS is what every node compares on every spend.
> >
> > The conversion happens once, not per payment.

**First reply** (141 chars)

> Which means you fund an agent with whatever you already hold, and never touch the asset the limits are denominated in. wardaprotocol.com/rail


---

## Post 4 — the agent economy

**Image:** `warda-post-4.png`

**Post** (257 chars)

> An agent hired another agent and gave it a budget out of its own.
> >
> > 2 KAS → 0.5. A 0.1 cap per payment → 0.05. Two allowed payees → one.
> >
> > Smaller in every dimension, and not by convention: the covenant refuses a child that isn't. No human approved any of it.

**First reply** (146 chars)

> Both are live on Kaspa testnet. The delegation is 6a534c38…, the settlement that brought the remainder home is 85fa34cd…. wardaprotocol.com/agents


---

## Post 5 — the proof

**Image:** `warda-post-5.png`

**Post** (259 chars)

> Two payments from the same AI agent.
> >
> > One settled — inside its limits, to an address on its list.
> >
> > The other has no transaction to sign. Not rejected: unbuildable. Nothing to retry, override or approve, and the budget never moved.
> >
> > The refusal is the product.

**First reply** (120 chars)

> You can check both against the chain without an account and without anything of ours in the way. wardaprotocol.com/proof

