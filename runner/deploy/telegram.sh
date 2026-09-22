#!/usr/bin/env bash
# Give the hosted runner your Telegram bot, and point the bot at it.
#
#   runner/deploy/telegram.sh https://warda-runner.vercel.app
#
# Reuses the bot ops/alerts.sh already uses (WARDA_TELEGRAM_TOKEN in
# ops/alerts.env). Adds it to the Vercel project as TELEGRAM_BOT_TOKEN,
# redeploys, and registers the runner's /v1/telegram/hook as the bot's webhook
# with a secret only the runner can recompute. Prints no secret.
#
# The webhook replaces getUpdates for this bot; sending (which is all
# ops/alerts.sh does) is unaffected.
set -euo pipefail
URL="${1:?usage: telegram.sh https://<your-runner>.vercel.app}"
cd "$(dirname "$0")"
TOKEN="$(bash -c '. ../../ops/alerts.env >/dev/null 2>&1; printf "%s" "${WARDA_TELEGRAM_TOKEN:-}"')"
[ -n "$TOKEN" ] || { echo "no WARDA_TELEGRAM_TOKEN in ops/alerts.env" >&2; exit 1; }
npx vercel env rm TELEGRAM_BOT_TOKEN production -y >/dev/null 2>&1 || true
printf '%s' "$TOKEN" | npx vercel env add TELEGRAM_BOT_TOKEN production >/dev/null
echo "  set TELEGRAM_BOT_TOKEN"
./deploy.sh >/dev/null
echo "  redeployed"
SECRET="$(printf '%s' "warda-runner-telegram:$TOKEN" | shasum -a 256 | cut -c1-48)"
curl -sf "https://api.telegram.org/bot$TOKEN/setWebhook" \
  --data-urlencode "url=${URL%/}/v1/telegram/hook" \
  --data-urlencode "secret_token=$SECRET" \
  --data-urlencode 'allowed_updates=["message","callback_query"]' >/dev/null
echo "  webhook set: ${URL%/}/v1/telegram/hook"
echo "done. In the console: Your agents → Connect Telegram."
