# Warda on X — the opening series

Ten posts, in order. The arc: **problem → why the obvious fix fails → what
we did → what it cost → what we still can't do.**

Warda is not named until post 3. The first two earn the right to name it.

Rules I've followed, from what worked on KOMarkets: text carries the post, a
diagram supports it, and every number is one we can point at. Nothing here is
a claim the repo can't back — a series that gets caught inventing one number
loses the credibility the honest ones bought.

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

> "Just add a spending cap."
>
> The x402 docs describe the standard one: the client "applies a $1 USD
> spend cap unless you override `spendControls`."
>
> Unless you override it. The code that pays is the code that sets the
> ceiling — so the cap is bypassed by a redeploy with a different value, a
> second instance, or anyone who can read the key out of `env`.
>
> A limit enforced by the thing being limited isn't a limit. It's a
> preference.

*Screenshot of that line at <https://docs.x402.org/guides/mcp-server-with-x402>.
Their words, quoted in full, and the reader can open the page themselves.*

*Cite the protocol's own documentation, not an individual project's repo.
Several small libraries put the same cap in an environment variable and would
make the point more vividly, but naming one developer's work to score against
it reads as punching down — and the standard is the stronger target anyway,
because nobody can answer that it was just one implementation getting it
wrong.*

*What this post does NOT claim: that the $1 cap is per-payment, per-session or
cumulative. The documentation does not say, so neither do we. The argument
does not need it — "unless you override" carries the whole thing.*

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
> Anyone can sign with it. It's been up for weeks.
>
> The most anyone has managed is to pay the vendor it was already allowed to
> pay. Someone tried to drain it at exactly the per-payment cap, which is the
> correct attack. The covenant let through exactly the cap and not a sompi
> more.
>
> wardaprotocol.com/attack

*Screenshot of the key on the page. The provocation is the point.*

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

**Don't claim an agent economy.** x402 across all chains does roughly $28k a
day and about half of that is self-dealing. The honest position — *the
authority layer is ready and the market isn't* — is more defensible and ages
better than being early to a boom that hasn't happened.

**Don't round the numbers.** One authorized payee, three payments, six
refusals, 0.6 KAS. Every one is checkable, and the smallness is the proof
they're real.
