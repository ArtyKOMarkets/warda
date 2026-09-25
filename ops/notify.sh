#!/bin/bash
# The one place an ops script says something to a person.
#
#   . "$REPO/ops/notify.sh"
#   warda_notify "the text"
#
# ## Why this is a file
#
# The same six lines were written out five times — auto-issue.sh,
# grants-heartbeat.sh, listener-heartbeat.sh, listener-pass.sh and, in
# TypeScript, alerts.ts. Five copies is not a style problem. It is the reason
# nothing new ever got a notification: adding one meant pasting a curl with a
# bot token in it into a sixth file, and the honest reaction to that is to skip
# it and write to a log instead. Which is exactly what the three endpoint
# monitors did.
#
# ## It is deliberately quiet about failure to send
#
# A notifier that exits non-zero when Telegram is down would take the caller
# down with it, and the caller is usually a watchdog. So the send is
# best-effort and the text ALWAYS goes to stderr first, whatever happens to the
# network — the log is the floor, not the ceiling.
#
# But "no token configured" is different from "Telegram was unreachable": the
# first is permanent and silent and makes every caller above it a no-op.
# `warda_notify_configured` answers it, and ops/monitor.sh refuses to pretend.
#
# ## The token
#
# WARDA_TELEGRAM_TOKEN is a password: anyone holding it can post as the bot.
# It is used in exactly one place, the request URL. Never echo it, never put
# it in a message, never write it to a state file — ops/check-alerts.mjs
# enforces that for alerts.ts and ops/check-secret-age.mjs tracks its age.
#
# This one leaked on 2026-09-23 (into a transcript, via a `${v:+present}`
# idiom that expands to the value when the variable is empty-but-set). It is
# recorded compromised in ops/secrets.json with rotatedAt null. Everything
# below sends as that bot until it is rotated.

# Where a test wants the messages instead of Telegram. Set to a file path and
# nothing leaves the machine. This exists so the send path can be exercised
# for real — an alert nobody has ever seen fire is indistinguishable from one
# that cannot.
: "${WARDA_NOTIFY_SINK:=}"

warda_notify_configured() {
  [ -n "${WARDA_NOTIFY_SINK:-}" ] && return 0
  [ -n "${WARDA_TELEGRAM_TOKEN:-}" ] && [ -n "${WARDA_TELEGRAM_CHAT:-}" ]
}

warda_notify() {
  local text="$1"
  printf '%s\n' "$text" >&2

  if [ -n "${WARDA_NOTIFY_SINK:-}" ]; then
    printf '%s\n' "$text" >> "$WARDA_NOTIFY_SINK"
    return 0
  fi

  warda_notify_configured || return 1

  curl -sS -m 10 -X POST \
    "https://api.telegram.org/bot$WARDA_TELEGRAM_TOKEN/sendMessage" \
    --data-urlencode "chat_id=$WARDA_TELEGRAM_CHAT" \
    --data-urlencode "text=$text" >/dev/null 2>&1 || return 2
  return 0
}
