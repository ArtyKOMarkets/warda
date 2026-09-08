#!/bin/bash
#
# One purchase a day, on a schedule. Agent #003 buys agent #001's digest.
#
# ## Why this exists
#
# Every payment between these agents so far has been a ceremony: somebody at a
# terminal, running commands. That is fine for proving a thing works once and
# useless for showing that it keeps working. A protocol whose demonstrations
# all happened on the day of the announcement is indistinguishable from one
# that only ever worked that day.
#
# On a schedule it stops being a demo. The counters on the site climb without
# anyone touching them, the purchase log fills with dates rather than one date,
# and the honest claim gets stronger every night for free.
#
# ## What it costs, and when it stops
#
# 0.04 KAS per run against a grant that holds 1.75, so a little over forty
# days. It does NOT top itself up, and it must not: a grant's budget is the
# whole point, and a cron that refunds one has quietly reinvented the hot
# wallet this project exists to replace. When it runs out it starts failing,
# and that failure is a true thing about a bounded agent reaching its bound.
#
# ## The environment
#
# cron runs with a near-empty PATH and does not read ~/.zshrc, so node is not
# on the path and neither is anything else. Everything is named absolutely
# here. A cron entry that leans on the interactive shell's environment works
# perfectly when tested by hand and silently does nothing at 3am.
set -euo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/bin:/bin"

if [ -f "$REPO/ops/node.env" ]; then
  # shellcheck disable=SC1091
  . "$REPO/ops/node.env"
fi

KEY="$REPO/covenant/deploy/agent-003.key"
if [ ! -f "$KEY" ]; then
  echo "no agent key at $KEY — nothing to buy with." >&2
  exit 1
fi

cd "$REPO"

# --json so the record is machine-readable: this runs unattended, and stderr
# scrolls into a log nobody reads. Exit codes are the real signal — 3 is the
# covenant refusing (nothing spent), 4 is paid-and-unserved (do NOT retry).
WARDA_SK="$(cat "$KEY")" node --experimental-strip-types agents/tools/buy.ts \
  https://warda-demo-api.vercel.app/digest \
  --json \
  --id WARDA-003 \
  --grant x402/demo/agent-003-grant.json \
  --recipients x402/demo/agent-003-recipients.txt \
  --out agent-003/purchases
rc=$?

case $rc in
  0) echo "bought." ;;
  3) echo "the covenant refused it. Nothing was spent." >&2 ;;
  4) echo "PAID AND NOT SERVED. The money is gone; do not re-run to compensate." >&2 ;;
  *) echo "failed with $rc — see above." >&2 ;;
esac
exit $rc
