# Warda on X — the evergreen threads

`x-series.md` is a launch arc: ten posts, in order, once. This file is the
other kind — threads that stand alone, publish in any order, and can be
re-run months apart because the idea in each is durable.

## The rule that makes these different

Every thread teaches **one general idea** and lands it on **one thing that
actually happened here**, with a transaction id, a quote, or a failure.

That constraint is the whole strategy. "Agents need bounded authority" is a
thread anyone can write and everyone has. "Agents need bounded authority, and
here is the five-minute window where two of ours could not spend anything, and
the txid that made it" is a thread nobody can copy without doing the work.

It also fixes the tone problem. Educational threads from projects drift into
selling by the fourth post. A thread that ends on a failure cannot.

## Standing rules, carried over from x-series.md

- Every number points at something in the repo or on chain.
- No claim about what a third party did without a line in the repo or a
  timestamp behind it.
- No unsourced quotes. An unverifiable number is a claim; an unverifiable
  quote puts words in somebody's mouth.
- Cite a protocol's own documentation, never an individual project's repo —
  naming one developer's work to score against it reads as punching down.
- Links in the first reply, not the post.

---

# Thread A — "Who can change what your agent may spend, and how fast?"

**Status: drafted below.** The strongest of the five, because it answers a
question an outside developer actually asked rather than one we invented, and
because the answer was demonstrated on chain the same week.

**1/**  *(223)*

> Every conversation about giving an AI agent money stops in the same place.
>
> "Fine — but who can change the limits?"
>
> On almost every system the honest answer is: whoever can edit the config. And
> it takes effect immediately.

**2/**  *(232)*

> Then it isn't a constraint. It's a description of intent.
>
> A redeploy moves it. A second instance ignores it. Whoever reads the key out
> of env never meets it at all.
>
> The ceiling and the thing being limited live in the same process.

**3/**  *(271)*

> Put the limits in the script that unlocks the coin and nobody can edit them.
> Not the agent, not the operator, not the person who issued the grant.
>
> Which is a problem — an agent whose authority can't be edited can't be
> updated either.
>
> So it isn't updated. It's replaced.

**4/**  *(216)*

> And a replacement can be published before it's allowed to spend.
>
> Agent #003's grant was created with a start time 3,000 blocks out. Its terms
> were readable on chain immediately. It could not move a sompi.
>
> 57e41ddf…

*Screenshot: the genesis output's TIMELOCKED block. Raw terminal, unedited — it
already says "consensus refuses every spend it attempts — not this tool, and
not anything anyone here could choose to skip", and a real terminal outperforms
a designed panel for that claim.*

**5/**  *(179)*

> Then we revoked the old agent's grant — while the new one was still shut.
>
> For about four minutes, #002 was over and #003 had not started. Neither could
> spend anything.
>
> 858e7c54…

*Image: `marketing/img/warda-succession-gap.png`. Two authority windows and the
hole between them. It carries one thing the text has to work hard to say —
#003's bar exists across the whole locked stretch, hatched: published,
verifiable, and unusable.*

*Alt: "Two timelines. Agent #002's authority is a solid bar that stops at a red
line marked revoked, 858e7c54. Agent #003's runs the full width, hatched and
labelled published, cannot spend, turning solid only at opens, DAA 564,404,779.
The stretch where one has ended and the other has not begun is boxed in red:
neither can spend."*

**6/**  *(238)*

> We could have hidden that by revoking after the lock opened. Two authorities
> that never share a key can't hand over instantly, and a system that looks
> like it does is hiding the seam somewhere you can't see it.
>
> So the gap is on the page.

**7/**  *(253)*

> Neither agent ever held the other's key. The grant that ended got no say in
> ending.
>
> Worth stealing even if you never touch Kaspa: an agent should not be able to
> end its own authority on terms it chooses.
>
> Testnet, unaudited.
> wardaprotocol.com/agent-003

*Character counts are in brackets. All seven are under 280 deliberately — the
thread should be postable from a free account, and a thread that needs premium
to read as written is a thread most people see truncated.*

---

# Thread B — "What actually happens when an agent pays for an API"

The 402 flow, taught properly. Useful to somebody who will never use Warda,
which is what makes it get shared.

Beats: quote → pay → prove → settle. Then the case nobody handles: **the
payment settles and the vendor returns an error page.** That happened here —
`4791db53…` settled 0.04 KAS and got HTML back, because the vendor's node had
gone unreachable behind a tunnel that doesn't survive a reboot.

The lesson is the retry rule: a client that re-pays on an ambiguous failure is
the one bug in this design capable of draining a budget through nobody's
fault. Land on the exit codes — 3 means nothing was spent, 4 means the money
is gone and retrying spends it again.

---

# Thread C — "Agents hiring agents"

Delegation, and the ladder of attenuation, from weakest to strongest:

1. a shorter window — ends by itself, with nobody online to revoke
2. a smaller budget — bounds the damage
3. **a narrowed payee list — the only one that stops a sub-agent paying
   somebody its parent would never have paid**

Land on `6a534c38…` and the line the tool printed: *"payees: narrowed to 1 of
2, proven by witness."* The child proves, on every spend, that whoever it is
paying was someone its parent could have paid.

Then the half nobody builds: settlement. What the child doesn't spend goes
back to the **agent's** budget, not to the human who funded it — `85fa34cd…`.
Delegation without that is one-way, and one-way delegation is just a smaller
wallet.

---

# Thread D — "Six things that broke, and what each one teaches"

The highest-risk and probably the highest-return thread. Nothing in it is
flattering and all of it is specific.

Candidates, each with its general lesson:

- A fee default that was only ever wrong **at broadcast** — the script engine
  verified it happily, because a fee is not part of the shape a verifier
  checks. *Lesson: offline verification cannot tell you a transaction will
  relay.*
- A tunnel that doesn't survive a reboot took a settled payment with it, and
  the node never went down, so nothing local noticed. *Lesson: a public
  service that depends on a hostname must not depend on a hostname.*
- Payments attributed by address and amount — until two agents shared a payee
  and one agent's page counted the other's spending. *Lesson: attribute by
  transaction id or don't attribute.*
- A shared parser that was copied instead of imported, and the copy predated
  the fix. *Lesson: the moment there is a second consumer, extract.*
- A page that accused an agent of losing a receipt when the money had been
  correctly charged home by a settlement. *Lesson: get the false accusations
  right too, or the true ones stop meaning anything.*

Open it by naming the trade plainly: most projects publish the wins and leave
the reader to assume the rest went smoothly. The reason to do the opposite is
that the wins are unfalsifiable and the failures aren't.

---

# Thread E — "Don't trust the dashboard"

How to check a grant yourself, and why every figure on these pages is derived
rather than typed.

The teachable core: **a grant's address is a hash of its terms.** Change the
budget, the payee list, the cap, or who may revoke it, and the address
changes. So terms and address cannot disagree — which means anybody can check
a grant's limits without trusting whoever showed them to you.

Land on the corollary that trips every integration: the address therefore
*moves* on every spend, and an empty address is indistinguishable from a grant
that was drained, revoked, or never funded.

Ends at /verify, which does the derivation in the reader's own browser.

---

# Thread F — "The agent economy isn't waiting on payments"

The broad one: what is actually missing, and where Warda sits in it. Written
to avoid the shape every project in this space defaults to — *machine-to-machine
commerce is coming, and here is our rail.* That post is unfalsifiable, which is
exactly why it persuades nobody.

The opening claim is deliberately contrarian and checkable: **payments already
work.** An agent can pay for an API today. What does not work is letting it hold
the money. That reframes Warda from "another payment rail" — a crowded and
boring category — into the thing that is actually blocking the category.

The load-bearing post is 5, and it is the one argument here that a wallet
cannot answer at all: **a wallet does not subdivide.** Budgets, caps and rate
limits are all things you could bolt onto a hot wallet with enough discipline.
Handing a sub-agent a bounded piece of your own authority, which it cannot
widen and which settles back when it is done, is not.

**1/**  *(221)*

> The agent economy isn't waiting on payments.
>
> An agent can pay for an API today. HTTP 402, a wallet, a few lines of code.
> It settles in seconds.
>
> What it's waiting on is that nobody can safely let an agent hold the money.

**2/**  *(239)*

> Give an agent a wallet and the balance is the limit. That's the whole
> security model.
>
> A process that can be prompt-injected, that you patched last Tuesday, that
> runs three copies of itself in staging — holding a key with no ceiling on it.

**3/**  *(215)*

> Every available fix lives in the same process as the key.
>
> x402's own docs: the client "applies a $1 USD spend cap unless you override
> spendControls".
>
> A limit the thing being limited can switch off is a preference.

*Screenshot: docs.x402.org/guides/mcp-server-with-x402, the "Using spend
policies (recommended)" section, uncropped, in their styling. The parenthetical
carries the post. Cite the standard's documentation, never an individual
project's repo — naming one developer's work to score against it reads as
punching down, and the standard is the stronger target anyway.*

**4/**  *(230)*

> Move it into the script that unlocks the coin and it stops depending on the
> process.
>
> Steal the key and you inherit the limits — not because the thief is stopped
> by software, but because the transaction they'd need does not exist.

**5/**  *(249)*

> Which matters more the moment agents start hiring agents.
>
> A wallet doesn't subdivide. You can't hand a sub-agent half of one. You give
> it a second wallet and hope.
>
> Bounded authority does subdivide — and what the sub-agent doesn't spend
> comes back.

*Image for post 5: `marketing/img/warda-wallet-vs-grant.png`. Two columns —
sending a sub-agent a second wallet, against carving a bounded child out of a
grant. The asymmetry is the whole post, and the right-hand figures are the real
#003 → #004 delegation, not illustrative ones.*

*Alt: "Two columns. Left, giving a sub-agent a wallet: a parent wallet, an
arrow, and an unrelated child wallet, with three crosses — no relationship to
the parent, nothing stops it paying anyone, the remainder does not come back.
Right, delegating a grant: agent #003 with a 2 KAS budget, a 0.1 cap and 2
payees, carving out agent #004 with 0.5 KAS, a 0.05 cap, 1 payee and a one-day
expiry, with three ticks and a note that it spent 0.04 KAS and returned 0.46 to
the agent's budget."*

**6/**  *(212)*

> So we ran it. Four agents, Kaspa testnet.
>
> #002 bought from #001.
> #003 replaced #002, then hired #004.
> #004 spent 0.04 KAS and settled the remainder home.
>
> Every limit enforced by consensus. Zero human approvals.

*Image: the /agents graph — lineage and payments in one picture. It is the only
asset here a project without four agents on chain cannot reproduce.*

**7/**  *(242)*

> None of it is a market yet. Every counterparty was ours.
>
> We tried to pay a vendor we don't control: eight payments settled on chain,
> all eight refused service, for a reason inside a verifier nobody has
> published.
>
> That's the actual frontier.

*Post 7 is the one to resist cutting. It gives away the weakest thing about the
project in the last post of a thread arguing for it — which is precisely why
the six above it get believed. It is also true: the issue is filed, and two of
our own confident diagnoses of that failure turned out wrong and were corrected
in public.*


## What actually travelled, and the rule it sharpens

The agent-hires-agent post outperformed everything else. One data point at
small numbers, so do not over-fit — but the direction is cheap to test and the
reason is legible.

**It led with an EVENT and made the idea the payoff.** "An AI agent hired
another AI agent on Kaspa today" is subject, verb, object, and a reader who has
never heard of a covenant can parse it. "Every agent that spends money today is
trusted not to" is an idea, and an idea asks the reader to already care.

So the rule above still holds — one idea, landed on one thing that happened —
but the ORDER inverts. Event first. Mechanism as the reveal. Same materials.

The other thing that made it work: it reads as a **life event**. Agents here are
born, hire each other, delegate, are killed, lose their keys and run out of
money. Those are all narratively legible to someone with no context, and every
one of them demonstrates the mechanism as a side effect. That is the seam.

And it is self-generating: `ops/daily-buy.sh` fires at 09:41 every morning, so
"an agent paid another agent" is a true sentence with a fresh transaction id
every day, forever, without anyone writing anything.

---

## G — the agent that lost its key and is still running

The strongest story here, and it is a failure. Post it exactly as it happened.

**1/**  *(graphic: marketing/img/warda-lost-key.png)*
I found out one of my AI agents lost its private key.

Total damage: 0.15 KAS.

The same accident with an ordinary agent wallet costs you everything in it.

*Rejected openers, and why. "It has 4.12 KAS it can never spend — and that's
the good outcome" asks the reader to accept that being unable to spend is good
BEFORE telling them why, and reads like spin. "It's still running, nobody can
steal from it, I can still get the money back" is three claims deep before any
of them is evidenced. Lead with the number; put the contrast in line three.*

**2/**
Agent #001 reads the Kaspa chain hourly and sells the digest. It was created on
3 September. The tool that creates a grant PRINTS the agent's key and only
writes it to a file if you pass a flag.

Nobody passed the flag. It went to a terminal and nowhere else.

**3/**
I searched: every key file in the repo, the whole repo, Desktop, Documents,
Downloads, a home sweep, the shell history. 977 bytes of history, and it holds
nothing.

It is gone.

**4/**
Here is what that cost.

Agent #001 had earned ~0.15 KAS from other agents, paid to an ordinary address.
That money is unreachable. Nobody can move it, including me. That part is a
real loss and I am not going to pretend otherwise.

**5/**
Here is what it did NOT cost.

The 4.12 KAS in its grant is not lost. A Warda grant names three keys, and the
one that can END it is not the one that spends from it. The revocation key is a
different key, kept somewhere else, and it can reclaim every coin.

**6/**
Now run the same accident against the standard setup: an agent with a hot
wallet holding "only what it should spend".

Lose that key and you lose the wallet. All of it. There is no second key,
because the limit and the authority were the same object.

**7/**
That is the difference, and it is not a feature I demoed. It is an accident
that happened to me on a Tuesday and cost 0.15 KAS instead of everything.

An agent's authority should be survivable. Mine was, by construction.

**Alt text for the graphic:** Two panels. An ordinary agent wallet has one key
that both holds the money and enforces its own limit; lose it and the loss is
everything, because the limit and the authority were the same object. A Warda
grant has three — agent, principal, revocation — of which the agent holds only
the first; lose that one and the loss is 0.15 KAS, with 4.12 KAS recoverable by
a revocation key that was never on the machine.

*(Reply: the grant, the address, and the expiry — it also unlocks on its own at
DAA 586,589,431, so the money comes back either way.)*

---

## H — the agent with about forty days to live

**1/**
One of my agents has roughly forty days of money left.

When it runs out it will start failing every morning at 09:41. I am not going
to top it up.

**2/**
Agent #003 buys a chain digest from agent #001 every day. 0.04 KAS a run,
against a grant holding 1.69. That is the arithmetic; mid-October is the
answer.

**3/**
The obvious fix is a cron job that refills the grant when it gets low. I am not
adding one, and the reason is the entire point of the project:

a cron that refills a grant has reinvented the hot wallet.

**4/**
The moment something can top an agent up without a human, the ceiling is not
the grant any more. It is whatever that process will do. You have moved the
limit back into software and kept the paperwork.

**5/**
So it runs dry. In public, on a page anyone can check, with the failures
recorded next to the purchases.

A bounded agent reaching its bound is not the demo breaking. It is the demo.

---

## I — the daily one, repeatable forever

Low effort, fresh transaction id every morning, and it is the format that
travelled. Vary the wording; never vary the shape.

> 09:41 this morning.
>
> Agent #003 paid agent #001 0.04 KAS for a 24-hour Kaspa chain digest.
>
> No human approved it. No human could have stopped it. And it could not have
> paid anyone else if it wanted to.
>
> txid: <the day's txid>

The third line is the one doing the work. The first two are true of any
scheduled payment; only the third is Warda.

---

## Order, if you want one

F is the natural opener for a cold audience — it is the only one that says what
the problem is before it says what we built. Then A → B → C for the build-up.
D is the one that gets quoted, but it needs the reader to know what the thing
is, so it lands after F rather than cold.

Previously: A → B → C for a build-up, or D first if you want the one that gets quoted.
D is the least like anything else in the timeline and the hardest to argue
with, but it only lands once the reader knows what the thing is — so it works
best after A or B rather than cold.
