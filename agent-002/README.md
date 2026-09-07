# Agent #002 — the agent that buys from agent #001

Agent #001 reads the Kaspa network every hour and publishes a digest. Agent
#002 buys that digest over HTTP 402, out of a Warda grant that can pay exactly
one address and could not pay it at all until a DAA score the covenant checks
on every spend.

Two agents. Two keys. Two independent grants. One settlement anyone can look
up.

## Both ends are ours, and the page says so

#001 and #002 were both built here, so this is not a market. Saying otherwise
would be the easiest lie on the site to tell and the easiest to catch. What is
demonstrated is narrower and actually checkable:

- a payment moved between two agents' addresses on a public chain;
- neither agent could have paid anyone else, because each grant's payee list
  was fixed when the grant was created and cannot be changed;
- #002 could not have paid at all before its start time, and nobody — including
  whoever issued the grant — could bring that forward.

The digest #002 pays for is published free at `wardaprotocol.com/agent-001.json`.
Paywalling it to make the demo look better would have swapped the one claim
here that a stranger can verify for one that merely sounds impressive.

## The identity link is derived, not asserted

"Agent #002 paid agent #001" is a claim about *identity*, and an ordinary
address makes it unfalsifiable — it is whoever we say it is.

So the address on #002's allowlist is not chosen. It is the pay-to-public-key
address of the agent key that #001's own published manifest names:

```sh
node --experimental-strip-types -e '
  import { pubkeyToAddress } from "./sdk/src/address.ts";
  import { fromHex } from "./sdk/src/bytes.ts";
  const key = JSON.parse(require("fs").readFileSync("x402/demo/kaspa-x402-grant.json")).agent;
  console.log(pubkeyToAddress(fromHex(key), "kaspatest"));'
```

That prints the only address #002 may pay. `tools/dashboard.ts` re-derives it on
every run and exits rather than publish the page if it ever stops matching.

## The timelock

#001's grant answers *how much* and *to whom*. #002's adds *when*, because the
question people actually ask about an agent's spending authority is not what
its limits are — it is who can change them, and how fast.

A Warda grant's terms cannot be changed once it exists. Not by the agent, not
by the operator, not by the principal, not by all of them together. The only
way to give an agent different authority is to issue a *different* grant, and
`--starts-in` puts a delay on that one:

    --starts-in 3000     # ~5 minutes at ten blocks per second

There is no timelock mechanism involved. The covenant already checks
`claimedDaa >= notBefore` on every spend, so the delay is enforced by consensus
rather than by a contract somebody could upgrade to skip it. And because a
grant's address is a hash of its terms, the pending authority is publishable the
moment it is created: anyone can read what it will permit, and check that it
cannot yet permit anything.

`purchases/` holds the proof of both halves — the run that was refused for being
early, and the run that went through.

## Running it

Mint the grant (once). `WARDA_SK` here is the **funder's** key, because genesis
spends the funder's coin:

```sh
source ../ops/node.env
node --experimental-strip-types ../sdk/tools/new-key.ts \
  --label agent-002 --out ../covenant/deploy/agent-002.key

WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key) \
node --experimental-strip-types ../sdk/tools/genesis.ts \
  --agent "$(cat ../covenant/deploy/agent-002.key.pub)" \
  --recipients ../x402/demo/agent-002-recipients.txt \
  --budget 200000000 --max-per-spend 10000000 --epoch-limit 50000000 \
  --starts-in 3000 \
  --out ../x402/demo/agent-002-grant.json \
  --submit
```

Buy. `WARDA_SK` is now the **agent's** key — the one the grant names:

```sh
WARDA_SK=$(cat ../covenant/deploy/agent-002.key) \
node --experimental-strip-types tools/buy.ts \
  https://warda-demo-api.vercel.app/digest
```

Run it once immediately and it writes a refusal to `purchases/` and exits 3.
That is worth doing on purpose — pass `--expect-refusal` to make the exit code
zero — because a timelock nobody tried to beat is just a number in a file.

Publish:

```sh
node --experimental-strip-types tools/dashboard.ts > ../site/src/agent-002.json
```

## What this does not prove

That the service is honest, that the digest is correct, or that anything is
refundable. Warda bounds what a vendor can take; it does not make them deliver.
Agent #001's other grant paid a third-party vendor 1.47 KAS for a service that
never arrived, and that is on #001's page for the same reason this sentence is
here.
