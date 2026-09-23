#!/bin/bash
# Keep the covenant auditor running. Cron-safe, idempotent, quiet when healthy.
#
# This one is LISTED. The registry re-fetches its manifest from this host on
# every request, so when it is down a stranger looking for it sees
# UNREACHABLE — which is the honest behaviour and still a public one. The
# Listener's seller can die quietly and cost only a missed pass; this cannot.
#
# Same shape and reasoning as ops/proxy-up.sh and ops/xreads-up.sh: launchd
# spawns outside cron's Full Disk Access grant and cannot read a script in
# ~/Desktop at all, so a LaunchAgent is not available for any of these.
set -euo pipefail

REPO="$HOME/Desktop/warda"
PORT="${AUDITOR_PORT:-8787}"
LOG="$HOME/Library/Logs/warda-auditor.log"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

# Not configured is not down. Without ops/auditor.env there is no address to
# be paid at and no quote secret, and run-auditor.sh refuses — correctly, and
# every five minutes forever if this does not check first. A log full of a
# refusal nobody asked for is how the real one gets scrolled past.
[ -f "$REPO/ops/auditor.env" ] || exit 0

# Healthy means it ANSWERED. A wedged process behind an open socket is the
# state that must not be called fine, because the registry would keep listing
# it as live while every buyer's 402 timed out.
if curl -fsS --max-time 6 -X POST --data-binary "" "http://127.0.0.1:$PORT/v1/scan" >/dev/null 2>&1; then
  exit 0
fi
# An empty body is a 400, which still proves the server is answering. Only a
# connection failure means it is not there.
if curl -sS --max-time 6 -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
  exit 0
fi

if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) port $PORT is held but nothing answers — the auditor may be wedged" >> "$LOG"
  exit 0
fi

cd "$REPO"
echo "$(date -u +%FT%TZ) starting the covenant auditor on :$PORT" >> "$LOG"
nohup ops/run-auditor.sh >> "$LOG" 2>&1 &
