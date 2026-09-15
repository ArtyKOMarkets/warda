#!/bin/bash
#
# Install (or re-install) the scheduled jobs in your crontab.
#
#   ops/install-cron.sh            the hourly reading
#   ops/install-cron.sh --buy      that, and agent #003's daily purchase
#   ops/install-cron.sh --interop  and agent #005 buying from a third party
#
# This script exists because a crontab LINE and a shell COMMAND look identical
# in a chat window, and pasting one where the other belongs does nothing
# visible — the `>> log 2>&1` on the end swallows the shell's complaint. It has
# happened three times on this project.
#
# So there is no line to paste. Run this, and it edits the crontab for you:
# existing entries are kept, any previous entry for this script is replaced
# rather than duplicated, and the result is printed so you can see what you have.
set -euo pipefail

OPS="$HOME/Desktop/warda/ops"
SCRIPT="$OPS/hourly-reading.sh"
LOG="$HOME/Library/Logs/warda-agent.log"
ENTRY="17 * * * * $SCRIPT >> $LOG 2>&1"

# Agent #003 buying agent #001's digest, once a day. Opt-in with --buy,
# because unlike the reading this one SPENDS: about 0.04 KAS a run, against a
# grant that will not top itself up. See ops/daily-buy.sh.
BUY="$OPS/daily-buy.sh"
BUYLOG="$HOME/Library/Logs/warda-buy.log"
# 09:41, not on the hour and not at midnight: the reading runs at :17, and a
# purchase wants a digest that already exists rather than one being written.
BUYENTRY="41 9 * * * $BUY >> $BUYLOG 2>&1"

# Agent #005 buying from demo.kaspa-x402.org, once a day. Opt-in for the same
# reason as --buy: it SPENDS, about 0.22 KAS a run against 2.55 remaining, so
# roughly eleven days. It is also the only thing watching for the relayed
# payment that settled on chain and came back `invalid_transaction_state` on
# 15 September, which the next run did not reproduce and nobody has explained.
# An intermittent failure only becomes a rate if something keeps trying.
INTEROP="$OPS/daily-interop.sh"
INTEROPLOG="$HOME/Library/Logs/warda-interop.log"
# 09:23: after first-contact at :07 and before #003's buy at :41, so three jobs
# that all touch the chain are not queued behind each other.
INTEROPENTRY="23 9 * * * $INTEROP >> $INTEROPLOG 2>&1"

# Is the endpoint /start sends a stranger at actually answering? Not opt-in:
# it costs nothing, it touches no key and moves no coin, and the failure it
# watches for went unnoticed for days the last time it happened.
# Has anyone who is not us started using this? Weekly, Monday morning, because
# the answer changes on the scale of weeks and a daily check would train you to
# ignore it. Exit 10 means a stranger paid the demo vendor.
CONTACT="$OPS/first-contact.sh"
CONTACTLOG="$HOME/Library/Logs/warda-first-contact.log"
# Daily, not Mondays. Weekly was right while nothing was happening; the first
# post that could actually bring somebody went out on a Thursday, and a
# detector that next looks in five days is a detector that misses the arrival
# it was built for. The run costs two API calls and one node query.
CONTACTENTRY="7 9 * * * $OPS/first-contact.sh --quiet >> $CONTACTLOG 2>&1"

# The public node proxy, checked every five minutes rather than supervised.
# Cron cannot keep a daemon alive, but the failure being guarded against is a
# laptop that slept — and noticing that within five minutes is the requirement.
PROXY="$OPS/proxy-up.sh"
PROXYLOG="$HOME/Library/Logs/warda-proxy.log"
PROXYENTRY="*/5 * * * * $OPS/proxy-up.sh >> $PROXYLOG 2>&1"

# The public quickstart node, checked every fifteen minutes like the vendor.
# Same reasoning: /start is about to point a stranger at it, and the failure
# to avoid is a page that stays quiet while the endpoint behind it is dead.
NODECHK="$OPS/check-node.sh"
NODELOG="$HOME/Library/Logs/warda-node.log"
NODEENTRY="*/15 * * * * $OPS/check-node.sh --quiet >> $NODELOG 2>&1"

VENDOR="$OPS/check-vendor.sh"
VENDORLOG="$HOME/Library/Logs/warda-vendor.log"
VENDORENTRY="*/15 * * * * $VENDOR --quiet >> $VENDORLOG 2>&1"
WANT_BUY=""
NO_BUY=""
WANT_INTEROP=""
NO_INTEROP=""
for a in "$@"; do
  [ "$a" = "--buy" ] && WANT_BUY=1
  [ "$a" = "--no-buy" ] && NO_BUY=1
  [ "$a" = "--interop" ] && WANT_INTEROP=1
  [ "$a" = "--no-interop" ] && NO_INTEROP=1
done

if [ ! -x "$SCRIPT" ]; then
  echo "not found or not executable: $SCRIPT" >&2
  exit 1
fi
if [ -n "$WANT_BUY" ] && [ ! -x "$BUY" ]; then
  echo "not found or not executable: $BUY" >&2
  exit 1
fi
if [ -n "$WANT_INTEROP" ] && [ ! -x "$INTEROP" ]; then
  echo "not found or not executable: $INTEROP" >&2
  exit 1
fi

# Minute 17 rather than 0: nothing else is likely to be running then, and a
# schedule that fires on the hour with everything else on the machine is a
# schedule that competes for the same disk.
# Every script this installs has to be executable, checked HERE.
#
# `check-vendor.sh` shipped without its exec bit — created through a mount that
# did not carry the mode, and git recorded 100644. Running it by hand said
# "permission denied", which is at least loud. Under cron it would have said
# nothing anyone reads: the entry fires every fifteen minutes, fails instantly,
# and appends to a log whose whole purpose is to be empty when things are well.
# A monitor that cannot start looks exactly like a monitor with nothing to
# report.
#
# So: fix it if we can, refuse if we cannot. Installing a schedule of commands
# that cannot run is worse than installing nothing, because the crontab then
# says the job exists.
for f in "$SCRIPT" "$BUY" "$INTEROP" "$VENDOR" "$CONTACT" "$PROXY" "$NODECHK"; do
  [ -f "$f" ] || continue
  [ -x "$f" ] && continue
  chmod +x "$f" 2>/dev/null || true
  if [ ! -x "$f" ]; then
    echo "$f is not executable and could not be made so." >&2
    echo "  cron would fail on it every time it fired, silently. Fix it and re-run:" >&2
    echo "    chmod +x $f" >&2
    exit 1
  fi
  echo "made $f executable."
done

current="$(crontab -l 2>/dev/null || true)"

# An installed job is not re-installed by being asked for again — it is
# re-installed by not being FORGOTTEN. This script strips its own lines and
# re-adds them, so an opt-in job was silently removed by any later run without
# the flag. That is exactly what happened: #003's daily buy was installed on 7
# September with --buy, removed by a subsequent run without it, and the absence
# was invisible because a job that never runs writes no log to notice is empty.
#
# So --buy now means "add it", not "keep it", and removing takes --no-buy.
if printf '%s\n' "$current" | grep -q -F "daily-buy.sh"; then
  if [ -n "$NO_BUY" ]; then
    echo "removing agent #003's daily buy, as asked."
  else
    WANT_BUY=1
  fi
fi
if printf '%s\n' "$current" | grep -q -F "daily-interop.sh"; then
  if [ -n "$NO_INTEROP" ]; then
    echo "removing agent #005's daily interop buy, as asked."
  else
    WANT_INTEROP=1
  fi
fi

printf '%s\n' "$current" \
  | grep -v -F "hourly-reading.sh" \
  | grep -v -F "daily-buy.sh" \
  | grep -v -F "daily-interop.sh" \
  | grep -v -F "check-vendor.sh" \
  | grep -v -F "first-contact.sh" \
  | grep -v -F "proxy-up.sh" \
  | grep -v -F "check-node.sh" \
  | grep -v '^[[:space:]]*$' > /tmp/warda-cron.$$
printf '%s\n' "$ENTRY" >> /tmp/warda-cron.$$
printf '%s\n' "$VENDORENTRY" >> /tmp/warda-cron.$$
printf '%s\n' "$CONTACTENTRY" >> /tmp/warda-cron.$$
printf '%s\n' "$PROXYENTRY" >> /tmp/warda-cron.$$
printf '%s\n' "$NODEENTRY" >> /tmp/warda-cron.$$
if [ -n "$WANT_BUY" ]; then printf '%s\n' "$BUYENTRY" >> /tmp/warda-cron.$$; fi
if [ -n "$WANT_INTEROP" ]; then printf '%s\n' "$INTEROPENTRY" >> /tmp/warda-cron.$$; fi
crontab /tmp/warda-cron.$$
rm -f /tmp/warda-cron.$$

echo "installed. your crontab is now:"
echo
crontab -l
echo
echo "next reading is at :17 past the hour. then check:"
echo "  tail $LOG"
echo
echo "the demo vendor is checked every 15 minutes. It writes"
echo "site/src/vendor-status.json, which refresh-demo.sh deploys and /start"
echo "reads — so a stranger arriving while it is broken is told, rather than"
echo "sent at a dead endpoint. Failures only:"
echo "  tail $VENDORLOG"
echo "  ls $HOME/Desktop/warda/agent/readings/"
if [ -n "$WANT_BUY" ]; then
  echo
  echo "agent #003 buys daily at 09:41. It spends ~0.04 KAS a run against a"
  echo "grant that does NOT refill — roughly forty days from a 1.75 KAS balance."
  echo "When it runs dry it starts failing, and that is the correct behaviour:"
  echo "a cron that tops up a grant has reinvented the hot wallet."
  echo "  tail $BUYLOG"
  echo "  ls $HOME/Desktop/warda/agent-003/purchases/"
fi
if [ -n "$WANT_INTEROP" ]; then
  echo
  echo "agent #005 buys from demo.kaspa-x402.org at 09:23 — a vendor nobody here"
  echo "controls. ~0.22 KAS a run against 2.55 remaining, so about eleven days,"
  echo "and it does not top itself up either. It writes site/src/interop-status.json"
  echo "on EVERY outcome, including the failures, so a run that dies shows up as"
  echo "the claim going stale rather than as a stale green."
  echo "  tail $INTEROPLOG"
  echo "  cat $HOME/Desktop/warda/site/src/interop-status.json"
fi
echo
echo "If the log says 'Operation not permitted', cron needs Full Disk Access:"
echo "System Settings > Privacy & Security > Full Disk Access > add /usr/sbin/cron"
