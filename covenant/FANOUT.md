# Could delegation be atomic?

The /one-job page states three limits: hiring is not atomic, the hires are not
even concurrent, and every payee has to exist before the job does. This is what
each would actually cost to remove. Asked on 24 September 2026, after the first
coordinator run.

**Short version.** The first two are the same change and the compiler already
supports it — but KIP-9 prices it, and the price is a floor under every child's
budget that grows by about 0.08 KAS per child. The third cannot be fixed at
all without moving the payee guarantee out of the covenant.

---

## 1 and 2 — atomic hiring, which also makes it concurrent

`delegate` is declared `#[covenant.fanout(to = 2)]` with
`require(OpAuthOutputCount(this.activeInputIndex) == 2)`: parent continuation
at auth output 0, one child at auth output 1. Two workers is two transactions,
and the second one's input is the first one's output, which is the whole reason
hiring is serial. Make it `fanout(to = N+1)` and both limits go at once: the
children are created together, and from that moment each is its own UTXO and
genuinely parallel.

**The attribute is not the obstacle — measured, 24 September 2026.** `to = 2,
3, 4, 5` all compile, the script grows linearly at +93 bytes a child, and
`TxScriptEngine` accepts a 1:N spend at every value tried up to 8. Script units
grow quadratically (`388N² + 1161N + 616`, fitted to the unit) because reaching
`newStates[i]` costs something proportional to `i` — but one signature is
100,000 units on its own, so the whole transaction is 11 budget units at N = 2
and 14 at N = 8, against a ceiling of 65,535. `covenant/probes/` has both
probes and `covenant/V5.md` the numbers. `to = 2` was Warda's choice, and
nothing about the language or the engine is what would stop a larger one.

**Three real costs, in the order they bite:**

**Storage mass, which is the one that actually refuses.** An atomic 1:N
delegation creates N+1 covenant outputs in one transaction, and each carries a
32-byte binding that puts it in a second storage unit and squares its weight.
Mass counts `1/value` over outputs, so every extra child adds a whole term.
Measured with `sdk/src/mass.ts`, against the 500,000 ceiling:

| | mass | |
|---|---:|---|
| today: delegate research, serial | 185,329 | carried |
| today: delegate verify, serial | 243,476 | carried |
| atomic 1:2, the same two workers | **420,435** | carried, at 84% |
| atomic 1:3, 0.2 KAS each | 770,994 | **refused** |

Raising the parent's budget barely helps — 1:4 out of a 4 KAS parent still
masses 802,574 — because the cost is driven by the *children's* values, not the
parent's. What it buys is a floor under each child:

| fanout | minimum budget per child |
|---|---|
| 1:1 (today) | 0.10 KAS |
| 1:2 | 0.17 KAS |
| 1:3 | 0.25 KAS |
| 1:4 | 0.33 KAS |
| 1:6 | 0.49 KAS |
| 1:8 | 0.65 KAS |

About 0.08 KAS more per child, linearly. So atomic hiring is affordable at two,
awkward at three or four, and pointless at eight — a hiring round for eight
cheap specialists is exactly the case it cannot serve, and that is consensus
rather than anything Warda chose.

**N is part of the address.** The script is P2SH-committed, so a grant built for
2-way delegation cannot do a 3-way one. N is fixed per grant at genesis,
alongside every other term — which is consistent with the model, and means a
coordinator has to know its fanout before it knows its job.

**Settlement stays serial regardless.** `reabsorb` consumes parent plus one
child, and `settle` pops the reserve chain from the end. Atomic hiring gives
nothing back on the way out unless settlement becomes 1:N too, which is a
second change with its own conservation proof.

**And the stack is the tightest budget we have.** Size has 115× headroom and
compute 4,096×, but peak stack is 118 of 244 — 2.07×. A `delegate` that reads
and checks N children rather than one would grow it. That needs measuring
against the engine before anyone says it fits.

## 3 — payees fixed at genesis

This one is different in kind. It is not a constant to change.

The allowlist root is part of the address, so a grant cannot add a payee: a
different set is a different grant. A child may narrow, never widen — that
asymmetry is the guarantee, not an implementation detail. Committing at genesis
to a *registry* root instead of a payee list moves the problem one level up and
does not solve it: the registry root is still fixed, unless somebody can update
it, and then the payee guarantee is whatever that key says. In the router's
vocabulary that turns `enforced` into `attested`. It is a legitimate design —
but it should be described as what it is, and a principal should get to refuse
it.

**What is available today, with no covenant change at all: a much bigger
allowlist.** Depth costs 142 bytes a level, linearly. The shipped templates use
`maxProofDepth` 4, which is 16 payees. Depth 16 is 65,536 payees and 8,680
bytes — 0.87% of the million-byte script ceiling, with the compute and stack
figures unchanged across the whole range. A coordinator created against a
snapshot of a seller directory is not an open market, but it is nothing like 16
addresses either, and it stays *enforced*.

## What any of this costs in practice

All of it is a covenant change, which means v5, which means the audit Warda has
priced at $20–30k and has not funded. The code is the small part. Until then
the honest line is the one on the page: hiring is serial, and the cast is fixed
at genesis.

Numbers here are reproducible from `sdk/src/mass.ts` and
`growth/src/one-job-plan.ts`; the headroom figures are `LIMITS.md`, measured
against v4.
