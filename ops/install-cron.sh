#!/bin/bash
#
# Install (or re-install) the scheduled jobs in your crontab.
#
#   ops/install-cron.sh            the hourly reading
#   ops/install-cron.sh --buy      that, and agent #003's daily purchase
#   ops/install-cron.sh --interop  and agent #005 buying from a third party
#   ops/install-cron.sh --growth   and the growth fleet's weekly batch
#   ops/install-cron.sh --grants   and pending grant requests are issued
#                                  without waiting for a person
#   ops/install-cron.sh --listener and the Listener's twice-daily X pass
#   ops/install-cron.sh --auditor  and keeps the covenant auditor answering
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

# The growth fleet's week: a batch grant, Scout buying records from
# Researcher, drafts for a person to read. Opt-in, because it SPENDS — about
# 0.05 KAS a record plus fees, from the funder key. Monday 10:13, after the
# morning buys, so three chain jobs are not queued behind each other.
GROWTH="$OPS/weekly-growth.sh"
GROWTHLOG="$HOME/Library/Logs/warda-growth.log"
GROWTHENTRY="13 10 * * 1 $GROWTH >> $GROWTHLOG 2>&1"

# The Listener: X conversations worth replying to, twice a day, to Telegram.
# Opt-in, because it SPENDS — and unlike everything else here it spends
# DOLLARS, on the X developer account, about $0.15 a pass. No covenant bounds
# it yet; the cap is in tools/listen.ts. 08:13 and 20:13, twelve hours apart
# to match the grant's epoch, and off the hour so it is not queued behind the
# jobs that touch the chain.
LISTENER="$OPS/listener-pass.sh"
LISTENERLOG="$HOME/Library/Logs/warda-listener.log"
LISTENERENTRY="13 8,20 * * * $LISTENER >> $LISTENERLOG 2>&1"

# The heartbeat, at 21:05 -- after the evening pass, so its report includes
# the pass that just ran. The pass itself is deliberately silent when it finds
# nothing; this is what keeps that silence readable, because a spent epoch, a
# quiet day and a dead cron are otherwise the same message. Moving the pass
# off 12-hour spacing was considered and is WRONG: with an 11-hour gap the
# software epoch never rolls on that pass at all. The fix for that lives in
# rollEpoch in growth/tools/listen.ts, not in this schedule.
# The unattended grant issuer. Opt-in, because it gives testnet money away
# without asking — which is the point, and is still not a thing to switch on
# by surprise. Off the quarter-hour so it is not queued behind the watchers.
# ops/grants.ts refuses to run it against the main funder; it funds from
# ops/auto-issue.key and the float's balance is the only bound on genesis.
AUTOISSUE="$OPS/auto-issue.sh"
AUTOISSUELOG="$HOME/Library/Logs/warda-grants.log"
AUTOISSUEENTRY="7,22,37,52 * * * * $AUTOISSUE >> $AUTOISSUELOG 2>&1"

# And once a day, what the fifteen-minute job is deliberately quiet about: a
# float that has emptied or fragmented looks exactly like a quiet week, and
# /grant goes back to queueing people behind a page promising fifteen minutes.
GRANTSBEAT="$OPS/grants-heartbeat.sh"
GRANTSBEATENTRY="10 21 * * * $GRANTSBEAT >> $AUTOISSUELOG 2>&1"

HEARTBEAT="$OPS/listener-heartbeat.sh"
HEARTBEATENTRY="5 21 * * * $HEARTBEAT >> $LISTENERLOG 2>&1"

# The seller the Listener buys from, kept alive the way the proxy is. A
# LaunchAgent cannot do this: launchd spawns outside cron's Full Disk Access
# grant, so it cannot read a script in ~/Desktop at all. Installed with
# --listener, because a pass with nothing to buy from is not a working pass.
XREADSUP="$OPS/xreads-up.sh"

# The covenant auditor. Unlike everything else opt-in here it does not spend —
# it EARNS, and it is LISTED: the registry re-fetches its manifest from that
# host on every request, so when it is down a stranger looking for it is told
# so in public. That is the honest behaviour and still a public one, which is
# why it is worth a keepalive the Listener's private seller would not need.
AUDITORUP="$OPS/auditor-up.sh"
AUDITORLOG="$HOME/Library/Logs/warda-auditor.log"

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

# All three endpoint monitors below run through ops/monitor.sh. On their own
# they write an honest status file and exit 1 into a log, which is where the
# verification outage would have been recorded, promptly, unread. The wrapper
# turns a change of state into a message and leaves an unchanged state silent —
# see its header for why the edge, and not the failure, is the thing to send.
MONITOR="$OPS/monitor.sh"

# The public quickstart node, checked every fifteen minutes like the vendor.
# Same reasoning: /start is about to point a stranger at it, and the failure
# to avoid is a page that stays quiet while the endpoint behind it is dead.
NODECHK="$OPS/check-node.sh"
NODELOG="$HOME/Library/Logs/warda-node.log"
NODEENTRY="*/15 * * * * $MONITOR node $OPS/check-node.sh --quiet >> $NODELOG 2>&1"

# Every 15 minutes, beside the vendor monitor and for a sharper reason: the
# verification API returned `internal` to every request for an unknown length
# of time and nothing said so. It is the endpoint whose whole purpose is that a
# stranger does not have to trust us.
VERIFY="$OPS/check-verify.sh"
VERIFYLOG="$HOME/Library/Logs/warda-verify.log"
VERIFYENTRY="*/15 * * * * $MONITOR verify $VERIFY --quiet >> $VERIFYLOG 2>&1"

# The alerts. Notify-only by construction — ops/alerts.ts holds no key, signs
# nothing and builds no transaction — so it is as safe to schedule as the
# monitors above, and unlike them it watches YOUR grants rather than our
# endpoints.
#
# Installed only when ops/alerts.json exists. Without rules it exits 1 on every
# run, and a job that fails four times an hour into a log is a log nobody
# opens — which would cost us the next real failure written in the same file.
# Minutes 8/23/38/53: the three monitors above all fire at 0,15,30,45 and all
# three touch the node, and queueing a fourth behind them is how a reading
# times out for a reason that has nothing to do with the chain.
ALERTS="$OPS/alerts.sh"
ALERTSLOG="$HOME/Library/Logs/warda-alerts.log"
ALERTSENTRY="8,23,38,53 * * * * $ALERTS --quiet >> $ALERTSLOG 2>&1"

# Console accounts' rules, evaluated on the server; this is only the clock.
# Installed when ops/alerts.env has CONSOLE_CRON_SECRET. Minutes 11/26/41/56.
CONSOLEAL="$OPS/console-alerts.sh"
CONSOLEALLOG="$HOME/Library/Logs/warda-console-alerts.log"
CONSOLEALENTRY="11,26,41,56 * * * * $CONSOLEAL --quiet >> $CONSOLEALLOG 2>&1"

VENDOR="$OPS/check-vendor.sh"
VENDORLOG="$HOME/Library/Logs/warda-vendor.log"
VENDORENTRY="*/15 * * * * $MONITOR vendor $VENDOR --quiet >> $VENDORLOG 2>&1"
WANT_BUY=""
NO_BUY=""
WANT_INTEROP=""
NO_INTEROP=""
WANT_GROWTH=""
WANT_GRANTS=""
NO_GRANTS=""
WANT_LISTENER=""
NO_LISTENER=""
WANT_AUDITOR=""
NO_AUDITOR=""
NO_GROWTH=""
for a in "$@"; do
  [ "$a" = "--buy" ] && WANT_BUY=1
  [ "$a" = "--no-buy" ] && NO_BUY=1
  [ "$a" = "--interop" ] && WANT_INTEROP=1
  [ "$a" = "--no-interop" ] && NO_INTEROP=1
  [ "$a" = "--growth" ] && WANT_GROWTH=1
  [ "$a" = "--no-growth" ] && NO_GROWTH=1
  [ "$a" = "--grants" ] && WANT_GRANTS=1
  [ "$a" = "--no-grants" ] && NO_GRANTS=1
  [ "$a" = "--listener" ] && WANT_LISTENER=1
  [ "$a" = "--no-listener" ] && NO_LISTENER=1
  [ "$a" = "--auditor" ] && WANT_AUDITOR=1
  [ "$a" = "--no-auditor" ] && NO_AUDITOR=1
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
for f in "$SCRIPT" "$BUY" "$INTEROP" "$GROWTH" "$VENDOR" "$VERIFY" "$CONTACT" "$PROXY" "$NODECHK" "$ALERTS" "$CONSOLEAL" "$MONITOR"; do
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

# The wrapper has to be able to speak. Without a token it degrades to exactly
# what it replaced — an exit code in a log — and it degrades QUIETLY, which is
# the failure it was written to remove. This is the one moment a person is
# present to hear about it, so it is said here and nowhere else.
#
# Asked by SOURCING alerts.env and calling the sender's own predicate, in a
# subshell so nothing from it survives into this script. The first version of
# this grepped for `TOKEN="."` — a regex that matches a one-character token and
# nothing longer, so it fired on a perfectly configured machine. A warning that
# cries wolf on a correct setup is worse than no warning: the next person to
# see it will install anyway, and the time it is telling the truth will look
# exactly the same. One predicate, in one place, used by both.
if ! ( set +u
       [ -f "$OPS/alerts.env" ] && . "$OPS/alerts.env"
       . "$OPS/notify.sh"
       warda_notify_configured ); then
  echo >&2
  echo "WARNING: ops/alerts.env has no Telegram token and chat id." >&2
  echo "  The three endpoint monitors will run, write their status files and" >&2
  echo "  exit 1 into a log, exactly as before — nobody will be told. Fill in" >&2
  echo "  ops/alerts.env (see alerts.env.example) and re-run this." >&2
  echo "  Alerts raised meanwhile are not lost: they stay pending and go out" >&2
  echo "  on the first run that can deliver them." >&2
  echo >&2
fi

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

if printf '%s\n' "$current" | grep -q -F "weekly-growth.sh"; then
  if [ -n "$NO_GROWTH" ]; then
    echo "removing the growth fleet's weekly batch, as asked."
  else
    WANT_GROWTH=1
  fi
fi

if printf '%s\n' "$current" | grep -q -F "auditor-up.sh"; then
  if [ -n "$NO_AUDITOR" ]; then
    echo "removing the covenant auditor's keepalive, as asked."
  else
    WANT_AUDITOR=1
  fi
fi

if printf '%s\n' "$current" | grep -q -F "auto-issue.sh"; then
  if [ -n "$NO_GRANTS" ]; then
    echo "removing the unattended grant issuer, as asked. Requests go back to waiting for you."
  else
    WANT_GRANTS=1
  fi
fi
if printf '%s\n' "$current" | grep -q -F "listener-pass.sh"; then
  if [ -n "$NO_LISTENER" ]; then
    echo "removing the Listener's twice-daily X pass, as asked."
  else
    WANT_LISTENER=1
  fi
fi

printf '%s\n' "$current" \
  | grep -v -F "hourly-reading.sh" \
  | grep -v -F "weekly-growth.sh" \
  | grep -v -F "listener-pass.sh" \
  | grep -v -F "listener-heartbeat.sh" \
  | grep -v -F "auto-issue.sh" \
  | grep -v -F "grants-heartbeat.sh" \
  | grep -v -F "xreads-up.sh" \
  | grep -v -F "auditor-up.sh" \
  | grep -v -F "daily-buy.sh" \
  | grep -v -F "daily-interop.sh" \
  | grep -v -F "check-vendor.sh" \
  | grep -v -F "first-contact.sh" \
  | grep -v -F "proxy-up.sh" \
  | grep -v -F "check-node.sh" \
  | grep -v -F "check-verify.sh" \
  | grep -v -F "alerts.sh" \
  | grep -v '^[[:space:]]*$' > /tmp/warda-cron.$$
printf '%s\n' "$ENTRY" >> /tmp/warda-cron.$$
printf '%s\n' "$VENDORENTRY" >> /tmp/warda-cron.$$
printf '%s\n' "$CONTACTENTRY" >> /tmp/warda-cron.$$
printf '%s\n' "$PROXYENTRY" >> /tmp/warda-cron.$$
printf '%s\n' "$NODEENTRY" >> /tmp/warda-cron.$$
printf '%s\n' "$VERIFYENTRY" >> /tmp/warda-cron.$$
if [ -f "$OPS/alerts.json" ]; then printf '%s\n' "$ALERTSENTRY" >> /tmp/warda-cron.$$; fi
if [ -f "$OPS/alerts.env" ] && grep -q '^CONSOLE_CRON_SECRET=.' "$OPS/alerts.env"; then printf '%s\n' "$CONSOLEALENTRY" >> /tmp/warda-cron.$$; fi
if [ -n "$WANT_BUY" ]; then printf '%s\n' "$BUYENTRY" >> /tmp/warda-cron.$$; fi
if [ -n "$WANT_INTEROP" ]; then printf '%s\n' "$INTEROPENTRY" >> /tmp/warda-cron.$$; fi
if [ -n "$WANT_GROWTH" ]; then printf '%s\n' "$GROWTHENTRY" >> /tmp/warda-cron.$$; fi
if [ -n "$WANT_AUDITOR" ]; then printf '%s\n' "*/5 * * * * $AUDITORUP >> $AUDITORLOG 2>&1" >> /tmp/warda-cron.$$; fi
if [ -n "$WANT_GRANTS" ]; then
  printf '%s\n' "$AUTOISSUEENTRY" >> /tmp/warda-cron.$$
  printf '%s\n' "$GRANTSBEATENTRY" >> /tmp/warda-cron.$$
fi
if [ -n "$WANT_LISTENER" ]; then
  printf '%s\n' "$LISTENERENTRY" >> /tmp/warda-cron.$$
  printf '%s\n' "$HEARTBEATENTRY" >> /tmp/warda-cron.$$
  printf '%s\n' "*/5 * * * * $XREADSUP >> $LISTENERLOG 2>&1" >> /tmp/warda-cron.$$
fi
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
if [ -f "$OPS/alerts.json" ]; then
if [ -n "$WANT_GRANTS" ]; then
  cat <<TXT

pending grant requests are issued at 7/22/37/52 past the hour, without
waiting for you. Oldest first, ten a day, five KAS each by default
(ops/grants.ts --budget, --max-per-day). A request it
cannot serve stays PENDING and you get the message you always got — the
applicant keeps their place, so nothing is lost by the robot stopping.

It funds from ops/auto-issue.key and refuses to run against the main
funder. That refusal is the whole safety story: genesis is created FROM an
ordinary wallet, so no covenant bounds it and the float's balance is the
only limit there is. Keep in it what a bad week may cost.

Few large coins, not many small ones: genesis takes ONE input, so a float
of faucet drips fails with money in the wallet. If that happens the
message says to consolidate rather than refill.
  node --experimental-strip-types ops/grants.ts auto --dry-run
  tail $AUTOISSUELOG
  ops/install-cron.sh --no-grants     to stop it

A heartbeat at 21:10 reports the float and the queue once a day, and
shouts if the float cannot fund a grant or something has been pending
more than an hour. The fifteen-minute job stays quiet; this is what
makes its silence readable.
TXT
fi

if [ -n "$WANT_LISTENER" ]; then
  cat <<LISTENERNOTE

the Listener searches X at 08:13 and 20:13 and sends what is worth a reply
to Telegram, with a link. It posts nothing and replies to nothing — the
decision to speak stays with you.

It spends twice over. The agent pays the seller in testnet KAS from a grant
the network enforces — three searches an epoch, and the covenant refuses the
fourth whatever any file here says. The seller then pays X in dollars,
\$0.005 a post read, about \$0.15 a pass and \$2.10 a week, on the card behind
your developer account. The chain bounds the agent; nothing bounds the card.
  tail $LISTENERLOG
  ls $HOME/Desktop/warda/growth/listener/

It needs X_BEARER_TOKEN in growth/listener.env. A token exported into a
terminal is invisible to cron, and the pass will tell you so on Telegram
rather than dying into the log.
LISTENERNOTE
fi

  echo "your alert rules are watched at 8/23/38/53 past the hour. This NOTIFIES and"
  echo "never acts: it holds no key and builds no transaction, so the worst it can"
  echo "do is tell you something. Only CHANGES are sent, including the change back."
  echo "  ops/alerts.sh --dry-run"
  echo "  tail $ALERTSLOG"
else
  echo "no alert rules installed. There is nothing watching your grants:"
  echo "  cp ops/alerts.example.json ops/alerts.json    (or compose one at /app)"
  echo "  cp ops/alerts.env.example ops/alerts.env      then ops/alerts.sh --test"
  echo "  ops/install-cron.sh                           run this again to schedule it"
fi

echo
echo "If the log says 'Operation not permitted', cron needs Full Disk Access:"
echo "System Settings > Privacy & Security > Full Disk Access > add /usr/sbin/cron"
