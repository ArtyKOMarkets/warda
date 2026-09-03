#!/bin/bash
#
# One reading, on a schedule. Meant for cron, which is why it sets up its own
# environment rather than assuming one.
#
# cron runs with a near-empty PATH and does not read ~/.zshrc, so node is not
# on the path and neither is anything else. Everything this needs is therefore
# named here, absolutely. A cron entry that relies on the interactive shell's
# environment works when tested by hand and silently does nothing at 3am.
set -euo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/bin:/bin"

# The node's address. Untracked; see ops/node.env.example.
if [ -f "$REPO/ops/node.env" ]; then
  # shellcheck disable=SC1091
  . "$REPO/ops/node.env"
fi

cd "$REPO/agent"
exec node --experimental-strip-types tools/read.ts "$@"
