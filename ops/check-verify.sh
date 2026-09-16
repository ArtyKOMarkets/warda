#!/bin/bash
# Can the verification API actually verify anything?
#
#     ops/check-verify.sh              # probe, write the status file
#     ops/check-verify.sh --quiet      # same, no stdout on success
#
# ## Why this exists
#
# `verify.wardaprotocol.com/v1/verify` returned
#
#     {"ok":false,"error":"internal","message":"cannot read the covenant
#      template. Tried: /var/task/node_modules/@warda_protocol/sdk/…"}
#
# to EVERY request, for an unknown length of time, and nothing said so. It was
# found by accident on 16 September while shipping an unrelated borsh fix,
# because a before/after reading happened to be taken.
#
# The site links that endpoint. So does llms.txt. It is the thing a sceptic
# checks first, and its entire purpose is that nobody has to trust us — so an
# outage there is worse than an outage almost anywhere else on this project,
# and it was the one surface with no monitor at all.
#
# ## It checks /v1/verify, not /health
#
# `/health` answered perfectly throughout. It opens a node and reports on it,
# which is a different code path from the one that derives an address — and the
# missing file only broke the second. A liveness probe would have stayed green
# for the entire outage, exactly as the vendor monitor's index check would have.
# The rule is the same one written at the top of ops/check-vendor.sh: probe the
# path that does the work, not the door.
#
# ## What counts as working, and what deliberately does not
#
# It asserts three things, all of which the outage broke:
#
#   the service answered at all, with ok:true
#   the address it derived matches the published one   (the template loaded)
#   it read a node it considers usable                  (the transport loaded)
#
# It does NOT assert that the grant is still funded. /attack publishes that
# grant's private key and invites strangers to spend it, so `found:false` is a
# thing that is supposed to be able to happen — alarming on it would train
# whoever reads this to ignore it. Both `found` and `covenantAware` are
# reported as observations instead.
set -uo pipefail

REPO="$HOME/Desktop/warda"
export PATH="$HOME/.local/node/bin:/usr/bin:/bin"

BASE="${WARDA_VERIFY_BASE:-https://verify.wardaprotocol.com}"
MANIFEST="$REPO/site/src/demo-manifest.json"
OUT="$REPO/site/src/verify-status.json"
QUIET=""
for a in "$@"; do [ "$a" = "--quiet" ] && QUIET=1; done

now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT

# The address these terms must hash to. Read from the card the site publishes,
# so this cannot drift into asserting an address nobody else believes in.
expected="$(sed -n 's/.*"address": *"\(kaspatest:[a-z0-9]*\)".*/\1/p' "$REPO/site/src/demo-grant.json" 2>/dev/null | head -1)"

code=000
if [ -f "$MANIFEST" ]; then
  code="$(curl -s -o "$tmp" -w '%{http_code}' --max-time 30 \
    -X POST "$BASE/v1/verify" \
    -H 'content-type: application/json' \
    --data-binary @"$MANIFEST" || echo 000)"
fi

answered=false
derived=""
usable=false
found=null
covenant=null

if [ "$code" = "200" ] && grep -q '"ok": *true' "$tmp"; then
  answered=true
  derived="$(sed -n 's/.*"address": *"\(kaspatest:[a-z0-9]*\)".*/\1/p' "$tmp" | head -1)"
  grep -q '"usable": *true' "$tmp" && usable=true
  grep -q '"found": *true' "$tmp" && found=true || found=false
  grep -q '"covenantAware": *true' "$tmp" && covenant=true || covenant=false
fi

matches=false
[ -n "$expected" ] && [ "$derived" = "$expected" ] && matches=true

ok=false
[ "$answered" = true ] && [ "$matches" = true ] && [ "$usable" = true ] && ok=true

# Carried from the last file that said so, for the reason check-vendor.sh gives:
# a status file that forgets reports every outage as one minute old.
last_ok="$now"
if [ "$ok" = false ] && [ -f "$OUT" ]; then
  prev="$(sed -n 's/.*"lastOk": *"\([^"]*\)".*/\1/p' "$OUT" | head -1)"
  [ -n "$prev" ] && last_ok="$prev"
fi

reason=""
if [ "$ok" = false ]; then
  if [ ! -f "$MANIFEST" ]; then
    reason="site/src/demo-manifest.json is missing, so there was nothing to ask about"
  elif [ "$answered" != true ]; then
    case "$code" in
      000) reason="the endpoint could not be reached at all" ;;
      500) reason="it answered $code — the shape the missing covenant template produced" ;;
      *)   reason="it answered $code without ok:true" ;;
    esac
  elif [ "$matches" != true ]; then
    reason="it derived ${derived:-no address} for terms that hash to ${expected:-an address this check could not read}; a wrong address means a wrong covenant template, and every answer it gives is wrong with it"
  else
    reason="it answered but reported no usable node, so it has nothing to verify against"
  fi
fi

cat > "$OUT" <<JSON
{
  "_comment": "Written by ops/check-verify.sh. Whether the hosted verification API can actually verify. Probes /v1/verify with the published demo manifest, not /health — /health answered perfectly through a total outage of the path that derives an address. `found` is reported and NOT alarmed on: /attack publishes that grant's key and invites strangers to spend it.",
  "checkedAt": "$now",
  "endpoint": "$BASE",
  "ok": $ok,
  "lastOk": "$last_ok",
  "answered": { "status": $code, "ok": $answered },
  "derivedExpectedAddress": $matches,
  "node": { "usable": $usable, "covenantAware": $covenant },
  "grantStillFunded": $found,
  "reason": "${reason}"
}
JSON

if [ "$ok" = true ]; then
  [ -z "$QUIET" ] && echo "up · /v1/verify $code · address matches · node usable · covenantAware $covenant · funded $found"
  exit 0
fi
echo "DOWN: $reason (last healthy $last_ok)" >&2
exit 1
