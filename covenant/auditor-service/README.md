# The auditor, sold

```bash
cargo build --release --bin scan --manifest-path ../harness/Cargo.toml
PAY_TO=kaspatest:… QUOTE_SECRET=$(openssl rand -hex 32) node server.mjs

curl --data-binary @covenant.sil localhost:8787/v1/scan      # free
curl --data-binary @covenant.sil localhost:8787/v1/report    # 402
curl localhost:8787/                                         # free: the terms
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

### Replays

A coin at your address is a fact that stays true, so without a record of what
has been served the same `X-PAYMENT` header buys reports forever. `priced()`
falls back to a per-process set that forgets on restart, and this service
restarts — a new `scan` binary, a reboot, a tunnel reconnecting — so the set is
written to a file instead. See `spent.mjs`; `SPENT_FILE` moves it, and the
startup line says how many payments it loaded, because a store that silently
loaded nothing looks exactly like one that had nothing to load.

That file is right for **one process**, which is the only shape this service
can take: it shells out to a Rust binary, so it cannot be serverless. If it
ever runs in two places, `postgresSpent` in `growth/deploy/lib/spent.ts` is the
same interface against Neon and it is a one-line swap here.

`npm test` covers the property that matters — a payment recorded by one
instance is refused by the next one — and CI runs it.

### When a delivery fails after the payment settled

`settle` records the txid as spent **before** it calls deliver. That is the
right way round — recorded after, a crash leaves a payment that can be replayed
forever — but it means a delivery that throws leaves a buyer who paid, got a
502, and cannot present the same proof again: it is in `spent.log`, and the
next attempt is refused as a replay.

This is recoverable only by the operator, and only deliberately:

```bash
# the buyer's txid is in the 502 body, as `settledBy`
grep -v '^<txid>$' spent.log > spent.log.new && mv spent.log.new spent.log
# restart — the store is read once, at startup
```

Do that **only** when the 502 body shows the delivery failed, never because a
buyer says it did. The coin is still in the UTXO set and always will be, so a
proof presented twice proves nothing about whether the goods arrived; the
seller's own log of the failure is the evidence, not the buyer's word.

It has happened once, on 24 September 2026, on the first paid request this
service ever took. See `deliver.mjs`.

## Hosting

The `scan` binary rules out Vercel, which is where the other Warda services
live: this needs a machine with a Rust toolchain on it, published somehow.

`ops/README.md` has both routes already, and the choice is not free.

**Tailscale Funnel** is what the node uses and needs no DNS at all. Funnel
allows three public ports — 443, 8443, 10000 — and the node has 443, so this
takes 8443. `--bg` stores the configuration rather than holding a terminal, so
it comes back with tailscaled after a reboot:

    /Applications/Tailscale.app/Contents/MacOS/Tailscale funnel --bg --https=8443 localhost:8787

It prints the public URL. The endpoint is that plus `/v1/report`, and the port
is part of it: `https://<machine>.tailXXXX.ts.net:8443/v1/report`.

Do NOT use `--set-path` to put it under a path on 443 instead. The registry
finds a listing by resolving `/.well-known/warda-service.json` against the
endpoint, which lands at the host ROOT — and on 443 the host root is the node.
A separate port keeps the origin this service's own, which is the whole basis
of the check.

**A named Cloudflare tunnel** gives `auditor.wardaprotocol.com`, and needs the
zone in a Cloudflare account. As of this writing `wardaprotocol.com` answers
from `ns35/ns36.domaincontrol.com` — GoDaddy — so `cloudflared tunnel route
dns` has nothing to write to and moving the nameservers is a production DNS
change, not a step in this file. `ops/README.md` §"The other path" is the
install; the binary lands at `~/.local/bin/cloudflared`, which is not on PATH,
so every command names it in full.

### Running it

`ops/run-auditor.sh` and `ops/com.wardaprotocol.auditor.plist`, beside the
node's. The script refuses to start on any of the three things that otherwise
fail after a buyer has been charged: no `PAY_TO`, no `QUOTE_SECRET`, no release
build of `scan`. It also puts `SPENT_FILE` at an absolute path outside the repo
— a relative one would land wherever launchd happened to start the process,
which is not the same place twice, and that file is the only thing between one
payment and unlimited reports.

```bash
cargo build --release --bin scan --manifest-path ../harness/Cargo.toml
cp ../../ops/auditor.env.example ../../ops/auditor.env
```

Fill in `QUOTE_SECRET` with `openssl rand -hex 32`. It must be the same across
restarts: a secret generated per process makes every quote issued before a
restart unverifiable after it, so a buyer who paid against an old quote is
refused having paid. `ops/auditor.env` is gitignored.

```bash
cp ../../ops/com.wardaprotocol.auditor.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.wardaprotocol.auditor.plist
```

**A laptop is not a host, and this repo has already paid for learning that.**
A restart took the demo vendor's tunnel down, the dead hostname stayed in its
environment, and agent #002's first purchase settled 0.04 KAS on chain and got
an HTML error page back. A registry entry is a public claim that an endpoint is
payable; pointing one at a machine that sleeps repeats that failure with
strangers' money instead of our own.

## Listing it in the registry

The registry indexes; it does not vouch. What it checks is that a manifest
naming this endpoint was fetched from this endpoint's own host and is signed by
the key the service is paid at — so the listing has to be served from here, and
this server serves it at `/.well-known/warda-service.json` from `MANIFEST_FILE`.

`listing.json` is that manifest without its signature. Two fields in it are
placeholders until the service has a home:

- `endpoint` — set it to the real hostname. The signature covers it, so a
  listing signed for one host is invalid on another; that is the binding, not a
  formality.
- `payee` — the x-only public key of the address in `PAY_TO`.

```bash
npx warda key --out auditor.key          # the payee. It is a secret; it stays out of git.
# set "payee" in listing.json to the contents of auditor.key.pub, "endpoint" to the real host
node --experimental-strip-types ../../registry/tools/sign-listing.ts listing.json \
  --key auditor.key > public/.well-known/warda-service.json
```

Then add the entry to `site/src/services.json` — both the `services` array and
`sources`, which is how the hosted registry re-fetches and re-checks it — and
run `node ops/build-registry-sources.mjs`. The entry is `listing.json`'s fields
plus the three the site adds: `id`, `operator: "warda"` and an `operatorNote`,
because the registry's rule is that an entry says whether it is ours.

Do not list it before it answers on its hostname. An entry is a claim that an
endpoint exists and is payable, and `/network` renders it either way.
