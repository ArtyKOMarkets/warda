#!/bin/bash
#
# The Listener's seller: X reads, sold over HTTP 402.
#
# Bound to 127.0.0.1 and never published. Both ends of this are on one
# machine, so a public hostname would add nothing the payment needs — and X's
# Developer Policy forbids redistributing post content to third parties, so
# an endpoint strangers cannot reach is the strongest compliance available
# rather than a compromise. There is no signed listing and no registry entry.
#
# It holds a credential that SPENDS: X bills per post read against the card on
# the developer account. That is why it lives on one machine with one place to
# revoke it.
set -uo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
[ -f "$REPO/ops/alerts.env" ] && . "$REPO/ops/alerts.env"
[ -f "$REPO/growth/listener.env" ] && . "$REPO/growth/listener.env"

cd "$REPO" || exit 1

# The address it is paid at is the one the grant's allowlist names, and that
# is fixed on chain. Reading it from the key rather than from an env var means
# the two cannot disagree — a seller paid at a different address than the
# grant permits produces refusals that look like a covenant bug.
if [ -z "${XREADS_ADDRESS:-}" ] && [ -f growth/keys/xreads.key ]; then
  XREADS_ADDRESS="$(npx warda wallet --key growth/keys/xreads.key 2>/dev/null \
    | sed -n 's/.*address[ :]*\(kaspa[a-z]*:[0-9a-z]\{20,\}\).*/\1/p' | head -1)"
  export XREADS_ADDRESS
fi

exec node --experimental-strip-types growth/tools/xreads.ts
