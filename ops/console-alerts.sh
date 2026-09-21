#!/bin/bash
#
# Runs every console account's alert rules, by asking the site to: POSTs to
# /api/account?op=cron with CRON_SECRET. The evaluation happens on the server
# (site/src/api/account.mjs); this is only the clock. Vercel's own cron runs it
# once a day on the Hobby plan, and this makes it every 15 minutes.
#
# Needs CONSOLE_URL and CONSOLE_CRON_SECRET in ops/alerts.env (gitignored).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin"
[ -f "$REPO/ops/alerts.env" ] && . "$REPO/ops/alerts.env"
if [ -z "${CONSOLE_CRON_SECRET:-}" ]; then
  [ "${1:-}" = "--quiet" ] || echo "no CONSOLE_CRON_SECRET in ops/alerts.env — console alerts not run." >&2
  exit 0
fi
URL="${CONSOLE_URL:-https://www.wardaprotocol.com}"
out="$(curl -sS -m 60 -X POST "$URL/api/account?op=cron" -H "x-cron-secret: $CONSOLE_CRON_SECRET")"
case "$out" in
  *'"ok":true'*) [ "${1:-}" = "--quiet" ] || echo "$out" ;;
  *) echo "$(date -u +%FT%TZ) console alerts failed: $out" >&2; exit 1 ;;
esac
