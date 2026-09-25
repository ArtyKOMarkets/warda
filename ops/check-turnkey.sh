#!/bin/bash
# Can the hosted runner still sign? See runner/tools/turnkey-probe.ts for why
# this signs rather than asking a cheaper question.
#
#     ops/check-turnkey.sh            # probe
#     ops/check-turnkey.sh --quiet    # same, no stdout on success
#
# Scheduled HOURLY, not every fifteen minutes: each run spends one signature
# against the quota it is watching, and the failure it exists to catch — a
# plan limit — does not flap.
set -uo pipefail
REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
cd "$REPO" || exit 1
exec node --experimental-strip-types runner/tools/turnkey-probe.ts "$@"
