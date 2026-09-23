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

# --save, every pass. A run costs money and teaches more than a day of
# building; keeping it is what made the last three ranking fixes free. The
# files prune themselves after a day — X's terms allow keeping Post IDs, not
# post content, and src/retain.ts holds that rule so nobody has to.
exec node --experimental-strip-types growth/tools/listen.ts \
  --direct --send \
  --save "growth/listener/run-$(date +%Y%m%dT%H%M).json"
