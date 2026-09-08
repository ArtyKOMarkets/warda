# @warda_protocol/cli

One short command for the whole life of a grant.

```bash
npx warda key --out wallet.key                  # fund the address it prints
echo kaspatest:qq7x…jaam3e > payees.txt         # everyone this agent may ever pay
WARDA_SK=$(cat wallet.key) npx warda grant --payees payees.txt --budget 10 --max-per-spend 1
npx warda pay https://warda-demo-api.vercel.app/fact
```

```
warda node                    is a node worth believing? (run this first)
warda key      [--out f.key]  a new keypair, and its address
warda grant    --payees <f>   create a grant. Limits in KAS.
warda balance                 what may this agent spend right now?
warda pay      <url>          buy something behind an HTTP 402
warda activity                every attempt, refusals included
warda find                    the grant moved. Where is it now?
warda mcp                     serve the grant over MCP (stdio)
```

## It adds no capability

Every verb spawns a tool that already existed under `sdk/tools` or
`agents/tools`, and every protocol rule is still computed in exactly one place —
`@warda_protocol/core`, the same code the covenant was verified against. A
second implementation of the rules would drift, and the failure is bad in both
directions: telling an agent it may spend when the chain will refuse wastes a
fee, and telling it that it may not when the chain would allow it silently
strands funds.

What it adds is the part a developer meets first. Three things changed, and each
was a real place people fell off:

**KAS, not sompi.** `--budget 1000000000` is a number nobody can check by eye,
and the failure mode of getting it wrong by a factor of ten is a grant that is
silently ten times too permissive.

**The grant is remembered.** `.warda/config.json` records which manifest, which
allowlist and which agent key belong together, so `warda pay` takes a URL and
nothing else. The tool underneath is shared by every agent in this repo, and a
forgotten `--grant` there spends a grant you did not mean to spend; this removes
the opportunity rather than documenting it. The file stays in the working
directory and not `$HOME` on purpose — a machine running two agents has two
grants, and a config in `$HOME` would make the second one quietly spend the
first one's budget.

**The key is read, not exported.** `warda pay` reads the agent key from the file
it lives in and hands it to one child process. Nothing is sent anywhere, nothing
is stored that you did not give a path to, and no key is left in shell history.

## This is not a wallet, and the difference is the product

A wallet holds a key and asks software to check the limits before it signs.
Change the software and the limits change with it.

A grant is an address whose *unlocking script* carries the limits — the budget,
the per-payment cap, the per-epoch rate, the timelock, and the set of addresses
that may be paid. They are checked by the network on every spend, by nodes that
have never heard of this CLI. `warda pay` to an address outside the allowlist
does not fail a check here: the allowlist is committed as a Merkle root at
creation, so there is no proof to carry and no valid transaction to build.

There is no account here, and no balance held on your behalf. There is nothing
for this program to be a custodian of.

## Requirements

Node 22.6 or newer (`--experimental-strip-types`), and a Kaspa testnet-10 node
you can reach — Warda builds and signs locally but must read the UTXO set to do
it. `warda node` checks yours is synced, utxo-indexed and on the network it
claims, because each of those failures returns a *plausible wrong answer* rather
than an error: a node without a utxo index reports your grant as empty, which is
indistinguishable from a grant that was drained.

Unaudited. Testnet only. The coins are free and worth nothing, which is the
correct amount to risk on a protocol nobody has reviewed.
