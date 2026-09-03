#!/bin/bash
#
# Install (or re-install) the hourly reading in your crontab.
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

SCRIPT="$HOME/Desktop/warda/ops/hourly-reading.sh"
LOG="$HOME/Library/Logs/warda-agent.log"
ENTRY="17 * * * * $SCRIPT >> $LOG 2>&1"

if [ ! -x "$SCRIPT" ]; then
  echo "not found or not executable: $SCRIPT" >&2
  exit 1
fi

# Minute 17 rather than 0: nothing else is likely to be running then, and a
# schedule that fires on the hour with everything else on the machine is a
# schedule that competes for the same disk.
current="$(crontab -l 2>/dev/null || true)"
printf '%s\n' "$current" | grep -v -F "hourly-reading.sh" | grep -v '^[[:space:]]*$' > /tmp/warda-cron.$$
printf '%s\n' "$ENTRY" >> /tmp/warda-cron.$$
crontab /tmp/warda-cron.$$
rm -f /tmp/warda-cron.$$

echo "installed. your crontab is now:"
echo
crontab -l
echo
echo "next run is at :17 past the hour. then check:"
echo "  tail $LOG"
echo "  ls $HOME/Desktop/warda/agent/readings/"
echo
echo "If the log says 'Operation not permitted', cron needs Full Disk Access:"
echo "System Settings > Privacy & Security > Full Disk Access > add /usr/sbin/cron"
