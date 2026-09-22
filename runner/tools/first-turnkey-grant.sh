#!/usr/bin/env bash
# WARDA-011 — the first grant whose agent key has never been on any machine.
#
# 1. Turnkey creates the agent key and signs once to prove it (runner/agents/).
# 2. The funder creates a 2 KAS testnet grant naming that key as its agent,
#    with the separate revocation key, and one payee: the Warda demo vendor.
# 3. The agent buys /fact, signing through Turnkey via --signer.
#
# Each step is skipped if its output already exists, so a re-run resumes
# rather than repeats — and step 2 in particular can never make a second grant.
#
#   export TURNKEY_KEY_FILE=~/Downloads/turnkey-api-credentials-….json
#   export TURNKEY_ORGANIZATION_ID=…
#   runner/tools/first-turnkey-grant.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
ID="WARDA-011"
VAULT="runner/agents/$ID.vault.json"
GRANT="x402/demo/agent-011-grant.json"
PAYEES="x402/demo/agent-011-recipients.txt"
FUNDER="covenant/deploy/warda-testnet.key"
REVOCATION="4c36442ee9f1677a04c72b29931a18bbe085b44bb2da165a965b4d9bd1fc4897"
N="node --experimental-strip-types"

: "${TURNKEY_KEY_FILE:?export TURNKEY_KEY_FILE=<path to the Turnkey credentials JSON>}"
: "${TURNKEY_ORGANIZATION_ID:?export TURNKEY_ORGANIZATION_ID=<your Turnkey organization id>}"
[ -f ops/node.env ] && . ops/node.env
[ -f "$FUNDER" ] || { echo "no funder key at $FUNDER" >&2; exit 1; }

echo "== 1. agent key, held by Turnkey"
if [ -f "$VAULT" ]; then
  echo "   already created: $VAULT"
else
  $N runner/tools/turnkey-agent.ts "$ID" >/dev/null
fi
AGENT="$(sed -n 's/.*"publicKey": *"\([0-9a-f]\{64\}\)".*/\1/p' "$VAULT")"
[ -n "$AGENT" ] || { echo "could not read the agent key from $VAULT" >&2; exit 1; }
echo "   agent key $AGENT"

echo "== 2. the grant"
if [ -f "$GRANT" ]; then
  echo "   already created: $GRANT"
else
  WARDA_SK="$(cat "$FUNDER")" $N sdk/tools/genesis.ts \
    --agent "$AGENT" \
    --revocation "$REVOCATION" \
    --recipients "$PAYEES" \
    --budget 200000000 \
    --max-per-spend 50000000 \
    --epoch-limit 100000000 \
    --window 6048000 \
    --out "$GRANT" \
    --submit
  echo "   waiting for it to be accepted…"
  sleep 8
fi

echo "== 3. a purchase, signed by Turnkey"
mkdir -p agent-011/purchases
set +e
$N agents/tools/buy.ts https://warda-demo-api.vercel.app/fact \
  --id "$ID" \
  --grant "$GRANT" \
  --recipients "$PAYEES" \
  --out agent-011/purchases \
  --task "first Turnkey-signed purchase" \
  --signer "node --experimental-strip-types runner/tools/turnkey-sign.ts $ID"
rc=$?
set -e
case $rc in
  0) echo; echo "bought — signed by a key no machine of ours has ever held." ;;
  3) echo "the covenant refused it. Nothing was spent." >&2 ;;
  4) echo "PAID AND NOT SERVED. Do not re-run to compensate; resume by txid." >&2 ;;
  *) echo "failed with $rc — see above." >&2 ;;
esac
exit $rc
