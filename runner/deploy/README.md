# The hosted runner

One Vercel function, bundled from `runner/` by `build.mjs`. The runner and the
agent wallet it drives are unpublished, so unlike the other deploy directories
this one is built from the working tree at deploy time and the bundle is never
committed.

It reads the chain through the **public resolvers** (borsh), not a node, so it
runs with nobody's laptop on.

## First time

    cd runner/deploy
    npx vercel link                 # create a project, e.g. warda-runner
    ./env.sh                        # copies runner/.env + the Turnkey key into it, printing nothing
    ./deploy.sh                     # bundle and ship
    QSTASH_TOKEN=… ./schedule.sh https://<the URL deploy.sh printed>

Then point the console at it: on **New agent**, step 1, set Runner to that URL.

## After a change

    runner/deploy/deploy.sh

## What runs where

| | |
|---|---|
| API, MCP, webhooks | this function, on request |
| deposits → grants, scheduled jobs | `POST /v1/tick`, every minute, from QStash |
| agent keys, deposit keys | Turnkey — never in this function's memory as secrets |
| state | Neon (`DATABASE_URL`) |
