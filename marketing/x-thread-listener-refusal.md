# Thread — "A limit is only real when it refuses you"

One idea: **a spending limit the agent's own process enforces is a note, not
a limit.** Landed on 23 September 2026, when the covenant refused a payment I
was deliberately trying to make.

Rules carried over from `x-threads.md`: every number points at something on
chain or in the repo; links in the first reply, not the post; the honest gap
comes before anybody has to ask.

Audience: people building agents that spend — x402, paid MCP, agent wallets.
Assumes they know what an API key is and not what a covenant is.

---

**1/**  *(170)*

> My agent searches X for me twice a day. It pays for the data it reads.
>
> Today it made three payments and was refused the fourth.
>
> Not by my code. My code wasn't asked.
>
> 🧵

**2/**  *(255)*

> The usual shape for an agent that spends: an API key, and a budget in a config file the agent's own process checks.
>
> The thing being limited and the thing doing the limiting are the same program.
>
> If the agent can read the number, something can change it.

**3/**  *(206)*

> Mine holds a Kaspa grant instead.
>
> A covenant — the script that unlocks the coin — carries the terms:
>
> 2.1 KAS total
> 0.05 per payment
> 0.15 per 12-hour epoch
> one address it may ever pay
> 7 days, then it stops

**4/**  *(175)*

> Those are not settings.
>
> They were fixed when the grant was created and cannot be edited afterwards — not by me, not by the agent, not by whoever takes my laptop.
>
> Only ended.

**5/**  *(235)*

> First run under the grant: three searches, three payments.
>
> 91cfa8e8a484f1ac…
> c1be036ad512eef7…
> fec9f8a767053099…
>
> 0.05 KAS each. Exactly the per-payment cap, which is not a coincidence — it is the most any one of them could have been.

**6/**  *(218)*

> That spent the epoch's allowance. 0.15 of 0.15.
>
> My own budget code then refused the next pass, which is the boring correct outcome and proves nothing.
>
> So I disabled it and ran again, to make the chain answer instead.

**7/**  *(240)*

> It said:
>
> "this invoice is 5000000 sompi and only 0 remains in the current epoch (0). The allowance refreshes as the chain advances — and cannot be refreshed by claiming an earlier epoch, which the covenant refuses."
>
> No coin moved. No fee.

**8/**  *(270)*

> That last clause is the one I care about.
>
> The obvious way to beat an epoch limit is to claim an earlier epoch and collect a fresh allowance.
>
> We wrote a fuzzer specifically to catch that class of bug. Today the covenant answered it in public, to me, for the first time.

**9/**  *(195)*

> What this is not.
>
> The seller my agent pays is also me. Both ends are Warda. It is testnet coin and it is worth nothing.
>
> So the chain here proves a limit held. It does not prove a market exists.

**10/**  *(191)*

> And behind that seller is a bill that is not play money.
>
> X charges $0.005 per post read. That goes on a card.
>
> The chain bounds the agent. It cannot bound the card, because it cannot see it.

**11/**  *(271)*

> None of this came from the tests.
>
> Four bugs appeared only once real money moved: a lookup that needed the network, an unexported variable, two modules that never agreed on a parameter name, and a response shape the buyer could not read.
>
> All four passed their own tests.

**12/**  *(235)*

> So the claim is small and I can show all of it:
>
> An agent authorised for 42 searches spent three, and was refused the fourth by consensus rather than by me.
>
> It has never posted, replied, liked or followed anything. It is not built to.

**First reply — the links**  *(274)*

> The agent, its grant and every payment: wardaprotocol.com/agent-012
>
> The covenant, the harness and the fuzzer: github.com/ArtyKOMarkets/warda
>
> Testnet only. Unaudited — there is a machine-checked report at wardaprotocol.com/audit, and that is not the same thing as a review.

---

## Notes for posting

- Post 7 is the whole thread. If anything gets cut, cut around it.
- Post 11 is optional. It buys credibility with engineers and costs a beat of
  momentum; drop it if the thread is running long.
- Every txid is real and on testnet-10. They resolve in any Kaspa explorer
  pointed at testnet.
- The grant address is on /agent-012 rather than in the reply: it is 69
  characters and the page shows it beside every payment made from it.
- Do not add a call to action. The thread ends on what it cannot claim, which
  is the only thing stopping it reading as an advert.
