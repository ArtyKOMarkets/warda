# Covenant signing — the SDK story holds

**KOM bug #3 is already fixed upstream.** No patch to rusty-kaspa is needed, and
the `npm install @warda/kaspa` promise in spec §21/§36 survives.

## What the postmortem said

> WASM covenant-sighash gap — `consensus/client/src/signing.rs:144` `hash_output`
> omits covenant data; node's sighash includes it for v1. So WASM
> `createInputSignature` CANNOT sign covenant txs.

That was true when it was written. It is not true at the revision this project
pins.

## What is actually there now (rev `a41a333`)

**The divergent file is gone.** There is no `consensus/client/src/signing.rs`.
The client path was consolidated: `consensus/client/src/sign.rs` imports
`calc_schnorr_signature_hash` from `consensus_core::hashing::sighash` and calls
it directly. There is no second implementation left to drift.

**The shared function hashes the covenant binding** —
`consensus/core/src/hashing/sighash.rs:228`:

```rust
pub fn hash_output(hasher: &mut impl Hasher, output: &TransactionOutput, version: u16) {
    hasher.write_u64(output.value);
    hash_script_public_key(hasher, &output.script_public_key);
    if version >= 1 {
        hasher.write_bool(output.covenant.is_some());
        if let Some(covenant) = &output.covenant {
            hasher.write_u16(covenant.authorizing_input).update(covenant.covenant_id);
        }
    }
}
```

**Covenants are exposed to JavaScript.** `CovenantBinding` is
`#[wasm_bindgen(inspectable)]` with a constructor; `TransactionOutput` carries
`covenant`, accepts it in `ctor`, and exposes a getter.

## Proven, not just read

`covenant_binding_is_committed_by_the_signature` does not compare the two code
paths — they are one function now, so that would be tautological. It reproduces
the failure:

1. build a valid v1 covenant spend
2. sign the real transaction → **accepted**
3. sign a copy with every covenant binding stripped, attach that signature to
   the real transaction → **rejected**

```
digests differ           = true
correct signature        -> Ok(())
covenant-stripped digest -> Err(VerifyError)
```

The binding is load-bearing in the digest. A signer that omits it produces a
signature the engine refuses — which is exactly the symptom KOM hit, and exactly
what the current signer avoids.

## The condition that actually matters

Look at the gate: **`if version >= 1`**.

Covenant data enters the sighash **only for version-1 transactions**. A v0
transaction signs without it, silently, and produces the identical symptom from
a completely different cause. So the rule for the SDK is not "you cannot sign in
JS". It is:

- **build version-1 transactions**, and
- **build the WASM SDK from a revision at or after this consolidation**

Both are checkable. Neither requires a fork.

## Still unverified

This proves the *code path*, using the same crate the WASM SDK is built from. It
does **not** prove that a published `kaspa-wasm` npm package matches this
revision — those may lag. Before shipping the SDK, sign one covenant spend from
actual JS and run the bytes through this harness.

## Consequence

The SDK can be JavaScript-first. The Rust harness stays what it is — the proving
ground — rather than becoming the product. Spec §36's "three lines to give an
agent a budget" is buildable as written.
