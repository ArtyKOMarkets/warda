#!/bin/bash
# Is the quickstart node a stranger will try actually usable?
#
#     ops/check-node.sh              # probe, write the status file
#     ops/check-node.sh --quiet      # same, no stdout on success
#
# ## Why this exists
#
# /start will tell a first-time developer to point WARDA_RPC_JSON at a node
# this project runs. That node is a laptop behind a Tailscale funnel. It will
# be down sometimes — the lid closes, the tunnel restarts, kaspad is resyncing
# — and the whole reason check-vendor.sh exists is that the last time a public
# endpoint went quiet, nothing said so for days and it was discovered by a
# payment failing.
#
# ## It asks the node, not the door
#
# /health already refuses to answer ok without calling getInfo on kaspad, so a
# 200 here means the whole chain — funnel, proxy, node — answered. A TCP check
# or a probe of `/` would pass while kaspad was dead behind a perfectly healthy
# proxy, which is precisely the state that matters.
#
# ## What it does about it
#
# Writes a status file the site publishes, so a stranger arriving while it is
# down is told to run their own kaspad rather than sent at a socket that will
# never answer. Not an alert to a person.
set -euo pipefail

REPO="$HOME/Desktop/warda"
URL="${WARDA_PUBLIC_NODE:-}"
OUT="$REPO/site/src/node-status.json"
QUIET=0
[ "${1:-}" = "--quiet" ] && QUIET=1
export PATH="$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin"

say() { [ "$QUIET" = "1" ] || echo "$@"; }

if [ -z "$URL" ]; then
  echo "WARDA_PUBLIC_NODE is not set — nothing to check." >&2
  echo "  Set it to the funnel's https URL, e.g. https://warda-node.tailXXXX.ts.net" >&2
  exit 2
fi

now="$(date -u +%FT%TZ)"
body="$(curl -fsS --max-time 12 "$URL/health" 2>/dev/null || true)"

ok=false
detail="the quickstart node did not answer"
if [ -n "$body" ]; then
  # /health already proves it spoke to kaspad; this only reads the verdict.
  if printf '%s' "$body" | grep -q '"ok": *true'; then
    ok=true
    detail="$(printf '%s' "$body" | sed -n 's/.*"detail": *"\([^"]*\)".*/\1/p')"
    [ -n "$detail" ] || detail="answered"
  else
    detail="$(printf '%s' "$body" | sed -n 's/.*"detail": *"\([^"]*\)".*/\1/p')"
    [ -n "$detail" ] || detail="answered, but not ok"
  fi
fi

mkdir -p "$(dirname "$OUT")"
cat > "$OUT" <<JSON
{
  "_comment": "Written by ops/check-node.sh. Read by /start so a stranger arriving while the quickstart node is down is told, rather than sent at a socket that will never answer. This node is a laptop behind a tunnel: best effort, and the page says so.",
  "checkedAt": "$now",
  "url": "$URL",
  "ok": $ok,
  "detail": "$detail"
}
JSON

if [ "$ok" = "true" ]; then
  say "quickstart node ok — $detail"
else
  # Loud even with --quiet: the log this writes to is supposed to be empty.
  echo "$now  quickstart node DOWN — $detail" >&2
  exit 1
fi
