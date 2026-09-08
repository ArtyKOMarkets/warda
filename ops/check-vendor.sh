#!/bin/bash
# Is the thing a stranger will try actually up?
#
#     ops/check-vendor.sh              # probe, write the status file
#     ops/check-vendor.sh --quiet      # same, no stdout on success
#
# ## Why this exists
#
# `warda-demo-api.vercel.app` returned 500 to every paid request for several
# days and nothing said so. The node never went down and the hourly readings
# went to localhost, so every signal we had stayed green; the outage was
# discovered when a payment failed, which is the worst available way to find
# out. `/start` step 4 points a first-time developer straight at that endpoint.
#
# ## It checks the 402, not just the door
#
# A liveness probe on `/` would have passed through most of that outage: the
# index is static and the paid path is the one that needs a node. So this asks
# for a quote and reads it — a 402 carrying a payTo and an amount is the only
# answer that means the thing actually works. 200 means it served without being
# paid, which is a worse failure than being down.
#
# ## What it does about it
#
# It writes a status file the site publishes, and `/start` renders a warning
# from it. Not an alert to a person: the point is that the stranger who arrives
# while it is broken is told, rather than sent at a dead endpoint and left to
# conclude the protocol does not work.
set -uo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/bin:/bin"

BASE="${WARDA_DEMO_BASE:-https://warda-demo-api.vercel.app}"
OUT="$REPO/site/src/vendor-status.json"
QUIET=""
for a in "$@"; do [ "$a" = "--quiet" ] && QUIET=1; done

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

# --- the door ---------------------------------------------------------------
idx_code="$(curl -s -o "$tmp" -w '%{http_code}' --max-time 20 "$BASE/" || echo 000)"
idx_ok=false
[ "$idx_code" = "200" ] && grep -q '"endpoints"' "$tmp" && idx_ok=true

# --- the paid path, which is the one that breaks ----------------------------
pay_code="$(curl -s -o "$tmp" -w '%{http_code}' --max-time 25 "$BASE/weather" || echo 000)"
pay_ok=false
quoted=""
if [ "$pay_code" = "402" ] && grep -q '"payTo"' "$tmp" && grep -q '"amountSompi"' "$tmp"; then
  pay_ok=true
  # Whitespace-tolerant: the vendor's serialiser is not ours to depend on, and
  # a quote that fails to parse would report a healthy endpoint as amountless
  # rather than as healthy.
  quoted="$(sed -n 's/.*"amountSompi": *"\([0-9]*\)".*/\1/p' "$tmp" | head -1)"
fi

ok=false
[ "$idx_ok" = true ] && [ "$pay_ok" = true ] && ok=true

# --- how long it has been like this -----------------------------------------
# Carried from the previous run rather than recomputed, because the only thing
# that knows when it was last healthy is the last file that said so. A status
# file that forgets is one that reports every outage as one minute old.
last_ok="$now"
if [ "$ok" = false ] && [ -f "$OUT" ]; then
  prev="$(sed -n 's/.*"lastOk": *"\([^"]*\)".*/\1/p' "$OUT" | head -1)"
  [ -n "$prev" ] && last_ok="$prev"
fi

reason=""
if [ "$ok" = false ]; then
  if [ "$idx_ok" != true ]; then
    reason="the vendor's index answered $idx_code"
  else
    case "$pay_code" in
      200) reason="the paid endpoint served without being paid — worse than being down" ;;
      500|502|503|504) reason="the paid endpoint answered $pay_code; it usually means its node is unreachable" ;;
      000) reason="the paid endpoint could not be reached at all" ;;
      *)   reason="the paid endpoint answered $pay_code, not 402" ;;
    esac
  fi
fi

cat > "$OUT" <<JSON
{
  "_comment": "Written by ops/check-vendor.sh. Whether the demo endpoint /start sends people at is actually answering. Checks the 402 quote, not just the index: the index is static and stayed up through a multi-day outage of the paid path.",
  "checkedAt": "$now",
  "endpoint": "$BASE",
  "ok": $ok,
  "lastOk": "$last_ok",
  "index": { "status": $idx_code, "ok": $idx_ok },
  "quote": { "status": $pay_code, "ok": $pay_ok, "amountSompi": "${quoted:-}" },
  "reason": "${reason}"
}
JSON

if [ "$ok" = true ]; then
  [ -z "$QUIET" ] && echo "up · index $idx_code · quote $pay_code${quoted:+ for $quoted sompi}"
  exit 0
fi
echo "DOWN: $reason (last healthy $last_ok)" >&2
exit 1
