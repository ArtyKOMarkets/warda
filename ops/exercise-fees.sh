#!/bin/bash
# Make every fee corrector actually fire, once, on testnet.
#
#     ops/exercise-fees.sh            # show the plan, change nothing
#     ops/exercise-fees.sh --go       # run it
#
# ## Why this exists
#
# Five tools now submit, read the fee the node names on a rejection, rebuild
# and submit again. Four of those five have NEVER had that path run: it was
# written in one afternoon and tested against a stub client. This repository's
# own rule is that a component correct in isolation tells you nothing about the
# chain it sits in, and every serious defect here was found by running the
# thing for real — build-exit had never broadcast anything until it was wrong
# by 437,200 sompi.
#
# So: deliberately offer a fee the node must refuse (1000 sompi, far under any
# real minimum), and watch each tool discover the true figure and land the
# transaction. A corrector that fires is proved. A corrector that never fires
# is a comment.
#
# ## It builds its own grant, and touches no agent
#
# The obvious way to do this is against agent #003 — it is live and it can
# spend. That would take fees out of a budget that does not refill and shorten
# the daily buy's runway for a test. Worse, the delegation and settlement steps
# would leave a real agent with a child it did not mean to have.
#
# So this creates a throwaway grant from the funder, exercises all four against
# it, and revokes it at the end. The money returns to the principal minus fees.
# Nothing on the site changes, and no agent's history gains an entry that has
# to be explained later.
set -uo pipefail

REPO="${WARDA_REPO:-$HOME/Desktop/warda}"
cd "$REPO" || { echo "no repo at $REPO" >&2; exit 1; }
[ -f ops/node.env ] && . ops/node.env

GO=""
for a in "$@"; do [ "$a" = "--go" ] && GO=1; done

RIG="$(mktemp -d "${TMPDIR:-/tmp}/warda-feerig.XXXXXX")"
FUNDER="covenant/deploy/warda-testnet.key"
PAYEE="kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4"
LOW=1000   # far under any real minimum. The point is to be refused.
N="node --experimental-strip-types"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if [ -z "$GO" ]; then
  cat <<PLAN

What this would do, on testnet-10, with a throwaway grant:

  1. create a 1 KAS grant from the funder, payee = the demo vendor
  2. spend from it        with --fee $LOW   -> build-live-spend corrector
  3. delegate a child     with --fee $LOW   -> build-delegation corrector
  4. settle the child     with --fee $LOW   -> build-settlement corrector
  5. revoke the grant     with --fee $LOW   -> build-exit corrector

Each step must print "the node refused that fee and named N sompi. Rebuilding."
A step that succeeds on the FIRST submit has not tested anything — say so and
lower $LOW further.

No agent is touched. Working files go to $RIG.
Roughly 1 KAS leaves the funder and comes back at step 5, less five fees.

Run it:  ops/exercise-fees.sh --go

PLAN
  exit 0
fi

fail() { echo; echo "STOPPED at $1. The rig is at $RIG — the grant may still hold coin." >&2; exit 1; }

say "1/5  creating a throwaway grant"
echo "$PAYEE" > "$RIG/payees.txt"
WARDA_SK="$(cat "$FUNDER")" $N sdk/tools/quickstart.ts \
  --recipients "$RIG/payees.txt" \
  --budget 100000000 --max-per-spend 20000000 --epoch-limit 50000000 \
  --out "$RIG/grant.json" --agent-out "$RIG/agent.key" || fail "genesis"

say "waiting out the timelock (a new grant may not spend immediately)"
sleep 45

say "2/5  a spend, at a fee the node must refuse"
WARDA_SK="$(cat "$RIG/agent.key")" $N sdk/tools/build-live-spend.ts "$RIG/grant.json" \
  --recipients "$RIG/payees.txt" --to "$PAYEE" \
  --amount 10000000 --fee $LOW --submit > "$RIG/spend.json" || fail "the spend"

say "3/5  a delegation, same"
# No --child-out: build-delegation writes the child manifest itself, beside the
# parent, as grant-child-<first 8 of the child key>.json. The child key is
# derived from the parent secret and an index, so the path is deterministic —
# and that determinism is why the tool refuses to overwrite an existing one.
WARDA_SK="$(cat "$RIG/agent.key")" $N sdk/tools/build-delegation.ts "$RIG/grant.json" \
  --recipients "$RIG/payees.txt" --budget 20000000 \
  --max-per-spend 5000000 --epoch-limit 10000000 \
  --fee $LOW --submit || fail "the delegation"

CHILD="$(ls -t "$RIG"/grant-child-*.json 2>/dev/null | head -1)"
[ -n "$CHILD" ] || fail "the delegation (no child manifest was written)"
echo "child manifest: $CHILD"

say "4/5  settling the child home"
# Two inputs, two keys: the parent's AGENT signs the reabsorb and the child's
# REVOCATION signs the settle. WARDA_SK is the agent; WARDA_REVOCATION_SK is
# the other, and here both grants name the funder as revocation.
WARDA_SK="$(cat "$RIG/agent.key")" \
WARDA_REVOCATION_SK="$(cat "$FUNDER")" \
  $N sdk/tools/build-settlement.ts "$RIG/grant.json" "$CHILD" \
  --fee $LOW --submit || fail "the settlement"

say "5/5  revoking the grant, which returns the coin"
# A revoke is signed by the REVOCATION key, not the agent's — that separation
# is the whole reason a lost agent key does not strand a grant. quickstart made
# the funder both principal and revocation for this rig.
WARDA_SK="$(cat "$FUNDER")" $N sdk/tools/build-exit.ts "$RIG/grant.json" \
  --revoke --fee $LOW --submit || fail "the revoke"

cat <<DONE

All four correctors fired against a real node.

Each step should have printed the node's own figure and rebuilt at it. If any
step landed on the FIRST attempt, that corrector is still untested — the
estimate happened to be high enough — and $LOW should go lower.

The rig is at $RIG. The grant is revoked and holds nothing; the coin is back
with the funder, less five fees.

DONE
