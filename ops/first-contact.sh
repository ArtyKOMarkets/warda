#!/bin/bash
# Cron wrapper for first-contact.ts.
#
# A .ts file cannot be a cron entry on its own: cron runs with a near-empty
# PATH and does not read a shell profile, so `node` is not findable and neither
# is anything else. Every other job here learned that the same way — the hourly
# reading says so in its own header — and a wrapper is how they all fix it.
set -euo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/bin:/bin"

# The chain signal is the only one that proves USE rather than interest, and it
# needs a node. Without node.env this still runs and still reports npm and
# GitHub — and says out loud that it did not read the one that matters.
if [ -f "$REPO/ops/node.env" ]; then
  # shellcheck disable=SC1091
  . "$REPO/ops/node.env"
fi

cd "$REPO"
exec node --experimental-strip-types ops/first-contact.ts "$@"
