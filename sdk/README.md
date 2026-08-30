# @warda/kaspa

Give an agent a spending budget on Kaspa, enforced by the chain rather than by
your code.

A **grant** is a UTXO locked by a covenant. It names an agent key, a total
budget, a per-spend cap, a per-epoch cap, a validity window, and an allowlist of
recipients. The agent spends from it directly — no co-signing, no relay, no
custody — and the network rejects anything outside those limits. The principal
signs once, to create the grant, and is never online again.

This package creates those grants and signs those spends, from JavaScript. No
Silverscript compiler, no Rust toolchain, no node process of its own.

```
npm install @warda/kaspa
```

## What it does not do

**It does not decide whether a spend is allowed.** The covenant does that, on
chain, and it is the only thing that can.

That is a deliberate limit, not a missing feature. If this package
reimplemented the rules, a divergence between the two would fail by wrongly
*permitting* — the SDK says yes, and a budget gets drained by a spend nobody
authorised. Reimplementing *assembly* fails the other way: a divergence
produces a transaction the network rejects. Everything here is byte layout,
where mistakes are loud.

**It does not broadcast.** A spend is an ordinary transaction once it is built;
submit it with whatever node client you already use.

## Creating a grant

Genesis is an ordinary P2PK spend that happens to pay into a covenant. One
thing about it is not ordinary, and it fails quietly if you get it wrong:

```ts
import { buildGenesis, attachGenesisSignature, signDigest } from "@warda/kaspa";

const genesis = buildGenesis({
  template,
  grant: { authority, state },   // state must be all-zero: a grant starts new
  funding: yourWalletUtxo,
  grantValue: 1_000_000_000n,
  fee: 1_000_000n,
  computeBudget: 12,
});

const tx = attachGenesisSignature(genesis, signDigest(genesis.sighash, principalKey));
// genesis.covenantId, genesis.grantScriptHash — record both; see below.
```

The grant output carries a covenant **binding**, which contains a covenant
**id** derived from the funding outpoint and the authorized outputs — each
hashed *without* its binding, to avoid self-reference. So the output is built
unbound, the id computed over it, and only then is the binding written in.
Reverse that order and you get a well-formed transaction, paying a plausible
address, whose grant nothing can ever spend. Nothing surfaces until the agent's
first payment is refused for reasons that look like a covenant bug.

**Record the grant's parameters before you broadcast.** Its address is derived
from them, so losing them strands the UTXO.

## Building a spend

```ts
import { readFileSync } from "node:fs";
import { signSpend, type SpendPlan } from "@warda/kaspa";

const template = JSON.parse(readFileSync("covenant-template.json", "utf8"));

const plan: SpendPlan = {
  template,

  // Fixed for the life of the grant. The agent cannot move these.
  authority: {
    principalKey: "…",   // who may reclaim after expiry
    revocationKey: "…",  // who may revoke
  },

  // The grant as it stands now. Its address is derived from this.
  state: {
    agentKey: "…",
    budgetTotal: 1_000_000_000n,
    maxPerSpend: 200_000_000n,
    epochLimit: 500_000_000n,
    epochLength: 1_000n,
    recipientsRoot: "…",
    notBefore: 1_000_000n,
    expiresAt: 1_864_000n,
    delegationDepth: 2n,
    spentTotal: 0n,
    reserved: 0n,
    epochIndex: 0n,
    epochSpent: 0n,
  },

  utxo: { /* the grant's current UTXO */ },
  amount: 50_000_000n,
  recipient: allowlistedPubkey,      // x-only, must be a leaf of recipientsRoot
  proof: merkleProofFor(recipient),  // siblings + which side each sits on
  claimedDaa: 1_000_500n,            // slightly in the past; see below
  fee: 1_000_000n,
  computeBudget: 16,
};

const { tx } = signSpend(plan, agentSecretKey);
```

`signSpend` verifies its own signature before returning it, so a wrong key or a
wrong digest surfaces as a readable error rather than as a node saying only
that the script failed.

## Delegating to a sub-agent

The thing that makes a grant more than a spending cap. An agent can hand a
narrower grant to a sub-agent without asking the principal, without custody,
and without being able to hand over more than it holds.

```ts
import { buildUnsignedDelegation, attachDelegationSignature, signDigest } from "@warda/kaspa";

const d = buildUnsignedDelegation({
  template, authority, state,        // the parent, as it stands
  utxo: parentUtxo,
  child: {
    agentKey: subAgentPubkey,        // the one field that is genuinely new
    budgetTotal: 400_000_000n,
    maxPerSpend: 100_000_000n,       // may only ever shrink
    epochLimit: 200_000_000n,
    delegationDepth: 1n,             // strictly less than the parent's
  },
  fee: 1_000_000n,
  computeBudget: 16,
});

const tx = attachDelegationSignature(d, signDigest(d.sighash, agentSecretKey));
// d.childScriptPublicKey — where the child lives. Watch it to see it spend.
```

**Conservation is the point.** The parent *reserves* exactly what the child
receives, and real coins move with it. Reserve without coins and the child can
pay nobody; coins without reserve and the same KAS is spendable twice, from two
addresses, both legitimately.

Everything the child does not narrow it **inherits** — allowlist, epoch length,
validity window, and the parent's principal and revocation keys. Delegation
subdivides an agent's budget; it does not hand over the right to revoke or
reclaim. A field forgotten in the narrowing is one the child *shares*, which is
the safe direction to be wrong in.

Note the encoding is not the spend's. `delegate` takes `State[]`, and the
compiler **transposes** a struct array: one push per *field* holding that
field's value across every element, so `State[2]` is thirteen pushes rather
than two — with integers fixed at 8 bytes instead of minimal. Laying the two
states out one after the other produces a sigscript of exactly the same length
with every value in the wrong place. `golden-delegation.json` is what catches
that.

## Three things that will bite you

**The grant's address moves every time it is spent.** A grant lives at
`P2SH(covenant compiled with its state)`, and the state includes `spentTotal`
and `epochSpent` — so spending necessarily relocates it. The continuation
output goes to the *successor's* address, which `buildUnsignedSpend` computes
for you. Sending it back to the input's own address produces an output that no
longer matches its own state and is unspendable forever.

**`claimedDaa` must be in the past.** It becomes the transaction's lock time,
and a transaction whose lock time equals the current DAA score is not yet
final. Leave a margin — the reference tool uses 100.

**The compute budget is charged as mass, so it costs real money, and
under-provisioning is rejected outright.** One signature verification alone
costs 100,000 script units; 16 is right for a spend with a proof depth of 4.

## Address derivation without a compiler

A grant's address depends on its state, so deriving one normally means
compiling the covenant. `covenant-template.json` makes that unnecessary: every
value a grant can vary occupies a fixed-width slice of the bytecode, so
splicing values into the template produces output byte-identical to compiling.

```ts
import { scriptHashFor } from "@warda/kaspa";
const hash = scriptHashFor(template, { authority, state });
```

Two properties of that layout are easy to assume wrongly, and both were:

- **A value can appear more than once.** `principalKey` is embedded three
  times — the revoke and reclaim entrypoints each check it. Writing only the
  first occurrence leaves a covenant that answers to two different principals.
- **Not every value is spliceable.** `maxProofDepth` and `maxFee` have
  value-dependent widths, so they are compiled in. They tell you *which*
  template you are holding, not what you can change about it. A grant that
  changes either needs its own template.

The template is regenerated by `warda-deploy template`, which proves
splice-equals-compile across every field before writing the file.

## Checking against the engine, not just against a file

`golden-spend.json` proves this package agrees with a recorded reference. It
does not prove the *consensus engine* agrees with either of them — a shared
misreading of the spec would satisfy both.

So a built transaction can be written out and handed to the engine directly:

```
npm run build:golden  > js-spend.json      # a spend
npm run build:genesis  > js-genesis.json    # a grant being created
npm run build:delegate > js-delegation.json # a grant subdividing itself
cd ../covenant/deploy && cargo run -- verify ../../sdk/js-spend.json
```

```
built by   : @warda/kaspa
script engine -> Ok(())
the consensus engine accepts a transaction this tool did not build.
```

That runs the same `TxScriptEngine` a node runs, over bytes JavaScript
assembled. It needs no node and no network. `submit` does the same and
broadcasts.

The check is not vacuous: paying the recipient one extra sompi, without
adjusting the successor state, is refused with `VerifyError`.

## Why you can trust the bytes

`golden-spend.json` is a reference transaction emitted by the same Rust
construction path that put a spend on testnet-10. The test suite reproduces it
here: the unsigned signature script byte-for-byte, the sighash, the successor
address, and the transaction id.

The signature itself is deliberately not compared — schnorr draws a random
nonce, so two correct implementations differ there. Instead the suite checks
the stronger thing: **the reference signature, over a transaction the network
already validated, verifies against a digest this package derived
independently.**

```
npm test
```

## License

MIT
