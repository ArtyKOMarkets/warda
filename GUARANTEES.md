# What the chain actually enforces

`LIMITS.md` covers consensus resource ceilings — script size, compute, stack.
This is the other question, and the one a counterparty asks: **given a Warda
grant, what can the agent holding it do, and what stops it?**

Everything below is either a line of `warda_grant.sil` or a verdict from the
consensus script engine. Nothing here is inferred from the design.

Three vulnerabilities were found in this covenant in a single afternoon, all
three by the same method and none of them by reading the code. They are
recorded in full at the end, because a document that lists only guarantees is
a sales sheet.

---

## The four things an agent or principal can do

A grant is a UTXO locked by a covenant with four entrypoints. Each is listed
with what the chain checks — not what the SDK checks, which is a convenience
and can be bypassed by anyone who declines to use it.

### `auth_spend` — the agent pays an allowlisted recipient

| Enforced | How |
|---|---|
| The payee is on the allowlist | `merkleRoot(recipient, proof) == recipientsRoot` |
| The amount is within the per-spend cap | `amount <= maxPerSpend` |
| Total spending stays within budget | `amount <= budgetTotal - (spentTotal + reserved)` |
| Per-epoch spending stays within the epoch cap | `amount <= epochLimit - spentThisEpoch` |
| **Epochs are consumed once, in order** | `currentEpoch >= prevState.epochIndex` |
| The claimed time has actually arrived | `tx.daa >= claimedDaa` (CLTV) |
| The window has opened | `claimedDaa >= notBefore` |
| **The window has not closed** | `claimedDaa < expiresAt` |
| Authority is unchanged in the successor | nine equality checks on `newState` |
| The successor state is exactly right | four checks on spent/reserved/epoch |
| The continuation keeps the remainder | `outputs[0].value >= inValue - amount - maxFee` |
| The agent signed it | `checkSig(agentSig, agentKey)` |

The two bolded rows are new in v2 and are what make the epoch cap a *rate*
limit rather than decoration. See the findings below.

### `delegate` — the agent subdivides its budget, without the principal

| Enforced | How |
|---|---|
| The child cannot exceed the parent's uncommitted budget | `child.budgetTotal <= budgetTotal - committed` |
| Every attenuable field only narrows | six checks, listed below |
| The allowlist is inherited exactly | `child.recipientsRoot == recipientsRoot` |
| The child starts clean | `spentTotal == reserved == epochIndex == epochSpent == 0` |
| The parent changes in exactly one way | twelve equality checks plus `reserved + child.budgetTotal` |
| Coin follows authority | `outputs[1].value == child.budgetTotal` |
| Exactly one child | `OpAuthOutputCount == 2`, `#[covenant.fanout(to = 2)]` |

The six attenuation axes: `budgetTotal` ≤ uncommitted, `maxPerSpend` ≤,
`epochLimit` ≤, `notBefore` ≥, `expiresAt` ≤, `delegationDepth` <. Everything
else must be equal. A field forgotten in the narrowing is one the child
**shares**, which is the safe direction to be wrong in.

### `revoke` — stop a grant immediately

`checkSig(revocationKey)`, the output must be `P2PK(principalKey)`, and — as of
v3 — `outputs[0].value >= inValue - maxFee`. Available at any time.

### `reclaim` — recover after the term

The same, signed by `principalKey`, and gated on `tx.daa >= expiresAt` via
CLTV.

---

## What the chain cannot enforce

Each of these is structural. None is a missing feature waiting to be built.

### Expiry does not stop an agent dead

`expiresAt` is enforced against `claimedDaa`, and `claimedDaa` is supplied by
the agent. CLTV proves only that the chain has *reached* a time, never that it
is *before* one — so an agent can always claim an earlier moment.

The epoch ratchet bounds this: each epoch is consumable once and only in
increasing order, so total spending over a grant's life cannot exceed
`epochs × epochLimit`, capped by `budgetTotal`. But allowance from epochs the
grant never used stays spendable **after the chain has passed `expiresAt`**.

*Residual:* a grant spending steadily carries about one `epochLimit`. A grant
idle since epoch *E* carries the unused allowance of every epoch from *E* to
the end of its window. `verify-grant` reports the figure for a given grant.

*If you need a hard stop:* `revoke`. It is the only mechanism that ends a grant
immediately, and it requires somebody online to use it.

### Reserve is never released

Nothing decrements `reserved`. `auth_spend` requires it unchanged, `delegate`
adds to it, and the exits are terminal. So a parent with a 500,000,000 budget
can delegate 500,000,000 **in total across its entire life**. Reclaiming a
child returns the coin to the principal but does not restore the parent's
capacity to delegate again.

*Consequence:* lanes cannot be churned. Either delegate long-lived children, or
size the parent for total lifetime delegation, or issue fresh top-level grants
— which is cheap, and is what the principal should do when they are available.

*Why it is not built — corrected.* This section previously said a release path
was blocked because the parent cannot verify a child's `budgetTotal` and
`spentTotal` without compiling the child's script inside script. That was
wrong, and it is worth recording as an error rather than quietly editing:
Silverscript provides `readInputStateWithTemplate(inputIndex, prefixLen,
suffixLen, expectedTemplateHash)`, which slices the claimed redeem script out
of a foreign input's signature script, checks `templateHash(prefix, suffix)`
against a trusted value, proves that P2SH of that script equals the foreign
input's actual `scriptPublicKey`, and only then decodes the state.

That is exactly the primitive a reabsorb path needs, and no Merkle accumulator
is required. A settle transaction consumes the parent and the child together;
the parent reads the child's real `budgetTotal` and `spentTotal` from input 1
and requires `reserved -= child.budgetTotal` and `spentTotal += child.spentTotal`,
which preserves the invariant exactly.

One wrinkle decides the shape: `expectedTemplateHash` must be trusted data, and
it cannot be a constructor constant, because the hash covers the prefix and
suffix that would contain it — a hash preimage fixed point. It has to be a
STATE field, where it sits between prefix and suffix and is therefore not
covered, and where a wrong value simply produces a different address.

Still not built. But it is a covenant change of known shape, not a limitation
of the model.

### One child per delegation

`#[covenant.fanout(to = 2)]` and `require(OpAuthOutputCount == 2)` fix the
topology at parent-plus-one-child. Building *N* lanes costs *N* sequential
delegations — a setup cost paid once, after which the lanes are genuinely
parallel, since each is its own UTXO.

### The allowlist is fixed at genesis, and children inherit it whole

Set inclusion is not decidable from a Merkle root, so the only relation
enforceable on roots alone is equality. A grant cannot add a payee, and a child
cannot be given a *narrower* set than its parent. Narrowing needs per-member
inclusion proofs — a subset witness — which is not in this covenant.

### A grant is one UTXO, so payments are serial

The second spend's input is the first spend's output, which does not exist
until the first confirms. Delegation is the concurrency primitive: *N* children
are *N* independent UTXOs and therefore *N* parallel lanes.

### Fees are not charged against the budget

A spend pays its fee from the grant's coin, and only the recipient amount is
charged to `spentTotal`. The two diverge by exactly the fees paid, permanently
and growing. An agent acting on `remaining` will eventually build a spend the
coin cannot fund. `verify-grant` reports `maxNextSpend`, which is the tightest
of the four limits that actually bind — including the coin.

---

## Vulnerabilities found, and how

All three share a shape: **the covenant checked what something was, and not how
much of it there was.** All three were found by asking what an adversary
supplies at each input and handing the answer to the real script engine. None
was visible in review.

### 1. The epoch cap limited nothing — `a048b13e95125ad1`

`currentEpoch` was compared for **equality** with the recorded index, and
`claimedDaa` is agent-supplied and bounded below only. An agent whose allowance
was exhausted claimed an *earlier* epoch; the equality test found a mismatch,
`spentThisEpoch` reset to zero, and the whole allowance came back. Repeatably.
The only real bound was `budgetTotal`.

```
state: epochIndex 5, epochSpent == epochLimit
  claiming epoch 5  ->  Err(VerifyError)
  claiming epoch 4  ->  Ok(())            <-- full allowance, again
```

Fixed in v2 by `require(currentEpoch >= prevState.epochIndex)`.

### 2. Expiry was absent from the spend path — `a048b13e95125ad1`

There was no `expiresAt` check on `auth_spend` at all. The covenant comment
correctly noted that CLTV cannot express an upper bound, and the conclusion
drawn was that expiry could not bind — but with the ratchet in place it binds
usefully, to the residual described above. Fixed in v2 by
`require(claimedDaa < expiresAt)`.

The ratchet is what makes it stick. An upper bound alone is meaningless: the
agent walks under it by claiming the past.

### 3. The exits could burn the balance — `4af9600b1d35e87b`

`revoke` and `reclaim` constrained the output's `scriptPubKey` and never its
value. A revoke paying 1 sompi to the principal and burning 999,999,999 to fees
was accepted by the engine.

This mattered most where the design was strongest: `revocationKey` is separate
from `principalKey` so that a monitor can be given the power to *stop* a grant
without being trusted with its balance. A monitor that cannot take the money
but can destroy it is not meaningfully safer. Fixed in v3 by adding the same
conservation clause the other two paths already carried.

---

## Checking any of this yourself

```
cd sdk && node --experimental-strip-types tools/probes.ts
cd ../covenant/deploy && cargo run -q -- probe
```

Seven transactions the covenant must refuse, each beside its nearest
legitimate twin — because a covenant that refuses everything would pass a suite
made only of refusals. A mismatch in either direction fails.

Two of the probes are assembled **without** the SDK. `buildUnsignedSpend`
refuses an epoch rewind itself, so routing the probe through it would test our
guard and never reach the covenant. An attacker does not use our SDK.

Golden vectors are the other half: they prove two implementations agree about
a transaction meant to *work*. They cannot catch any of the three findings
above.

---

## Operational requirements

**A grant's parameters must be recorded before it is broadcast.** The address
is derived from them; losing them strands the coin at an address nobody can
reconstruct. Every tool here writes its manifest first and submits second.

**A covenant upgrade changes every address.** The same state under different
bytecode derives a different address, and a tool holding the wrong template
does not fail loudly — it derives a plausible address, finds nothing, and
reports the grant missing. Manifests record a covenant fingerprint and the
tools refuse a mismatch. Old templates are kept:

| | fingerprint | |
|---|---|---|
| v1 | `a048b13e95125ad1` | epoch hole, no expiry, exits could burn |
| v2 | `4af9600b1d35e87b` | ratchet and expiry |
| v3 | `4612a19b16911c6e` | exits conserve value |

**A covenant id does not identify a grant.** A delegated child inherits its
parent's, so a whole tree shares one. What identifies a grant is its address,
because the address *is* the state.

**The demo collapses three keys into one.** `agentKey`, `revocationKey` and
`principalKey` are three different powers — spend, stop, receive — and a
deployment should separate them. Doing so is the first thing to change.
