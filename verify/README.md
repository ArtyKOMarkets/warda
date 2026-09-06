# @warda_protocol/verify

An HTTP endpoint that answers a counterparty's questions about a Warda grant by
reading a Kaspa node.

```bash
node --experimental-strip-types tools/serve.ts --port 8477
npm test                                        # 38 tests, no node required
```

## It decides nothing

The covenant decides, on chain, and it is the only thing that can. Everything
here re-derives what the covenant would check, so that a caller learns **which
rule binds** instead of paying a fee to find out. Every response carries an
`enforcement` field saying so, and a test asserts it is there.

It holds no key, signs nothing and broadcasts nothing. There is nothing here to
compromise beyond the node it reads.

## The three questions, which are not one question

| | |
|---|---|
| `POST /v1/verify` | Somebody handed you terms. Does the chain agree with them? |
| `GET /v1/grant/{address}` | You have an address and nothing else. Strictly less can be answered. |
| `POST /v1/authority` | Would this payment go through, and if not, why not? |
| `POST /v1/locate` | The manifest is stale. Where did the grant move to? |
| `GET /health` | Which node is answering, and can it be believed? |

### An address does not carry its terms

`GET /v1/grant/{address}` reports the coin, its size, and whether it is
covenant-bound — and then says plainly that budget, per-payment cap, epoch
limit and payee list are **not knowable from an address**. The address is the
hash of a script; the script is published only when the grant is spent; finding
that spend from an address alone needs an index kaspad does not keep.

An endpoint that guessed the rest would be the most dangerous thing in this
repository: a confident answer about a limit nobody enforces. So it returns
`termsKnowable: false` and says what to do instead.

### Authority needs the payee list, not the root

`POST /v1/authority` refuses to answer from `recipients_root` alone. A Merkle
root can confirm a list but cannot produce a membership proof from one, so *is
this vendor allowed* is unanswerable without the members. Send them; they are
checked against the committed root before anything else, and a list that does
not hash to it is refused rather than used.

The refusal sentence comes from `explainRefusal` in `@warda_protocol/x402` —
the same function the payer calls before it builds anything. This service does
not carry its own copy of the ordering. A second implementation of the rules
would fail in the direction that matters: by wrongly permitting.

## What it refuses to do

**Answer from a node it has not checked.** Three of the four ways a node can be
wrong produce a plausible answer rather than an error, and all three read as a
problem with the grant: a node without `--utxoindex` reports every grant as
missing, a node on the wrong network derives every address perfectly and finds
nothing, and a node behind on sync computes an epoch the chain has left. The
service returns `503` naming the failed check rather than `200` with a
confident wrong answer in it.

**Take a covenant template from the caller.** The template decides how an
address derives, so letting the party being verified choose it would make the
verification meaningless. It is loaded from the SDK; `WARDA_TEMPLATE` is an
operator's override, never a request field.

**Emit an amount as a JSON number.** kaspad returns u64 fields that a double
cannot hold — one of them was rounded inside `JSON.parse` in this repository
before any code saw it. Every amount goes out as `{ sompi, kas }`, both
strings, and a JSON number arriving in a request is accepted only when it is
exactly representable.

**Silently default a field that moves the address.** Guessing
`delegation_depth` or `reserve_root` produces a perfectly valid address with
nothing at it, and "nothing there" is the same answer a spent grant gives.
Where a default is unavoidable it comes back in `assumptions`, with the reason.

## Example

```bash
curl -s localhost:8477/v1/authority -H 'content-type: application/json' -d '{
  "manifest": { ... the deploy manifest ... },
  "recipients": ["kaspatest:qz..."],
  "payment": { "amountSompi": "200000001", "payTo": "kaspatest:qz..." }
}'
```

```json
{
  "ok": true,
  "result": {
    "wouldBeRefused": true,
    "refusal": "this invoice is 200000001 sompi and the grant's per-payment cap is 200000000. The cap exists to bound what a single decision can do, so it binds here regardless of how much budget remains.",
    "maxNextSpend": { "sompi": "200000000", "kas": "2" },
    "boundBy": "maxPerSpend"
  },
  "readFrom": { "url": "...", "network": "kaspa-testnet-10", "synced": true, "virtualDaaScore": "..." },
  "assumptions": [],
  "enforcement": "Advisory. This service reads a node and re-derives what the covenant would check; it enforces nothing..."
}
```

## Configuration

| | |
|---|---|
| `--rpc <url>` | a node to read. Without it, the resolver picks one. |
| `--network <id>` | the network the operator intends to serve. Checked, not assumed. |
| `--port`, `--host` | default `8477` and `127.0.0.1`. |
| `WARDA_TEMPLATE` | override the covenant template path. |

It binds to localhost by default. Nothing here authenticates, and nothing here
rate-limits: put it behind whatever terminates TLS for you, and remember that
every answer it gives is derived from public chain state, so there is nothing
in it to keep secret — only capacity to protect.

## Licence

MIT.
