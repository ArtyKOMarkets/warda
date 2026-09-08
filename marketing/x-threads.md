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

**1/**

> Every conversation about giving an AI agent money stops at the same place.
>
> "Fine — but who can change the limits?"
>
> On almost every system the honest answer is: whoever can edit the config,
> and it takes effect immediately.

**2/**

> That means the limit isn't a constraint. It's a description of intent.
>
> A redeploy with a different number moves it. A second instance ignores it.
> Anyone who can read the key out of `env` never meets it.
>
> The ceiling and the thing being limited live in the same process.

**3/**

> Put the limits in the script that unlocks the coin instead, and the question
> changes shape.
>
> Now nobody can edit them. Not the agent, not the operator, not the person
> who issued the grant, not all three together.
>
> A grant's terms are fixed for its whole life.

**4/**

> Which sounds great until you need to change something.
>
> An agent whose authority can't be edited can't be *updated* either. New
> vendor, different budget, rotated key — none of it is an edit.
>
> So it isn't updated. It's replaced.

**5/**

> Replacement is where it gets interesting, because a new grant can be
> published *before it is allowed to spend*.
>
> Agent #003's grant was created with a start time 3,000 blocks out. Its terms
> were readable on chain immediately. It could not move a sompi.
>
> `57e41ddf…`

*Screenshot: the genesis output, the TIMELOCKED block. It says "cannot spend
until DAA 564404779… Until then consensus refuses every spend it attempts —
not this tool, and not anything anyone here could choose to skip."*

**6/**

> Anyone could read exactly what the replacement would be permitted to do, and
> verify that it could not yet do it.
>
> That is the answer to "how fast can the spend path change." Not "trust our
> deploy process." A number, on a public chain, that nobody can bring forward.

**7/**

> Then we revoked the old agent's grant — while the new one was still shut.
>
> `858e7c54…`
>
> For about four minutes, agent #002 was over and agent #003 had not started.
> **Neither one could spend anything.**

**8/**

> We could have hidden that. Revoke after the lock opens and the handover
> looks atomic.
>
> It isn't. Two authorities that never share a key cannot hand over
> instantaneously, and a system that appears to is hiding the seam somewhere
> you can't see it.
>
> So the gap is on the page.

*Screenshot: agent-003's page, the succession section, with "right now: the
old grant is ended and the new one has not opened. Neither can spend."*

**9/**

> Neither agent ever held the other's key. The grant that ended did not get a
> say in ending — the key that revoked it was never the agent's.
>
> That's the part worth stealing even if you never touch Kaspa: **an agent
> should not be able to end its own authority on terms it chooses.**

**10/**

> None of this is theoretical and none of it is finished. Testnet only,
> unaudited, and the digest one of these agents buys is published free — the
> payment is the point, not the data.
>
> wardaprotocol.com/agent-003

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

## Order, if you want one

A → B → C for a build-up, or D first if you want the one that gets quoted.
D is the least like anything else in the timeline and the hardest to argue
with, but it only lands once the reader knows what the thing is — so it works
best after A or B rather than cold.
