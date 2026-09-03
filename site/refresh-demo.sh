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
#     */20 * * * * cd $HOME/Desktop/warda/site && ./refresh-demo.sh
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
python3 build.py >/dev/null

sig() { grep -v '"checkedAt"' "$1" 2>/dev/null || true; }
signature() {
  {
    sig src/demo-state.json
    find web -type f ! -name demo-state.json -print0 | sort -z | xargs -0 shasum -a 256
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
