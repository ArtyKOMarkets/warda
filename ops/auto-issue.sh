#!/bin/bash
#
# Issue the pending testnet grant requests, without waiting for a person.
# Installed by `ops/install-cron.sh --grants` for every fifteen minutes.
#
# Warda's whole argument is that an untrusted party can hold bounded money
# safely, because the limits are enforced by every node rather than by
# anyone's judgement. Five testnet KAS under those terms is not a thing that
# needs approving — and until this existed, the honest answer to a developer
# who found /grant at 2am was "wait for Arty", which is a human bottleneck on
# a system whose entire premise is not needing one.
#
# What it does NOT claim: genesis is unbounded. A grant is created FROM an
# ordinary wallet, so the key funding one can spend everything it holds, and
# no covenant covers that step. The bound is the float — a key of its own,
# holding what a bad week may cost. ops/grants.ts refuses to run this against
# the main funder however the environment is set.
set -uo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
[ -f "$REPO/ops/node.env" ] && . "$REPO/ops/node.env"
[ -f "$REPO/ops/alerts.env" ] && . "$REPO/ops/alerts.env"

cd "$REPO" || exit 1

# One copy of this lived in each of four scripts, character for character.
# It is ops/notify.sh now — not to save six lines, but because a send path
# nobody could add a caller to without pasting a bot token is a send path that
# gets skipped, and three endpoint monitors did skip it for exactly that
# reason. `|| true` keeps the old contract: a watchdog is not brought down by
# Telegram being unreachable.
. "$REPO/ops/notify.sh"
say() { warda_notify "$1" || true; }

out=$(node --experimental-strip-types ops/grants.ts auto 2>&1)
code=$?

# Exit 2 is a setup problem — no float key, or it is the main funder. Those
# are loud, because they mean the queue is silently not being served.
if [ "$code" -eq 2 ]; then
  say "Grants: the unattended issuer cannot run.

$out"
  exit 2
fi

if [ "$code" -ne 0 ]; then
  say "Grants: the unattended issuer failed (exit $code).

$out"
  exit "$code"
fi

# A pass that issued nothing and had nothing to issue says nothing: this runs
# four times an hour, and "nothing pending" ninety-six times a day is how a
# feed teaches you to ignore it. Anything else is news — a grant went out, or
# somebody is waiting and the robot stopped.
case "$out" in
  *"nothing pending"*) printf '%s\n' "$out" ;;
  *)                   say "$out" ;;
esac
exit 0
