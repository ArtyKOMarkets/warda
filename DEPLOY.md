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

## The MCP endpoint → mcp.wardaprotocol.com

    cd mcp
    vercel --prod

`api/mcp.ts` is a stateless Streamable HTTP endpoint. `vercel.json` rewrites
both `/` and `/mcp` to it, so either URL works — the discovery documents
advertise `/mcp`.

Point the subdomain at that project in Vercel, then check it:

    curl -s https://mcp.wardaprotocol.com/mcp | jq .
    npx @modelcontextprotocol/inspector --cli \
      https://mcp.wardaprotocol.com/mcp --method tools/list

An agent framework then needs one line rather than an install:

    { "mcpServers": { "warda": { "url": "https://mcp.wardaprotocol.com/mcp" } } }

## The registry

`.github/workflows/publish-mcp.yml` publishes `mcp/server.json` to
registry.modelcontextprotocol.io on a tag, authenticated by GitHub OIDC — the
`io.github.ArtyKOMarkets/*` namespace is exactly the claim that OIDC proves, so
there is no secret to configure.

    git tag mcp-v0.4.1 && git push --tags

The workflow refuses to publish an entry for a version that is not on npm yet,
because a registry entry pointing at a missing package gives every client a 404
at install time.

Downstream directories take the official registry as source of truth: PulseMCP
ingests it weekly, Glama and mcp.so consume it, and awesome-mcp-servers wants a
Glama listing first. Smithery is the one that needs the hosted endpoint above.

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
