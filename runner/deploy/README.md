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

## The runner's keys and addresses

**Turnkey: a restricted key, not root.** `node --experimental-strip-types runner/tools/turnkey-lockdown.ts`
creates a non-root Turnkey user `warda-runner` with its own API key and one ALLOW policy:
`ACTIVITY_TYPE_CREATE_WALLET` and `ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2`, nothing else (Turnkey does not apply
policies to root users, which is why the root key must not be the runner's). It proves both directions with
the new key, writes it to `~/.warda/turnkey-runner.json`, and points `TURNKEY_KEY_FILE` at it. Then
`./env.sh && ./deploy.sh`.

**Fee address: the runner's own.** `node --experimental-strip-types runner/tools/new-fee-payee.ts` makes a key
at `~/.warda/runner-fee-testnet-10.key` (the runner only ever gets the address), sets `RUNNER_FEE_PAYEE`, and
moves the old address to `RUNNER_FEE_PAYEES_PREVIOUS` — grants made before the change can only pay the address
their allowlist names, and keep settling there. Then `./env.sh && ./deploy.sh`.
