# Agent #003 — the successor

Agent #002 could pay one address, and could not pay it before a start time the
network enforced. Both were fixed when its grant was created and neither could
be edited afterwards — which is the property, and also the problem. An agent
whose authority cannot be changed cannot be *updated* either.

So it was not updated. It was **replaced**.

## The ceremony

Three transactions, in this order, and the order is the whole point.

1. **`57e41ddf…`** — #003's grant is created, timelocked five minutes. Its terms
   are on chain and readable immediately; it cannot spend a sompi.
2. **`858e7c54…`** — #002's grant is revoked, *while #003 is still shut*. The
   coin leaves the covenant and returns to the principal.
3. #003's lock expires and it starts buying.

Between 2 and 3 there is a window in which **neither grant can spend anything**.
That gap is real and `agent-003/handover-gap.json` is a dashboard reading taken
inside it. A handover between two authorities that never share a key is not
atomic, and the page says so rather than implying otherwise.

## What is checkable

- #002's agent key and #003's are different keys. Neither agent ever held the
  other's, and no transaction here is signed by both.
- #002's grant was ended by the **revocation** key, which is not its agent key.
  A grant does not get a say in its own ending.
- #003's terms were published before it could act on them. Anyone reading the
  chain during the lock could see exactly what it would be allowed to do, and
  verify that it could not yet do it.

## Two payees, on purpose

#002 had one. That makes a clean demonstration and a poor parent: a sub-agent's
allowlist must be a subset of its parent's, and the only subsets of a
one-element set are that element and nothing. #003 holds two — agent #001 and
the Warda demo vendor, both real endpoints it buys from — so that
[agent #004](../agent-004) could be delegated from it with the list narrowed.

## Running it

```sh
source ../ops/node.env
WARDA_SK=$(cat ../covenant/deploy/agent-003.key) \
node --experimental-strip-types ../agents/tools/buy.ts \
  https://warda-demo-api.vercel.app/digest \
  --id WARDA-003 \
  --grant ../x402/demo/agent-003-grant.json \
  --recipients ../x402/demo/agent-003-recipients.txt \
  --out purchases
```

The tools live in `agents/tools/` and are shared by every agent here. Nothing
about them defaults: an omitted flag would spend a grant you did not mean to.
