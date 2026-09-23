#!/bin/bash
# Keep the Listener's seller running. Cron-safe, idempotent, quiet when healthy.
#
# A LaunchAgent was the obvious tool and it does not work here: launchd spawns
# it outside cron's Full Disk Access grant, so bash cannot even read a script
# in ~/Desktop and the log fills with "Operation not permitted". Granting Full
# Disk Access to /bin/bash to fix one daemon is a wide permission for a narrow
# problem.
#
# Cron already has the grant, and this repo already keeps a process alive this
# way — ops/proxy-up.sh, same shape, same reasoning. Cron cannot supervise a
# daemon, but it can notice a dead one every few minutes and start it again,
# which is the whole requirement: the failure being guarded against is a
# laptop that slept, not a crash loop.
#
# Idempotent, because a cron that starts a second copy every five minutes is
# worse than no cron: the port is taken, each new copy dies, and the log fills
# with failures that look like the seller is broken when it is fine.
set -euo pipefail

REPO="$HOME/Desktop/warda"
PORT="${XREADS_PORT:-8788}"
LOG="$HOME/Library/Logs/warda-xreads.log"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

# Healthy means it ANSWERED, not that the port is open. A process wedged
# behind an open socket is exactly the state this must not call fine, because
# the pass at 08:13 would then fail with something that reads like a covenant
# refusal.
if curl -fsS --max-time 6 "http://127.0.0.1:$PORT/" >/dev/null 2>&1; then
  exit 0
fi

if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  echo "$(date -u +%FT%TZ) port $PORT is held but / does not answer — the seller may be wedged" >> "$LOG"
  exit 0
fi

cd "$REPO"
echo "$(date -u +%FT%TZ) starting the X-reads seller on :$PORT" >> "$LOG"
nohup ops/run-xreads.sh >> "$LOG" 2>&1 &
