# Deployed — testnet-10

A Warda grant exists on a public network. An agent holding its key was
prompt-injected, attempted to pay an address outside its allowlist, and **the
network refused to include the transaction.**

Not filtered. Not flagged for review. The script ran and could not be satisfied.

## The receipts

Network: **testnet-10** · Node: rusty-kaspa v2.0.1 · Covenant: 3,036 bytes

| | |
|---|---|
| Grant address | `kaspatest:prm79fmfrrw80r5mrf5a0ltzsnskxutu77996xh0zajhygusylpkzhemc2zpl` |
| Covenant id | `f7947f65000b60e59819b02b93b5fd1761772f4edcf07010268ab7eefad375f8` |
| Genesis | `626736a3a202e838e4d0adca095c8660cb46638da3910bf89f589deb571343d4` |
| Legitimate spend — **accepted** | `36f3dff2e5218651d80e62f1c7e620313a58fbc6ecd18a81d68050a33544fb55` |
| Prompt injection — **refused** | `e251a20effea166c90f9cf4f19e28073856e57b3dc9ef0209269347e7a1396f1` |
| Spend assembled in **JavaScript** — accepted | `7dbc957fbf87ca26bc9b83ec81849f4f713c255fa6d39f44a53301813ceb86ba` |

> Rejected transaction e251a20e…: failed to verify the signature script:
> **script ran, but verification failed**

The grant: 10 KAS budget, 2 KAS per-transaction cap, 5 KAS per epoch, four
allowlisted recipients.

**Both spends came from the same grant, at the same address, signed by the same
key.** They differ in one field — the payee. That is what makes the pair
evidence rather than two anecdotes.

## A second implementation, on the same chain

`7dbc957f…` was not built by the Rust tool. Every byte of it — the covenant
arguments, the Merkle proof, the successor address, the signature hash — was
assembled by `@warda_protocol/kaspa`, in JavaScript, with no Silverscript compiler and
no Rust toolchain.

That matters because a protocol only one implementation can speak is a product
nobody else can build on. The SDK derives grant addresses by splicing a
template, and proving that splice equals what the compiler emits is what makes
an npm package possible at all.

It was checked in three widening circles before it was broadcast, each one
answering a question the previous could not:

| Check | Answers |
|---|---|
| `golden-spend.json` | do the bytes match a reference the network already accepted? |
| `warda-deploy verify` | does the **consensus engine** accept them — not just our own reference? |
| `submit` | does the network? |

The middle one is the load-bearing step. Matching a recorded vector proves two
implementations agree; it does not prove either is right, because a shared
misreading of the spec satisfies both. Running JavaScript's output through the
same `TxScriptEngine` a node runs is what turns agreement into correctness.

## The local engine predicted the network exactly

Before broadcasting, each transaction ran through `TxScriptEngine` locally:

| | Local | Network |
|---|---|---|
| Legitimate spend | `Ok(())` | accepted |
| Prompt injection | `Err(VerifyError)` | refused |

The harness built while waiting for IBD turned out to be a faithful oracle for
what the network would do. Every covenant failure was caught locally first.

## What only the network could teach us

Four things the local harness could not have found, because they are policy and
economics rather than script semantics.

**Compute budget is charged as mass.** `compute_budget = 1000` — copied from
KOMarkets — added 100,000 mass and demanded a **10.1 KAS fee** for a transaction
that computes almost nothing.

**One signature costs 100,000 script units.** `GRAMS_PER_SIGOP_COUNT_UNIT`
(1000) × `SCRIPT_UNITS_PER_GRAM` (100). It dwarfs the covenant's own work, which
is ~24,000. So *any* signed input needs ≥10 budget units before doing anything
interesting. Working values: **genesis 12, spend 16.**

**maxFee must exceed the real fee.** A spend carries the ~3KB redeem script in
its signature script, so its mass is size-dominated. The original 100,000 sompi
cap was below the actual fee, and the covenant's own value-conservation check
would have refused the transaction the SDK had just built.

**`claimedDaa` must sit behind the chain tip.** The covenant's `tx.daa >=
claimedDaa` compiles to a CLTV lock, so a locktime equal to the current DAA
leaves the transaction not yet final and the mempool rejects it. We back off 100
DAA (~10s).

That last one is the design paying off. PHASE0 established that *understating*
claimedDaa is safe while overstating is impossible. The direction that turned
out to be operationally necessary is the same direction that was already sound —
had it been the other way, there would be no fix.

## And one thing the architecture taught us by breaking

The first `spend` succeeded, then `inject` failed with *"no UTXO at the grant
address"*. Not a bug: **the spend had moved the grant to a different address**,
the one encoding its new state. The deploy tool was still looking at the old one.

This is KOM bug #6 in the open. The grant's address *is* its state, so a tool
that assumes a fixed address works exactly once. `grant.json` now tracks state
and `spend` advances it on success.

## Still true

Testnet only. Unaudited. Silverscript pre-v1. One generation of delegation
untested on-chain, no presentation-layer challenge, and a child grant inherits
its parent's allowlist rather than narrowing it.
