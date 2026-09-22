#!/usr/bin/env bash
# Call the hosted runner's tick every minute, with Upstash QStash (free tier).
#
#   QSTASH_TOKEN=… runner/deploy/schedule.sh https://<your-runner>.vercel.app
#
# The token is on the QStash tab of console.upstash.com. The tick secret is
# read from runner/.env and forwarded as the Authorization header; neither is
# printed. Vercel's own cron runs once a day on the free plan, which is why
# this is not a vercel.json cron.
set -euo pipefail
: "${QSTASH_TOKEN:?set QSTASH_TOKEN (console.upstash.com → QStash)}"
URL="${1:?usage: schedule.sh https://<your-runner>.vercel.app}"
cd "$(dirname "$0")/.."
TICK="$(sed -n 's/^RUNNER_TICK_SECRET=//p' .env)"
[ -n "$TICK" ] || { echo "no RUNNER_TICK_SECRET in runner/.env" >&2; exit 1; }
curl -sf -X POST "https://qstash.upstash.io/v2/schedules/${URL%/}/v1/tick" \
  -H "Authorization: Bearer $QSTASH_TOKEN" \
  -H "Upstash-Cron: * * * * *" \
  -H "Upstash-Method: POST" \
  -H "Upstash-Forward-Authorization: Bearer $TICK" \
  && echo && echo "scheduled: POST ${URL%/}/v1/tick every minute"
