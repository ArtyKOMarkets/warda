#!/bin/bash
# Run a check, and tell a person when the answer changes.
#
#   ops/monitor.sh verify ops/check-verify.sh --quiet
#   ops/monitor.sh --status           what each monitor currently believes
#   ops/monitor.sh --selftest         drive the state machine with fakes
#
# ## Why this exists
#
# ops/check-verify.sh, ops/check-node.sh and ops/check-vendor.sh are all
# correct and all useless at 3am. Each one probes the right path, writes an
# honest status file and exits 1. Under cron that exit code goes to
# ~/Library/Logs/warda-*.log, and a log is a place failures go to be alone.
#
# check-verify.sh exists BECAUSE /v1/verify answered `internal` to every
# request for an unknown length of time and nothing said so. We then built the
# monitor that would have caught it and wired it to a log file, which is the
# same mistake with a smaller radius: the outage is now recorded, promptly,
# where nobody is looking.
#
# ## Why it is not "send the failure"
#
# These fire every fifteen minutes. A down endpoint would produce ninety-six
# identical messages a day, and every file in ops/ that sends anything has a
# comment explaining why it stays quiet — auto-issue.sh, listener-pass.sh —
# because the authors had all watched a feed train them to stop reading it.
# Alerting on the EDGE is what makes the alert mean something:
#
#   down       after CONFIRM consecutive failures, once
#   still down every REMIND hours, so silence can never mean health
#   recovered  on the first success, but only if the down was announced
#
# CONFIRM is 2 by default: one timed-out curl at minute 15 is not an outage,
# and waiting one cycle costs fifteen minutes against an incident that lasted
# days. A blip that clears on its own sends nothing at all — and because the
# recovery is conditional on having announced, it can never send a lone "back
# up" for a failure nobody was told about.
#
# ## Delivery is not assumed
#
# If the message could not be sent — no token configured, Telegram
# unreachable — the state is NOT advanced. The alert stays pending and goes
# out on the next run that can deliver it. A monitor that counts an undelivered
# alert as delivered is back where it started.
#
# The token this sends with is the one recorded compromised on 2026-09-23 in
# ops/secrets.json, rotatedAt null. This makes it load-bearing; it was already
# overdue.
set -uo pipefail

REPO="${WARDA_REPO:-$HOME/Desktop/warda}"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
# --selftest sets this. Without it the self-test would source the real
# alerts.env, find a real token however carefully the caller blanked it, and
# send "selftest is DOWN" to a human being at 3am.
[ -z "${WARDA_MONITOR_NO_ENV:-}" ] && [ -f "$REPO/ops/alerts.env" ] && . "$REPO/ops/alerts.env"
if ! . "$REPO/ops/notify.sh" 2>/dev/null; then
  echo "ops/monitor.sh: cannot read $REPO/ops/notify.sh — set WARDA_REPO." >&2
  exit 2
fi

STATEDIR="${WARDA_MONITOR_STATE:-$REPO/ops/monitor-state}"
CONFIRM="${WARDA_MONITOR_CONFIRM:-2}"
REMIND="${WARDA_MONITOR_REMIND_SECONDS:-21600}"   # 6h

# ---------------------------------------------------------------- helpers

duration() {
  local s="$1"
  if   [ "$s" -lt 3600 ]  ; then echo "$((s / 60))m"
  elif [ "$s" -lt 172800 ]; then echo "$((s / 3600))h $(((s % 3600) / 60))m"
  else echo "$((s / 86400))d $(((s % 86400) / 3600))h"
  fi
}

# The state file is key=value, not JSON, and read with `.` — it is ours, it is
# gitignored, and sed-ing JSON in bash is how ops/check-vendor.sh's lastOk
# nearly got lost. Values are integers and timestamps only; nothing from the
# checked command is ever written here, so nothing it prints can become shell.
load() {
  m_ok=1; m_since=0; m_fails=0; m_announced=0; m_notified=0; m_undelivered=0
  [ -f "$1" ] && . "$1"
}

save() {
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<EOF
m_ok=$m_ok
m_since=$m_since
m_fails=$m_fails
m_announced=$m_announced
m_notified=$m_notified
m_undelivered=$m_undelivered
EOF
}

# ---------------------------------------------------------------- --status

if [ "${1:-}" = "--status" ]; then
  found=0
  for f in "$STATEDIR"/*.state; do
    [ -f "$f" ] || continue
    found=1
    n="$(basename "$f" .state)"
    load "$f"
    now="$(date +%s)"
    if [ "$m_ok" = 1 ]; then
      echo "$n: up"
    else
      echo "$n: DOWN for $(duration $((now - m_since))) · $m_fails failed runs · announced $m_announced · undelivered $m_undelivered"
    fi
  done
  [ "$found" = 1 ] || echo "no monitor has run yet"
  exit 0
fi

# ---------------------------------------------------------------- --selftest

if [ "${1:-}" = "--selftest" ]; then
  # An alert nobody has watched fire is indistinguishable from one that
  # cannot. This drives the whole state machine against a fake check whose
  # verdict is a file, and asserts on the messages that came out — including,
  # at every step, the ones that must NOT have.
  tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
  verdict="$tmp/verdict"; sink="$tmp/sink"; : > "$sink"
  cat > "$tmp/fake" <<'FAKE'
#!/bin/bash
echo "fake check says $(cat "$VERDICT_FILE")"
[ "$(cat "$VERDICT_FILE")" = up ] && exit 0 || exit 1
FAKE
  chmod +x "$tmp/fake"

  fails=0
  step() { # step <verdict> <expected new messages> <substring or -> <label> [remind seconds]
    echo "$1" > "$verdict"
    local before after got
    before="$(wc -l < "$sink" | tr -d ' ')"
    VERDICT_FILE="$verdict" WARDA_NOTIFY_SINK="$sink" WARDA_MONITOR_NO_ENV=1 \
      WARDA_REPO="$REPO" WARDA_MONITOR_STATE="$tmp/state" WARDA_MONITOR_REMIND_SECONDS="${5:-21600}" \
      "$0" selftest "$tmp/fake" >/dev/null 2>&1
    after="$(wc -l < "$sink" | tr -d ' ')"
    got=$((after - before))
    if [ "$got" != "$2" ]; then
      echo "FAIL  $4: expected $2 message(s), got $got"; fails=$((fails + 1)); return
    fi
    if [ "$3" != "-" ] && ! tail -n "$2" "$sink" | grep -qi -- "$3"; then
      echo "FAIL  $4: message did not mention '$3' — $(tail -n1 "$sink")"; fails=$((fails + 1)); return
    fi
    echo "ok    $4"
  }

  echo "monitor self-test"
  step up   0 -           "first run, healthy: silent"
  step down 0 -           "one failure: silent (CONFIRM=2, a blip is not an outage)"
  step up   0 -           "blip cleared: silent — a recovery nobody was warned about is noise"
  step down 0 -           "failure 1 again"
  step down 1 "DOWN"      "failure 2: the alert fires"
  step down 0 -           "still failing: silent, not 96 messages a day"
  step down 0 -           "still failing: still silent"
  step down 1 "still down" "reminder due: silence can never mean health" 0
  step up   1 "recovered" "back up: said once"
  step up   0 -           "still up: silent"

  # A check that cannot START is a real failure and a different message. The
  # first live run of this file was against /bin/false, which does not exist on
  # macOS, and it reported the endpoint down.
  rm -rf "$tmp/state"; : > "$sink"
  for i in 1 2; do
    WARDA_NOTIFY_SINK="$sink" WARDA_MONITOR_NO_ENV=1 WARDA_REPO="$REPO" \
      WARDA_MONITOR_STATE="$tmp/state" "$0" selftest "$tmp/no-such-command" >/dev/null 2>&1
  done
  if grep -q "CHECK could not run" "$sink" && ! grep -q "is DOWN" "$sink"; then
    echo "ok    a check that cannot start says so, instead of blaming the endpoint"
  else
    echo "FAIL  missing check reported as: $(tail -n1 "$sink")"; fails=$((fails + 1))
  fi

  # Delivery is not assumed. With no sink and no token, nothing can be sent,
  # and the state must not record that it was.
  echo down > "$verdict"
  rm -rf "$tmp/state"
  for i in 1 2 3; do
    VERDICT_FILE="$verdict" WARDA_TELEGRAM_TOKEN="" WARDA_TELEGRAM_CHAT="" \
      WARDA_MONITOR_NO_ENV=1 WARDA_MONITOR_STATE="$tmp/state" WARDA_REPO="$REPO" \
      "$0" selftest "$tmp/fake" >/dev/null 2>&1
  done
  load "$tmp/state/selftest.state"
  if [ "$m_announced" = 0 ] && [ "$m_undelivered" -ge 1 ]; then
    echo "ok    undeliverable alert stays pending, not marked sent"
  else
    echo "FAIL  undeliverable alert was marked announced=$m_announced undelivered=$m_undelivered"
    fails=$((fails + 1))
  fi

  echo
  [ "$fails" = 0 ] && { echo "all good"; exit 0; }
  echo "$fails failing"; exit 1
fi

# ---------------------------------------------------------------- the job

name="${1:-}"
shift || true
if [ -z "$name" ] || [ "$#" -eq 0 ]; then
  echo "usage: ops/monitor.sh <name> <command> [args...]" >&2
  echo "       ops/monitor.sh --status | --selftest" >&2
  exit 2
fi

state="$STATEDIR/$name.state"
load "$state"
now="$(date +%s)"

out="$("$@" 2>&1)"; code=$?
[ -n "$out" ] && printf '%s\n' "$out"

# Only the tail, and only from the check's own output. Telegram takes 4096
# bytes and a wall of them is a message people learn to swipe away.
tail_text="$(printf '%s' "$out" | tail -n 4 | cut -c1-400)"

if [ "$code" = 0 ]; then
  if [ "$m_announced" = 1 ]; then
    if warda_notify "$name recovered after $(duration $((now - m_since))) down. ${tail_text:-the check now passes.}"; then
      m_undelivered=0
    else
      m_undelivered=$((m_undelivered + 1))
      # Not delivered, so the recovery is still owed. Everything else resets:
      # the thing is up, and the next failure is a new incident.
      m_ok=1; m_since="$now"; m_fails=0; m_notified=0
      save "$state"
      exit 0
    fi
  fi
  m_ok=1; m_since="$now"; m_fails=0; m_announced=0; m_notified=0
  save "$state"
  exit 0
fi

m_fails=$((m_fails + 1))
[ "$m_ok" = 1 ] && { m_since="$now"; m_ok=0; }

# 126 and 127 are the shell saying it could not start the check — missing,
# or not executable. That IS worth waking somebody for: ops/install-cron.sh's
# exec-bit guard exists because check-vendor.sh once shipped without one, and
# "a monitor that cannot start looks exactly like a monitor with nothing to
# report." But it is a different message. Told "verify is DOWN" you go and
# look at the endpoint, and the endpoint is fine.
headline="$name is DOWN"
again="$name still down"
aside=""
if [ "$code" = 127 ] || [ "$code" = 126 ]; then
  headline="$name: the CHECK could not run (exit $code)"
  again="$name: the CHECK still cannot run (exit $code)"
  aside=" The probe is missing or not executable; this says nothing either way about $name itself."
fi

send=""
if [ "$m_announced" = 0 ] && [ "$m_fails" -ge "$CONFIRM" ]; then
  send="$headline — $m_fails consecutive failed checks since $(date -u -r "$m_since" +%FT%TZ 2>/dev/null || date -u +%FT%TZ).${aside} ${tail_text:-no output.}"
elif [ "$m_announced" = 1 ] && [ $((now - m_notified)) -ge "$REMIND" ]; then
  send="$again, $(duration $((now - m_since))) now.${aside} ${tail_text:-no output.}"
fi

if [ -n "$send" ]; then
  if warda_notify "$send"; then
    m_announced=1; m_notified="$now"; m_undelivered=0
  else
    m_undelivered=$((m_undelivered + 1))
    echo "$name: alert NOT delivered ($m_undelivered pending). $(warda_notify_configured || echo 'ops/alerts.env has no WARDA_TELEGRAM_TOKEN/CHAT')" >&2
  fi
fi

save "$state"
exit "$code"
