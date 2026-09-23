# Covenant audit — `warda_grant.sil` v4

Produced by `covenant/harness/src/bin/audit.rs`. Every line below is a
verdict from `TxScriptEngine`, the same script engine a Kaspa node validates
with. Nothing here is inferred from the source.

**This is not a statement that the covenant is secure.** It reports the
properties that were tested, where the bytecode and `GUARANTEES.md` disagree,
and which claims were not reachable by a constructed transaction.

| | |
|---|---|
| Cases executed | 76 |
| Baseline accepted | yes |
| Rules `enforced` | 15 (10 at a measured boundary) |
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

## Enforced

`boundary` means both halves were measured inside the rule's own family —
the tightest value accepted and the loosest refused, one unit apart.
`flip` means only the refusal is in the family, and it is attributable
because the case is a single field away from the accepted baseline.

- `per-spend cap` — *boundary* — amount <= maxPerSpend
- `budget` — *boundary* — amount <= budgetTotal - (spentTotal + reserved)
- `epoch limit` — *boundary* — amount <= epochLimit - spentThisEpoch
- `epoch ratchet` — *boundary* — currentEpoch >= prevState.epochIndex
- `cltv` — *boundary* — tx.daa >= claimedDaa
- `window opens` — *boundary* — claimedDaa >= notBefore
- `window closes` — *boundary* — claimedDaa < expiresAt
- `authority immutable` — *flip* — authority is unchanged in the successor (nine equality checks)
- `successor accounting` — *flip* — the successor state is exactly right (four checks on spent/reserved/epoch)
- `continuation value` — *boundary* — outputs[0].value >= inValue - amount - maxFee
- `signature` — *flip* — checkSig(agentSig, agentKey)
- `allowlist` — *boundary* — merkleRoot(recipient, proof) == recipientsRoot
- `delegation attenuation` — *boundary* — every attenuable field only narrows
- `delegation start` — *flip* — the child starts clean
- `delegation reserve` — *flip* — the parent changes in exactly one way: reserved + child.budgetTotal

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

## What this run did not test

- `revoke` and `reclaim` — the exits. Both are signed by keys the agent does
  not hold, and neither moves the accounting this report is about.
- `settle` / `reabsorb` — the v4 splice path. It needs a real foreign-input
  redeem script, which this harness does not yet build.
- The subset witness: a child narrowing its allowlist to a subtree.
- Anything above the script engine — a node's mempool policy, relay rules,
  or what a wallet does with the transaction before it is broadcast.
- The residual described in `GUARANTEES.md`: allowance from unused epochs
  stays spendable after the chain passes `expiresAt`. That is a property of
  the design, correctly implemented, not a defect the engine can report.

