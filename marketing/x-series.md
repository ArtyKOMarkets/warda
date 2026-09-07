# Warda on X — the opening series

Ten posts, in order. The arc: **problem → why the obvious fix fails → what
we did → what it cost → what we still can't do.**

Warda is not named until post 3. The first two earn the right to name it.

Rules I've followed, from what worked on KOMarkets: text carries the post, a
diagram supports it, and every number is one we can point at. Nothing here is
a claim the repo can't back — a series that gets caught inventing one number
loses the credibility the honest ones bought.

Two of those got through the first draft anyway, and both are worth naming
because they are the shapes to watch for. One was a **quote** attributed to an
unnamed library that could not be sourced afterwards — an unverifiable number
is a claim, an unverifiable quote puts words in somebody's mouth. The other
was a **claim about what a third party did**: that someone had attempted to
drain the published key. Nothing recorded it. Anything asserting what an
outsider did, or how long something has been true, needs a line in the repo or
a timestamp behind it before it ships.

Where a post needs a picture, the brief is in *italics* underneath. Most are
already in the repo or trivially screenshottable.

---

## 1 — The problem, and Warda is not in it

> An AI agent that can buy things needs money.
>
> So you give it a wallet.
>
> Now a process that can be prompt-injected, that you patched last Tuesday,
> that runs three copies of itself in staging, holds a private key with no
> spending limit on it at all.
>
> The wallet balance is the limit. That's the whole security model.

*No image. Post 1 is a sentence people recognise.*

---

## 2 — Why the obvious fix doesn't work

Under 280 characters, so it needs no premium account.

> "Just add a spending cap."
>
> x402's docs: a "$1 USD spend cap unless you override `spendControls`."
>
> Per payment — the knob is `maxAmountPerPayment`. And it has an off switch:
> `spendControls: false`.
>
> A limit the thing being limited can switch off isn't a limit. It's a
> preference.

*Screenshot: <https://docs.x402.org/guides/mcp-server-with-x402>, the section
headed "Using spend policies (recommended)". Frame it to include that heading
and the whole paragraph, parenthetical included — the parenthetical is what
carries the post. Their page in their styling, uncropped and unedited.*

*Alt text: "x402 documentation, Using spend policies: the client applies a $1
USD spend cap unless you override spendControls — raise or disable
maxAmountPerPayment, or set spendControls: false."*

*Link in the first reply, not the post. X buries outbound links and the
screenshot carries the claim by itself.*

*Cite the protocol's own documentation, never an individual project's repo.
Several small libraries put the same cap in an environment variable and would
make the point more vividly, but naming one developer's work to score against
it reads as punching down — and the standard is the stronger target anyway,
because nobody can answer that it was just one implementation getting it wrong.*

*Two claims here rest on the parenthetical rather than on us: that the cap is
per payment (their knob is named `maxAmountPerPayment`) and that it can be
turned off (`spendControls: false`). An earlier draft of this note said not to
claim per-payment because the docs did not say. They do say — in the override
list, which is visible in the screenshot. Let the reader draw it from their
words rather than asserting it in ours.*

*If someone replies that a caller can simply configure it properly, agree. That
is the post: the ceiling is set by the code that pays, so it holds exactly as
long as that code is behaving. The argument is not that the default is badly
chosen.*

---

## 3 — The move

> Put the limit in the coin, not in the code.
>
> Kaspa's Toccata covenants let an output carry its own spending rules. The
> money itself knows what it may be spent on.
>
> So: the agent gets a key. The grant gets the money. The rules live in the
> script that unlocks it.
>
> Now a stolen key inherits the limits. That's the difference between a
> policy and a constraint.
>
> We call it Warda.

*The architecture diagram: agent → grant → covenant → payee. Already on the
site.*

---

## 4 — What a grant actually says

> A Warda grant commits to five things when it's created, and can never
> change them afterwards:
>
> • total budget
> • maximum per payment
> • maximum per epoch
> • which addresses it may pay
> • when it expires, and who can revoke it
>
> That fourth one is the one people underestimate. The payee list is fixed at
> genesis. Not "checked against" — *committed to*. There is no transaction
> that pays anyone else. Not one the network rejects; none that exists.

*The capability tree from /agent-001: can pay → one address. Cannot pay →
every other address on Kaspa.*

---

## 5 — We published the key

> There's a funded grant on Kaspa testnet with its agent's complete private
> key printed on a public web page. Not a hash of it. The actual key.
>
> Anyone can sign with it. It has been up since 2 September.
>
> Everything that grant has spent went to the single address it was allowed
> to pay. Nothing has reached anywhere else. That figure is on the page, read
> from the chain, and it updates.
>
> The point isn't that nobody has taken it yet. It's that the page cannot be
> made to lie: if a coin ever landed anywhere else, the counter would say so.
>
> wardaprotocol.com/attack

*Screenshot of the key on the page. The provocation is the point.*

*Do not claim anyone has attacked it. An earlier draft said someone had tried
to drain it at exactly the per-payment cap — nothing in the repo, on the page,
or in the published state records any outside attempt, and the page's own
counter proves only that nothing succeeded, not that anything was tried. The
honest version does not need an attacker: an unspent published key is the
claim.*

*Check the date before posting. The page went up 2 September 2026; "for weeks"
was wrong when it was written.*

---

## 6 — Meet Agent #001

> It has a job. It has money. It has rules. It makes purchases. Sometimes
> those purchases fail. **It cannot change its own rules.** You can verify
> every line of that.
>
> Agent #001 reads the Kaspa network every hour and publishes a daily digest,
> unattended. Every figure in it is the difference between two counters the
> network keeps for its own reasons — nothing sampled, nothing extrapolated.
>
> wardaprotocol.com/agent-001

*Screenshot of the live digest block.*

---

## 7 — The part most protocols hide

> Agent #001's page lists six things it cannot do — over the per-payment cap,
> over the epoch allowance, over the budget, a payee never authorized, a
> script type the covenant can't build, an amount below what Kaspa will carry.
>
> None of those sentences was written for the page.
>
> Five are produced by *running the same check the payer runs* before it
> builds a transaction. If a refusal ever stopped happening, the page would
> fail to build rather than keep the claim.
>
> Marketing copy that can't drift, because nobody writes it.

*Screenshot of two refusal cards.*

---

## 8 — What it cost to find out

> Things we learned by pointing this at a real chain instead of at tests:
>
> • Kaspa charges storage mass for small outputs. Payments under ~0.02 KAS
>   cannot be broadcast at all. Sub-cent micropayments are not a thing on
>   this chain, whatever your budget says.
>
> • kaspad sends u64 as raw JSON numbers. Testnet's circulating supply is
>   ~299× what a double holds exactly, so the value was already rounded
>   before our code saw it. Our guard caught it; the fix had to happen inside
>   the parser.
>
> Neither was findable from a schema. One live connection found both.

*No image, or a terminal screenshot of the storage-mass error.*

---

## 9 — We tried to pay someone else, and failed

> Every payment a project like this makes is usually to an endpoint the same
> project wrote. That makes the money real and the market imaginary.
>
> So we pointed Agent #001 at kaspa-x402's own demo vendor. Five attempts.
> All five accepted on chain, paying their quoted address the quoted amount.
> All five refused service, with one error code that maps to eight different
> internal causes.
>
> We ruled out finality, replay, and the payer address. What's left is inside
> a verifier that isn't published.
>
> Our best guess: x402's `exact` scheme assumes the payer is a wallet, and a
> bounded payer is not a wallet. Our spend has a second output that isn't
> change — it's the successor grant.
>
> Full write-up, txids included, in the repo.

*The attempts table from INTEROP-KASPA-X402.md.*

---

## 10 — What Warda is not

> Warda guarantees: only an authorized key spends, never above the caps, only
> to committed payees, delegation only within the parent's limits, revocation
> at any time.
>
> Warda does not guarantee: that the service arrives, that the vendor is
> honest, that you get a refund, that the price was fair, that the agent chose
> well.
>
> **Warda is not escrow.** It bounds what an agent may spend and says nothing
> about what it receives. kaspa-x402 built an escrow covenant; the two
> compose. Anything claiming to do both at once is worth reading twice.

*The two-column guarantees / does-not-guarantee block.*

---

## After the ten

The series stops here on purpose. What comes next should be things that
happened, not things we planned:

- delegation — #001 granting bounded authority to a sub-agent, which needs no
  vendor and no one's permission, and is the only unshipped covenant feature
- whatever kaspa-x402 answers about the interop failure
- the first payment that is actually served

Announcing a roadmap invites people to measure you against it. Announcing what
shipped invites them to check it.

## Two things to avoid

**Don't claim an agent economy.** The honest position — *the authority layer is
ready and the market isn't* — is more defensible and ages better than being
early to a boom that hasn't happened.

(An earlier draft here carried a daily volume figure for x402 across all chains
and a claim about how much of it was self-dealing. Neither has a source in this
repo and both would be stale within a week of writing. If a version of this
argument needs a number, get it from a dated public dashboard on the day of
posting and cite it in the post. Otherwise the argument stands without one —
it is about what we should not claim, not about what the market did.)

**Don't round the numbers.** One authorized payee, three payments, six
refusals, 0.6 KAS. Every one is checkable, and the smallness is the proof
they're real.
