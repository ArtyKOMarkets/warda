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
# ## The exit codes it reads
#
# Not every non-zero is an outage, and saying so is most of this file's value.
#
#   0        healthy
#   2        the probe ran and cannot check (not configured)
#   3        the covenant refused — the grant working, not a failure
#   4        paid and not served — sent EVERY time, it costs money each time
#   5        every purchase failed — nothing spent, nothing bought
#   126/127  the probe could not start
#   anything else  down
#
# 3, 4 and 5 are `agents/tools/buy.ts`'s documented codes, unchanged.
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

  # A probe that STARTS and reports it cannot check is the same class, and it
  # is the one that actually happened: check-node.sh exits 2 when the funnel URL
  # is unset, and this wrapper called that "node is DOWN, 24h 30m now" while
  # printing the probe's own "nothing to check" underneath it.
  rm -rf "$tmp/state"; : > "$sink"
  cat > "$tmp/unconfigured" <<'NOCFG'
#!/bin/bash
echo "WARDA_PUBLIC_NODE is not set — nothing to check." >&2
exit 2
NOCFG
  chmod +x "$tmp/unconfigured"
  for i in 1 2; do
    WARDA_NOTIFY_SINK="$sink" WARDA_MONITOR_NO_ENV=1 WARDA_REPO="$REPO" \
      WARDA_MONITOR_STATE="$tmp/state" "$0" selftest "$tmp/unconfigured" >/dev/null 2>&1
  done
  if grep -q "CHECK cannot run" "$sink" && ! grep -q "is DOWN" "$sink"; then
    echo "ok    a probe that is not configured says so, instead of blaming the endpoint"
  else
    echo "FAIL  exit 2 reported as: $(tail -n1 "$sink")"; fails=$((fails + 1))
  fi

  # The buy protocol's codes, each of which used to read as "DOWN".
  code_case() { # code_case <exit> <runs> <expected sends> <substring> <label>
    rm -rf "$tmp/state"; : > "$sink"
    cat > "$tmp/coded" <<CODED
#!/bin/bash
echo "the tool said something about exit $1" >&2
exit $1
CODED
    chmod +x "$tmp/coded"
    # A counting `while`, not `for i in $(seq 1 "$2")`.
    #
    # $2 is 1 or 2 here so seq would behave — but BSD seq counts DOWN when the
    # end is below the start, and ops/check-portable.mjs learned that rule an hour
    # ago from ops/principal-bundle.sh dying on the Mac with "!i: unbound
    # variable". A construct that is only safe because of the values it happens to
    # get today is one somebody changes tomorrow.
    local i=0
    while [ "$i" -lt "$2" ]; do
      i=$((i + 1))
      WARDA_NOTIFY_SINK="$sink" WARDA_MONITOR_NO_ENV=1 WARDA_REPO="$REPO" \
        WARDA_MONITOR_STATE="$tmp/state" "$0" selftest "$tmp/coded" >/dev/null 2>&1
    done
    # Counted by OCCURRENCES of the headline, not by lines: the exit-4 alert is
    # three lines long, and a line count read that as three alerts.
    local got; got="$(grep -c -i -- "$4" "$sink" | tr -d ' ')"
    if [ "$got" != "$3" ]; then
      echo "FAIL  $5: expected $3 '$4' message(s) from $2 run(s), got $got"; fails=$((fails + 1)); return
    fi
    if grep -q "is DOWN" "$sink"; then
      echo "FAIL  $5: still called it DOWN — $(tail -n1 "$sink")"; fails=$((fails + 1)); return
    fi
    echo "ok    $5"
  }

  code_case 3 2 1 "covenant REFUSED" "a covenant refusal is the grant working, not an outage"
  code_case 5 2 1 "every purchase FAILED" "every buy failing is not the same as a refusal"
  # Two runs, TWO alerts. The whole point: each one is another payment, so
  # edge-triggering would swallow the second loss.
  code_case 4 2 2 "PAID AND NOT SERVED" "paid-and-unserved is sent every single time"
  if grep -q "Do NOT re-run" "$sink"; then
    echo "ok    and it says what not to do, which is the instinct that doubles the loss"
  else
    echo "FAIL  exit 4 alert does not warn against re-running"; fails=$((fails + 1))
  fi
  # CONFIRM is not consulted for 4: one run, one alert.
  rm -rf "$tmp/state"; : > "$sink"
  WARDA_NOTIFY_SINK="$sink" WARDA_MONITOR_NO_ENV=1 WARDA_REPO="$REPO" \
    WARDA_MONITOR_STATE="$tmp/state" "$0" selftest "$tmp/coded" >/dev/null 2>&1
  if [ "$(grep -c "PAID AND NOT SERVED" "$sink" | tr -d ' ')" = 1 ]; then
    echo "ok    exit 4 does not wait for CONFIRM — the money is already gone"
  else
    echo "FAIL  exit 4 waited for CONFIRM"; fails=$((fails + 1))
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
#
# Exit 2 is the same class from the other end: the probe STARTED and said it
# could not do its job. check-node.sh exits 2 when WARDA_PUBLIC_NODE is unset,
# and for a day and a half this wrapper turned that into "node is DOWN, 24h 30m
# now" while the node was up and the tunnel was up. The alert even carried the
# probe's own words — "WARDA_PUBLIC_NODE is not set — nothing to check" —
# directly under a headline that contradicted them, which is worse than either
# sentence alone: it invites you to believe the headline and distrust the body.
#
# So 2 means "cannot check" for every probe this wraps, and the probes that
# exit 1 for a real failure are unaffected — check-node, check-vendor and
# check-verify all use 1 for "answered badly" and nothing else uses 2.
headline="$name is DOWN"
again="$name still down"
aside=""
if [ "$code" = 127 ] || [ "$code" = 126 ]; then
  headline="$name: the CHECK could not run (exit $code)"
  again="$name: the CHECK still cannot run (exit $code)"
  aside=" The probe is missing or not executable; this says nothing either way about $name itself."
elif [ "$code" = 2 ]; then
  headline="$name: the CHECK cannot run (exit 2)"
  again="$name: the CHECK still cannot run (exit 2)"
  aside=" The probe says it is not configured to check; this says nothing either way about $name itself."
#
# 3, 4 and 5 are the BUY protocol, which this wrapper now speaks because the
# things worth watching are no longer only endpoints.
#
# `agents/tools/buy.ts` documents its exit codes as "the API when you call this
# from another language", and three agents were calling it from cron with those
# codes going into a log file. When the covenant template moved under them,
# agent-003 and agent-005 failed every purchase for a day with nobody told —
# the same outage as the Listener's, one directory over, and neither of their
# wrappers had anywhere to send.
#
# Wrapping them means the codes have to keep their meanings here. A grant whose
# budget has run out is not "agent-003 is DOWN": it is the grant doing exactly
# what it was made to do, and it deserves one alert and reminders, not a daily
# panic. `ops/check-monitors.mjs` asserts this table against buy.ts's own usage
# text so the two cannot drift.
elif [ "$code" = 3 ]; then
  headline="$name: the covenant REFUSED — nothing was spent"
  again="$name: the covenant is still refusing"
  aside=" This is the grant enforcing its own terms, not a failure: the budget or the epoch allowance is spent. It needs a top-up or a new grant, not a fix."
elif [ "$code" = 5 ]; then
  headline="$name: every purchase FAILED"
  again="$name: every purchase is still failing"
  aside=" Distinct from a refusal: the covenant said nothing, the buys could not be made at all. Nothing was spent and nothing was bought."
fi

# Exit 4 does not belong to the state machine at all.
#
# "Paid and not served": the money settled and the vendor did not deliver. Every
# occurrence is a separate loss, so edge-triggering it would suppress the second
# one — and the second one is another payment. It is sent on every run that
# produces it, before CONFIRM is consulted and regardless of what was announced
# before.
#
# It is also the one alert that must say what NOT to do. The proof is resumable:
# re-running the same command re-presents it and pays nothing, and "run it
# again" is the instinct that turns one loss into two.
if [ "$code" = 4 ]; then
  if warda_notify "$name: PAID AND NOT SERVED. The money settled and the vendor did not deliver.
Do NOT re-run to compensate — that buys it twice. Running the SAME command again re-presents the proof and pays nothing.
${tail_text:-no output.}"; then
    m_undelivered=0
  else
    m_undelivered=$((m_undelivered + 1))
    echo "$name: exit 4 alert NOT delivered ($m_undelivered pending)." >&2
  fi
  save "$state"
  exit "$code"
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
