#!/usr/bin/env bash
# Build the hosted runner from the working tree and ship it.
#
#   runner/deploy/deploy.sh            production
#   runner/deploy/deploy.sh --preview  a preview URL
#
# The environment (DATABASE_URL, RUNNER_TICK_SECRET, RUNNER_FEE_PAYEE, the
# three TURNKEY_* keys) lives in the Vercel project, not here: see README.md.
set -euo pipefail
cd "$(dirname "$0")"
node build.mjs
if [ "${1:-}" = "--preview" ]; then npx vercel; else npx vercel --prod; fi
