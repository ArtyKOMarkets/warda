#!/bin/bash
#
# The Listener's grant, once.
#
#   growth/tools/first-listener-grant.sh --dry-run    say what it would do
#   growth/tools/first-listener-grant.sh              do it
#
# Genesis is the irreversible step in this whole project. A grant's terms are
# fixed the moment it lands: the budget, the per-payment cap, the epoch limit,
# the allowlist and the term cannot be edited, only ended. Assembling that by
# hand from a table in a runbook is how a digit goes missing, and the way you
# find out is an agent that cannot pay or one that can pay too much.
#
# So this refuses rather than improvises. Every precondition is checked before
# anything is created, and the numbers come from growth/src/shape.ts — the
# same file the runner and the seller read, and the one ops/check-listener.mjs
# holds the runbook to.
#
# It never overwrites a key. On 17 September a repeated `warda key --out` in
# this repo replaced a key holding 1000 KAS; the coin stayed where it was and
# the only thing that could move it did not. Every step here is skipped when
# its output already exists, and says so.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

N="node --experimental-strip-types"
DRY=""
FUNDING_OK=""
for a in "$@"; do
  [ "$a" = "--dry-run" ] && DRY=1
  [ "$a" = "--funding-checked" ] && FUNDING_OK=1
done

AGENT_KEY="growth/keys/listener.key"
SELLER_KEY="growth/keys/xreads.key"
PAYEES="growth/listener-payees.txt"
GRANT="growth/listener-grant.json"
FUNDER="${LISTENER_FUNDER_KEY:-covenant/deploy/warda-testnet.key}"

say() { printf '%s\n' "$*"; }
die() { printf '%s\n' "$*" >&2; exit 1; }

# The numbers, read from the one file that decides them rather than repeated
# here. A script that restates them is a fifth copy, and the guard exists
# because four was already too many.
eval "$($N -e '
import { LISTENER, derived } from "./growth/src/shape.ts";
const out = {
  BUDGET: LISTENER.budgetSompi, MAXSPEND: LISTENER.priceSompi,
  EPOCHLIMIT: LISTENER.epochLimitSompi, EPOCHLEN: derived.epochLengthDaa,
  WINDOW: derived.termDaa, SEARCHES: derived.searchesPerTerm, USD: derived.usdPerTerm,
};
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
')"

say "the Listener's grant"
say "  budget        $BUDGET sompi   ($SEARCHES searches, about \$$USD of X reads)"
say "  maxPerSpend   $MAXSPEND sompi   (one search)"
say "  epochLimit    $EPOCHLIMIT sompi   (three searches)"
say "  epochLength   $EPOCHLEN DAA    (12 hours)"
say "  window        $WINDOW DAA  (7 days)"
say "  depth         0              (it hires nobody)"
say ""

# ---- preconditions, all of them, before anything is created ---------------

[ -f "$FUNDER" ] || die "no funder key at $FUNDER
Set LISTENER_FUNDER_KEY to the key that should own this grant. Whichever key
signs genesis becomes the principal AND the revocation — the one that can end
it — so this is not a detail to let default by accident."

[ -f ops/node.env ] && . ops/node.env
[ -n "${WARDA_RPC_JSON:-}" ] || say "note: no WARDA_RPC_JSON; a public node will be found."

# ---- 1. the seller's key, which is the payee ------------------------------

say "== 1. the seller's key (the one address this grant may ever pay)"
if [ -f "$SELLER_KEY" ]; then
  say "   already exists: $SELLER_KEY"
elif [ -n "$DRY" ]; then
  say "   would create $SELLER_KEY"
else
  npx warda key --out "$SELLER_KEY"
fi

# ---- 2. the agent's key ---------------------------------------------------

say "== 2. the agent's key (what the Listener signs spends with)"
if [ -f "$AGENT_KEY" ]; then
  say "   already exists: $AGENT_KEY"
elif [ -n "$DRY" ]; then
  say "   would create $AGENT_KEY"
else
  npx warda key --out "$AGENT_KEY"
fi

# ---- 3. the allowlist -----------------------------------------------------
#
# Written from the seller key's own address rather than typed. A payees file
# that disagrees with the key by one character produces a grant that can pay
# an address nobody holds, and the covenant will enforce that faithfully
# forever.

say "== 3. the allowlist"
if [ -n "$DRY" ] && [ ! -f "$SELLER_KEY" ]; then
  say "   would write the seller's address into $PAYEES"
else
  # There is no `warda address`. Two commands print one, in two shapes:
  #   warda key     ->  "  address : kaspatest:qz89…"
  #   warda wallet  ->  "  address     kaspatest:qr7z…"
  # so the pattern takes either separator rather than guessing which ran.
  ADDR="$(npx warda wallet --key "$SELLER_KEY" 2>/dev/null \
    | sed -n 's/.*address[ :]*\(kaspa[a-z]*:[0-9a-z]\{20,\}\).*/\1/p' | head -1)"
  [ -n "$ADDR" ] || die "could not read the seller's address from $SELLER_KEY.
Check by hand:  npx warda wallet --key $SELLER_KEY"
  if grep -q "^kaspa" "$PAYEES" 2>/dev/null; then
    grep -q -F "$ADDR" "$PAYEES" || die "$PAYEES already lists a different address.
The allowlist is fixed at genesis. If that other address is the one you want,
leave it; if not, fix the file before creating anything."
    say "   already listed: $ADDR"
  elif [ -n "$DRY" ]; then
    say "   would add $ADDR to $PAYEES"
  else
    printf '%s\n' "$ADDR" >> "$PAYEES"
    say "   added $ADDR"
  fi
fi

# ---- 4. is there one coin big enough? -------------------------------------
#
# Genesis takes a SINGLE input, so a funder holding 5 KAS in five drips cannot
# make a 2.1 KAS grant. This is the failure that wastes the most time, because
# the balance looks fine.

say "== 4. the funder's coins"
NEED=$((BUDGET + 1000000))
if [ -n "$DRY" ]; then
  say "   would need one coin of at least $NEED sompi"
elif [ -n "$FUNDING_OK" ]; then
  say "   skipped: you said you checked it"
else
  WALLET="$(npx warda wallet --key "$FUNDER" 2>&1 || true)"
  printf '%s\n' "$WALLET" | sed 's/^/   /'
  # `warda wallet` prints KAS with a decimal — "largest 3.1 KAS" — not sompi.
  # Read it as a decimal and convert, because treating "3.1" as an integer
  # gives 3 and refuses a funder that is fine.
  BIGGEST_KAS="$(printf '%s\n' "$WALLET" | sed -n 's/.*largest[^0-9]*\([0-9]*\.\{0,1\}[0-9]*\).*/\1/p' | head -1)"
  NEED_KAS="$(awk -v n="$NEED" 'BEGIN { printf "%.8f", n / 100000000 }')"
  if [ -n "$BIGGEST_KAS" ]; then
    if awk -v a="$BIGGEST_KAS" -v b="$NEED_KAS" 'BEGIN { exit !(a + 0 < b + 0) }'; then
      die "the largest single coin is $BIGGEST_KAS KAS and genesis needs $NEED_KAS.
Genesis takes ONE input, so a balance spread across drips will not do. Merge first:
  npx warda wallet consolidate --key $FUNDER --submit"
    fi
    say "   largest coin $BIGGEST_KAS KAS, needs $NEED_KAS — enough."
  else
    # Not a silent pass. An unreadable balance is a reason to stop, because
    # the next step is the irreversible one.
    die "could not read the largest coin from \`warda wallet\`.
Check it yourself, then re-run with --funding-checked if it is fine:
  npx warda wallet --key $FUNDER"
  fi
fi

# ---- 5. genesis -----------------------------------------------------------

say "== 5. genesis"
if [ -f "$GRANT" ]; then
  say "   already created: $GRANT"
  say "   A grant is made once. Delete the file only if you know the grant on chain is gone."
elif [ -n "$DRY" ]; then
  say "   would submit genesis and write $GRANT"
else
  AGENT_PUB="$(cat "$AGENT_KEY.pub")"
  [ -n "$AGENT_PUB" ] || die "no public half at $AGENT_KEY.pub"
  say "   agent $AGENT_PUB"
  WARDA_SK="$(cat "$FUNDER")" $N sdk/tools/genesis.ts \
    --agent "$AGENT_PUB" \
    --recipients "$PAYEES" \
    --budget "$BUDGET" \
    --max-per-spend "$MAXSPEND" \
    --epoch-limit "$EPOCHLIMIT" \
    --epoch-length "$EPOCHLEN" \
    --window "$WINDOW" \
    --depth 0 \
    --out "$GRANT" \
    --submit
  say "   waiting for it to be accepted…"
  sleep 8
fi

# ---- 6. do the chain and the code agree? ----------------------------------

say "== 6. the guard"
if [ -n "$DRY" ] && [ ! -f "$GRANT" ]; then
  say "   would check the grant against growth/src/shape.ts"
else
  $N ops/check-listener.mjs
fi

say ""
say "Next: point the pass at the grant instead of your card."
say "  edit ops/listener-pass.sh — drop '--direct --send', add '--grant $GRANT'"
say "  then one attended run before cron takes it:"
say "    $N growth/tools/listen.ts --grant $GRANT"
