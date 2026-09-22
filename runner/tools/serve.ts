/**
 * Run the runner: the API on a port, and the one-minute tick in-process.
 *
 *   node --experimental-strip-types runner/tools/serve.ts
 *
 * Reads runner/.env, then ops/node.env (for WARDA_RPC_JSON). Required:
 *   DATABASE_URL          Neon
 *   RUNNER_TICK_SECRET    ≥16 chars; also guards POST /v1/tick
 *   RUNNER_FEE_PAYEE      the runner's fee address (on each grant's allowlist)
 * Keys — one of:
 *   TURNKEY_ORGANIZATION_ID + TURNKEY_KEY_FILE (or the two API key vars)
 *   RUNNER_MASTER_KEY     64 hex chars, for the envelope vault (local only)
 * Optional:
 *   RUNNER_FEE_PER_RUN_KAS (0.001)  RUNNER_SETTLE_AT_KAS (0.05)
 *   RUNNER_SIGNUP_CODE  RUNNER_BASE_URL  PORT (8787)
 *   TELEGRAM_BOT_TOKEN  RUNNER_OWNER_TELEGRAM (where approvals are announced)
 *
 * The in-process tick (every 20 s; RUNNER_TICK_MS) is for a machine that stays up. Hosted, the
 * same POST /v1/tick is called by a scheduler instead.
 */
import { createServer } from "node:http";
import { Pool } from "@neondatabase/serverless";
import { kas } from "@warda_protocol/core";
import { fromHex, openChain, pubkeyToAddress } from "@warda_protocol/kaspa";
import { Funder, type FundingChain } from "../src/funding.ts";
import { Agent, type Manifest } from "@warda_protocol/agent";
import { createApi, memberKey } from "../src/api.ts";
import { Engine } from "../src/engine.ts";
import { liveApprovals, liveGrants, liveHttp, liveNotifier, livePayments, type OpenAgent } from "../src/live.ts";
import { migrateRegistry, pgRegistry } from "../src/registry.ts";
import { migrate, pgStore } from "../src/store-pg.ts";
import { EnvelopeVault, localMasterKey, type KeyVault } from "../src/vault.ts";
import { TurnkeyVault, turnkeyFromEnv } from "../src/vault-turnkey.ts";
import { loadEnv } from "./env.ts";

loadEnv();
loadEnv(new URL("../../ops/node.env", import.meta.url).pathname);

const env = (k: string, fallback?: string) => {
  const v = process.env[k] ?? fallback;
  if (v === undefined || v === "") throw new Error(`${k} is required (runner/.env)`);
  return v;
};

const pool = new Pool({ connectionString: env("DATABASE_URL") });
await migrate(pool);
await migrateRegistry(pool);
const store = pgStore(pool);
const registry = pgRegistry(pool);

let vault: KeyVault;
if (process.env.TURNKEY_ORGANIZATION_ID) {
  vault = new TurnkeyVault(await turnkeyFromEnv(), store);
  console.error("vault    : Turnkey");
} else {
  vault = new EnvelopeVault(localMasterKey(fromHex(env("RUNNER_MASTER_KEY"))), store);
  console.error("vault    : envelope (local master key)");
}

const prefix = "kaspatest" as const;
const openAgent: OpenAgent = async (agentId) => {
  const g = await registry.getGrant(agentId);
  if (!g) throw new Error(`no grant registered for ${agentId}`);
  let manifest: Manifest = g.manifest;
  const agent = await Agent.open({
    store: {
      async load() { return structuredClone(manifest); },
      async save(m) {
        manifest = structuredClone(m);
        await registry.putGrant({ ...g, manifest: m, updatedAt: Date.now() });
      },
    },
    recipients: g.recipients,
    sign: await vault.signer(agentId),
    url: env("WARDA_RPC_JSON"),
  });
  const payees = g.recipients.map((r) => pubkeyToAddress(fromHex(memberKey(r)), prefix));
  return { agent, payees, close: () => agent.close() };
};

const fees = {
  payee: env("RUNNER_FEE_PAYEE"),
  perRunSompi: kas(env("RUNNER_FEE_PER_RUN_KAS", "0.001")),
  settleAtSompi: kas(env("RUNNER_SETTLE_AT_KAS", "0.05")),
  settleBeforeExpiryHours: 24,
};
const notifier = liveNotifier(process.env.TELEGRAM_BOT_TOKEN ? { telegramToken: process.env.TELEGRAM_BOT_TOKEN } : {});
const grants = liveGrants(openAgent);
const port = Number(process.env.PORT ?? 8787);
const baseUrl = process.env.RUNNER_BASE_URL ?? `http://localhost:${port}`;
const engine = new Engine({
  store, grants, fees, notifier,
  payments: livePayments(openAgent),
  http: liveHttp,
  approvals: liveApprovals(notifier, () => process.env.RUNNER_OWNER_TELEGRAM ?? null, "https://wardaprotocol.com/app"),
  networkFee: 2_000_000n,
});
/* One chain connection for funding, reopened if it drops. */
type Client = Awaited<ReturnType<typeof openChain>>["client"];
let client: Client | null = null;
const chainClient = async (): Promise<Client> =>
  (client ??= (await openChain({ url: env("WARDA_RPC_JSON"), networkId: "testnet-10" })).client);
const withChain = async <T>(f: (c: Client) => Promise<T>): Promise<T> => {
  try {
    return await f(await chainClient());
  } catch (e) {
    try { void client?.close(); } catch { /* already gone */ }
    client = null;
    throw e;
  }
};
const fundingChain: FundingChain = {
  daa: () => withChain(async (c) => (await c.getBlockDagInfo()).virtualDaaScore),
  utxos: (a) => withChain((c) => c.getUtxosByAddresses([a])),
  submit: (tx) => withChain((c) => c.submitTransaction(tx)),
};
const funder = new Funder({ registry, vault, chain: fundingChain, prefix });

const api = createApi({
  funder, prefix,
  store, registry, vault, engine, grants, fees, baseUrl,
  tickSecret: env("RUNNER_TICK_SECRET"),
  ...(process.env.RUNNER_SIGNUP_CODE ? { signupCode: process.env.RUNNER_SIGNUP_CODE } : {}),
});

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
  const out = await api(new Request(baseUrl + (req.url ?? "/"), {
    method: req.method ?? "GET",
    headers,
    ...(chunks.length && req.method !== "GET" ? { body: Buffer.concat(chunks) } : {}),
  }));
  const h: Record<string, string> = {};
  out.headers.forEach((v, k) => { h[k] = v; });
  res.writeHead(out.status, h);
  res.end(Buffer.from(await out.arrayBuffer()));
}).listen(port, () => console.error(`runner   : ${baseUrl}`));

let ticking = false;
setInterval(async () => {
  if (ticking) return; // a slow tick is skipped, never overlapped
  ticking = true;
  try {
    const funded = await funder.tick();
    for (const a of funded) console.error(`funded   : ${a} — deposit turned into its grant`);
    const r = await engine.tick();
    if (r.started.length || r.missed) console.error(`tick     : ${r.started.length} run(s), ${r.missed} missed`);
  } catch (e) {
    console.error(`tick     : ${(e as Error).message}`);
  } finally {
    ticking = false;
  }
}, Number(process.env.RUNNER_TICK_MS ?? 20_000));
