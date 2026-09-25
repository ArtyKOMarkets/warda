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
# It spends twice over, and the two are different in kind. The agent pays the
# seller in testnet KAS from a grant the network enforces — three searches an
# epoch, 0.05 each, and the covenant refuses the fourth whatever this file
# says. The seller then pays X in dollars, $0.005 a post read, about $0.15 a
# pass, on the card behind the developer account.
#
# So the chain bounds the agent and nothing bounds the card. That asymmetry is
# the honest shape of this: the covenant can only govern what it can see.
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
# One copy of this lived in each of four scripts, character for character.
# It is ops/notify.sh now — not to save six lines, but because a send path
# nobody could add a caller to without pasting a bot token is a send path that
# gets skipped, and three endpoint monitors did skip it for exactly that
# reason. `|| true` keeps the old contract: a watchdog is not brought down by
# Telegram being unreachable.
. "$REPO/ops/notify.sh"
say() { warda_notify "$1" || true; }

# The failure this was written for. The token was exported into a terminal
# once, which is invisible to cron — so the first scheduled pass would have
# exited 2 into warda-listener.log and the feed would simply never have
# started. A missing credential and a quiet week look identical from a phone.
# Once the grant exists the pass buys from the seller rather than from a card,
# and the seller has to be up. A pass that cannot reach it reports a failure
# that looks like the covenant refusing, which is the one misreading worth
# spending four lines to prevent.
if [ -f growth/listener-grant.json ]; then
  curl -sS -m 5 -o /dev/null "${XREADS_URL:-http://127.0.0.1:8788}/" 2>/dev/null || \
    say "Listener: the X-reads seller is not answering on ${XREADS_URL:-http://127.0.0.1:8788}.
The pass will find nothing to buy. Start it, or load the LaunchAgent:

  launchctl load ~/Library/LaunchAgents/com.wardaprotocol.xreads.plist"
fi

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
  --grant growth/listener-grant.json \
  --save "growth/listener/run-$(date +%Y%m%dT%H%M).json"
code=$?

# Not `exec`, so there is something left to notice a failure. A pass that
# found nothing exits 0 and says nothing, which is correct; a pass that could
# not run at all has to say so somewhere a person looks.
[ "$code" -eq 0 ] || say "Listener: the pass failed (exit $code). See ~/Library/Logs/warda-listener.log"
exit "$code"
