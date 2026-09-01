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

### The allowlist is fixed at genesis, and a child may only narrow it to a subtree

A grant can never add a payee: the root is part of the address, so changing the
set is a different grant.

A child *can* now be given a narrower set than its parent — v4 added the subset
witness. The child states any node of the parent's Merkle tree as its own
`recipientsRoot` and carries the path from that node to the parent's root; its
members are exactly the leaves beneath it. Inheriting everything is the same
check with an empty witness, so there is one rule rather than two.

The constraint is that a subset must be a **subtree**: a contiguous,
power-of-two-aligned run of the parent's canonically sorted members. An
arbitrary selection would need one inclusion proof per member, which is a
different and much more expensive construction. In practice this means the
order of a parent's allowlist is a design decision — payees that will be
delegated together should sit together. `RecipientSet.subtree` refuses a
selection it cannot cover and says which rule was missed.

Narrowing to a *single* payee is the degenerate case and costs nothing extra:
the child states that member's leaf hash, and its own spends fold from the same
leaf with an empty proof.

### The epoch limit bounds one grant's rate, not a subtree's

`epochLimit` caps what a single grant spends per epoch, and a child's is capped
by its parent's — but the **sum** is not. A parent limited to 5 KAS per epoch
can delegate to ten children at 5 KAS per epoch each, and the tree spends 50 KAS
in that epoch.

This is not a leak: `budgetTotal` still bounds the total, exactly, because the
reserve accounting is conservative and every delegation moves real coin. What
degrades is the *rate* limit — under delegation it collapses toward the budget
limit.

Anyone reading "500 KAS per epoch" will assume it binds the whole tree. It binds
one grant. If a subtree-wide rate limit is wanted, the way to get it today is to
keep `delegationDepth` at 1 for grants where the rate matters, or to size each
child's `epochLimit` as a share of the parent's rather than a copy of it —
neither of which the covenant enforces.

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

The first three share a shape: **the covenant checked what something was, and
not how much of it there was.** All three were found by asking what an
adversary supplies at each input and handing the answer to the real script
engine. None was visible in review.

The fourth has a different shape and a different finder, and both are worth
recording: it was a **derivation that ignored one of its inputs**, and it was
caught by the splice trust anchor rather than by the engine — the one check
that compiles the covenant with a revocation key distinct from the principal.

The fifth is the first one again, verbatim, in a path written after it was
fixed: **a value check with no destination check.** `revoke` was repaired in
v3; `settle` was written for v4 and never got the same treatment. A fix is not
a lesson until it is applied to the code written next.

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

### 4. The template id ignored the revocation key — v4, pre-release

`templateId` is a grant's claim about its own redeem-script shape:
`readInputStateWithTemplate` recomputes blake3 over `len(prefix) || prefix ||
len(suffix) || suffix` and requires the result to equal it. That is what lets a
parent read a child's state at settlement without trusting the child.

Both `principalKey` and `revocationKey` are constructor constants compiled into
the **suffix**, so both are inside the preimage. The Rust derivation took only
the principal:

    fn template_id_for(principal: [u8; 32]) -> [u8; 32]

Every probe it compiled set `revocationKey := principalKey`, so the id it
returned was the id of a *different covenant* than the one being built whenever
the two keys differ. Consequence: a parent's stored `templateId` would not match
the true hash of its own children, and every `reabsorb` would be refused —
reserves locked, permanently, with no error that points at the cause.

Two things hid it:

- **Every key in the deploy tool is a bare `[u8; 32]`.** Nothing distinguishes
  an agent key from a principal key, so four manifest paths were also passing
  `plan.agent` to the parameter named `principal`, and the compiler had no
  opinion.
- **The SDK's address tests read `templateId` from the vectors as data** rather
  than deriving it. Eight vectors carried an id that was not the covenant's
  true template hash, and all eight passed.

The fix is a type, not a patch: `Authority { principal, revocation }`, which
makes "the id of one key" unrepresentable and turned the four agent/principal
confusions into compile errors. Two SDK tests now derive the id and require it
to match the compiled one — the only tests that would have failed.

A second defect surfaced underneath it. The template's field-geometry prober
infers each field's extent from *which bytes changed* between a baseline and a
probe compilation, which is sound only when the two values differ in **every**
byte. Fixed probe constants gave that for hand-picked baselines and lost it for
derived ones: `templateId` is a hash, so whether any of its 32 bytes happened to
equal the probe's `0x99` was chance — about one in eight — and a collision split
the run and made an intact field look mis-measured. Probes are now the
baseline's bit-complement, so the property holds by construction.

### 5. `settle` let the revocation key take a child — v4, pre-release

Settlement spends the parent and the child in one transaction: the parent runs
`reabsorb` under its agent key, the child runs `settle` under the REVOCATION
key. The child's half is signed by the revocation key on purpose — if
settlement needed the child's cooperation, an unresponsive child could lock its
parent's budget forever, which is the failure settlement exists to remove.

`settle` checked that output 0 received `inputs[0].value + inputs[1].value -
maxFee`. It did not check output 0's **scriptPubKey**, and nothing required the
other input to be a parent — or a grant at all. So:

    input 0   the child grant, spent under `settle`
    input 1   any dust the revocation key already owns
    output 0  a plain P2PK the revoker chose, holding the child's balance

The engine accepted it. That makes the revocation key a **take** capability
over every delegated child, when the entire reason it is a separate key from
`principalKey` is so a monitor can stop a grant *without* being trusted with
its balance. `revoke` pays the principal and only the principal; `settle` paid
anyone.

The fix binds settle to a real settlement rather than constraining the
destination directly: the co-input must be a grant of **this template** — and
since the template id is keyed on the authority, that means the same principal
and revocation keys — and output 0 must be that grant's single authorised
continuation. A parent running `reabsorb` produces exactly that shape; a bag of
the revoker's own coin produces none of it.

**A note on how nearly this was missed.** The first run of `settle-steal` came
back refused, and the refusal was a lie: the decoy input carried no signature,
so the engine rejected *that* input with a stack error before `settle`'s
semantics decided anything. The probe was reporting a refusal that had nothing
to do with the attack. Signing the decoy properly flipped the verdict to
accepted. A probe that fails for the wrong reason is worse than no probe,
because it is recorded as evidence of safety — so the refusal REASON is now
read, not just the verdict.

### 6. A child could be settled while its own children were live — v4, pre-release

`reabsorb` released the child's full `budgetTotal` from the parent's `reserved`
while charging only `child.spentTotal`. If the child had delegated onward, the
coin funding those grandchildren had already left the tree — and settling the
child released the parent's reserve in full anyway.

The grandchildren's coin then sat outside every grant's accounting. Nothing
could reabsorb it: the only grant that could was the child, and the child had
just been consumed. The parent's budget, meanwhile, reported headroom it did
not have.

Fixed with `require(child.reserved == 0)` — the LIFO discipline applied
downward. A subtree settles from the leaves up.

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
| v4 | `b3e5eeefacf2021f` | reserve accumulator, settlement, subset witness; template id fixed |

v3's template is archived as `sdk/covenant-template-v3.json`. It was archived
*before* v4 overwrote `covenant-template.json`, which is the only order that
works: the live v3 grant is addressable only through the template it was issued
under, and that file is the sole copy of it.

**A covenant id does not identify a grant.** A delegated child inherits its
parent's, so a whole tree shares one. What identifies a grant is its address,
because the address *is* the state.

**The demo collapses three keys into one.** `agentKey`, `revocationKey` and
`principalKey` are three different powers — spend, stop, receive — and a
deployment should separate them. Doing so is the first thing to change.
