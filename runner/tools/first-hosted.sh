#!/usr/bin/env bash
# The first agent onboarded entirely through the runner API.
#
#   (terminal 1)  node --experimental-strip-types runner/tools/serve.ts
#   (terminal 2)  KEY=wk_…  runner/tools/first-hosted.sh
#
# 1. reads the agent key the runner holds for `first-hosted`
# 2. the funder creates a 1 KAS testnet grant naming it (payees: the demo
#    vendor and the runner's fee payee; separate revocation key)
# 3. registers the grant with the runner
# 4. creates a workflow that buys /fact, and runs it once by hand
# 5. shows the run — every step the runner took, and the txid
#
# Skips the grant if its manifest exists, so a re-run cannot make a second one.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"
: "${KEY:?set KEY to the wk_… API key from POST /v1/accounts}"
API="${RUNNER_URL:-http://localhost:8787}"
ID="first-hosted"
GRANT="runner/agents/$ID-grant.json"
PAYEES="runner/agents/$ID-recipients.txt"
REVOCATION="4c36442ee9f1677a04c72b29931a18bbe085b44bb2da165a965b4d9bd1fc4897"
N="node --experimental-strip-types"
auth=(-H "Authorization: Bearer $KEY" -H "Content-Type: application/json")
[ -f ops/node.env ] && . ops/node.env

echo "== 1. the agent key the runner holds"
AGENT="$(curl -sf "${auth[@]}" "$API/v1/agents/$ID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).agentKey))')"
echo "   $AGENT"

echo "== 2. the grant"
if [ -f "$GRANT" ]; then
  echo "   already created: $GRANT"
else
  WARDA_SK="$(cat covenant/deploy/warda-testnet.key)" $N sdk/tools/genesis.ts \
    --agent "$AGENT" --revocation "$REVOCATION" --recipients "$PAYEES" \
    --budget 100000000 --max-per-spend 20000000 --epoch-limit 50000000 --window 6048000 \
    --out "$GRANT" --submit >/dev/null
  echo "   submitted; waiting for it to be accepted…"
  sleep 8
fi

echo "== 3. register it with the runner"
node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const recipients = fs.readFileSync(process.argv[2], "utf8").split(/\r?\n/).map(l => l.replace(/#.*$/, "").trim()).filter(Boolean);
process.stdout.write(JSON.stringify({ manifest, recipients }));
' "$GRANT" "$PAYEES" | curl -s -X PUT "${auth[@]}" --data-binary @- "$API/v1/agents/$ID/grant"
echo

echo "== 4. a workflow, run once"
WF="$(curl -s -X POST "${auth[@]}" "$API/v1/workflows" -d '{
  "agent": "first-hosted",
  "name": "Buy a fact",
  "trigger": { "type": "manual" },
  "then": [ { "type": "pay-x402", "url": "https://warda-demo-api.vercel.app/fact", "maxKas": "0.05" } ]
}')"
echo "$WF"
WFID="$(echo "$WF" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).workflow.id))')"
curl -s -X POST "${auth[@]}" -H "Idempotency-Key: first-run" "$API/v1/workflows/$WFID/run"
echo

echo "== 5. the run"
curl -s "${auth[@]}" "$API/v1/agents/$ID/runs?limit=1"
echo
