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

**Deploy `mcp/deploy`, not `mcp`.** The first attempt deployed the package
directory and Vercel chose `src/server.ts` as the entrypoint — the STDIO
server, which exports no HTTP handler, so every request died as
`FUNCTION_INVOCATION_FAILED`. It was not wrong to guess: a directory holding
both a library and a function is ambiguous. `mcp/deploy` holds nothing but the
function — no `src/`, no `main`, nothing else that could be mistaken for an
entrypoint.

It depends on the PUBLISHED `@warda_protocol/mcp` rather than on the working
tree, so the hosted endpoint serves a released version by construction. That
costs something real — it cannot run unreleased code, so publish first — and
buys something worth more: it exercises the package the way an installing user
does, which is the exact path that hid the covenant-template bug.

The handler takes Node's `(IncomingMessage, ServerResponse)`, not a Web
`Request`. Vercel's Node runtime calls it that way, and a web-standard handler
is invoked with arguments it does not understand — the failure is
`FUNCTION_INVOCATION_FAILED` with nothing in the logs about signatures. The
Edge runtime IS web-standard and would accept one, but it has no filesystem,
and reading the covenant template needs one.

In Vercel's project settings, set **Root Directory** to `mcp/deploy`.

`vercel.json` rewrites both `/` and `/mcp` to the function, so either URL
works; the discovery documents advertise `/mcp`.

Check it:

    curl -si https://<the alias vercel prints>/mcp | head -5
    npx @modelcontextprotocol/inspector --cli https://<alias>/mcp --method tools/list

Nine tools. Then add the domain and re-check on `mcp.wardaprotocol.com`, since
that is the hostname the server card advertises.

An agent framework then needs one line rather than an install:

    { "mcpServers": { "warda": { "url": "https://mcp.wardaprotocol.com/mcp" } } }

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
