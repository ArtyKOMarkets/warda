# Paying an x402 `exact` vendor from a grant, through one relay hop

**Proven 14 September 2026** against `demo.kaspa-x402.org`, a vendor built by
the people who wrote the protocol: `200 {"ok":true}`, `finality: accepted`.

```
funding   78e5564a1ec9956bcb7a1c0f8baa23d2b01600bc7a89ae3d8726f219c7c9040c
payment   28a084fd6b36daf26d77838f3e85f8f0c2798ad4f8f2d87f8d78f82065a4d49b
```

The boundary is in `INTEROP-KASPA-X402.md`: x402's `exact` scheme requires a
version-0 transaction whose every input is a **bare P2PK unlocked by a single
66-byte Schnorr push**, and whose outputs carry no covenant. A Warda spend is
none of those things, under any version, and no redeem script gets through —
their `exactV0SchnorrSignatureEvidence` reads the public key out of a P2PK
script or throws.

So the paying transaction can never be the covenant spend. It can only be a
second transaction, and that is the whole design.

## The shape

    tx A   covenant spend      grant ──▶ successor grant (covenant)
                                     └─▶ relay key, P2PK, exactly amount + feeB

    tx B   ordinary payment    relay key ──▶ merchant, P2PK, exactly amount

`tx B` is wallet-shaped by construction: version 0, one input, one output, no
change, `sigOpCount 1`, script version 0, no covenant. That is precisely what
`assertStandardNativeTransactionEnvelope` demands.

The relay key is **the agent's own key**. A separate one would add a file to
lose and no security: whoever can sign tx B can redirect it, and that is the
agent either way. Using the agent key makes the cost legible where it belongs —
the grant's allowlist must contain the agent's own public key, so the manifest
says, in as many words, *this agent may pay itself*.

## What this costs, exactly

**The allowlist, for the final hop.** Once the coin sits at a key the agent
holds, the agent chooses the destination. This cannot be engineered around:
`exact` requires the payer's input to be key-controlled, so whoever holds the
key has discretion. Everything else the covenant enforces still enforces —
budget, per-payment cap, epoch limit, window, delegation depth.

The blast radius is one invoice, not the budget, because tx A funds the relay
with exactly what tx B spends and tx B is built before tx A is broadcast.

**This is opt-in and named.** A grant created without `--relay` cannot do this
at all, because its allowlist does not contain the agent key and the covenant
will refuse to build the spend. The refusal that is this protocol's product —
*that payee is not on this grant's allowlist; there is nothing to sign* — is
unchanged for every grant that does not ask for it.

## The fee, measured

`warda fee relay` on testnet-10: the node refused 1,000 sompi on exactly this
shape and named **162,400**. The default derived from this repo's fitted mass
model was 365,000 — 2.25x too high, because that model was fitted to
version-1 transactions carrying a compute budget and a version-0 input carries
a sig-op count instead.

It also reported storage mass **zero**, which is the finding. Kaspa charges the
greater of compute and KIP-9 storage mass, and storage mass here is
`C/output - C/input` — it prices the GAP, and the gap is the fee:

| amount | storage mass at a 162,400 fee |
|---|---|
| 2.0 KAS | 5 |
| 0.2 KAS | 403 |
| 0.1 KAS | 1,599 — still under compute mass |
| 0.05 KAS | 6,292 → needs 629,200, which needs more |

So the fee is compute-driven for a large payment and storage-driven for a small
one, and a constant is wrong in both directions. `relayFeeFor` iterates to a
fixed point. Below roughly 0.1 KAS it refuses: the arithmetic still settles —
0.001 KAS converges at about 12 KAS of fee — but a transport that costs more
than the goods is a stable answer to the wrong question.

The live payment used **194,880**, which is that floor plus the repo's usual
fifth.

## Measured, not assumed

Against `@kaspa-x402/covenant@1.0.0-rc.1`, their own canonical encoder:

| | |
|---|---|
| their `exactV0TransactionId` vs the WASM SDK's `.id` | **agree, byte for byte** |
| their `exactV0SchnorrSignatureEvidence` public key | ours, read out of the P2PK script |
| digest stable across signing | yes — a v0 sighash does not commit to the signature |
| our Schnorr signature against their digest | **verifies** |

So the relay is plumbing rather than research. Nothing here needs a
re-implementation of their canonical encoding: the WASM build we already carry
for borsh produces an identical id, and their published package computes the
storage mass they will check.

## Why tx B must have NO change output

KIP-9 storage mass, via their `calculateKaspaStorageMass`:

| tx B shape | mass | fee floor |
|---|---|---|
| 1 in → 1 out, exact funding | 1,108 | **0.0011 KAS** |
| 1 in → 2 out, 0.0008 change | 12,510,753 | 12.5108 KAS |
| 1 in → 2 out, 0.05 change | 408,333 | 0.4083 KAS |

Not an optimisation. A change output of the size a relay would naturally
produce costs **more than ten thousand times** the exact-funded version, and
more than any plausible payment. So tx A must fund the relay to the penny, and
tx B must spend all of it.

That also settles the fee argument. A relayed payment is one covenant spend
(~14,982 mass, ~0.015 KAS) plus ~0.0011 KAS — **about 7% more**, not double.

## The arithmetic that follows

`tx A` pays the relay `amount + feeB`, so the covenant charges the grant
`amount + feeB` against budget, cap and epoch limit. The grant is debited
slightly more than the invoice, which is correct: the fee is part of what
buying that thing costs, and hiding it would make the budget mean less than it
says.
