# @warda_protocol/core

Reference implementation of the **Warda agent grant protocol** — the executable
definition of what a Kaspa Toccata covenant must enforce.

This package settles the protocol semantics *before* anyone fights a pre-v1
compiler. It runs with no chain, no network and no dependencies, and it emits
the test vectors any covenant implementation is validated against.

```bash
npm run check     # typecheck + 45 tests, including the full attack suite
npm test          # tests only
npm run vectors   # regenerate vectors/vectors.json
```

Requires Node ≥ 22.6 (native TypeScript type stripping — there is no build step).

---

## Phase 0 findings

Checked against Kaspa's current documentation, August 2026.

| Question | Answer |
|---|---|
| Is Toccata live? | **Yes — mainnet since 30 June 2026**, DAA score 474,165,565 |
| Does it support transaction introspection? | **Yes** — inputs, outputs, covenant groups, auth groups, hashes, byte slices |
| Can a script validate its own successor output? | **Yes.** The documented pattern is exactly Warda's: the transaction reveals the preimage, the script computes the next state, and refuses to pass unless the transaction creates the next committed UTXO |
| Is Silverscript production-ready? | **No.** Pre-v1, "unstable and may introduce breaking changes without notice". The maintainers recommend testnet-10 only until a stable release |
| Script size / compute budget limits? | **Undocumented.** "Keep state small enough for script limits and transaction mass" — with no numbers. This must be *measured*, not read |

**Conclusion:** the covenant Warda needs is expressible today. The risk is
tooling maturity, not consensus capability. Build against testnet-10.

---

## Open design issues

Found while implementing. Each needs a decision before the phase named.

### 1. Recipient subset — RESOLVED

`child.recipients ⊆ parent.recipients` is not decidable from a Merkle root, so
the child **witnesses** the relation instead of asserting it. Two modes:

| Mode | Cost | Use |
|---|---|---|
| `inherit` | one root equality | the child takes the parent's whole allowlist |
| `subset` | k inclusion proofs + k−1 hashes | the child names its members and proves each is in the parent tree |

In `subset` mode the members must arrive in strict ascending order. Verifying
that a list is sorted costs k−1 comparisons; sorting it inside a script costs
far more. Ordering also forces one encoding per set, so the child root is
unique, and strictness rejects duplicates — without it a child could claim k
members while really holding fewer. The child's committed root is then rebuilt
from the witnessed leaves and compared, so it cannot prove a narrow set and
commit to a wide one.

**Rejected alternatives.** *Singleton-only children* is just `subset` with k=1
and needlessly restrictive once the general path exists. *"Child root must be
an internal node of the parent tree"* costs one proof instead of k, but only
permits contiguous runs of the canonical ordering — which subsets are
expressible would depend on how addresses happen to sort. Unusable.

`MAX_SUBSET_MEMBERS` is **8, provisionally**. The real ceiling is whatever
Toccata's script budget allows, which is undocumented. Set it from a
measurement, not from taste.

### 2. The hash — SETTLED

Kaspa's `OpBlake2b` is `blake2b_simd::Params::new().hash_length(32)`: plain
BLAKE2b-256, unkeyed, no personalization, no salt. Read straight out of the
script engine, not inferred.

Node's crypto cannot produce it — it exposes only `blake2b512`, and truncating
that is **not** BLAKE2b-256 (different IV parameterisation). Hence the single
runtime dependency on `@noble/hashes`.

Verified: `RecipientSet` here and the Rust tree in `covenant/harness` produce
**byte-identical roots**, and the covenant accepts a proof built from either.

### 3. Fixed epochs permit 2× the limit across a boundary

An agent can spend its full epoch limit at the end of one epoch and again at
the start of the next. This is a property of fixed epochs, accepted for v0.1,
and pinned by a test so it is never rediscovered as a bug report. It belongs in
the public docs.

### 4. `maxPerSpend > budgetTotal` is legal

An early guard rejected this. It was wrong: a child with a 0.5 KAS budget that
inherits a 2 KAS per-spend cap is well-formed — the cap simply never binds
because the budget binds first. Rejecting it breaks small delegations. Worth an
SDK warning; not a protocol rule.

---

### 5. Domain separators must be NON-ZERO

`0x00` as a Merkle domain separator is a **silent no-op** in Kaspa script,
which encodes the value zero as the EMPTY byte string. `byte[](0x00)` compiles
to nothing, so leaves were hashed unprefixed while nodes got their `0x01` —
the source read as domain-separated, the bytecode was not.

Found by per-opcode tracing against the real engine. Review would not have
caught it; nor would any test that only checks TypeScript against itself.
`LEAF` is now `0x01` and `NODE` is `0x02`, matching `warda_grant.sil`.

## Two bugs the test suite caught

Recorded because both are easy to reintroduce in the covenant.

**Merkle proofs broke on odd-sized sets.** Odd nodes are promoted rather than
duplicated (duplication enables the CVE-2012-2459 ambiguity where two distinct
trees share a root). But promotion skips a level, and a verifier that derives
left/right from index parity desynchronises. Each sibling now carries its own
`left` flag. A size sweep from 1 to 33 keeps it caught.

**A hostile successor crashed the validator.** A negative `spentTotal` threw
inside the u64 encoder instead of returning a rejection. A covenant would
simply fail; an SDK that throws on hostile input hands an attacker a
denial-of-service. `statesEqual` now returns `false` for anything that cannot
be canonically encoded.

---

## Layout

```
src/
  types.ts        Grant, GrantState, failure codes
  hash.ts         canonical u64/u32 encoding, pluggable hash  ← placeholder
  amounts.ts      sompi arithmetic; bigint only, never floats
  merkle.ts       recipient allowlist tree and inclusion proofs
  grant.ts        canonical encoding, grant_id derivation, available()
  epoch.ts        DAA-based fixed-epoch accounting
  validate.ts     validateSpend, validateDelegation, revoke
test/
  attacks.test.ts       the spec's Phase 7 malicious agent — 15 attacks
  recipients.test.ts    inherit and subset witness modes — 12 cases
  conservation.test.ts  authority conservation over randomised trees
  epoch.test.ts         epoch boundaries and the known 2× property
  merkle.test.ts        proofs, tampering, size sweep
vectors/
  generate.ts     emits vectors.json
```

## Design rules

- **All amounts are `bigint` sompi.** No floats anywhere near money.
- **Failures are collected, not short-circuited.** A covenant may reject on the
  first failure; the reference implementation reports all of them, because the
  attack demo needs to show precisely which rules bit.
- **Successor validation is the load-bearing check.** Without it every other
  limit is decorative — an agent that can rewrite its remaining budget has no
  budget. See `ATTACK 4` in the attack suite.
- **`available = budgetTotal − spentTotal − reserved`.** `reserved` is what has
  been delegated to children. This is what makes delegation conserve authority
  instead of creating it.

## Status

Experimental. Unaudited. No covenant yet — this is the specification the
covenant will be checked against.
