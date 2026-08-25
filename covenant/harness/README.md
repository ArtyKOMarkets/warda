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

## Two gotchas already paid for

**Signatures are 65 bytes, not 64.** A 64-byte `sig` argument is rejected at
sigscript-build time with a type mismatch. This is KOM bug #1, and Silverscript
catches it at build time rather than on-chain — strictly better than finding it
in a rejected transaction.

**`TransactionInput::new` is the wrong constructor.** It sets a `SigopCount`
commit; a v1 covenant input needs a `ComputeBudget` commit via
`new_with_compute_budget`. This is KOM bug #5, and the trap is that the
obvious-looking function is the wrong one.

## Next

The spend path itself. It needs three things this smoke test does not yet build:
a `State` argument, a real Merkle inclusion proof, and a covenant-aware
signature (see REUSE.md — the WASM signer cannot do this; it has to be Rust).
Then each vector in `vectors/vectors.json` gets asserted against the engine, and
the attack suite is proven twice: once in semantics, once in bytecode.
