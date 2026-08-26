# Launch

Spec §41–42, rewritten now that the work exists and we know what is actually
true.

## The one strategic change

§41 says: announce *"We gave an AI agent 100 KAS and tried to make it steal the
money."* That is the right **second** post. It should not be the first.

The audience Warda needs — Kaspa covenant developers, agent-infrastructure
engineers — is small, technical, and allergic to product announcements. They
have seen a dozen "spend controls for AI agents" launches this year. What they
have *not* seen is a covenant bug post-mortem with real opcodes in it.

So lead with the engineering. It costs nothing, asks for nothing, and buys the
only thing that matters at this stage: the reader's belief that we know what we
are doing before we tell them what we built.

## Post 1 — the bug (credibility, no ask)

> **`byte constant LEAF = 0x00` compiles to nothing**

Kaspa script encodes the value zero as the empty byte string. So a `0x00` Merkle
domain separator silently vanishes: leaves hashed unprefixed while internal
nodes correctly carried theirs. **The source read as domain-separated. The
bytecode was not.**

Why it is worth writing up:

- No code review catches it. The source is correct-looking and conventional.
- No test comparing one implementation to itself catches it, because both sides
  were consistently wrong.
- It took per-opcode tracing against the real script engine — watching `OpEqual`
  compare `2f27eb30…` against `ecbafdae…` — and then brute-forcing which
  encoding produced the difference.

Include the actual method: `TxScriptEngine` with
`with_opcode_execution_log_buffer`, no node, sub-second. Most people fighting
covenants are still on submit-to-testnet-and-see. **Give them the faster loop.**

Ends with: *this is what we were building when we found it* — one line, one
link, no pitch.

## Post 2 — the demo (the product)

Now the §41 line lands, because the reader already trusts the source.

> We gave an AI agent a grant. Then we prompt-injected it and told it to pay an
> attacker. Here is the transaction the network refused.

The whole post is one transaction pair with real txids:

1. the agent legitimately pays an allowlisted API — **accepted**
2. the same agent, same key, same grant, pays an address that is not on the
   allowlist — **refused by consensus**

Not filtered. Not flagged for review. Not caught by a policy engine. There is
simply no valid transaction to broadcast, because no Merkle proof places that
address in the tree.

**This post cannot ship until the node syncs and both txids exist.** Everything
else here can be written now; this one is gated on evidence and should stay
gated. A demo of a local test run is a demo of nothing.

## Post 3 — the protocol

For the people who read posts 1 and 2 and want depth. The spec, the covenant,
the 82 tests. This is where `warda.sh` and the landing page belong.

## Disclose the weakness before someone finds it

The strongest claim — *consensus-enforced, not provider-enforced* — invites
scrutiny from exactly the people who understand UTXO systems well enough to
attack it. Two limitations will be found in minutes by anyone competent:

**Expiry is a reclaim right, not a spend prohibition.** CLTV expresses "not
before" and has no "not after". A covenant cannot forbid a late spend. What is
true: after `expires_at` the principal may sweep the remaining balance, and the
agent's authority ends when they do.

**Revocation does not race-proof an in-flight transaction.** It makes the balance
unreachable from the next block on. Nothing in a UTXO system retracts a
transaction that is already broadcast.

State both in the launch, in our own words, as design consequences we measured.
Anyone who "discovers" them afterwards is then repeating our documentation
rather than correcting our marketing. The alternative — being corrected in
public on the central claim — costs far more than the disclosure does.

## What we may honestly claim today

- spend and delegation covenants **proven against the node's own script engine**
- **82 tests**: 45 protocol semantics, 33 covenant, 4 SDK
- every attack rejected by a **flip test** — a spend the engine accepts, one
  field changed
- delegation **conserves authority**: reserving nothing, too little, or too much
  are all rejected
- consensus limits **measured**, not estimated

## What we may not claim

Not on mainnet. Not audited. Silverscript is pre-v1 and may break without
notice. No presentation-layer challenge. A child grant inherits its parent's
allowlist rather than narrowing it. Multi-level delegation is untested past one
generation.

Write "experimental, unaudited" on everything, visibly. §40 already says to keep
that line on the landing page — keep it on the posts too. The credibility gained
by being the project that overstates nothing is worth more right now than any
individual claim we could inflate.

## Channels

| Where | What |
|---|---|
| Kaspa Discord / research forum | Post 1. This is the home audience; the tracing method is directly useful to them |
| GitHub | The repo is the landing page for post 1. It already reads correctly |
| Hacker News | Post 2 only, and only with txids. HN punishes a demo that cannot be reproduced |
| X | Post 2 as a thread, one transaction per card |

Not Product Hunt, not "AI agent" listicles, not crypto-Twitter engagement farms.
None of them contain the fifty people who could actually use this.

## The sentence to get right

Everything above serves one distinction, and if a reader takes away only this,
the launch worked:

> **AP2 proves authorization. Warda makes economic authority enforceable at the
> settlement layer.**

A signature attests that someone approved something. A covenant refuses to
produce a valid transaction. Those are different in kind, not degree — and
almost every competing product is on the first side of that line.
