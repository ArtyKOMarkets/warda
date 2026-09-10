# @warda_protocol/vendor

Sell an API for Kaspa, over HTTP 402.

```ts
import { priced } from "@warda_protocol/vendor";

export default priced(
  {
    payTo: process.env.PAY_TO!,      // the address that must be paid
    sompi: 4_000_000n,               // 0.04 KAS, exactly
    network: "mainnet",
    secret: process.env.QUOTE_SECRET!,
  },
  async () => ({ answer: 42 }),
);
```

No payment header, and it quotes a price. With one, it looks in the UTXO set for
a coin **at your address, from the transaction the buyer named, for exactly the
amount you quoted** — and only then calls your function.

It never reads the payment header as truth. The header is written by the party
who benefits from lying, and a fabricated transaction id is as easy to write as
a real one.

## It does not know what a covenant is

A [Warda](https://wardaprotocol.com) grant is one kind of buyer. An ordinary
wallet is another. This cannot tell them apart and does not try: whether a
payment was *allowed* is a question answered on the buyer's side before the
transaction existed. A seller only needs to know whether it arrived.

## Replays are your decision, and you have to make it

A coin at your address stays there. So the same proof verifies every time, and
a buyer who paid once can call forever. There is no stateless fix — spending
the coin onward costs a transaction and a fee; binding payment to the request
body needs both ends to implement it. What a seller needs is a set of
transaction ids already served:

```ts
priced({ ..., spent: { has: (id) => redis.sismember("paid", id),
                       add: (id) => redis.sadd("paid", id) } }, deliver)
```

The default, `inMemorySpent()`, holds for one process and says so on startup.
Under any serverless host that is most requests. `replayAllowed()` exists so
that choosing to allow them is visible in your source rather than looking like
an oversight.

## The status codes are the API

A buyer holding a broadcast payment reads them to decide whether to wait, stop,
or re-present the same proof. That difference is one payment or two.

| | |
|---|---|
| `402` no header | here is the price |
| `402` + `retry` | **re-present the same proof.** Not yet visible on chain |
| `400` | the proof is wrong, or the amount is. Paying again will not help |
| `409` | this payment already bought one thing |
| `503` | the seller cannot see the chain. Same proof again, do not re-pay |
| `502` | paid, and the goods failed. The txid is in the body |
| `200` | served, with a receipt naming what was checked and which node said so |

## Which node answered

Your security here is "the money is visibly in the UTXO set", which makes the
node answering that part of your security. `rpc` is tried first, always. A
`resolver` is consulted only if that fails, and when it does the response says
so in `readFrom` — a node you do not control is then telling you that you were
paid. That risk is yours, not the buyer's, which is why the fallback exists at
all and why it is reported rather than hidden.

MIT.
