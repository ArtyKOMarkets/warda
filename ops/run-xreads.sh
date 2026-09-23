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
# `set -a`, because sourcing a file of bare KEY=value assignments sets shell
# variables and does not EXPORT them — so node, a child process, sees none of
# them. ops/alerts.env writes `export` on every line and works either way;
# growth/listener.env does not, and the seller started, printed its address,
# and then exited saying it had no QUOTE_SECRET that was sitting in the file
# it had just read. ops/run-auditor.sh does this correctly; this did not.
set -a
[ -f "$REPO/ops/alerts.env" ] && . "$REPO/ops/alerts.env"
[ -f "$REPO/growth/listener.env" ] && . "$REPO/growth/listener.env"
set +a

cd "$REPO" || exit 1

# The address it is paid at is the one the grant's allowlist names, and that
# is fixed on chain — so it is read from the allowlist itself. The two cannot
# disagree, because they are the same line of the same file: a seller paid at
# an address the grant does not permit produces refusals that look exactly
# like a covenant bug.
#
# Read from the file rather than derived from the key, because deriving it
# meant `warda wallet`, which asks the CHAIN for a balance nobody here wants.
# Under launchd that is a network call at startup with no node configured: it
# hangs or fails, the address comes back empty, and the seller exits saying it
# has no --pay-to. A daemon must not need the network to know its own name.
if [ -z "${XREADS_ADDRESS:-}" ] && [ -f growth/listener-payees.txt ]; then
  XREADS_ADDRESS="$(sed -n 's/^\(kaspa[a-z]*:[0-9a-z]\{20,\}\).*/\1/p' growth/listener-payees.txt | head -1)"
  export XREADS_ADDRESS
fi
if [ -z "${XREADS_ADDRESS:-}" ]; then
  echo "no payee address: growth/listener-payees.txt has no kaspa address in it." >&2
  echo "That file is the grant's allowlist. Without it this would be paid at an" >&2
  echo "address the covenant does not permit, so it refuses to start." >&2
  exit 2
fi
echo "xreads: paid at $XREADS_ADDRESS (from the grant's allowlist)" >&2

exec node --experimental-strip-types growth/tools/xreads.ts
