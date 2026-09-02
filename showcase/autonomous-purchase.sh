#!/usr/bin/env bash
#
# An autonomous agent buying an API, with authority it cannot exceed.
#
#     WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key) \
#       ./autonomous-purchase.sh --rpc ws://127.0.0.1:18210
#
# ## What this is
#
# The whole protocol in one sitting, using only the shipped tools — no demo
# harness, no special-cased code path. Every step below is a command a
# developer would run, in the order they would run it, and each transaction is
# real on Kaspa testnet-10.
#
#   1. a supervisor creates a bounded grant
#   2. it delegates a smaller, separately-keyed grant to a worker
#   3. the worker buys from a real HTTP 402 endpoint, which verifies the
#      payment on chain before it serves anything
#   4. the worker tries to pay somebody else            — no transaction exists
#   5. the worker tries to exceed its per-call cap      — no transaction exists
#   6. the supervisor reabsorbs what is left
#
# Steps 4 and 5 are the point. They are not error handling: there is no valid
# transaction to build, so nothing is signed and nothing is broadcast. The
# refusal happens before the network is ever asked.
#
# ## Why it composes tools instead of being one script
#
# A single demo script proves a single demo script works. This runs the same
# commands the README documents, which means the showcase and the quickstart
# cannot drift apart: if a step here needs a flag the docs do not mention, the
# docs are wrong and this breaks.
set -euo pipefail
cd "$(dirname "$0")"

RPC=""
for i in "$@"; do :; done
while [ $# -gt 0 ]; do
  case "$1" in
    --rpc) RPC="$2"; shift 2 ;;
    *) shift ;;
  esac
done
RPCARG=${RPC:+--rpc $RPC}

: "${WARDA_SK:?WARDA_SK must be the funder key that pays for the supervisor grant}"

# Three keys, and confusing them is the first thing that goes wrong.
#
#   FUNDER      pays for the supervisor grant, and is its principal and its
#               revocation key
#   SUPERVISOR  the supervisor's AGENT key — generated in step 1. Only the
#               agent may delegate: it is the agent's budget being subdivided
#   WORKER      the child's agent key, derived by build-delegation for
#               reproducibility. A real sub-agent generates its own.
#
# The first run of this script passed the funder key to the delegation and got
# "WARDA_SK does not control this grant's agent" — accurate, and no help at all
# in working out that a different key existed and had just been printed.
FUNDER="$WARDA_SK"

SDK=../sdk
WORK=$(mktemp -d)
VENDOR=kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4

step() { printf '\n\033[36m── %s\033[0m\n\n' "$1"; }
note() { printf '   \033[2m%s\033[0m\n' "$1"; }

step "1. The supervisor creates a bounded grant"
note "10 KAS total, 0.1 per payment, one permitted payee. Fixed at creation."
( cd $SDK && node --experimental-strip-types tools/quickstart.ts \
    --recipients "$VENDOR" --budget 1000000000 --max-per-spend 100000000 \
    --out "$WORK/supervisor.json" --agent-out "$WORK/supervisor-agent.key" \
    $RPCARG ) 2>&1 | sed 's/^/   /'

SUPERVISOR=$(cat "$WORK/supervisor-agent.key")

step "2. It delegates a smaller grant to a worker"
note "The worker gets its own key. The supervisor hands over budget, never"
note "custody, and can end the delegation at any time."
( cd $SDK && WARDA_SK="$SUPERVISOR" node --experimental-strip-types tools/build-delegation.ts \
    "$WORK/supervisor.json" --budget 300000000 --submit $RPCARG \
    > "$WORK/delegation.json" ) 2>&1 | sed 's/^/   /'

# build-delegation names the child after its key, beside the parent. Found
# rather than assumed: guessing this filename is how a showcase ends up
# running step 3 against a grant that does not exist.
CHILD=$(ls -t "$WORK"/grant-child-*.json 2>/dev/null | head -1)
if [ -z "$CHILD" ]; then
  echo "   no child manifest was written — stopping rather than continuing blind" >&2
  exit 1
fi
note "child manifest: $(basename "$CHILD")"

step "3. The worker buys from a real 402 endpoint"
note "The vendor verifies the payment against the UTXO set before serving."
( cd ../x402 && WARDA_SK="$SUPERVISOR" node --experimental-strip-types demo/testnet-demo.ts \
    --grant "$CHILD" --recipients "$VENDOR" $RPCARG ) 2>&1 | sed 's/^/   /'

step "3b. The manifest catches up with the chain"
note "Paying MOVED the child: its address is a hash of its state. Everything"
note "below would otherwise look at an address the grant has already left."
( cd $SDK && node --experimental-strip-types tools/follow-grant.ts \
    "$CHILD" --vendor "$VENDOR" --write $RPCARG ) 2>&1 | sed 's/^/   /'

step "4. The worker tries to pay somebody else"
note "Expected: no proof exists, so there is nothing to sign."
( cd $SDK && WARDA_SK="$SUPERVISOR" node --experimental-strip-types tools/build-live-spend.ts \
    "$CHILD" --recipients "$VENDOR" \
    --to kaspatest:qrq97752zpxn27tc6uynvegyq0z5vk9g3s2yrrnag32yrrvy3ygwsxv5tu5g2 \
    --amount 10000000 $RPCARG > "$WORK/refused-payee.json" ) 2>&1 | sed 's/^/   /' || true

step "5. The worker tries to exceed its per-payment cap"
note "1 KAS against a 0.05 cap. The child HOLDS 2.78, so this tests the cap"
note "and not the balance — asking for more than it holds fails earlier, for a"
note "duller reason, and proves nothing about the covenant."
( cd $SDK && WARDA_SK="$SUPERVISOR" node --experimental-strip-types tools/build-live-spend.ts \
    "$CHILD" --recipients "$VENDOR" --to "$VENDOR" \
    --amount 100000000 $RPCARG > "$WORK/refused-cap.json" ) 2>&1 | sed 's/^/   /' || true

step "6. The supervisor reabsorbs what is left"
note "The remainder returns to the supervisor's budget — not to a human, and"
note "not to anywhere the worker chose."
( cd $SDK && WARDA_SK="$SUPERVISOR" WARDA_REVOCATION_SK="$FUNDER" \
    node --experimental-strip-types tools/build-settlement.ts \
    "$WORK/supervisor.json" "$CHILD" --submit $RPCARG \
    > "$WORK/settlement.json" ) 2>&1 | sed 's/^/   /'

printf '\n\033[36m── Done\033[0m\n\n'
note "Working files: $WORK"
