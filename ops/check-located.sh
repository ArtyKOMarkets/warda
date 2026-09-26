#!/bin/bash
# Are our grants where we think they are? Scheduled through ops/monitor.sh.
#
#     ops/check-located.sh             # ask the chain, write the status file
#     ops/check-located.sh --quiet     # same, no stdout on success
#
# A thin wrapper, for the same reason ops/check-node.sh is one: the thing that
# decides who to wake is ops/monitor.sh, and a probe that also decided would be
# a probe you cannot run by hand while looking at it.
#
# It sources ops/node.env ITSELF. The URL lives in an untracked file whose
# instructions say to source it before anything that talks to the node, and a
# person in a terminal does while cron does not — which is exactly how
# check-node.sh spent a day and a half reporting "nothing to check" under a
# headline that said the node was down.
set -uo pipefail

# WARDA_REPO honoured, like ops/monitor.sh. Every other probe in this directory
# hardcodes the path, which means none of them can be run against a checkout
# anywhere else — including by the tests that would prove they work.
REPO="${WARDA_REPO:-$HOME/Desktop/warda}"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

if [ -f "$REPO/ops/node.env" ]; then
  set +u
  . "$REPO/ops/node.env"
  set -u
fi

cd "$REPO" || exit 2

exec node --experimental-strip-types ops/check-located.ts "$@"
