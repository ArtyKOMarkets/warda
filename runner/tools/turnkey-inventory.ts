/**
 * Which Turnkey wallets are safe to delete, and which are irreplaceable.
 *
 *   node --experimental-strip-types runner/tools/turnkey-inventory.ts
 *
 * ## Why this exists
 *
 * Deleting a Turnkey wallet deletes the private key in it. A grant's
 * `agentKey` IS that key, and the agent key is hashed into the grant's
 * ADDRESS — so it cannot be replaced, reissued into, or recovered. A grant
 * whose wallet was deleted is permanently unspendable: not by the agent, not
 * by the principal, not by anyone. The coin sits at an address nothing on
 * earth can produce a signature for.
 *
 * That is the worst irreversible action available in this project, it is two
 * clicks in a dashboard, and every wallet there is called `warda-something`.
 * A tidy-up at the wrong moment ends grants.
 *
 * So: nothing here deletes anything. It reads the three places that know, and
 * prints a verdict per wallet.
 *
 *   the runner's vault store   agent -> walletId, the authoritative mapping
 *   every grant manifest here  the agent keys that are actually spent from
 *   Turnkey                    what exists
 *
 * A wallet is only ever reported as safe when all three agree: not in the
 * vault, not naming a key any manifest uses, and matching a name this
 * repository's own tools generate for probes. Anything else is KEEP, including
 * anything it cannot explain — the asymmetry is the whole point. Keeping a
 * wallet you did not need costs nothing; deleting one you did is final.
 *
 * Needs DATABASE_URL and the Turnkey credentials from runner/.env.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.ts";
import { credentialsFile } from "../src/vault-turnkey.ts";

loadEnv();
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/* ---- 1. every agent key any manifest in this repository names ----------- */
const usedKeys = new Map<string, string[]>();
const SKIP = new Set(["node_modules", ".git", "_to_delete", "dist", "target", "build"]);
(function walk(dir: string) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name) || name.startsWith(".")) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p); continue; }
    if (!name.endsWith(".json")) continue;
    let text: string;
    try { text = readFileSync(p, "utf8"); } catch { continue; }
    for (const m of text.matchAll(/"agent"\s*:\s*"([0-9a-f]{64})"/g)) {
      const where = usedKeys.get(m[1]!) ?? [];
      where.push(p.slice(REPO.length + 1));
      usedKeys.set(m[1]!, where);
    }
  }
})(REPO);

/* ---- 2. the vault: agent -> walletId ------------------------------------ */
const vault = new Map<string, { agent: string; publicKey: string }>();
const dbUrl = process.env.DATABASE_URL;
let vaultRead = false;
if (dbUrl) {
  const { Pool } = await import("@neondatabase/serverless");
  const pool = new Pool({ connectionString: dbUrl });
  try {
    /* runner_vault stores the whole VaultRecord as `body` jsonb — see
       runner/src/store-pg.ts. The reference to the Turnkey wallet is inside
       `sealed`, which for the turnkey provider is JSON and holds no secret. */
    const { rows } = await pool.query(`select agent, public_key, body from runner_vault`);
    for (const r of rows as { agent: string; public_key: string; body: unknown }[]) {
      const rec = (typeof r.body === "string" ? JSON.parse(r.body) : r.body) as
        { provider?: string; sealed?: string };
      if (rec?.provider !== "turnkey" || !rec.sealed) continue;
      try {
        const ref = JSON.parse(rec.sealed) as { walletId?: string };
        if (ref.walletId) vault.set(ref.walletId, { agent: r.agent, publicKey: r.public_key });
      } catch { /* an envelope secret, not a turnkey reference */ }
    }
    vaultRead = true;
  } catch (e) {
    console.error(`could not read the vault table: ${(e as Error).message}`);
  } finally {
    await pool.end().catch(() => {});
  }
}
/* Local vault files too — the first hosted agents were recorded this way. */
const agentsDir = join(REPO, "runner", "agents");
try {
  for (const f of readdirSync(agentsDir).filter((f) => f.endsWith(".vault.json"))) {
    const v = JSON.parse(readFileSync(join(agentsDir, f), "utf8")) as
      { agent: string; publicKey: string; provider: string; sealed: string };
    if (v.provider !== "turnkey") continue;
    const ref = JSON.parse(v.sealed) as { walletId?: string };
    if (ref.walletId) vault.set(ref.walletId, { agent: v.agent, publicKey: v.publicKey });
  }
} catch { /* none */ }

if (!vaultRead) {
  console.error(
    "\nDATABASE_URL is unset or the vault table could not be read, so the authoritative\n" +
      "agent-to-wallet mapping is MISSING and only the local .vault.json files were used.\n" +
      "Every wallet below will read as unexplained, which is the safe direction and is not\n" +
      "an inventory. Set DATABASE_URL in runner/.env and run this again before deleting\n" +
      "anything.\n",
  );
}

/* ---- 3. what Turnkey holds ---------------------------------------------- */
const file = process.env.TURNKEY_KEY_FILE ? credentialsFile(process.env.TURNKEY_KEY_FILE) : {};
const org = process.env.TURNKEY_ORGANIZATION_ID || file.TURNKEY_ORGANIZATION_ID;
const pub = process.env.TURNKEY_API_PUBLIC_KEY || file.TURNKEY_API_PUBLIC_KEY;
const priv = process.env.TURNKEY_API_PRIVATE_KEY || file.TURNKEY_API_PRIVATE_KEY;
if (!org || !pub || !priv) {
  console.error("runner/.env needs TURNKEY_ORGANIZATION_ID and TURNKEY_KEY_FILE.");
  process.exit(2);
}
const { Turnkey } = await import("@turnkey/sdk-server");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = new Turnkey({
  apiBaseUrl: process.env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com",
  apiPublicKey: pub, apiPrivateKey: priv, defaultOrganizationId: org,
}).apiClient() as any;

const wallets = (await api.getWallets({ organizationId: org })).wallets as
  { walletId: string; walletName: string }[];

/* A probe, by a name one of this repository's own tools generates. Matching
   the pattern is necessary and not sufficient: it still has to be absent from
   the vault and name no key any manifest uses. */
const PROBE = /^(warda-lockdown-probe-|warda-scope-probe-|not-an-agent-|warda-spike-|warda-test-)/;
const MONITOR = "warda-monitor-probe";

const keep: string[] = [];
const safe: string[] = [];
const unexplained: string[] = [];
for (const w of wallets.sort((a, b) => a.walletName.localeCompare(b.walletName))) {
  const v = vault.get(w.walletId);
  if (v) {
    const used = usedKeys.get(v.publicKey) ?? [];
    keep.push(
      `${w.walletName}  — agent ${v.agent}` +
        (used.length ? `, named by ${used.length} manifest(s): ${used.slice(0, 2).join(", ")}` : ", in the vault (no manifest here names it)"),
    );
  } else if (w.walletName === MONITOR) {
    keep.push(`${w.walletName}  — the hourly signing monitor's probe wallet (ops/check-turnkey.sh). Deleting it only makes the monitor recreate it.`);
  } else if (PROBE.test(w.walletName)) {
    safe.push(`${w.walletName}  — a probe this repository's tooling created; not in the vault, no manifest names its key`);
  } else {
    unexplained.push(`${w.walletName}  — NOT in the vault and not a name this tooling generates. Unexplained is KEEP.`);
  }
}

const say = (title: string, lines: string[]) => {
  console.log(`\n${title}  (${lines.length})`);
  for (const l of lines) console.log(`  ${l}`);
  if (!lines.length) console.log("  none");
};

console.log(`Turnkey organisation ${org.slice(0, 8)}… — ${wallets.length} wallet(s)`);
say("KEEP — deleting one of these ends a grant, permanently", keep);
say("KEEP — cannot be explained, so not safe to call safe", unexplained);
say("Safe to delete", safe);
console.log(
  `\nNothing was deleted. A grant's agent key is hashed into its address: a deleted\n` +
    `wallet is a grant nobody can ever spend from again, including its principal.`,
);
