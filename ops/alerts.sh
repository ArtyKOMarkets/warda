#!/bin/bash
#
# Cron wrapper for alerts.ts.
#
#   ops/alerts.sh --dry-run    what it would send
#   ops/alerts.sh --test       one message, to prove the pipe works
#   ops/alerts.sh --quiet      for cron: output only when something happened
#
# cron runs with a near-empty PATH and does not read a shell profile, so node
# is not findable and neither is anything else. Every job in this directory
# learned that the same way; a wrapper is how they all fix it.
set -euo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/bin:/bin"

# The node. Without it nothing can be read, and this says so rather than
# reporting an unread world as a quiet one.
if [ -f "$REPO/ops/node.env" ]; then
  # shellcheck disable=SC1091
  . "$REPO/ops/node.env"
fi

# The Telegram bot token and chat id. Untracked; see ops/alerts.env.example.
# Kept apart from node.env because node.env is read by every job here and this
# is a credential only one of them needs.
if [ -f "$REPO/ops/alerts.env" ]; then
  # shellcheck disable=SC1091
  . "$REPO/ops/alerts.env"
fi

cd "$REPO"
exec node --experimental-strip-types ops/alerts.ts "$@"
