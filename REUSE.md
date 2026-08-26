# What Warda takes from KOMarkets

Source: `~/Desktop/kom-main`, Arty's prediction market — covenant token genesis
and transfer **proven on-chain** with real txids. Everything below is earned
knowledge, not documentation.

## The finding that changes Warda's architecture

From the KOM deploy log, bug #6 — the one that took longest to find:

> each transfer output must be sent to the P2SH address that **encodes its new
> share amount**. A 400-share output lives at P2SH(KomShare-state-with-amount-400);
> 600 at a different address. The covenant computes the expected output spk from
> the new state and OpEqualVerify-checks it. This is how the covenant tracks
> balances across spends — **each UTXO's address commits its amount.**

**Applied to Warda:** grant state lives in the P2SH address, not beside it. Every
spend sends the continuation to a *different address* — the one encoding the new
`(spentTotal, reserved, epochIndex, epochSpent)`. Three consequences:

1. **The SDK must derive the successor address off-chain before it can build a
   spend.** This is not optional plumbing; it is the transaction. `@warda/core`
   already computes the expected successor state — it now also needs to turn that
   state into an address.
2. **The continuation's scriptPubKey is not the input's.** Any covenant that
   compares them directly is wrong. The declaration layer's `validateOutputState`
   computes the expected spk from the new state — that is precisely its job.
3. **Grant state becomes publicly enumerable**, which is a feature. Spec section
   18 claims a counterparty can independently verify remaining budget. This is
   *how*: the address itself commits the state. Say so in the docs.

## The bug chain — Warda will hit every one of these

Reproduced from `KOM_RUST_DEPLOY_GUIDE.md`. Each cost real debugging time.

| # | Bug | What it means for us |
|---|---|---|
| 1 | Signature must be exactly 65 bytes (64 schnorr + SIG_HASH_ALL); strip WASM's `0x41` push prefix | Bake into the signer, with a length assertion |
| 2 | ~2.8KB witness must pass via **file**, not a shell env var | Our witness is larger — Merkle proofs. Plan for files from day one |
| 3 | **WASM cannot sign covenant transactions.** `consensus/client/src/signing.rs` `hash_output` omits covenant data; the node's sighash includes it for v1. `createInputSignature` is unusable here | **Kills the "just use the JS SDK" plan.** Signing must happen in Rust via consensus-core's covenant-aware `calc_schnorr_signature_hash` |
| 4 | `covenant_id` must be **inherited** from genesis, not re-derived — `txscript covenants.rs` requires `output.covenant_id == input.covenant_id` | A grant keeps one covenant id across its whole life, including delegation |
| 5 | v1 inputs must carry `compute_budget = 1000` to match the node | Set it and assert it |
| 6 | Per-state output spks (above) | Architectural — see previous section |
| **7** | **`compute_budget = 1000` is ~300× over-provisioned** — and budget is charged as transaction MASS, so it is not a free margin. Demands a ~10 KAS fee per covenant transaction | Measured: one signature costs 100,000 script units, the covenant ~24,000 on top. Use **12** for a plain input, **16** for a covenant spend |

## The debugging method — adopt this in Phase 1, not after

KOM cracked #6 with a **local repro test** rather than submit-and-pray:

- run the transaction through the same engine the node uses,
  `execute_input_with_covenants` — instant, deterministic, no node, no RPC
- add a Cargo `[patch]` redirecting the GitHub kaspa deps to a local
  `rusty-kaspa` checkout, so txscript can be instrumented
- enable per-opcode stack tracing (`print_opcode_execution`) and watch the exact
  failing `OpEqual`

That harness is the single highest-value thing to build first. Our attack suite
in `@warda/core` proves the *semantics*; this proves the *bytecode*. Between the
two there is no gap left for "submit to testnet and see."

## Directly reusable code

From `kom_deploy.rs` / `kom_compile.rs`:

- `covenant_decl_sigscript(compiled, function_name, args, is_leader)` — builds
  the sigscript for a covenant-declaration entrypoint. Warda's spend and delegate
  entrypoints need exactly this.
- `push_redeem_script` — P2SH wrapping
- `sign_tx_input` — the covenant-aware Rust signer from bug #3
- in-process compilation via `compile_contract` with `Expr` args, rather than the
  `silverc` CLI and its JSON

Note the CLI's `--ctor` JSON is awkward: `ExprKind` is serde-tagged
`{tag="kind", content="data"}`, so an array argument needs
`{"kind":"array","data":{"type_ref":…,"values":[…]}}`, not a bare list. The
`kcc20_ctor.json` in kom-main uses the bare-list form and does not parse. Build
`Expr` values in Rust and skip the JSON entirely.

## Also worth knowing

- `SILVERSCRIPT_EVALUATION.md` predates the TN12 → TN10 move; its network
  references are stale, its language findings are not.
- KOM's verdict — keep proven hand-written covenants, author *new* work in
  Silverscript with the debugger — is the right posture for Warda too, except
  Warda has no proven hand-written covenants to keep. We are all new work, so the
  local repro harness matters more for us, not less.


## Repaid

Bug #7 is the first thing this project found that KOMarkets did not. On testnet
the over-provisioned fee is invisible; on mainnet it is roughly 10 KAS of
unnecessary fee on every covenant transaction KOM sends. Worth fixing in
`kom_deploy.rs` before real value moves.
