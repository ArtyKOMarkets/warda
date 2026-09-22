# Thread — "An agent whose key nobody here holds"

One idea: **hosting an agent's money is only acceptable when the host
*can't* overspend it.** Landed on what happened on 22 September 2026, with
transaction ids.

Rules carried over from `x-threads.md`: every number points at something on
chain or in the repo; links in the first reply, not the post; the honest gap
comes before anybody has to ask.

---

**1/**

> We hosted an AI agent's wallet today.
>
> We don't hold its key. Nobody does — it lives in a signing enclave.
>
> And the host can't make it overspend, because the limits aren't ours to enforce.
>
> 🧵

**2/**

> The usual deal with a hosted agent: you trust the operator with the whole wallet.
>
> Their config says "max $5 per call". Their process holds the key.
>
> The ceiling and the thing it limits live in the same place. That's a promise, not a limit.

**3/**

> Warda puts the limits in a Kaspa covenant — the script that unlocks the coin.
>
> Budget, per-payment cap, who it may pay, when it ends.
>
> Every node checks them. The agent, the host, and the person who funded it all hit the same wall.

**4/**

> So hosting stops being scary.
>
> The runner holds the agent key (in Turnkey, never exported). Worst case, a breach spends what the grant allows — to the payees it allows.
>
> Your key, which the runner never sees, can stop it any second and takes the rest back.

**5/**

> What it looks like now:
>
> 1. Create an agent
> 2. Send KAS to an address, from any wallet
> 3. Type "message me on Telegram when 25% of the budget is left"
> 4. Confirm the card
>
> Two minutes. No keys, no CLI, no cron.

**6/**

> Receipts, on Kaspa testnet:
>
> • 85b12166… — first grant with a Turnkey-held key
> • fa5dfe72… — its first purchase
> • 7f4835fc… — a payment made by the hosted runner, with no machine of ours in the path

**7/**

> The honest part: testnet, unaudited, invite-only.
>
> And trust moved — it didn't vanish. The key service could sign. It still can't sign for more than the grant allows, or pay anyone the grant doesn't name.
>
> That bound is the whole product.

---

**First reply (links):**

> Console: wardaprotocol.com/app → 🔥 New agent
> The agent with the key nobody holds: wardaprotocol.com/agent-011
> Invite code for the beta: DM me.

---

## The screen recording (≈50 seconds, no voice needed)

Record at 1440×900, browser zoomed to 110%. Captions are the text overlays.

| # | Seconds | Screen | Caption |
|---|---|---|---|
| 1 | 0–5 | `/agent-011` — the header and the grant card | "An agent whose key nobody here holds." |
| 2 | 5–12 | Console → 🔥 New agent, step 2 → type budget 1, cap 0.1 | "Set its limits. They go into the coin, not a config." |
| 3 | 12–20 | Step 4 — the deposit QR, then (cut) "Live" with the transaction link | "Fund it from any wallet. It's live on chain in seconds." |
| 4 | 20–32 | Step 5 — tap "Message me on Telegram when less than 25%…" → the card appears | "Tell it what to do in one sentence." |
| 5 | 32–38 | Press **Add this job** → "✓ Added" | "You confirm. Nothing runs until you do." |
| 6 | 38–46 | Your agents → the agent's detail, the run log with a transaction | "Every payment, on chain." |
| 7 | 46–50 | Phone screen: the Telegram message from the bot | "And it tells you when to care." |

For shot 7, trigger a real message: add the job "Message me on Telegram" with
a manual trigger and press **Run now** just before recording.

## Before posting

- [ ] `/agent-011` loads and shows the grant.
- [ ] The 🔥 banner is live on Overview.
- [ ] You have invite codes ready for DMs (`RUNNER_SIGNUP_CODE`).
- [ ] Pin the first reply.
