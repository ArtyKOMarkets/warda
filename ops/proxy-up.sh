#!/bin/bash
# Keep the public node proxy running. Cron-safe, idempotent, quiet when healthy.
#
# Every other job here is cron, so this is too rather than introducing launchd
# for one process. Cron cannot supervise a daemon, but it can notice a dead one
# every few minutes and start it again — which is the whole requirement, since
# the failure being guarded against is a laptop that slept, not a crash loop.
#
# Idempotent because a cron that starts a second copy every five minutes is
# worse than no cron: the port is taken, each new copy dies, and the log fills
# with failures that look like the proxy is broken when it is fine.
set -euo pipefail

REPO="$HOME/Desktop/warda"
PORT="${WARDA_PROXY_PORT:-8410}"
LOG="$HOME/Library/Logs/warda-proxy.log"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/usr/bin:/bin"

# Healthy means the NODE answered, not that the port is open. A proxy running
# in front of a dead kaspad is exactly the state this must not call fine.
if curl -fsS --max-time 6 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
  exit 0
fi

if lsof -ti tcp:"$PORT" >/dev/null 2>&1; then
  # Port held but unhealthy: either kaspad is down (restarting the proxy will
  # not help, and saying so is more use than a restart loop) or the proxy is
  # wedged. Report, and let the next run try again once kaspad is back.
  echo "$(date -u +%FT%TZ) port $PORT is held but /health is not ok — kaspad may be down" >> "$LOG"
  exit 0
fi

cd "$REPO"
[ -f ops/node.env ] && . ops/node.env
echo "$(date -u +%FT%TZ) starting proxy on :$PORT" >> "$LOG"
nohup node --experimental-strip-types ops/node-proxy.ts --port "$PORT" >> "$LOG" 2>&1 &
