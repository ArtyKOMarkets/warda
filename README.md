# Warda

**Give agents money. Not unlimited authority.**

An open protocol for creating, delegating, verifying and enforcing cryptographic
economic grants for autonomous software agents, on Kaspa.

A principal commits funds to a *grant* and defines what the agent may do with
them. The property that matters:

> The agent cannot exceed the authority encoded in its grant — even if the agent
> itself, its wallet software, or the Warda backend is compromised.

Enforcement is not a policy in a database. It is a Toccata covenant: the
settlement layer refuses to produce a valid transaction.

---

## Live on testnet-10

An agent was prompt-injected and told to pay an address outside its allowlist.
**The network refused the transaction.**

| | |
|---|---|
| Legitimate spend — accepted | `36f3dff2e5218651d80e62f1c7e620313a58fbc6ecd18a81d68050a33544fb55` |
| Prompt injection — refused | `e251a20effea166c90f9cf4f19e28073856e57b3dc9ef0209269347e7a1396f1` |

Same grant, same address, same key — differing in one field, the payee. Full
detail in [DEPLOYED.md](DEPLOYED.md).

## Status: experimental, unaudited, nothing on mainnet

The spend and delegation covenants exist and are **proven against
`TxScriptEngine`** — the same script engine a Kaspa node uses to validate a
transaction. 33 covenant tests, 45 protocol tests, sub-second, no node required.

| | |
|---|---|
| Protocol semantics | `@warda_protocol/core`, 45 tests |
| Spend covenant | proven, 1,810 bytes |
| Delegation covenant | proven, conservation demonstrated |
| Consensus limits | measured — [LIMITS.md](LIMITS.md) |
| Signing path | verified — [SIGNING.md](SIGNING.md) |
| On a public network | **testnet-10** — [DEPLOYED.md](DEPLOYED.md) |

Nothing here has touched mainnet, and Silverscript itself is pre-v1 and may
break without notice.

## Quick start

```bash
npm run check                              # protocol semantics: typecheck + 45 tests
cd covenant/harness && cargo test          # covenant vs. the node engine: 33 tests
cd covenant/deploy && cargo run -- dry-run # deploy tool, no node needed
```

## What is actually proven

Each row below has a **flip test**: a spend the engine *accepts*, with exactly
one field changed. Because the baseline passes, the rejection can only be caused
by that field.

| Attack | Verdict |
|---|---|
| Prompt injection to an unlisted payee | rejected |
| Overspend past the per-transaction cap | rejected |
| Payment diverted after a valid proof | rejected |
| Agent rewrites its own authority | rejected |
| Successor state not advanced | rejected |
| Delegation escalation, on every axis | rejected |
| Authority created by delegating | rejected |
| **A correctly formed spend** | **accepted** |

This distinction matters more than it looks. The engine collapses every failed
`require` into one opaque `VerifyError` — it never says *which* rule rejected. So
`assert!(is_err())` against a baseline that never passed proves nothing at all: a
malformed script produces the same verdict as a working per-spend cap.

## Layout

```
src/            @warda_protocol/core — protocol semantics in TypeScript, no dependencies
test/           45 tests: attacks, conservation, epochs, allowlists
vectors/        test vectors any covenant implementation is checked against
covenant/
  warda_grant.sil    the covenant
  harness/           executes it against the node's script engine
  deploy/            puts it on testnet-10
```

## Findings

The interesting parts of this project are the things that turned out not to be
true. Each of these cost real debugging and is written up:

- **[PHASE0.md](PHASE0.md)** — Toccata is mainnet-live; `tx.daa` is write-only, so
  epochs need a different construction; **expiry cannot be enforced** — it is a
  reclaim right, not a spend prohibition
- **[DEPLOYED.md](DEPLOYED.md)** — the testnet transactions, and the four things
  only a real network could teach us
- **[LIMITS.md](LIMITS.md)** — script size, compute budget and stack depth. Includes
  a corrected measurement: the first compute figure was taken with the signature
  charge suppressed, and measured the flag rather than the system
- **[SIGNING.md](SIGNING.md)** — covenant bindings enter the signature only at
  transaction **version 1**; a v0 signer fails in a way that looks exactly like a
  covenant bug
- **[DELEGATION.md](DELEGATION.md)** — why authority had to move out of constructor
  parameters and into state before delegation could be expressed at all
- **[REUSE.md](REUSE.md)** — six bugs inherited from a prior Kaspa covenant project,
  every one of which bit again
- **[CORE.md](CORE.md)** — `@warda_protocol/core` internals and design rules

The single best example: `byte constant LEAF = 0x00` compiles to an **empty**
byte array, because Kaspa script encodes zero as the empty string. The Merkle
leaf domain separator silently vanished — the source read as domain-separated,
the bytecode was not. No code review catches that, and no test comparing one
implementation to itself catches it either, because both sides were consistently
wrong. It took per-opcode tracing against the real engine.

## Not built yet

The presentation-layer challenge, covenant-side allowlist narrowing (a child
currently inherits its parent's allowlist rather than narrowing it), multi-level
delegation beyond one generation, and the hosted services.

## License

MIT.
