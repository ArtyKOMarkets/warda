#!/bin/bash
#
# One message a day about whether the Listener is alive. Installed by
# `ops/install-cron.sh --listener` for 21:05, after the evening pass.
#
# This is the counterpart to listener-pass.sh's silence. That file is right
# not to send "nothing today" twice a day -- a feed that cries wolf twice
# daily is one you stop opening. But the cost is that a dead cron, a spent
# epoch and a genuinely quiet day all look identical from a phone, and on
# 23 September they did for eighteen hours.
#
# So this reports on the PASSES, not on the posts. It reads only
# growth/listener/passes.jsonl and state.json -- no chain, no seller, no X.
# A heartbeat that can fail for the same reasons as the thing it watches is
# not a heartbeat, so it deliberately shares no dependency with the pass
# beyond node and the repo being where it thinks it is.
set -uo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
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

msg=$(node --experimental-strip-types growth/tools/heartbeat.ts 2>&1)
code=$?

# Exit 3 is the heartbeat itself failing to run, which is worth saying out
# loud: the one job of this file is that a person hears something daily, and
# "the watchdog is broken" is the one silence that cannot be self-reporting.
if [ -z "$msg" ]; then
  say "Listener heartbeat: produced no output (exit $code). The watchdog is broken, which says nothing either way about the Listener."
  exit 3
fi

say "$msg"
exit "$code"
