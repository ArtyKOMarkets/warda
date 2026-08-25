# warda-harness — covenant execution proof

Runs `warda_grant.sil` through `TxScriptEngine`, the **same script engine a
Kaspa node uses** to validate a transaction. No node, no RPC, no testnet
round-trip — a verdict in milliseconds.

```bash
cd covenant/harness
cargo test --test spend -- --nocapture
```

First build takes a few minutes (it fetches rusty-kaspa); after that it is
sub-second.

## Why this exists

`@warda/core` proves the **semantics** — what the rules mean. This proves the
**bytecode** — that the compiled covenant actually enforces them inside the
engine that matters. Between the two there is no room left for "submit to
testnet and see what happens".

The method is lifted directly from KOMarkets' bug #6 postmortem, which is the
technique that cracked a bug that testnet round-trips could not.

## Deliberate dependency choice

Depends on `kaspa-txscript` but **not** `kaspa-consensus`. The full consensus
crate pulls `librocksdb-sys`, which takes minutes to build and OOM-killed this
harness on the first attempt. The script engine is all we need.

Both kaspa and silverscript deps are **pinned by revision**. The Silverscript
repo states it "may introduce breaking changes without notice" — unpinned, a
compiler change could silently alter our bytecode between runs and we would be
debugging the wrong thing.

## Verified so far

- covenant compiles at **1,988 bytes** (maxProofDepth = 16)
- ABI is `__covenant_entrypoint_auth_spend`, `revoke`, `reclaim`
- a size assertion guards against silent bloat
- **`reclaim`'s expiry lock fires inside the real engine**:
  `UnsatisfiedLockTime: locktime is greater than the transaction locktime:
  1007000 > 0` — CLTV enforcement is proven, not assumed

## Proven at bytecode level

Six tests, 0.27s. Every one runs the compiled covenant through the node engine.

| Test | Verdict |
|---|---|
| covenant compiles, ABI as expected | 1,988 bytes, size assertion guards bloat |
| harness reaches a real engine verdict | `UnsatisfiedLockTime` from reclaim CLTV |
| **overspend — 20 KAS against a 2 KAS cap** | rejected |
| zero amount | rejected |
| spend before `not_before` | rejected |
| **per-spend cap fires before the DAA lock** | proven by distinguishable verdicts |

The overspend rejection is the product claim, now demonstrated in the same
engine a node runs — not reasoned about, not simulated.

## KNOWN LIMITATION — read before trusting any of the above

**The engine collapses every failed `require` into one opaque `VerifyError`.**
It never reports which rule rejected.

So `assert!(result.is_err())` on its own proves only that the covenant refused
the transaction — never that it refused it *for the stated reason*. A malformed
sigscript produces exactly the same verdict as a working per-spend cap. Any test
suite here that ignores this is lying to you.

Two ways to close the gap, one of which is already done:

1. **Distinguishable downstream failure** (done — `per_spend_cap_fires_before_the_daa_lock`).
   Hold the transaction shape fixed, change one field, and arrange for the
   *passing* case to fail later at a NAMED error. An over-limit spend dies at a
   `require()` with `VerifyError`; an in-limit spend clears every amount guard
   and reaches the CLTV lock, returning `UnsatisfiedLockTime`. Different
   verdicts from one changed field is what makes the guard genuinely provable.
2. **A valid happy path that flips to rejection** when a single field changes.
   Needs a real Merkle proof and a covenant-aware Rust signature. Not built yet.

Until (2) exists, read every `is_err()` in this suite as "the covenant rejected
this", never as "the covenant rejected this for the reason in the test name".

## Two gotchas already paid for

**Signatures are 65 bytes, not 64.** A 64-byte `sig` argument is rejected at
sigscript-build time with a type mismatch. This is KOM bug #1, and Silverscript
catches it at build time rather than on-chain — strictly better than finding it
in a rejected transaction.

**`TransactionInput::new` is the wrong constructor.** It sets a `SigopCount`
commit; a v1 covenant input needs a `ComputeBudget` commit via
`new_with_compute_budget`. This is KOM bug #5, and the trap is that the
obvious-looking function is the wrong one.

## Three type traps in the argument builders

Each cost a build cycle and none is documented:

- **`sig` is 65 bytes** — 64 is rejected as a type mismatch at sigscript-build
  time (KOM bug #1, caught early instead of on-chain)
- **`TransactionInput::new` sets a SigopCount commit** — v1 covenant inputs need
  `new_with_compute_budget` (KOM bug #5; the obvious constructor is wrong)
- **`byte[32][]` has no working helper.** `inferred_array` yields `byte[][]`;
  `TryFrom<Vec<Vec<u8>>>` yields `byte[32][N]` with a FIXED outer dimension.
  The parameter is dynamic-outer, so the `TypeRef` must be built by hand —
  see `byte32_array` in the test.

Plain `entry` functions use `build_sig_script`; `#[covenant]` policy functions
use `build_sig_script_for_covenant_decl`. Passing a plain entry to the covenant
builder panics.

## Next

The happy path — the piece that upgrades every rejection above from "refused" to
"refused for this reason". It needs a real Merkle proof over the recipient root
and a covenant-aware Rust signature (see REUSE.md: the WASM signer cannot do
this). Then each vector in `vectors/vectors.json` is asserted against the
engine, and the attack suite is proven twice — once in semantics, once in
bytecode.
