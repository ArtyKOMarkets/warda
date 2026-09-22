#!/usr/bin/env bash
# Copy the runner's settings into the linked Vercel project, without printing
# a single value. Run once after `npx vercel link` in this directory.
#
#   runner/deploy/env.sh
#
# Reads runner/.env (DATABASE_URL, RUNNER_TICK_SECRET, RUNNER_FEE_PAYEE,
# TURNKEY_ORGANIZATION_ID) and the Turnkey key file it names, and adds each as
# a production variable. WARDA_RPC_JSON is deliberately NOT copied: the hosted
# runner reads the chain through the public resolvers, so it does not depend
# on a node behind anybody's laptop.
set -euo pipefail
cd "$(dirname "$0")"
[ -f .vercel/project.json ] || { echo "link this directory first: npx vercel link" >&2; exit 1; }
node --experimental-strip-types -e '
  import("../tools/env.ts").then(async ({ loadEnv }) => {
    loadEnv(process.cwd() + "/../.env");
    const { credentialsFile } = await import("../src/vault-turnkey.ts");
    const file = process.env.TURNKEY_KEY_FILE ? credentialsFile(process.env.TURNKEY_KEY_FILE) : {};
    const want = ["DATABASE_URL", "RUNNER_TICK_SECRET", "RUNNER_FEE_PAYEE", "TURNKEY_ORGANIZATION_ID",
                  "TURNKEY_API_PUBLIC_KEY", "TURNKEY_API_PRIVATE_KEY"];
    const out = {};
    for (const k of want) out[k] = process.env[k] || file[k] || "";
    const missing = want.filter((k) => !out[k]);
    if (missing.length) { console.error("missing: " + missing.join(", ")); process.exit(1); }
    require("node:fs").writeFileSync(".env.push", Object.entries(out).map(([k, v]) => k + "=" + v).join("\n") + "\n", { mode: 0o600 });
  });
'
trap 'rm -f .env.push' EXIT
while IFS='=' read -r k v; do
  [ -n "$k" ] || continue
  npx vercel env rm "$k" production -y >/dev/null 2>&1 || true
  printf '%s' "$v" | npx vercel env add "$k" production >/dev/null
  echo "  set $k"
done < .env.push
echo "done. Deploy with runner/deploy/deploy.sh"
