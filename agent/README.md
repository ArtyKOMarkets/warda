# Agent #001 — daily Kaspa network digest

An agent that reads the Kaspa network every hour, publishes a digest of what
changed, and pays for the one thing it cannot do itself out of a Warda grant
whose limits the network enforces.

This directory is the half that needs no money: the reading, the arithmetic and
the digest. It runs today, against any Kaspa node, and every number it publishes
can be re-derived by anyone with a node of their own.

## The idea

Most "autonomous agent" demonstrations are autonomous in the way a screensaver
is autonomous. This one is meant to survive the obvious question — *how do you
know it did what it says?* — so it is built around one rule:

> Every number published is the difference between two counters the network
> maintains for its own reasons, and both readings are published beside the
> digest.

Nothing is sampled. Nothing is extrapolated. The single estimate in the output
is the node's own hashrate estimate, and it is labelled as an estimate every
time it appears.

## Running it

Take a reading:

```sh
node --experimental-strip-types tools/read.ts --rpc ws://127.0.0.1:18210
node --experimental-strip-types tools/read.ts --resolver "$WARDA_RESOLVER"
```

Readings land in `readings/` as JSON, one file per reading, named so they sort
chronologically. Each run is independent: it reads no previous file and writes
no state, so a missed run costs one data point and leaves nothing to repair.

Then, once there are two:

```sh
node --experimental-strip-types tools/digest.ts                    # last 24 h
node --experimental-strip-types tools/digest.ts --window 7d --markdown
node --experimental-strip-types tools/digest.ts a.json b.json --out digest.md
```

`digest.ts` touches no network at all.

Hourly, unattended:

```
7 * * * * cd ~/warda/agent && node --experimental-strip-types tools/read.ts --resolver "…"
```

## What it reports

```
Kaspa testnet-10 · 24 h to 2026-09-02 06:00 UTC

  blue score  +863,798        9.99 blue blocks/s
  DAA score   +864,097        now 41,867,209
  minted      +4,316,069 KAS  4,814,339,213 KAS in existence
  hashrate    1.24 PH/s       node estimate over its last 1,000 blocks
  mempool     12 tx           held, unaccepted, at the closing reading
  DAG         4 tips          1,207,881 blocks held by this node

measured between two readings of one node (kaspad 1.0.1)
```

Some of those are differences and some are states, and the layout says which:
a `+` is a change over the window, everything else is where things stood at the
closing reading.

## The things it refuses to do

**Report a window it did not measure.** The heading is computed from the two
timestamps in the two files, never from the `--window` argument. Ask for 24 h
when the closest pair is 23 h 12 m apart and the digest says 23 h 12 m.

**Print a negative delta.** Three of the six counters can go backwards — a node
prunes, resyncs, or gets swapped for a different one. That is a fact about the
node, not about Kaspa, and rendering it as a change would read as the network
shrinking. The affected line is dropped and the reason goes in the caveats.

**Turn a missing answer into a zero.** Three of the readings come from RPC
methods this repository had not called before. If a node does not implement one,
or spells a field differently, the line is absent and a footnote says which
method did not answer and what the node replied with instead. A digest with four
lines and a footnote is true. A digest with five lines where the fifth is a zero
is not.

**Publish from a node that is behind.** `read.ts` refuses an unsynced node
outright, because the difference between two stale readings is the node's
catch-up rate wearing the network's clothes. `--allow-unsynced` overrides it,
and the reading records that it did.

**Publish the node's address.** Provenance belongs in the reading file, which
names the node. A digest is a public artefact; the node behind it is
infrastructure.

## What is not here yet

The paid half. The agent is supposed to buy one inference call per digest from a
Warda grant, so that its spending is bounded by the covenant rather than by the
process holding the key, and so the accumulating record — *31 calls, 3.1 KAS
spent of 50, 0 KAS anywhere else, since 3 September* — is the artefact that
makes the point.

Two things block it and neither is code:

1. **A node that outlives a terminal.** Everything here, the demo API and the
   CLI quickstart all currently point at a Cloudflare quick tunnel.
2. **Somewhere real to buy inference from.** Nobody sells inference for KAS, so
   the endpoint would be ours — and "our agent pays our endpoint from a grant we
   funded" is a closed loop wearing a costume. It becomes real when the endpoint
   does real inference against a real model at a real cost, priced in KAS. Then
   the only thing supplied is the vendor.

When the prose summary does arrive, it goes in its own block, below the numbers
and labelled as model output. The numbers stay verifiable without it.

## Tests

```sh
node --experimental-strip-types --test test/*.test.ts
npx tsc -p tsconfig.json
```

Everything above the network boundary is a pure function over two readings, so
the interesting cases — a reset counter, a missing method, a window that is not
the one asked for, a node that says it is not synced — are all tested without a
node and without waiting a day.
