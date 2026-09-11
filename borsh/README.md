# @warda_protocol/borsh

Read the Kaspa UTXO set over **borsh** wRPC — the encoding the public
resolvers actually serve — so that accepting Warda payments needs no node.

Read-only, on purpose. Spending stays on JSON, and the reason is below.

```bash
npm install @warda_protocol/borsh kaspa-wasm32-sdk
```

```ts
import { BorshReader } from "@warda_protocol/borsh";
import { inspect, formatHealth } from "@warda_protocol/kaspa";

const reader = await BorshReader.open({ networkId: "testnet-10" });
console.log(formatHealth(await inspect(reader, { networkId: "testnet-10", tolerate: true })));

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

## Why it does not write

The obvious move is to route everything through the official WASM client and
delete the JSON transport. It does not work, and it fails *quietly*.

Borsh is **positional**. There are no field names on the wire, so a field the
encoder does not know about is not an unknown field — it is an absent one, and
absence shifts everything after it. The WASM SDK was built before covenants:
its `ITransactionOutput` is `{value, scriptPublicKey}`, and the string
`covenant` does not appear in the package anywhere.

Hand it a grant spend and it will serialize a transaction that is well-formed,
correctly signed, and carries **no covenant binding at all** — a payment that
means nothing, submitted successfully. So `submitTransaction` is not here. It
is not missing because it was hard; it is missing because the only honest
version of it on this transport silently discards the one guarantee this
protocol makes.

Calling it anyway throws `WriteNotSupported`, which says that.

## What that leaves, which is more than it sounds

A seller never submits anything.

| package | calls | needs a covenant field |
| --- | --- | --- |
| `@warda_protocol/vendor` | `getUtxosByAddresses` | no |
| `@warda_protocol/verify` | `+ getBlockDagInfo` | for grants, yes |
| the buyer (`warda pay`) | `+ submitTransaction` | yes |

The coin a vendor is paid with is an ordinary P2PK output to the vendor's own
address. Nothing about it is covenant-carrying, so a vendor checking "is the
coin I was promised actually in the UTXO set" can read it from any resolver.

Serving paid API calls, therefore, needs no node:

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

The **buyer** still needs JSON — their own node, or `WARDA_RPC_JSON`. That
asymmetry is the honest state of things, and stating it is better than a
transport that auto-detects its way into building an unbound spend.

## The covenant question, and why this refuses to answer it

`NodeClient.assertCovenantAware` resolves a real ambiguity: an absent
`covenantId` means either *no covenant here* or *this node is too old to say*,
and it tells them apart by asking an address where the field must be present.

On this transport there is a **third** cause — the WASM deserializer may never
have carried the field — and one observation cannot separate three causes. So
`assertCovenantAware` throws `CovenantUnanswerable` rather than guessing, and
`inspect` reports the covenant check as failed-unknown rather than reporting a
perfectly modern node as pre-covenant.

Whether the field survives the WASM client is a measurement, not an opinion.
`spike/covenant-probe.cjs` in the repo runs it against a live grant. If it
turns out the field *does* survive, reading grants over borsh becomes possible
too and this paragraph gets shorter.

## Health checks are not optional here

`BorshReader` implements `Inspectable`, so the same four checks run against it.
That matters **more** on a resolver-chosen stranger than on your own node:
three of the four ways a node can be wrong produce a plausible answer rather
than an error, and the plausible answer always reads as a problem with your
grant.

- not synced → your spend claims an epoch the chain has left
- no utxo index → your grant looks *gone*
- wrong network → every address derives perfectly and nothing is ever found
- pre-covenant → unknown on this transport, see above

## Install

`kaspa-wasm32-sdk` is a **peer** dependency, and optional. It carries a wasm
binary that no JSON user should have to download.

## License

MIT
