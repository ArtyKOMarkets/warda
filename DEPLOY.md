# Deploying

Two Vercel projects, deliberately separate: a bad MCP deploy must not be able
to take the front page down with it.

## The site → wardaprotocol.com

    cd site
    python3 build.py          # writes web/ from src/. Edit src/, never web/.
    vercel --cwd web --prod

`site/vercel.json` sits at the repo's `site/` root, so pass `--cwd web` and
Vercel will still read it — or link the project with `web` as the output
directory once and `vercel --prod` from `site/` afterwards.

What it serves beyond the two pages:

    /llms.txt                            structure for an agent that lands here
    /.well-known/mcp                     SEP-1960 manifest (via a rewrite)
    /.well-known/mcp/server-card.json    SEP-1649 server card

The rewrite exists because the two proposals disagree: one needs
`/.well-known/mcp` to be a directory, the other a file. A filesystem cannot be
both, so the manifest lives beside it as `mcp-manifest.json` and is served at
the bare path.

## Before anything: .vercelignore

The Vercel CLI uploads from DISK, not from git. `covenant/deploy/target` is a
Rust build directory of about 2.3 GB — gitignored, so pushes stay small, and
completely invisible to that protection. Uploading it fails as a repeating
`Upload aborted`, an error that names neither the size nor the file.

`.vercelignore` at the repo root and in each deploy directory excludes it,
along with `node_modules`, `dist`, and anything matching `.env*` or `*.key`.

The more reliable route is to not upload at all. Both projects are connected to
the GitHub repo, so setting the Root Directory and pushing makes Vercel clone
from GitHub — where `target/` does not exist, because it is gitignored — and
build there. `vercel --prod` is for when you want to deploy something you have
not pushed.

## The MCP endpoint → mcp.wardaprotocol.com

    # preferred: set Root Directory to mcp/deploy in the dashboard, then
    git push

    # or, to deploy the working tree:
    cd mcp/deploy && vercel --prod

**Deploy `mcp/deploy`, not `mcp`, and set the Root Directory to match.**

This Vercel version picks ONE root entrypoint per project and routes every
path to it — `/`, `/mcp` and `/favicon.ico` all arrive at the same function.
It announces its choice in the build log, and that line is the first thing to
read when a deploy misbehaves:

    ✓ Build complete — Using <file> as the root entrypoint.

Two deploys were lost to skimming past it. Pointed at `mcp/` it chose
`src/server.ts`, the STDIO server, which exports no HTTP handler. Pointed at
the repo root it chose `src/index.ts`, the core library, and every request
returned `Invalid export found in module` — a library has named exports and no
default.

So `mcp/deploy` contains exactly one candidate and that candidate is the
handler: `index.ts`, no `src/`, no `main`, no build script, no `api/`.
Whatever Vercel picks there, it can only pick this. Because a root entrypoint
serves every path, no rewrites are needed.

The same rule bites in the other direction, and a third deploy was lost to it.
`api/` is Vercel's name for a functions directory, not a name a package may
take: the verification service was added as a top-level `api/`, and the next
push made the site's git-integration build install that package and run its
`tsc` instead of leaving the static site alone. The build failed, and nothing
in the log said why a static site was compiling TypeScript.

So no directory in this repository is called `api/` except the one that
already is a functions directory. The service lives in `verify/`, which is
also what its package is called.

That rename fixed a real problem and not the one that had broken the build.
The root `.vercel/repo.json` links this repository to Vercel as a whole and
lists the directories that are projects — today exactly one, `warda_mcp` at
`mcp/deploy`. A `vercel` command run anywhere else in the repo does not fail:
it CREATES a project named after that directory. `api/` produced a project
called `api`, and the moment the directory became `verify/`, the next run
produced one called `verify`. Two projects nobody wanted, deploying a
repository that has no web app at its root.

So: run `vercel` only from a directory listed in `.vercel/repo.json`, and if a
project appears in `vercel projects ls` that nobody chose to make, that is
where it came from. `vercel project rm <name>` removes it.

And nothing that holds a connection open belongs on Vercel at all. The
verification service keeps a WebSocket to a kaspad between requests, which a
function cannot do; it needs somewhere a process can stay running.

The handler takes Node's `(IncomingMessage, ServerResponse)`, not a Web
`Request`. Vercel's Node runtime calls it that way, and a web-standard handler
is invoked with arguments it does not understand. The Edge runtime IS
web-standard and would accept one, but it has no filesystem, and reading the
covenant template needs one.

It depends on the PUBLISHED `@warda_protocol/mcp` rather than on the working
tree, so the endpoint serves a released version by construction. That costs
something real — it cannot run unreleased code, so publish first — and buys
something worth more: it exercises the package the way an installing user
does, which is the exact path that hid the covenant-template bug.

In Vercel's project settings, set **Root Directory** to `mcp/deploy`.

Check it:

    curl -si https://<the alias vercel prints>/mcp | head -5
    npx @modelcontextprotocol/inspector --cli https://<alias>/mcp --method tools/list

Nine tools. Then add the domain and re-check on `mcp.wardaprotocol.com`, since
that is the hostname the server card advertises.

An agent framework then needs one line rather than an install:

    { "mcpServers": { "warda": { "url": "https://mcp.wardaprotocol.com/mcp" } } }

## The demo vendor → warda-demo-api.vercel.app

    cd x402/demo-server && vercel --prod

Run it from THAT directory and no other. The repository root carries a
`.vercel/repo.json`, so a `vercel` command run anywhere not listed in it
creates a brand new project named after whatever directory you were standing
in. Two stray projects have been made this way already.

Its environment (Vercel project `warda-demo-api`, production):

    WARDA_DEMO_VENDOR      the demo vendor's address — /weather, /fact, /inference
    WARDA_AGENT_001_PAYEE  agent #001's address — /digest
    WARDA_RPC_JSON         a testnet-10 JSON wRPC url reachable FROM VERCEL,
                           so the tunnel hostname here, not 127.0.0.1
    WARDA_QUOTE_SECRET     optional; signs quotes so the function needs no state

`WARDA_AGENT_001_PAYEE` is not a new address to invent. It is the
pay-to-public-key address of the agent key named in
`x402/demo/kaspa-x402-grant.json`, and `x402/demo/agent-002-recipients.txt`
carries both the value and the command that re-derives it. Agent #002's grant
commits to that address for its whole life, so changing it here does not
redirect #002's money — it makes /digest quote an address #002 must refuse, and
the demo stops working with no error anywhere.

Without it set, /digest answers 503 and the other three endpoints carry on.

## Publishing to npm

In dependency order, because the ranges are exact about it:

    npm publish              # @warda_protocol/core  0.3.1
    npm publish -w sdk       # @warda_protocol/kaspa 0.4.0
    npm publish -w x402      # @warda_protocol/x402  0.3.2
    npm publish -w mcp       # @warda_protocol/mcp   0.4.1

The order is not a formality. `mcp` 0.4.1 imports `decodeGrant`,
`grantFromSignatureScript`, `redeemScriptFrom`, `pushChild`, `toWireMulti`,
`GrantWatcher`, `resolveNode` and `inspect` from `kaspa` by name, and none of
them exist before 0.4.0 — publishing `mcp` first gives anyone who installs it
during the gap a package that throws on import.

Check afterwards, in a scratch directory rather than in this repo, because this
repo is the one layout where a broken path still resolves:

    cd $(mktemp -d) && npm init -y && npm i @warda_protocol/mcp
    node -e "import('@warda_protocol/mcp/dist/build.js').then(m=>{m.loadTemplate();console.log('template ok')})"
    npx warda-mcp < /dev/null    # the bin entry exists and runs

## Order, the first time

1. **npm**, in the order above. Nothing downstream is valid until it is there,
   and `mcp` 0.3.0 cannot read its own covenant template once installed.
2. Deploy `mcp/`, point `mcp.wardaprotocol.com` at it, and confirm `tools/list`
   answers. The server card advertises that URL, so publishing the card before
   the endpoint answers advertises a dead address.
3. Deploy `site/`.
4. Tag `mcp-v0.4.1` and let the workflow publish to the registry.

## Keeping the attack page true

The page publishes a grant's key, its address, and a snapshot of what has
happened to it. The card and the snapshot are written by two different tools
for two different reasons.

    sdk/tools/demo-card.ts     the key, the address, the limits, the allowlist
    sdk/tools/demo-state.ts    what has reached the vendor, and when it was read

The card is written once, when the grant is funded. The snapshot is written
repeatedly:

    cd site
    WARDA_RESOLVER="https://…" ./refresh-demo.sh          # read, rebuild, deploy
    WARDA_RESOLVER="https://…" ./refresh-demo.sh --no-deploy

It is quiet when nothing moved on chain, so it is safe on a timer:

    */20 * * * * cd ~/Desktop/warda/site && WARDA_RESOLVER="https://…" ./refresh-demo.sh

### The snapshot names its grant, and two places check the name

A snapshot is a set of numbers with no visible owner. "3 payments · 0.3 KAS"
reads as true of whatever address is printed above it, so a reading left over
from an earlier grant would render as this one's, and nothing about the page
would look wrong.

So `demo-state.json` carries `grant` and `vendor`, and both `build.py` and the
page itself refuse a snapshot whose `grant` is missing or is not the address on
the card. A refused snapshot costs the page one section; it never contradicts
the card. When the section is missing, that is why — run `demo-state.ts` again.

### What refresh-demo.sh will not do

It does not rewrite the card. A successful spend MOVES the grant: its address
is a hash of its state, so paying the vendor gives it a new one. Finding where
it went means following it through the mempool (`sdk/tools/watch-grant.ts`),
not asking a node — a node can only say what is unspent at an address it is
given, and an empty address is indistinguishable from drained, revoked, and
never-funded.

Rather than guess, the snapshot reports `grantStillAtPublishedAddress: false`
and the page says the printed address is where the grant *was*. That is both
honest and the more interesting sentence: it means somebody used the key.
