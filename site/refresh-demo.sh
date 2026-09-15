#!/usr/bin/env bash
#
# Refresh the attack page's snapshot, and redeploy if it changed.
#
#     ./refresh-demo.sh                 # read, rebuild, deploy
#     ./refresh-demo.sh --no-deploy     # read and rebuild only
#     ./refresh-demo.sh --force         # deploy even if nothing changed
#
# Reads the node on localhost:18210 by default. Set WARDA_RESOLVER to a real
# Kaspa Resolver instead if you do not run one — leaving it UNSET is a choice,
# not an omission.
#
# ## Running it on a timer
#
# This is quiet when nothing moved, so it is safe to run often. The line goes
# in `crontab -e`, not in a shell:
#
#     PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin
#     35 * * * * cd $HOME/Desktop/warda/site && ./refresh-demo.sh
#
# Hourly, at :35. It was */20, which is up to 72 deploys a day before anyone
# types anything — and on 10 September that plus a day of --force runs hit
# Vercel's free ceiling of 100, which locks deploying for twenty-four hours.
# The site was mid-correction at the time: /start had been updated to offer a
# node and /build still said you had to run one, and there was no way to ship
# the fix. A deploy budget spent on unchanged content is a deploy you cannot
# make when a page is wrong.
#
# :35 rather than :00 because the hourly reading lands at :17 — this runs after
# it, so a reading and its deploy are one cycle rather than two.
#
# The PATH line is not optional. cron runs with /usr/bin:/bin and nothing else,
# so node, python3 and vercel — installed by homebrew or nvm — are simply not
# found, and the job fails every twenty minutes into mail nobody reads. The
# preflight below turns that into one legible sentence.
#
# On macOS there is a second trap: ~/Desktop is protected by TCC, and a cron
# job cannot read it until /usr/sbin/cron has Full Disk Access (System Settings
# → Privacy & Security). A launchd agent hits the same wall. If the job cannot
# see files you can see from your own terminal, that is why.
#
# ## What it does when somebody spends
#
# A spend MOVES the grant — its address is blake2b of its state — so the card
# and the published manifest both go stale, and the demo stops being
# attemptable. This follows it: `follow-grant.ts` recomputes the new address
# from the payments sitting at the vendor, the card is re-derived, and the page
# republishes. No daemon and no mempool tailing, because a grant's address
# depends on its counters and not on its coin, and the counters are recoverable
# from what the vendor holds.
#
# It gives up rather than guesses when the move was something it cannot model —
# a delegation, a settlement, a revocation. That exits non-zero and says so.
#
# ## The one thing it will not do
#
# It will not mint a new grant. If the grant is gone in a way follow-grant
# cannot account for, this stops and says so rather than quietly starting over:
# a fresh grant abandons the old one's coin at an address nobody can compute,
# and doing that automatically, on a timer, is how a demo silently eats a
# wallet.
#
set -euo pipefail
cd "$(dirname "$0")"

DEPLOY=1
FORCE=0
for arg in "$@"; do
  [ "$arg" = "--no-deploy" ] && DEPLOY=0
  [ "$arg" = "--force" ] && FORCE=1
done

# Named separately from the work, because "node: command not found" three
# layers into a pipeline is a different debugging session from "cron cannot
# see your node".
missing=""
for c in node python3; do command -v "$c" >/dev/null || missing="$missing $c"; done
[ "$DEPLOY" = "1" ] && { command -v vercel >/dev/null || missing="$missing vercel"; }
if [ -n "$missing" ]; then
  echo "not on PATH:$missing" >&2
  echo "PATH is: $PATH" >&2
  echo "Under cron that PATH is /usr/bin:/bin unless you set it yourself — see" >&2
  echo "the header of this script." >&2
  exit 127
fi

# Documentation ellipses have a way of surviving into shell history. An unset
# WARDA_RESOLVER is a real choice — it means "use the node on localhost" — so
# the failure to catch is a value that was never a URL, not a missing one.
case "${WARDA_RESOLVER:-}" in
  *"…"*|*"..."*|*example*|*"<"*)
    echo "WARDA_RESOLVER is set to a placeholder: ${WARDA_RESOLVER}" >&2
    echo "Either name a real resolver, or unset it and use the node on" >&2
    echo "localhost:18210 (started with --rpclisten-json=127.0.0.1:18210)." >&2
    exit 2 ;;
esac

if [ ! -f src/demo-grant.json ]; then
  echo "no src/demo-grant.json — nothing to refresh (the attack page is not built)" >&2
  exit 0
fi

# ---------------------------------------------------------------------------
# 1. Read the chain.
# ---------------------------------------------------------------------------
# Write via a temp file. A snapshot half-written by a run that died mid-fetch
# is worse than yesterday's snapshot: the page would render it.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

snapshot() {
  (cd ../sdk && node --experimental-strip-types tools/demo-state.ts \
      ../site/src/demo-grant.json \
      --manifest ../covenant/deploy/grant-demo.json \
      ${WARDA_RESOLVER:+--resolver "$WARDA_RESOLVER"} \
      ${WARDA_RPC_JSON:+--rpc "$WARDA_RPC_JSON"}) > "$tmp"
}

if ! snapshot; then
  echo "demo-state.ts refused or failed — keeping the previous snapshot" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. If somebody spent, find where the grant went.
# ---------------------------------------------------------------------------
# A spend MOVES the grant: its address is a hash of its state. Left alone, the
# page would keep naming an address holding nothing, and the manifest it
# publishes would let nobody build another spend — the demo would quietly stop
# being attemptable, which is the failure it took a live attempt to notice the
# first time.
#
# follow-grant.ts recomputes where it went from the payments sitting at the
# vendor. It needs no history, no mempool tailing and no daemon, because a
# grant's address depends on its counters and not on its coin.
moved=$(python3 -c "import json,sys; print(json.load(open('$tmp'))['grantStillAtPublishedAddress'])")
if [ "$moved" = "False" ]; then
  vendor=$(python3 -c "import json; print(json.load(open('src/demo-grant.json'))['vendor'])")
  echo "the grant has moved — following it"

  if (cd ../sdk && node --experimental-strip-types tools/follow-grant.ts \
        ../covenant/deploy/grant-demo.json --vendor "$vendor" \
        ${WARDA_RESOLVER:+--resolver "$WARDA_RESOLVER"} \
        ${WARDA_RPC_JSON:+--rpc "$WARDA_RPC_JSON"} --write); then
    # Re-derive the card from the advanced manifest. demo-card.ts checks the
    # key still controls the grant, the list still hashes to the root, and the
    # grant exists funded on chain — so a bad follow cannot reach the page.
    (cd ../sdk && node --experimental-strip-types tools/demo-card.ts \
        ../covenant/deploy/grant-demo.json \
        --key ../covenant/deploy/demo-agent.key \
        --recipients ../covenant/deploy/demo-recipients.txt \
        --emit ../site/src \
        > ../site/src/demo-grant.json) || {
      echo "followed the grant but could not re-derive the card — nothing published" >&2
      exit 1
    }
    snapshot || { echo "could not re-read the chain after following" >&2; exit 1; }
    echo "followed and re-published"
  else
    # follow-grant refuses rather than guesses, so this means something it
    # cannot model happened: a delegation, a settlement, or a revocation.
    echo "" >&2
    echo "COULD NOT FOLLOW THE GRANT. The page still names its old address, which now" >&2
    echo "holds nothing, and the published manifest can no longer build a spend." >&2
    echo "The demo is not attemptable until this is looked at." >&2
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 3. Publish, if anything actually changed.
# ---------------------------------------------------------------------------
# Every run differs in checkedAt alone, so compare on everything else. A cron
# that redeploys twelve times a day to change a timestamp is a cron that
# teaches you to ignore its output.
#
# The comparison is against what was last DEPLOYED, not against what is last on
# disk. Those differ the moment a run builds without deploying (--no-deploy, a
# failed vercel, a cancelled cron), and comparing against disk in that state
# reports "no change" while the site still serves the older snapshot — true
# about the chain, and wrong about the only thing the run is for.
MARK=.last-deployed.sha

cp "$tmp" src/demo-state.json

# The site is BUILT before anything is compared.
#
# This used to compare the snapshot alone and exit before building, on the
# reasoning that the snapshot is the only thing a scheduled run changes. That
# is true of the chain and false of the repository: an edit to src/index.html
# changes the site and not the reading, so the run reported "no change" and the
# fix never shipped. It took a reported bug — a button that did nothing —
# to notice, because nothing about the output said it had been skipped.
#
# So the signature covers the whole built site. demo-state.json is excluded
# from the file walk and folded in with its timestamp stripped, because
# `checkedAt` changes on every reading and would make every run look different.
# The agent dashboards, on the same schedule as everything else.
#
# It was manual, which meant the pages were accurate exactly as often as
# someone remembered — and a dashboard stale by an unknown amount is worse than
# one that says when it was read.
#
# Only #001 and #003. #002 and #004 have both ended — one revoked, one settled
# — so their pages are records rather than dashboards and there is nothing on
# chain left to re-read. #005 buys at 09:23 and is refreshed after that, not
# twenty-four times a day. Twenty node round-trips an hour to re-derive a
# figure that cannot change is not diligence.
#
# THE COMMANDS ARE NOT HERE ANY MORE. They used to be, inline, and build.py
# kept its own copies to print when it drops a page — two sources, which
# drifted: the recorded ones lost #001's --readings, --also and
# --also-recipients and #003's --settled and --mission, and named a manifest
# for #004 that does not exist. Running them succeeded and silently published
# poorer pages. One list, in build.py, run by ops/refresh-agents.sh, which also
# refuses a reading that drops a section the previous one had.
#
# Failure is not fatal: a refresh that cannot reach the node should cost those
# pages their freshness, not stop the site shipping the ones that were fine.
if ! ../ops/refresh-agents.sh agent-001 agent-003; then
  echo "agent dashboard refresh failed — keeping the previous readings" >&2
fi


python3 build.py >/dev/null

# Nothing is deployed that links into a hole. build.py DROPS a page whose data
# is missing — an agent with no reading, the attack page with no live grant —
# and everything linking to it is published regardless, so the site ships
# looking finished with a 404 behind one link. That has happened twice; the
# guard is what stops the third. It exits non-zero and `set -e` stops here,
# before the deploy rather than after it.
node ../ops/check-links.mjs

# And the commands build.py prints when it drops a page. Those are read months
# later by somebody who cannot test them, so a flag that was never real is
# found at the worst possible moment — which already happened once, to the
# agent-005 command, written from the shape of its neighbours rather than from
# the tool.
node ../ops/check-commands.mjs

# And that the scripts here still run on macOS, which is where they run. bash
# 3.2 from 2007 is what `#!/bin/bash` gets there; this file's own note about
# `sort -z` is the previous time that cost something.
node ../ops/check-portable.mjs

sig() { grep -v '"checkedAt"' "$1" 2>/dev/null || true; }

# `sort -z` is a GNU extension and this runs on macOS, where BSD sort does not
# have it — the pipeline then produced nothing, the signature collapsed to the
# reading alone, and a run that had built a whole new page reported "no change".
# Sorting the hash LINES instead needs no extension and no NUL handling.
# Every agent JSON carries `checkedAt`, which moves on every run whether or not
# anything about the agent did. Left in the walk it defeated the whole guard:
# the signature changed every twenty minutes, "no change since the last deploy"
# never fired once, and this deployed around the clock for nothing. Folded in
# with the timestamp stripped, exactly like demo-state.json — same reason, and
# the first file to have it was the only one anybody thought about.
# THREE files have now carried a `checkedAt` into this signature, and each was
# added by someone who had read the warning above and still did not think of
# theirs: demo-state.json (handled from the start), the agent JSONs (a week of
# deploying every twenty minutes), and now vendor-status.json — which moves
# every FIFTEEN minutes, faster than this runs, so the guard would never once
# have fired again.
#
# The pattern is not "remember to add it here". It is that any file written by
# a periodic job carries the time it ran, and the time it ran is not a change
# in what it describes. Both lists below have to name every such file, so they
# are kept adjacent and a new one is two edits in one place rather than a bug
# found a week later.
#
# interop-status.json is the deliberate EXCEPTION, and it is listed here so
# that nobody adds it by following the paragraph above. Its timestamp is not
# incidental to what it describes — it IS what it describes. The landing page
# renders "still true on <date>" and goes silent when the reading is older than
# a day and a half, so a run whose only change is the date still has to reach
# the web or the claim disappears while it is true. Stripping the timestamp
# here would produce exactly the false negative this file spends fifty lines
# guarding against, in the opposite direction. It changes once a day, not every
# fifteen minutes, so it costs one deploy.
TIMESTAMPED_SRC="src/demo-state.json src/vendor-status.json src/node-status.json"

signature() {
  {
    for f in $TIMESTAMPED_SRC; do sig "$f"; done
    for f in src/agent-0*.json; do sig "$f"; done
    find web -type f \
      ! -name demo-state.json \
      ! -name vendor-status.json \
      ! -name node-status.json \
      ! -name 'agent-0*.json' \
      -exec shasum -a 256 {} + | sort
  } | shasum -a 256 | cut -d" " -f1
}
now=$(signature)

if [ "$FORCE" = "0" ] && [ -f "$MARK" ] && [ "$now" = "$(cat "$MARK")" ]; then
  echo "no change since the last deploy — neither the reading nor the site."
  echo "  (--force deploys anyway)"
  exit 0
fi

echo "current reading:"
sed 's/^/  /' src/demo-state.json

if [ "$DEPLOY" = "0" ]; then
  echo "built; not deployed (--no-deploy). The next run will still deploy this."
  exit 0
fi

vercel --cwd web --prod
# Only now. A marker written before the deploy succeeds is a marker that
# silences every run after a failure.
printf '%s\n' "$now" > "$MARK"
