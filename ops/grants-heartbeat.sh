#!/bin/bash
#
# One message a day about whether /grant is keeping the promise it makes.
# Installed by `ops/install-cron.sh --grants` for 21:10.
#
# ops/auto-issue.sh is deliberately silent when there is nothing pending: it
# runs ninety-six times a day and "nothing pending" at that rate is how a feed
# teaches you to stop reading it. The cost is that a float which has quietly
# emptied — or fragmented into coins too small for genesis, which takes ONE
# input — looks exactly like a quiet week, while /grant goes back to queueing
# people behind a page that promises fifteen minutes.
#
# So this reports the float and the queue once a day, and shouts on the two
# states that need a person.
set -uo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
[ -f "$REPO/ops/node.env" ] && . "$REPO/ops/node.env"
[ -f "$REPO/ops/alerts.env" ] && . "$REPO/ops/alerts.env"

cd "$REPO" || exit 1

say() {
  printf '%s\n' "$1" >&2
  [ -n "${WARDA_TELEGRAM_TOKEN:-}" ] && [ -n "${WARDA_TELEGRAM_CHAT:-}" ] || return 0
  curl -sS -m 10 -X POST \
    "https://api.telegram.org/bot$WARDA_TELEGRAM_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$WARDA_TELEGRAM_CHAT" \
    --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

msg=$(node --experimental-strip-types ops/grants.ts heartbeat 2>&1)
code=$?

# The one silence that cannot be self-reporting is the watchdog's own.
if [ -z "$msg" ]; then
  say "Grants heartbeat: produced no output (exit $code). The watchdog is broken, which says nothing either way about /grant."
  exit 3
fi

say "$msg"
exit "$code"
