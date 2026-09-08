#!/bin/bash
#
# Install (or re-install) the scheduled jobs in your crontab.
#
#   ops/install-cron.sh            the hourly reading
#   ops/install-cron.sh --buy      that, and agent #003's daily purchase
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
WANT_BUY=""
for a in "$@"; do [ "$a" = "--buy" ] && WANT_BUY=1; done

if [ ! -x "$SCRIPT" ]; then
  echo "not found or not executable: $SCRIPT" >&2
  exit 1
fi
if [ -n "$WANT_BUY" ] && [ ! -x "$BUY" ]; then
  echo "not found or not executable: $BUY" >&2
  exit 1
fi

# Minute 17 rather than 0: nothing else is likely to be running then, and a
# schedule that fires on the hour with everything else on the machine is a
# schedule that competes for the same disk.
current="$(crontab -l 2>/dev/null || true)"
printf '%s\n' "$current" \
  | grep -v -F "hourly-reading.sh" \
  | grep -v -F "daily-buy.sh" \
  | grep -v '^[[:space:]]*$' > /tmp/warda-cron.$$
printf '%s\n' "$ENTRY" >> /tmp/warda-cron.$$
if [ -n "$WANT_BUY" ]; then printf '%s\n' "$BUYENTRY" >> /tmp/warda-cron.$$; fi
crontab /tmp/warda-cron.$$
rm -f /tmp/warda-cron.$$

echo "installed. your crontab is now:"
echo
crontab -l
echo
echo "next reading is at :17 past the hour. then check:"
echo "  tail $LOG"
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
echo
echo "If the log says 'Operation not permitted', cron needs Full Disk Access:"
echo "System Settings > Privacy & Security > Full Disk Access > add /usr/sbin/cron"
