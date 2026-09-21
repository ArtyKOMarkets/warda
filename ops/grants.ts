/**
 * Funded testnet grants for builders who asked on wardaprotocol.com/grant.
 *
 *   source ops/node.env; source ops/alerts.env
 *   node --experimental-strip-types ops/grants.ts list
 *   node --experimental-strip-types ops/grants.ts issue <id> [--budget 5] [--dry-run]
 *   node --experimental-strip-types ops/grants.ts decline <id> --note "…"
 *
 * `issue` runs sdk/tools/genesis.ts on this machine — the only place a key is
 * used — for the agent key the builder sent, then posts the resulting MANIFEST
 * (public by construction) back to the site, where their status page shows it
 * with the commands to spend from it.
 *
 * ## The three keys
 *
 *   agent       theirs. We never see the secret; they sent the public half.
 *   principal   ours (the funder). An unspent balance comes home on revoke or
 *               reclaim — this is testnet money we lend, not give.
 *   revocation  ops/warda-revocation.key: stops the grant, receives nothing.
 *
 * ## Who it may pay
 *
 * Every registry service run here (the demo vendor, agent #001's digest,
 * Researcher) so the grant can buy something the minute it lands, plus up to
 * six payees of the builder's own. The manifest and payees file are kept in
 * outside-grants/<id>/ so sdk/tools/keys.ts accounts for them like every
 * other grant this project has issued.
 *
 * Environment: CONSOLE_CRON_SECRET (or WARDA_ADMIN_SECRET), CONSOLE_URL,
 * WARDA_RPC_JSON; GRANTS_FUNDER_KEY defaults to covenant/deploy/warda-testnet.key.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SDK = join(REPO, "sdk");
const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : d;
};
const die = (m: string, c = 1): never => { console.error(m); process.exit(c); };

const API = (process.env.CONSOLE_URL ?? "https://www.wardaprotocol.com").replace(/\/$/, "") + "/api/account";
const SECRET = process.env.WARDA_ADMIN_SECRET ?? process.env.CONSOLE_CRON_SECRET ?? "";
const FUNDER = process.env.GRANTS_FUNDER_KEY ?? join(REPO, "covenant/deploy/warda-testnet.key");

/** Our registry services: what a fresh grant can buy the minute it lands. */
export const HOUSE_PAYEES = [
  "16e6af2030f7e4510d1a417391a7ff7ccad21864f17eef7ee035f0453e21a033", // demo vendor: /fact /weather /inference
  "3c693f61fbc35d1fd4dcec2bbbab692be38656e6fd5a4077ee495afcb23535a1", // agent #001: /digest
  "254385aa03abefa14e997d01ad5e6b8c13ca4aba7b030d675ca5922c39f8af48", // Growth Researcher: /verify
];

/** The revocation key named in ops/known-keys.json for grants issued from here on. */
function revocationKey(): string {
  const inv = JSON.parse(readFileSync(join(REPO, "ops/known-keys.json"), "utf8")) as { keys: { key: string; label: string }[] };
  const k = inv.keys.find((x) => x.label.startsWith("revocation key, for grants issued from here on"));
  if (!k) die("ops/known-keys.json names no revocation key for new grants.");
  return k!.key;
}

async function api(op: string, method: "GET" | "POST", body?: unknown) {
  if (!SECRET) die("no CONSOLE_CRON_SECRET (or WARDA_ADMIN_SECRET): source ops/alerts.env first.", 2);
  const res = await fetch(`${API}?op=${op}`, {
    method,
    headers: { "x-admin-secret": SECRET, "x-warda": "1", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; [k: string]: unknown };
  if (!res.ok || !j.ok) die(`${op}: ${res.status} ${j.message ?? JSON.stringify(j)}`);
  return j;
}

function run(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((done) => {
    const base = { ...process.env };
    delete base.WARDA_SK;
    const c = spawn(process.execPath, ["--experimental-strip-types", ...args], { cwd: SDK, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    c.stdout.on("data", (d) => { out += String(d); });
    c.stderr.on("data", (d) => { out += String(d); process.stderr.write(d); });
    c.on("close", (code) => done({ code: code ?? 1, out }));
  });
}

interface Req { id: string; status: string; createdAt: string; project: string; contact?: string; about?: string; agentKey: string; payeesAsked: string[] }

async function main() {
  const verb = argv[0];
  if (verb === "list") {
    const { requests } = (await api("requests", "GET")) as unknown as { requests: Req[] };
    const show = has("all") ? requests : requests.filter((r) => r.status === "pending");
    if (!show.length) return console.log(has("all") ? "no requests yet." : "nothing pending. (--all shows issued and declined too)");
    for (const r of show) {
      console.log(`${r.id}  ${r.status.padEnd(8)} ${r.createdAt.slice(0, 16)}  ${r.project}`);
      console.log(`          contact ${r.contact}  ·  agent ${r.agentKey.slice(0, 16)}…  ·  ${r.payeesAsked.length} payee(s) of their own`);
      if (r.about) console.log(`          ${r.about}`);
    }
    return;
  }

  if (verb === "decline") {
    const id = argv[1] ?? die("decline <id> --note \"why\"");
    await api("decline", "POST", { id, note: flag("note", "") });
    return console.log(`declined ${id}. Their status page says so${flag("note") ? ", with your note" : ""}.`);
  }

  if (verb === "issue") {
    const id = argv[1] ?? die("issue <id> [--budget 5]");
    const { requests } = (await api("requests", "GET")) as unknown as { requests: Req[] };
    const r = requests.find((x) => x.id === id) ?? die(`no request ${id}`);
    if (r.status !== "pending") die(`${id} is ${r.status}, not pending.`, 2);

    const budgetKas = Number(flag("budget", "5"));
    if (!(budgetKas > 0 && budgetKas <= 50)) die("--budget is in KAS, between 0 and 50.");
    const budget = BigInt(Math.round(budgetKas * 1e8));
    const cap = budget / 10n;          // one payment at most a tenth of the budget
    const epoch = (budget * 2n) / 5n;  // at most 40% of it in any ~100 s
    const payees = [...new Set([...HOUSE_PAYEES, ...r.payeesAsked])];

    const dir = join(REPO, "outside-grants", id);
    const manifestPath = join(dir, "grant.json");
    const payeesPath = join(dir, "payees.txt");
    if (existsSync(manifestPath)) die(`${manifestPath} exists. If that genesis broadcast, finish with: ops/grants.ts publish ${id}`, 2);
    mkdirSync(dir, { recursive: true });
    writeFileSync(payeesPath,
      `# Who grant ${id} may pay, fixed at creation. The first three are Warda's own\n` +
      `# registry services; the rest were asked for by the builder.\n` + payees.join("\n") + "\n");

    const args = [
      join(SDK, "tools/genesis.ts"),
      "--agent", r.agentKey,
      "--recipients", payeesPath,
      "--revocation", revocationKey(),
      "--budget", String(budget), "--max-per-spend", String(cap), "--epoch-limit", String(epoch),
      "--depth", "2", "--window", "25920000",
      "--out", manifestPath,
    ];
    if (!has("dry-run")) args.push("--submit");
    console.error(`issuing ${id} for "${r.project}": ${budgetKas} KAS, cap ${Number(cap) / 1e8}, ${Number(epoch) / 1e8} per epoch, 30 days, ${payees.length} payees`);
    const g = await run(args, { WARDA_SK: readFileSync(FUNDER, "utf8").trim() });
    if (g.code !== 0) die(`genesis refused; nothing was published. ${has("dry-run") ? "" : "Check the chain before retrying."}`);
    if (has("dry-run")) return console.error(`\ndry run: nothing broadcast. Remove ${dir} before issuing for real.`);
    await publish(id, g.out);
    return;
  }

  if (verb === "publish") {
    /* For a genesis that broadcast but whose publish did not happen. */
    const id = argv[1] ?? die("publish <id>");
    await publish(id, "");
    return;
  }

  console.error(
    "ops/grants.ts list [--all]\n" +
      "ops/grants.ts issue <id> [--budget 5] [--dry-run]\n" +
      "ops/grants.ts decline <id> --note \"…\"\n" +
      "ops/grants.ts publish <id>     re-send a manifest whose genesis already broadcast",
  );
  process.exit(verb ? 1 : 0);
}

async function publish(id: string, genesisOut: string) {
  const dir = join(REPO, "outside-grants", id);
  const manifest = JSON.parse(readFileSync(join(dir, "grant.json"), "utf8")) as Record<string, unknown>;
  const payees = readFileSync(join(dir, "payees.txt"), "utf8").split("\n").filter((l) => l && !l.startsWith("#"));
  const address = /grant address\s*:\s*(kaspa(?:test)?:[a-z0-9]+)/.exec(genesisOut)?.[1]
    ?? (manifest.address as string | undefined) ?? (manifest.grant_address as string | undefined);
  const txid = /SUBMITTED:\s*([0-9a-f]{64})/.exec(genesisOut)?.[1] ?? "";
  if (!address) die(`could not find the grant's address; pass it by hand: edit outside-grants/${id}/grant.json or re-run publish after adding "address".`);
  if (!manifest.address) writeFileSync(join(dir, "grant.json"), JSON.stringify({ ...manifest, address }, null, 2) + "\n");
  await api("issue", "POST", { id, manifest, payees, address, txid });
  console.log(`\nissued ${id}: ${address}\nTheir page: ${API.replace("/api/account", "")}/grant?r=${id}\n` +
    `Commit outside-grants/${id}/ so the key inventory counts it.`);
}

void main().catch((e: Error) => die(e.stack ?? e.message));
