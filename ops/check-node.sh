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
# never answer.
#
# It does not alert anybody itself, and for a while nothing else did either:
# cron ran it, it exited 1, and the 1 went to a log. It is scheduled through
# ops/monitor.sh now, which watches the exit code and sends on the change of
# state. Nothing in this file knows about that, deliberately — a probe that
# also decides who to wake is a probe you cannot run by hand.
set -euo pipefail

REPO="$HOME/Desktop/warda"

# Sourced HERE, not left to the caller.
#
# The funnel URL lives in ops/node.env, which is untracked — it is a public URL
# reaching a kaspad on a personal laptop, and the file's own comment says why it
# is not in the repository. Its instructions say to source it before running
# anything that talks to the node, and a person in a terminal does. Cron does
# not: the crontab entry is `monitor.sh node check-node.sh --quiet` and nothing
# in that line reads node.env.
#
# So from 25 September this exited 2 every fifteen minutes with "nothing to
# check", the wrapper called that DOWN, and the reminder said the public node
# had been down for a day while it had been up the whole time. A credential a
# script needs and does not fetch itself is a script that works by hand and
# fails on a schedule — the same failure listener-pass.sh has a four-line
# comment about, one directory over.
#
# `set +u` around it: node.env is a plain export file, not a manifest, and a
# `set -u` shell dies on an unset variable inside somebody else's file.
if [ -f "$REPO/ops/node.env" ]; then
  set +u
  . "$REPO/ops/node.env"
  set -u
fi

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
