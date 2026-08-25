# Phase 0 — findings

Checked against the Silverscript compiler built from source (`kaspanet/silverscript`,
master) and Kaspa's Toccata docs. Anything marked **VERIFIED** was run, not read.

## Status

| | |
|---|---|
| Toccata | **Live on mainnet** since 30 June 2026, DAA 474,165,565 |
| Target network | **testnet-10** — Arty confirms TN12 was temporary. The Silverscript README still says TN12; treat it as stale |
| Silverscript | Pre-v1, "unstable and may introduce breaking changes without notice" |
| Covenant declarations | Working. `#[covenant.singleton]` generated our entrypoint correctly — **VERIFIED** |

## The three findings that change the protocol

### 1. Integer overflow is undefined behaviour — and UB may silently SUCCEED

`UNDEFINED-BEHAVIOUR.md` is explicit:

> Undefined behaviour is not guaranteed to make execution fail. The compiler may
> remove, replace, fold, or avoid evaluating a statement... If the resulting
> contract completes successfully, its result is `true` and the spend succeeds.
> In particular, a contract must never use undefined behaviour as an implicit
> check which it expects to reject a transaction.

Run-time integers are signed-magnitude, at most **eight bytes**. Addition,
subtraction and multiplication outside that range are UB.

**Consequence for Warda: guard order is normative, not stylistic.** Every
attacker-supplied integer must be bounded *before* it reaches any arithmetic.
`spentTotal + amount` where `amount` is unbounded is UB, and UB may pass.

This invalidates a comment previously in `src/validate.ts` calling
short-circuit rejection "an implementation detail and cheaper on-chain". It is
neither. It is required. The reference implementation now documents the
ordering as normative so the covenant and the reference agree on *why*, not
just *what*.

Headroom check: Kaspa's max supply is ~28.7e9 KAS = ~2.87e18 sompi against a
~9.22e18 ceiling. About 3.2x. Sums of two in-range balances are safe; an
unbounded call arg is not.

### 2. `tx.daa` is write-only — the current DAA score cannot be read

> `tx.daa` accepts only an `int` threshold and emits an absolute CLTV lock in
> the DAA-score domain.

So `epochIndex = (currentDaa - notBefore) / epochLength` cannot be computed
from chain state. The workaround, which holds:

- the agent supplies `claimedDaa` as a call argument
- the covenant enforces `require(tx.daa >= claimedDaa)`
- CLTV makes the transaction unincludable before `claimedDaa`

**Overstating is therefore impossible** — an agent cannot claim a future epoch
to reset its epoch budget early. Understating is possible but only costs the
agent headroom, since it accumulates against an older epoch. Safe in the
direction that matters.

### 3. Expiry is a RECLAIM RIGHT, not a spend prohibition

CLTV expresses "not before". It cannot express "must be spent before X". A UTXO
covenant simply cannot forbid a late spend.

What is actually enforceable: after `expiresAt` the **principal can sweep** the
remaining balance. Until they do, the agent's spend path still works.

**This weakens spec section 7.5**, which says "grant becomes invalid after a
defined DAA score". True statement: *after expiry the principal can reclaim,
and the agent's authority ends when they do.* Same shape applies to revocation
— `revoke` makes the balance unreachable from the next block, but does not
race-proof an already-broadcast agent spend.

The spec and landing copy must say this plainly. It is still a strong claim; it
is not the claim currently written.

## Confirmed capabilities

- `blake2b(byte[]) : byte[32]` — **replace the placeholder hash in `src/hash.ts`
  with this**, then regenerate vectors
- `byte[32][]` and `bool[]` arrays, `+` concatenation, `.slice()`, `.split()` —
  everything the Merkle fold needs
- `for (i, start, end, MAX)` — bounded loops, explicit iteration cap
- `checkSig`, `new ScriptPubKeyP2PK(...)`, `tx.inputs[i].value`,
  `tx.outputs[i].value`, `tx.outputs[i].scriptPubKey`, `this.activeInputIndex`
- Contract params are immutable and baked into the scriptPubKey; contract
  *fields* become the implicit `State` struct bound to the successor output

## Verified against the compiler

Built `cli-debugger` from source and compiled `covenant/warda_grant.sil`:

- the contract **parses and compiles**
- `#[covenant.singleton] function spend(State prevState, State newState, ...)`
  produced an entrypoint taking **6 call args** — the two `State` params were
  stripped and injected by the generated wrapper, exactly as `docs/DECL.md`
  describes. Our function shape is correct.

## Resolved since first draft

### Output indexing — was a bug, now fixed

The continuation index comes from `OpAuthOutputIdx(this.activeInputIndex, 0)`.
It is **not** guaranteed to be `tx.outputs[0]`, and the first draft assumed it
was. The covenant now pins the topology explicitly — continuation at 0, payment
at 1 — which is cheaper than scanning and which the SDK must build to.

`OpAuthOutputCount` and `OpAuthOutputIdx` both compile.

### Single continuation — already enforced

`covenant_declaration_security_tests.rs` shows the generated singleton wrapper
rejects two authorised outputs from one input, so one grant cannot fan into two
continuations and double its authority. `groups = single` is a broader check at
covenant-id level across a whole transaction; worth adding once multiple grants
can share a covenant id, not needed for a single grant today.

The same suite confirms the wrapper rejects a continuation carrying a different
script, and rejects a mismatched next state — the successor binding the Toccata
docs warn about is handled by the declaration layer.

## Prior art — KOMarkets (Arty's own, komarkets.io)

A full parimutuel prediction market already running on **testnet-10** using
Silverscript covenants. Independently confirms TN10 is the live target and that
the stale TN12 in the Silverscript README should be ignored.

Two things worth mining once the repo is available:

- **A real script-size datapoint.** BetLock covenants compile to **65-byte
  scripts**. Warda's is far heavier — Merkle fold, state arithmetic, five
  guards — but this proves non-trivial covenants ship and gives a floor to
  measure against.
- **The deployment pipeline is the reusable part**, not the market logic:
  compiling Silverscript, deriving covenant addresses, building and submitting
  TN10 transactions, and reading covenant state back. That is exactly the
  scaffolding Phase 1 needs and it already exists and works.

## Script size — MEASURED, Phase 1 unblocked

Compiled with the real compiler (`silverscript-lang` in-process, not the CLI).
Cost is linear in `maxProofDepth`: **~852 bytes base, ~71 bytes per level.**

| maxProofDepth | Bytecode | Max recipients |
|---:|---:|---:|
| 2 | 994 | 4 |
| 4 | 1,136 | 16 |
| 8 | **1,420** | 256 |
| 16 | 1,988 | 65,536 |
| 24 | 2,557 | ~16.7M |
| 32 | 3,125 | ~4.3B |

**Reference point: KOMarkets runs a 2,184-byte covenant on-chain today.** Warda
at depth 8 is 1,420 bytes — smaller than something already proven to deploy.
Even depth 16 (1,988 bytes) sits inside proven territory, and buys a 65,536-entry
allowlist, which is far past any realistic agent.

**Decision: set `maxProofDepth = 16`.** The recipient allowlist was never going
to be the binding constraint, and `MAX_SUBSET_MEMBERS = 8` is comfortable. Both
were provisional pending this measurement; both are now settled.

Generated ABI confirms the wrapper shape:

```
__covenant_entrypoint_auth_spend(newState, amount, recipient,
                                 proofSiblings, proofSiblingIsLeft,
                                 claimedDaa, agentSig)
revoke(s)
reclaim(s)
```

`prevState` is injected from tx context and never appears in the ABI — exactly
as DECL.md specifies.

## Still open

1. **Delegation covenant.** 1:N fanout, not yet drafted.
2. **Script size and compute budget.** Still undocumented. `MAX_SUBSET_MEMBERS`
   and `maxProofDepth` must be set from a measurement.
3. **Uncommitted call args.** `DECL.md` warns extra call args "are not directly
   committed by tx structure". For us `amount` and `recipient` are constrained
   because the successor state derives from them — but this needs a written
   argument, not an assumption.
4. **Compiled script size for the spend covenant.** Still unmeasured. This sets
   `MAX_SUBSET_MEMBERS` and `maxProofDepth`, and is the last real unknown.
