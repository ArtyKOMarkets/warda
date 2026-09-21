#!/bin/bash
#
# The growth fleet's week, unattended. Installed by `ops/install-cron.sh --growth`
# for Monday 10:13.
#
# Opens a batch grant, has Scout search GitHub and buy one checkable record per
# candidate from Researcher, settles Scout home, ends the batch grant, and
# writes growth/batches/<week>/drafts.md — messages for a person to read and
# send, or not. Nothing here contacts anyone.
#
# Spends testnet KAS only: about 0.05 KAS a record plus fees, from the funder
# key's largest coin, and the batch grant is revoked at the end so the
# remainder goes home. A week that stops half way resumes on the next run.
set -uo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"
[ -f "$REPO/ops/node.env" ] && . "$REPO/ops/node.env"
[ -f "$REPO/ops/alerts.env" ] && . "$REPO/ops/alerts.env"
[ -f "$REPO/growth/weekly.env" ] && . "$REPO/growth/weekly.env"

cd "$REPO"
echo "── $(date -u +%FT%TZ) growth week"
node --experimental-strip-types growth/tools/week.ts "$@"
rc=$?
case $rc in
  0) echo "done." ;;
  4) echo "PAID AND NOT SERVED somewhere in this week. Read the log above before re-running." >&2 ;;
  *) echo "stopped with $rc. Re-running resumes at the step that stopped." >&2 ;;
esac
exit $rc
