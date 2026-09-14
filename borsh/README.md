# @warda_protocol/borsh

Kaspa over **borsh** wRPC — the encoding the public resolvers actually serve —
so that neither side of a Warda payment needs a node.

```bash
# a seller, who only reads
npm install @warda_protocol/borsh kaspa-wasm32-sdk

# a buyer, who also spends
npm install @warda_protocol/borsh @kluster/kaspa-wasm
```

```ts
import { BorshReader } from "@warda_protocol/borsh";
import { inspect, formatHealth } from "@warda_protocol/kaspa";

const reader = await BorshReader.open({ networkId: "testnet-10" });
console.log(formatHealth(await inspect(reader, { networkId: "testnet-10", tolerate: true })));
console.log(reader.canSubmit ? "can spend" : "read-only build");

const coins = await reader.getUtxosByAddresses([myVendorAddress]);
await reader.close();
```

## Why this exists

kaspad's wRPC speaks two encodings. **Borsh is the default**, and the only one
the sixteen resolvers in rusty-kaspa's `Resolvers.toml` serve. **JSON** exists
only when an operator passes `--rpclisten-json=`, which almost nobody does.

Measured, not assumed:

```
GET  {resolver}/v2/kaspa/testnet-10/wrpc/json     404
GET  {resolver}/v2/kaspa/testnet-10/wrpc/borsh    200
```

Which meant, until this package, that every Warda tool needed a node run by the
person running the tool. "Run a DAG node" is a real thing to ask of someone who
just wants to sell an API call for a fifth of a cent.

## Versions 0.1 and 0.2 refused to write. Here is what changed

Not the argument — the premise.

Borsh is **positional**. There are no field names on the wire, so a struct the
encoder does not know about is not an unknown field; it is an *absent* one, and
absence shifts everything after it. `kaspa-wasm32-sdk@0.15.2` was built before
covenants — its `ITransactionOutput` is `{value, scriptPublicKey}` and the
string `covenant` occurs zero times in the package. Hand it a grant spend and
it serializes a transaction that is well-formed, correctly signed, and bound to
**nothing**: accepted by the encoder, meaningless on chain. Refusing to submit
was the only honest option available.

But rusty-kaspa's own wasm bindings have carried covenants since Toccata —
`CovenantBinding` has a constructor, `TransactionOutput` takes one, `UtxoEntry`
exposes `covenantId` — and builds from those revisions are published.
[`@kluster/kaspa-wasm`](https://www.npmjs.com/package/@kluster/kaspa-wasm) is
one.

So the buyer's node requirement was never a protocol limit. It was a
**packaging** limit.

## Why using a third party's binary is not a trade-down

It would be a poor bargain to remove "run your own node" by adding "trust a
stranger's wasm with your transactions". This package does not ask you to.

**The covenant binding is part of the sighash.** That is exactly why a
covenant-blind wallet cannot sign a Warda spend — and it means any difference
between what was signed and what the encoder produced shows up in the
transaction id. So every submit computes the id twice, once through this SDK
and once through the WASM encoder, and refuses to broadcast unless they match
byte for byte:

```
SerialisationDisagreement: the WASM encoder produced a different transaction
than the one that was signed.

  signed   b488881787b3727b5a627c849d33f5c5d074694b380e2a654f375dc592b97200
  encoded  4f1e1c0a…

Nothing was broadcast.
```

A tampered build, a stale one, one from a revision where a field moved — all
caught before the network sees anything, every time. The dependency can break
this path. It cannot redirect money through it.

Check your own build before you fund anything:

```
node --experimental-strip-types tools/agree.ts /tmp/spend.json /tmp/genesis.json /tmp/delegate.json

build      @kluster/kaspa-wasm
covenants  yes

spend.json      2 outputs, 1 carrying a covenant     agree
genesis.json    2 outputs, 1 carrying a covenant     agree
delegate.json   2 outputs, 2 carrying a covenant     agree

All 3 agree byte for byte.
```

Support is detected by **constructing** a `CovenantBinding`, never by reading a
version or a package name — so the day upstream ships a covenant-carrying
`kaspa-wasm32-sdk`, this starts accepting it with no change here.

## Who needs which build

| package | calls | needs a covenant-carrying build |
| --- | --- | --- |
| `@warda_protocol/vendor` | `getUtxosByAddresses` | no |
| `@warda_protocol/verify` | `+ getBlockDagInfo` | to read grants, yes |
| the buyer (`warda pay --borsh`) | `+ submitTransaction` | yes |

The coin a vendor is paid with is an ordinary P2PK output to the vendor's own
address. Nothing about it is covenant-carrying, so "is the coin I was promised
actually in the UTXO set" can be read from any resolver with any build.

Serving paid API calls, therefore, needs no node and no covenant build:

```ts
import { priced } from "@warda_protocol/vendor";
import { BorshReader } from "@warda_protocol/borsh";

const paid = priced({
  price: "0.02",
  payTo: myVendorAddress,
  secret: process.env.WARDA_VENDOR_SECRET!,
  openNode: async () => {
    const client = await BorshReader.open({ networkId: "testnet-10" });
    return { client, readFrom: client.url };
  },
});
```

## The covenant question

`assertCovenantAware` resolves a real ambiguity: an absent `covenantId` means
either *no covenant here* or *this node is too old to say*, and it tells them
apart by asking an address where the field must be present.

With a covenant-blind build there is a **third** cause — the deserializer never
carried the field — and one observation cannot separate three causes, so it
throws `CovenantUnanswerable` rather than guessing. Reporting a perfectly
modern node as pre-covenant would send an operator to replace a node that is
fine.

With a covenant-carrying build the third cause is gone and the check runs for
real, naming the node rather than the ambiguity.

## Health checks are not optional here

`BorshReader` implements `Inspectable`, so the same four checks run against it.
That matters **more** on a resolver-chosen stranger than on your own node:
three of the four ways a node can be wrong produce a plausible answer rather
than an error, and the plausible answer always reads as a problem with your
grant.

- not synced → your spend claims an epoch the chain has left
- no utxo index → your grant looks *gone*
- wrong network → every address derives perfectly and nothing is ever found
- pre-covenant → caught, with a covenant-carrying build

## Install

Both WASM packages are **optional peer** dependencies. Each carries a
multi-megabyte binary, and nobody needs two — install
`@kluster/kaspa-wasm` to spend, `kaspa-wasm32-sdk` if you only read and already
have it.

## Filing this upstream

The right home for a covenant-carrying build is `kaspa-wasm32-sdk` itself, so
that this does not rest on a third party. Until then, the feature detection
above means adopting it will be an install and nothing else.

## License

MIT
