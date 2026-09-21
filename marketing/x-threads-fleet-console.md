# Two threads — the growth fleet, and the console (21 September 2026)

Images are 1600×900 at 2×, in `marketing/img/`, rendered from
`marketing/cards/fleet-console.html`. Every number is from the chain or the repo:
the week is `growth/batches/2026-W39`, transactions are listed on card G5.

Rules carried from `x-threads.md`: event first, mechanism as the reveal; links in
the last post or first reply, never the opener; Kaspa named late, never first.

---

## Thread N — the growth fleet

**1/** · `warda-g1.png` *(225)*

> This week an AI agent hired another AI agent to do market research — and paid a third for every record it bought.
>
> Nobody approved a single payment. None of them could have overspent.
>
> How a team of agents runs on one budget:

**2/** · `warda-g2.png` *(256)*

> Monday, the orchestrator got a grant: 0.9 KAS, one address it may pay, three days.
>
> It hired Scout with 0.6 of it. Every limit on Scout is smaller than its parent's — budget, rate, lifetime, who it can hire. The chain checks that when the child is created.

**3/** · `warda-g3.png` *(249)*

> Scout bought three research records at 0.05 each. On the fourth, its 0.15-per-epoch allowance was spent.
>
> There was no transaction to reject — its wallet couldn't build one. Our own agent hit its rate limit, and the network stopped it, not our code.

**4/** · `warda-g4.png` *(236)*

> The fourth agent writes to people. It holds no grant, no key, and has no send button.
>
> 12 projects found → 3 records → 1 draft → 0 sent by an agent. A person reads every draft.
>
> The agent that can embarrass you is the one with no money.

**5/** · `warda-g5.png` *(233)*

> Then Scout settled home: its parent was charged exactly what Scout spent. The principal revoked the rest.
>
> Every step is a public transaction. What the week cost is a fact anyone can check — so is the fact it couldn't have cost more.

**6/** *(177)*

> It runs every Monday now, unattended. Kaspa testnet: the authority is real, the money isn't.
>
> The agents: wardaprotocol.com/agents
> Buy a record yourself: warda-growth.vercel.app

---

## Thread O — Warda Console

**1/** · `warda-c1.png` *(168)*

> Giving an AI agent a budget shouldn't mean giving it your wallet.
>
> We built one place to issue agent budgets, watch them, and end them. Warda Console — live on testnet.

**2/** · `warda-c2.png` *(196)*

> Type a budget in dollars: $100 total, $5 a payment, $20 an hour, 30 days.
>
> It becomes a script that unlocks the coin. Not a setting. Nobody can edit it afterwards — not the agent, not you, not us.

**3/** · `warda-c3.png` *(189)*

> Fund it with the USDC or USDT you already hold.
>
> Every route is shown with its custodian named — including when there is one — before anything is sent. Warda's part: none. No fee, no float.

**4/** · `warda-c4.png` *(193)*

> Every grant comes with its controls: revoke, reclaim, renew, find.
>
> There's no pause button. Revoke is the pause — and the balance goes home to whoever funded it, not to whoever pressed revoke.

**5/** · `warda-c5.png` *(201)*

> Fleet, analytics and alerts, read from the chain: burn rate, runway against term, how close agents run to their caps, what was refused.
>
> Alerts go to Telegram. Your account follows grants as they move.

**6/** · `warda-c6.png` *(133)*

> What it will never do: hold a key, hold a coin, or take a cut of what your agents spend.
>
> Free during the beta: wardaprotocol.com/app

---

### Order

Fleet thread first — it is an event, and it is the one with a story. Console a few
days later; its post 1 can quote-tweet fleet post 5 ("this is where that week was
watched from").
