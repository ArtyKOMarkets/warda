#!/bin/bash
# Can the runner sign? Asked of whichever vault it is configured to use —
# Turnkey, or the envelope. See runner/tools/signing-probe.ts for why it signs
# rather than asking a cheaper question, and why it is not called check-turnkey.
#
#     ops/check-signing.sh            # probe
#     ops/check-signing.sh --quiet    # same, no stdout on success
#
# HOURLY. On the Turnkey path each run spends one signature against the quota
# it is watching; on the envelope path it costs nothing, and hourly is kept for
# both so the cadence does not change with the configuration.
set -uo pipefail
REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
cd "$REPO" || exit 1
exec node --experimental-strip-types runner/tools/signing-probe.ts "$@"
