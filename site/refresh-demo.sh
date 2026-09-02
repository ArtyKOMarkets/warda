#!/usr/bin/env bash
#
# Refresh the attack page's snapshot, and redeploy if it changed.
#
#     ./refresh-demo.sh                 # read, rebuild, deploy
#     ./refresh-demo.sh --no-deploy     # read and rebuild only
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
# ## What it will and will not do on its own
#
# It rewrites src/demo-state.json and redeploys. It does NOT rewrite
# src/demo-grant.json — the card that publishes the key, the address and the
# limits. A successful spend moves the grant to a new address, and finding
# where it went means following it through the mempool (sdk/tools/watch-grant.ts),
# not asking a node. Guessing here would mean publishing an address that is
# merely plausible, to strangers, as fact.
#
# So when the grant moves, this says so, keeps publishing the card unchanged,
# and lets the page tell the visitor the address named above is where the grant
# WAS. That is honest and it is also the more interesting sentence.
set -euo pipefail
cd "$(dirname "$0")"

DEPLOY=1
[ "${1:-}" = "--no-deploy" ] && DEPLOY=0

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

# Write via a temp file. A snapshot half-written by a run that died mid-fetch
# is worse than yesterday's snapshot: the page would render it.
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

if ! (cd ../sdk && node --experimental-strip-types tools/demo-state.ts \
        ../site/src/demo-grant.json \
        ${WARDA_RESOLVER:+--resolver "$WARDA_RESOLVER"} \
        ${WARDA_RPC_JSON:+--rpc "$WARDA_RPC_JSON"}) > "$tmp"; then
  echo "demo-state.ts refused or failed — keeping the previous snapshot" >&2
  exit 1
fi

# Every run differs in checkedAt alone, so compare on everything else. A cron
# that redeploys twelve times a day to change a timestamp is a cron that
# teaches you to ignore its output.
#
# The comparison is against what was last DEPLOYED, not against what is last on
# disk. Those differ the moment a run builds without deploying (--no-deploy, a
# failed vercel, a cancelled cron), and comparing against disk in that state
# reports "no change on chain" while the site still serves the older snapshot —
# true about the chain, and wrong about the only thing the run is for.
MARK=.last-deployed-state.json

sig() { grep -v '"checkedAt"' "$1" 2>/dev/null || true; }

cp "$tmp" src/demo-state.json
if [ -f "$MARK" ] && [ "$(sig "$tmp")" = "$(sig "$MARK")" ]; then
  echo "no change since the last deploy."
  exit 0
fi

echo "snapshot changed:"
sed 's/^/  /' src/demo-state.json

python3 build.py >/dev/null
if [ "$DEPLOY" = "0" ]; then
  echo "built; not deployed (--no-deploy). The next run will still deploy this."
  exit 0
fi

vercel --cwd web --prod
# Only now. A marker written before the deploy succeeds is a marker that
# silences every run after a failure.
cp src/demo-state.json "$MARK"
