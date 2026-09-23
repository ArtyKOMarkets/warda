# The auditor, sold

```bash
PAY_TO=kaspatest:… QUOTE_SECRET=… node server.mjs

curl --data-binary @covenant.sil localhost:8787/v1/scan      # free
curl --data-binary @covenant.sil localhost:8787/v1/report    # 402
```

## What is free and what is paid, and why that line is there

The line is not a pricing decision. It is where a machine stops being able to
tell the truth about a covenant it has never seen.

**Free — `/v1/scan`.** The analysis: the ABI, the state layout, the size
against the consensus ceiling, which constructor arguments move that size, and
every condition the covenant refuses on, taken from the AST and grouped by the
entrypoint that enforces it. None of this needs a builder, so it runs on
anybody's `.sil`.

**Paid — `/v1/report`.** The same analysis, dated and rendered as a
self-contained document you can send to somebody. That is what an audit is
actually bought for, and today it is the only thing here worth charging for.

**Not sold at all: the claims suite and the oracle.** Both need a builder for
the covenant's entrypoints — a function that constructs a transaction the
engine will accept — and that is code a person writes, because the shape of a
covenant's transaction is its design rather than a parameter of it. See
`../harness/PORTING.md`. Charging per upload for those would be selling
something this service cannot deliver.

If you want them for your covenant, the builder is the work, and it is a
conversation rather than an endpoint.

## What it does with your covenant

Writes it to a temporary file, runs the Silverscript compiler on it in a
subprocess with a 60-second limit, and deletes the file whether or not that
succeeds. It is never executed — a covenant is a script for the Kaspa engine,
not for this machine. Bodies over 256 KB are refused.

## Payment

`@warda_protocol/vendor`'s `priced()`. No payment header and it quotes a
price. With one it looks in the UTXO set for a coin at `PAY_TO`, from the
transaction the buyer named, for exactly the quoted amount — and only then
runs anything. It never reads the payment header as truth.

**Replays are your decision and this file does not make it for you.** A coin at
your address stays there, so the same proof verifies forever. `inMemorySpent`
and `replayAllowed` from the same package are how you close that; wire them
before this is in front of anybody.
