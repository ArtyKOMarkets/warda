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

`@warda_protocol/core` proves the **semantics** — what the rules mean. This proves the
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

## Proven at bytecode level

Every one runs the compiled covenant through the node engine.

| Test | Verdict |
|---|---|
| covenant compiles, ABI as expected | the test prints the size; the assertion guards bloat at 4,200 bytes |
| harness reaches a real engine verdict | `UnsatisfiedLockTime` from reclaim CLTV |
| **overspend — 20 KAS against a 2 KAS cap** | rejected |
| zero amount | rejected |
| spend before `not_before` | rejected |
| **per-spend cap fires before the DAA lock** | proven by distinguishable verdicts |
| **a fully valid signed spend** | **ACCEPTED** — `Ok(())` |
| prompt injection to an unlisted payee | rejected |
| six single-field flips from that baseline | see below |

**33 tests.** The count is `grep -c '#\[test\]' tests/spend.rs`, and it is written
that way because the last two numbers in this file went stale without anyone
noticing — it said six tests, then fifteen, and both were a snapshot of an
afternoon. A figure nobody can re-derive is a figure that decays.

## It was dead for two covenant versions

**15 September 2026.** Run to collect figures for the site's evidence page, this
suite returned `constructor argument count mismatch` on 32 of 33 tests. Its
`ctor()` still declared itself *"v2 constructor order"* and passed 17
arguments; the covenant takes 21. v4 inserted `genesisTemplateId`,
`templatePrefixLen` and `templateSuffixLen` at 12..14, moving `maxProofDepth`
to 15 and every init field down by three, and added `initReserveRoot` at 20.

`covenant/deploy` was updated at the time and carries comments recording the
insertion. This file was not. Two copies of one argument list, and only one of
them was maintained — which is this repo's most expensive recurring shape,
now on its sixth appearance.

The covenant was never broken: every live grant was produced by the deploy
tool, against the current constructor. What was broken is the only thing that
proves the covenant at the bytecode level, and it was broken silently, because
a test suite nobody runs fails in a way nobody sees.

**So the rule this directory exists to serve now has a second half.** The first
was: prove the bytecode, not the semantics. The second is: a proof that is not
re-run is not a proof, and CI is where that belongs.

The overspend rejection is the product claim, now demonstrated in the same
engine a node runs — not reasoned about, not simulated.

## How the assertions are made meaningful

The engine collapses every failed `require` into one opaque `VerifyError` — it
never says which rule rejected. So `assert!(is_err())` against a baseline that
never passed proves nothing: the transaction might be refused for any reason at
all, a malformed sigscript included.

The suite closes that gap with **flip tests**. `flip_baseline_is_accepted`
establishes a spend the engine returns `Ok(())` for. Every other flip starts
from that exact transaction and changes **one field**:

| Flip | Field changed | Verdict |
|---|---|---|
| baseline | — | **accepted** |
| overspend | amount 0.5 → 20 KAS | rejected |
| unlisted recipient | payee absent from the allowlist tree | rejected |
| payment diverted | proof names an API, money goes elsewhere | rejected |
| successor not advanced | spend the money, do not record it | rejected |
| successor reserved tampered | reserved moved independently of the spend | rejected |

Because the baseline passes, a rejection can only be caused by the changed
field. That is what turns "the covenant refused this" into "the covenant
refused this **because of that rule**".

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
