#!/bin/bash
#
# One Listener pass, unattended. Installed by `ops/install-cron.sh --listener`
# for 08:13 and 20:13.
#
# Searches X for conversations about agent payments, spending limits and
# x402, ranks what comes back, and sends the ones worth your attention to
# Telegram with a link. Nothing is posted, replied to or liked; the decision
# to speak stays with a person.
#
# SPENDS REAL MONEY, and not testnet KAS. X bills per post read — $0.005 —
# against the card on the developer account. The cap is three searches a pass,
# which is 30 reads, $0.15, and it is enforced by tools/listen.ts and by
# nothing else. There is no covenant behind this one yet. That is the whole
# reason it is opt-in and the whole reason the grant is the next thing.
set -uo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
[ -f "$REPO/ops/alerts.env" ] && . "$REPO/ops/alerts.env"
[ -f "$REPO/growth/listener.env" ] && . "$REPO/growth/listener.env"

cd "$REPO" || exit 1

# A cron job whose failures are silent is not a job, it is a habit of
# believing in one. This one's whole output channel is Telegram, so its
# failures go there too rather than into a log that gets read after somebody
# notices a week of quiet.
say() {
  printf '%s\n' "$1" >&2
  [ -n "${WARDA_TELEGRAM_TOKEN:-}" ] && [ -n "${WARDA_TELEGRAM_CHAT:-}" ] || return 0
  curl -sS -m 10 -X POST \
    "https://api.telegram.org/bot$WARDA_TELEGRAM_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$WARDA_TELEGRAM_CHAT" \
    --data-urlencode "text=$1" >/dev/null 2>&1 || true
}

# The failure this was written for. The token was exported into a terminal
# once, which is invisible to cron — so the first scheduled pass would have
# exited 2 into warda-listener.log and the feed would simply never have
# started. A missing credential and a quiet week look identical from a phone.
if [ -z "${X_BEARER_TOKEN:-}" ]; then
  say "Listener: no X_BEARER_TOKEN in growth/listener.env, so the pass did not run.
A token exported into a terminal is not visible to cron. Put it in the file:

  printf 'X_BEARER_TOKEN=%s\\n' \"\$TOKEN\" >> growth/listener.env"
  exit 2
fi

# --save, every pass. A run costs money and teaches more than a day of
# building; keeping it is what made the last three ranking fixes free. The
# files prune themselves after a day — X's terms allow keeping Post IDs, not
# post content, and src/retain.ts holds that rule so nobody has to.
node --experimental-strip-types growth/tools/listen.ts \
  --direct --send \
  --save "growth/listener/run-$(date +%Y%m%dT%H%M).json"
code=$?

# Not `exec`, so there is something left to notice a failure. A pass that
# found nothing exits 0 and says nothing, which is correct; a pass that could
# not run at all has to say so somewhere a person looks.
[ "$code" -eq 0 ] || say "Listener: the pass failed (exit $code). See ~/Library/Logs/warda-listener.log"
exit "$code"
