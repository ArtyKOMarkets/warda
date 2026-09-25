# Covenant audit — warda_grant.sil · v4 · fingerprint b3e5eeefacf2021f
budget 10000000000 · cap 200000000 · epoch 10000000000 per 1000 · window 1000000..1007000 · depth 2 · allowlist 4 · proof depth 4

Produced by `covenant/harness/src/bin/audit.rs`. Every line below is a
verdict from `TxScriptEngine`, the same script engine a Kaspa node validates
with. Nothing here is inferred from the source.

**This is not a statement that the covenant is secure.** It reports the
properties that were tested, where the bytecode and `GUARANTEES.md` disagree,
and which claims were not reachable by a constructed transaction.

| | |
|---|---|
| Cases executed | 129 |
| Baseline accepted | yes |
| Published claims covered | 39 of 40 |
| Rules `enforced` | 37 (13 at a measured boundary) |
| Violations | 0 |
| Over-refusals | 0 |
| Rules `assumed` | 0 |

## Why a rejection here means something

The engine collapses every failed `require` into one opaque `VerifyError`. It
never says which rule rejected, so `assert!(is_err())` on its own proves
nothing — a malformed sigscript looks the same as a working cap.

Every case below is a single field changed from a baseline this run proved
the engine accepts. A rejection can therefore only be caused by that field.
Numeric rules are exercised one sompi either side of their boundary, so a
rule that is present but off by one shows up as a disagreement rather than
as a pass.

## Violations

None. No case the spec forbids was accepted by the engine.

## Over-refusals

None. Every case the spec permits was accepted.

## Every claim the guarantees make

The report's denominator. A claim nothing covers is listed as uncovered
rather than left out of the count.

| Entry | Claim | Grade |
|---|---|---|
| `auth_spend` | the payee is on the allowlist | flip |
| `auth_spend` | the amount is within the per-spend cap | boundary |
| `auth_spend` | total spending stays within budget | boundary |
| `auth_spend` | per-epoch spending stays within the epoch cap | boundary |
| `auth_spend` | epochs are consumed once, in order | flip |
| `auth_spend` | the claimed time has actually arrived | boundary |
| `auth_spend` | the window has opened | boundary |
| `auth_spend` | the window has not closed | boundary |
| `auth_spend` | authority is unchanged in the successor | flip |
| `auth_spend` | the successor state is exactly right | flip |
| `auth_spend` | the continuation keeps the remainder | boundary |
| `auth_spend` | the agent signed it | flip |
| `delegate` | the child cannot exceed the parent's uncommitted budget | boundary |
| `delegate` | every attenuable field only narrows | boundary |
| `delegate` | the allowlist is inherited, or narrowed to a subtree of it | flip |
| `delegate` | a narrowed child cannot reach the rest of its parent's allowlist | flip |
| `delegate` | the child starts clean | flip |
| `delegate` | the parent changes in exactly one way | flip |
| `delegate` | coin follows authority | flip |
| `delegate` | exactly one child | flip |
| `revoke` | signed by the revocation key | flip |
| `revoke` | the output is P2PK(principalKey) | flip |
| `revoke` | the output keeps the balance, less maxFee | boundary |
| `reclaim` | the term is over — tx.daa >= expiresAt | boundary |
| `reclaim` | signed by the principal key | flip |
| `reclaim` | the output is P2PK(principalKey) | flip |
| `reclaim` | the output keeps the balance, less maxFee | boundary |
| `reabsorb` | the child is a real input, and not the parent itself | flip |
| `reabsorb` | the pop is proven — the parent carried exactly this child | flip |
| `reabsorb` | the child has no outstanding children of its own | flip |
| `reabsorb` | reserve is released by exactly the child's budget | flip |
| `reabsorb` | the child's spending becomes the parent's | flip |
| `reabsorb` | everything else about the parent stands still | flip |
| `reabsorb` | the parent's agent signed it | flip |
| `reabsorb` | one continuation, and the coin from both inputs lands in it | boundary |
| `settle` | signed by the revocation key | flip |
| `settle` | the co-input is a grant of this template | flip |
| `settle` | exactly two inputs | flip |
| `settle` | output 0 is that grant's single authorised continuation | **not covered** |
| `settle` | the output keeps both inputs' coin, less maxFee | boundary |

## Enforced

`boundary` means both halves were measured inside the rule's own family —
the tightest value accepted and the loosest refused, one unit apart.
`flip` means only the refusal is in the family, and it is attributable
because the case is a single field away from the accepted baseline.

- `per-spend cap` — *boundary* — amount <= maxPerSpend
- `budget` — *boundary* — amount <= budgetTotal - (spentTotal + reserved)
- `epoch limit` — *boundary* — amount <= epochLimit - spentThisEpoch
- `epoch ratchet` — *flip* — currentEpoch >= prevState.epochIndex
- `cltv` — *boundary* — tx.daa >= claimedDaa
- `window opens` — *boundary* — claimedDaa >= notBefore
- `window closes` — *boundary* — claimedDaa < expiresAt
- `authority immutable` — *flip* — authority is unchanged in the successor (nine equality checks)
- `successor accounting` — *flip* — the successor state is exactly right (four checks on spent/reserved/epoch)
- `continuation value` — *boundary* — outputs[0].value >= inValue - amount - maxFee
- `signature` — *flip* — checkSig(agentSig, agentKey)
- `allowlist` — *flip* — merkleRoot(recipient, proof) == recipientsRoot
- `delegation attenuation` — *boundary* — every attenuable field only narrows
- `delegation start` — *flip* — the child starts clean
- `delegation reserve` — *flip* — the parent changes in exactly one way: reserved + child.budgetTotal
- `delegation budget` — *boundary* — child.budgetTotal <= budgetTotal - committed
- `delegation allowlist` — *flip* — empty witness, so the fold returns the parent's own root
- `subset narrows` — *flip* — merkleRoot(recipient, proof) == recipientsRoot, the CHILD's
- `delegation coin` — *flip* — outputs[1].value == child.budgetTotal
- `delegation fanout` — *flip* — OpAuthOutputCount == 2, fanout(to = 2)
- `revoke signature` — *flip* — checkSig(s, revocationKey)
- `revoke destination` — *flip* — outputs[0].scriptPubKey == P2PK(principalKey)
- `revoke conservation` — *boundary* — outputs[0].value >= inValue - maxFee
- `reclaim signature` — *flip* — checkSig(s, principalKey)
- `reclaim destination` — *flip* — outputs[0].scriptPubKey == P2PK(principalKey)
- `reclaim term` — *boundary* — tx.daa >= expiresAt
- `reclaim conservation` — *boundary* — outputs[0].value >= inValue - maxFee
- `settle child index` — *flip* — childIdx is a real input, and not the active one
- `settle pop` — *flip* — reserveRoot == blake2b(prevRoot || childId), newState.reserveRoot == prevRoot
- `settle leaves first` — *flip* — child.reserved == 0
- `settle reserve` — *flip* — newState.reserved == reserved - child.budgetTotal
- `settle charge` — *flip* — newState.spentTotal == spentTotal + child.spentTotal
- `settle parent still` — *flip* — everything else about the parent stands still
- `settle parent signature` — *flip* — checkSig(agentSig, pubkey(agentKey))
- `settle child signature` — *flip* — checkSig(s, revocationKey)
- `settle co-input` — *flip* — the co-input is a grant of this template, and there are exactly two inputs
- `settle conservation` — *boundary* — outputs[0].value >= inputs[0].value + inputs[1].value - maxFee

## Every case

| Rule | Case | Spec | Engine | |
|---|---|---|---|---|
| baseline | 0.5 KAS to an allowlisted payee, in the window, within every cap | accept | accepted | ok |
| per-spend cap | exactly the cap | accept | accepted | ok |
| per-spend cap | one sompi under the cap | accept | accepted | ok |
| per-spend cap | one sompi over the cap | refuse | refused | ok |
| per-spend cap | a hundred times the cap | refuse | refused | ok |
| per-spend cap | one sompi | accept | accepted | ok |
| per-spend cap | nothing at all | refuse | refused | ok |
| per-spend cap | a negative amount | refuse | refused | ok |
| budget | exactly the uncommitted budget | accept | accepted | ok |
| budget | one sompi past the uncommitted budget | refuse | refused | ok |
| budget | exactly what is left once reserve is counted | accept | accepted | ok |
| budget | one sompi into the reserve | refuse | refused | ok |
| epoch limit | exactly this epoch's remaining allowance | accept | accepted | ok |
| epoch limit | one sompi past this epoch's allowance | refuse | refused | ok |
| epoch ratchet | a later epoch, with its own fresh allowance | accept | accepted | ok |
| epoch ratchet | the recorded epoch, which is already exhausted | refuse | refused | ok |
| epoch ratchet | an EARLIER epoch — the v1 allowance reset | refuse | refused | ok |
| epoch ratchet | the first epoch, long past | refuse | refused | ok |
| cltv | locktime exactly the claimed DAA | accept | accepted | ok |
| cltv | locktime one DAA below the claim | refuse | refused | ok |
| window opens | the first DAA of the window | accept | accepted | ok |
| window opens | one DAA before the window opens | refuse | refused | ok |
| window closes | the last DAA of the window | accept | accepted | ok |
| window closes | the first DAA after expiry | refuse | refused | ok |
| window closes | well past expiry | refuse | refused | ok |
| authority immutable | budgetTotal raised by one in the successor | refuse | refused | ok |
| authority immutable | budgetTotal lowered by one in the successor | refuse | refused | ok |
| authority immutable | maxPerSpend raised by one in the successor | refuse | refused | ok |
| authority immutable | maxPerSpend lowered by one in the successor | refuse | refused | ok |
| authority immutable | epochLimit raised by one in the successor | refuse | refused | ok |
| authority immutable | epochLimit lowered by one in the successor | refuse | refused | ok |
| authority immutable | epochLength raised by one in the successor | refuse | refused | ok |
| authority immutable | epochLength lowered by one in the successor | refuse | refused | ok |
| authority immutable | notBefore raised by one in the successor | refuse | refused | ok |
| authority immutable | notBefore lowered by one in the successor | refuse | refused | ok |
| authority immutable | expiresAt raised by one in the successor | refuse | refused | ok |
| authority immutable | expiresAt lowered by one in the successor | refuse | refused | ok |
| authority immutable | delegationDepth raised by one in the successor | refuse | refused | ok |
| authority immutable | delegationDepth lowered by one in the successor | refuse | refused | ok |
| authority immutable | agentKey swapped in the successor | refuse | refused | ok |
| authority immutable | recipientsRoot swapped in the successor | refuse | refused | ok |
| authority immutable | templateId swapped in the successor | refuse | refused | ok |
| successor accounting | spend the money, record nothing | refuse | refused | ok |
| successor accounting | spentTotal short by one | refuse | refused | ok |
| successor accounting | spentTotal over by one | refuse | refused | ok |
| successor accounting | reserved raised by one | refuse | refused | ok |
| successor accounting | reserved lowered by one | refuse | refused | ok |
| successor accounting | epochSpent short by one | refuse | refused | ok |
| successor accounting | epochSpent over by one | refuse | refused | ok |
| successor accounting | epochIndex pushed forward | refuse | refused | ok |
| successor accounting | epochIndex pushed backward | refuse | refused | ok |
| continuation value | a fee of exactly maxFee | accept | accepted | ok |
| continuation value | a fee one sompi over maxFee | refuse | refused | ok |
| continuation value | the whole remainder taken as fee | refuse | refused | ok |
| signature | signed by a key that is not the agent's | refuse | refused | ok |
| allowlist | member 0xa1 of the allowlist | accept | accepted | ok |
| allowlist | member 0xa2 of the allowlist | accept | accepted | ok |
| allowlist | member 0xa3 of the allowlist | accept | accepted | ok |
| allowlist | member 0xa4 of the allowlist | accept | accepted | ok |
| allowlist | a payee absent from the allowlist | refuse | refused | ok |
| allowlist | a proof naming an allowlisted payee, money going elsewhere | refuse | refused | ok |
| delegation baseline | a child narrower on every axis | accept | accepted | ok |
| delegation attenuation | child maxPerSpend exactly equal to the parent's | accept | accepted | ok |
| delegation attenuation | child maxPerSpend one step wider than the parent's | refuse | refused | ok |
| delegation attenuation | child epochLimit exactly equal to the parent's | accept | accepted | ok |
| delegation attenuation | child epochLimit one step wider than the parent's | refuse | refused | ok |
| delegation attenuation | child notBefore exactly equal to the parent's | accept | accepted | ok |
| delegation attenuation | child notBefore one step wider than the parent's | refuse | refused | ok |
| delegation attenuation | child expiresAt exactly equal to the parent's | accept | accepted | ok |
| delegation attenuation | child expiresAt one step wider than the parent's | refuse | refused | ok |
| delegation attenuation | child delegationDepth one below the parent's | accept | accepted | ok |
| delegation attenuation | child delegationDepth exactly equal to the parent's | refuse | refused | ok |
| delegation start | a child born already having spent one sompi | refuse | refused | ok |
| delegation reserve | no reserve taken | refuse | refused | ok |
| delegation reserve | reserve one KAS short | refuse | refused | ok |
| delegation reserve | reserve one KAS over | refuse | refused | ok |
| delegation budget | a child taking exactly the parent's uncommitted budget | accept | accepted | ok |
| delegation budget | one sompi more than the parent has left | refuse | refused | ok |
| delegation allowlist | a child inheriting the whole allowlist | accept | accepted | ok |
| delegation allowlist | a child claiming a different allowlist with an empty witness | refuse | refused | ok |
| delegation allowlist | a child narrowed to a subtree, with the path to prove it | accept | accepted | ok |
| delegation allowlist | a child narrowed to ONE member — the leaf hash, depth zero | accept | accepted | ok |
| delegation allowlist | a root that is in no tree, carrying a real node's witness | refuse | refused | ok |
| delegation allowlist | the right node, every sibling side flipped | refuse | refused | ok |
| delegation allowlist | the right node, a witness borrowed from another tree | refuse | refused | ok |
| subset narrows | a child narrowed to one member paying that member | accept | accepted | ok |
| subset narrows | the same child reaching for a member only its PARENT may pay | refuse | refused | ok |
| subset narrows | …offering that member's valid proof against the PARENT's root | refuse | refused | ok |
| subset narrows | a child narrowed to a subtree paying inside it | accept | accepted | ok |
| subset narrows | the same child reaching outside its subtree, with a parent-valid proof | refuse | refused | ok |
| delegation coin | the child's coin exactly its budget | accept | accepted | ok |
| delegation coin | the child's coin one sompi short of its budget | refuse | refused | ok |
| delegation coin | one sompi over | refuse | refused | ok |
| delegation fanout | one child | accept | accepted | ok |
| delegation fanout | two children in one delegation | refuse | refused | ok |
| revoke signature | the revocation key | accept | accepted | ok |
| revoke signature | the agent's key, not the revocation key | refuse | refused | ok |
| revoke signature | the principal's key, not the revocation key | refuse | refused | ok |
| revoke destination | paying anybody but the principal | refuse | refused | ok |
| revoke conservation | a fee of exactly maxFee | accept | accepted | ok |
| revoke conservation | one sompi more than maxFee burned | refuse | refused | ok |
| reclaim signature | the principal's key | accept | accepted | ok |
| reclaim signature | the agent's key, not the principal's | refuse | refused | ok |
| reclaim signature | the revocation key, not the principal's | refuse | refused | ok |
| reclaim destination | sweeping to anybody but the principal | refuse | refused | ok |
| reclaim term | the first DAA the term allows | accept | accepted | ok |
| reclaim term | one DAA before the term is over | refuse | refused | ok |
| reclaim conservation | a fee of exactly maxFee | accept | accepted | ok |
| reclaim conservation | one sompi more than maxFee burned | refuse | refused | ok |
| settle baseline | a child settled home, its spending charged and its reserve released | accept | accepted | ok |
| settle child index | the child claimed at the parent's own index | refuse | refused | ok |
| settle child index | the child claimed at an input that does not exist | refuse | refused | ok |
| settle child index | the child claimed at a negative index | refuse | refused | ok |
| settle pop | a previous reserve root the parent never carried | refuse | refused | ok |
| settle leaves first | a child that still has coin committed to a grandchild | refuse | refused | ok |
| settle reserve | the reserve not released | refuse | refused | ok |
| settle reserve | more reserve released than was held | refuse | refused | ok |
| settle charge | the child's spending never charged to the parent | refuse | refused | ok |
| settle charge | one sompi less charged than the child spent | refuse | refused | ok |
| settle parent still | the parent raising its own per-payment cap | refuse | refused | ok |
| settle parent still | the parent extending its own expiry | refuse | refused | ok |
| settle parent still | the parent inflating its own budget | refuse | refused | ok |
| settle parent signature | the parent's half signed by the revocation key | refuse | refused | ok |
| settle child signature | the revocation key | accept | accepted | ok |
| settle child signature | the child's half signed by the agent's key | refuse | refused | ok |
| settle child signature | the child's half signed by the principal's key | refuse | refused | ok |
| settle co-input | the revocation key settling a child against its own dust | refuse | refused | ok |
| settle conservation | a fee of exactly maxFee across both inputs | accept | accepted | ok |
| settle conservation | one sompi more than maxFee | refuse | refused | ok |

## The check that reads no specification

Everything above compares the bytecode to a written claim. A second pass
asks a question nobody had to write down first: generate spend attempts
structurally, discard everything the engine refused, and assert one property
of what is left — **an accepted spend must not leave the agent able to do more
than it could before, minus what it just paid.**

| Covenant | Generated | Engine accepted | Authority grew |
|---|---:|---:|---:|
| `warda_grant.sil` v4, as written | 768 | 61 | 0 |
| the same, epoch ratchet removed | 768 | 69 | **8** |

The second row is the self-check. An oracle that has never fired is
indistinguishable from one that cannot, so the run deletes
`require(currentEpoch >= prevState.epochIndex)` — and requires the same oracle to catch it.


## What this run did not test

- One claim on settle: that output 0 is the co-input grant's single authorised continuation. The baseline builds exactly that shape, so there is no transaction in this run where it is the only thing wrong — the refusals that would prove it are indistinguishable from the co-input check firing first.
- One grant shape per RUN — but no longer one shape per suite. This run used: budget 10000000000 · cap 200000000 · epoch 10000000000 per 1000 · window 1000000..1007000 · depth 2 · allowlist 4 · proof depth 4. Every axis of it is an environment variable now (WARDA_BUDGET, WARDA_MAX_PER_SPEND, WARDA_EPOCH_LIMIT, WARDA_EPOCH_LENGTH, WARDA_NOT_BEFORE, WARDA_EXPIRES_AT, WARDA_DELEGATION_DEPTH, WARDA_TREE_LEAVES, WARDA_PROOF_DEPTH), so another shape is a re-run rather than an argument. What this report cannot tell you is what the OTHER shapes did: read the matrix in covenant/SHAPES.md for that, and treat a claim about a shape nobody ran as exactly what it is.
- Anything above the script engine — a node's mempool policy, relay rules, or what a wallet does with a transaction before it is broadcast.
- The residual described in GUARANTEES.md: allowance from unused epochs stays spendable after the chain passes expiresAt. That is a property of the design, correctly implemented, not a defect the engine can report.

## What a clean run does not mean

This instrument checks the bytecode against a written claim. It cannot notice a rule that should exist and does not, because the document it takes its claims from is the same document that would have omitted it.

That is not a hypothetical. Of the five vulnerabilities this covenant has had, none would have been caught by the claims suite. The epoch cap that limited nothing and the missing expiry check were both absent from the guarantees at the time. The template-id defect is not engine-visible. The fifth was in settle, The fifth is now covered — but only because it has already been found: the claim it violates was written as part of its fix, and a suite whose oracle is the documentation learns about a hole the day somebody else closes it. Every one of the five was found the same way, and it was not this way: a person asked what an adversary supplies at each input, built it, and watched the engine accept it.

The section above it is the answer to that, and the only one this tool has: an oracle that consults no document, and a covenant with a known hole in it to prove the oracle can fire.

