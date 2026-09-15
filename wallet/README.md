# @warda_protocol/agent

A wallet an autonomous agent can hold.

```ts
import { Agent, fileStore } from "@warda_protocol/agent";

const agent = await Agent.open({
  store: fileStore("grant.json"),        // the grant's record, kept current
  recipients: ["kaspatest:qq7x…"],       // checked against the grant's root
  sign: process.env.AGENT_SECRET!,       // or a signer that holds the key elsewhere
  borsh: true,                           // read and spend with no node of your own
});

const { response, paid } = await agent.fetch("https://api.example/inference");
```

It quotes, pays, and keeps the grant findable. If the endpoint does not charge,
nothing is paid and nothing is written.

## Every other wallet asks before it signs. This one cannot

That is not a shortcut. The protection every wallet you have used offers is a
prompt, and an agent is defined by running when nobody is there to answer one.
An approval nobody sees is not a limit, it is a description of intent.

So the limit is not in this package. It is compiled into the covenant script
that unlocks the coin, and every node on the Kaspa network applies it. **This
wallet can be fully compromised — key stolen, process owned — and the ceiling
still holds**, because a payment outside the grant's terms is not a refused
request. It is not a transaction.

## The job that has no other home

A grant's address is a **hash of its state**. Spend from it and the coin moves
to a different address, derived from the new figures. The record is therefore
not a cache — it is the only way to find the money again. Lose it and the grant
is not gone, it is unaddressable, and nothing says so: every tool reports "no
UTXO at &lt;address&gt;", a message with three causes and no way to tell them
apart.

This package owns that, in a specific order:

| | |
|---|---|
| **pay** | through the payer, one purchase at a time |
| **deliver** | the vendor serves, or the purchase is a debt and not a spend |
| **advance** | only then, and only on delivery |

A failure between paying and delivering leaves the record **stale on purpose**.
Stale is recoverable by following the chain. Advanced past a payment that was
never delivered loses the proof needed to collect it. Of the two ways to be
wrong, only one is reversible.

## Bring your own store

`fileStore(path)` writes JSON through a temp file and a rename, because a
manifest truncated by a crash is a grant that cannot be located. It is a
`Store`, and so is anything with `load()` and `save()` — Postgres, S3,
`chrome.storage`, a test's memory. An agent wallet that needs a writable volume
is a wallet that cannot run where agents run.

```ts
const store = { async load() { … }, async save(m) { … } };
```

## What it deliberately does not do

**It does not tell you whether a payment is allowed.**
[`@warda_protocol/core`](https://www.npmjs.com/package/@warda_protocol/core)
owns the rules, so that a second copy of them cannot drift from the first. A
convenience here that re-derived "what may I spend right now" from the state
fields would be exactly that second copy.

The covenant is the real answer in any case, and it does not consult this
process.

## Paying a vendor that wants an ordinary transaction

Some x402 implementations accept only a plain payment — one key-controlled
input, no covenant field — so a covenant spend cannot *be* the payment. Pass
`relay: true` and the grant funds a single-use key that pays the vendor.

```ts
await agent.fetch(url, undefined, { relay: true });
```

The allowlist is still checked against the **vendor's** address, not the hop's.
What the hop costs is honesty about the last step: a vendor holding the relayed
coin cannot see that it could not have been larger. That guarantee needs the
grant, and it is not in the standard.

## A purchase that settled and never arrived

Re-present the proof. Do not buy it again.

```ts
await agent.fetch(url, undefined, { resume: proof });
```

Nothing is paid down that path — the payer is not reachable from it — and the
record is not advanced, because a resume spent nothing.

## Status

Exercised on **testnet-10 only**, and the covenant is unaudited. Nobody has ever
audited a Kaspa covenant; what evidence exists is published at
[wardaprotocol.com/proof](https://wardaprotocol.com/proof), including the six
vulnerabilities found in it so far and how each was found.

MIT.
