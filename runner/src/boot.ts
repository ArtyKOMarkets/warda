/**
 * Everything the runner is, wired from environment variables once — shared
 * by the local server (tools/serve.ts) and the hosted function (deploy/).
 *
 * The chain: WARDA_RPC_JSON names a node to use; without it, the runner reads
 * and submits through the public resolvers over borsh, which is what lets a
 * hosted runner exist without anybody's node behind it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "@neondatabase/serverless";
import { kas } from "@warda_protocol/core";
import { fromHex, openChain, pubkeyToAddress } from "@warda_protocol/kaspa";
import { Agent, type Manifest } from "@warda_protocol/agent";
import { createApi, memberKey } from "./api.ts";
import { Engine } from "./engine.ts";
import { Funder, refundDeposit, type FundingChain } from "./funding.ts";
import { liveApprovals, liveGrants, liveHttp, liveNotifier, livePayments, type OpenAgent } from "./live.ts";
import { createMcp } from "./mcp.ts";
import { migrateRegistry, pgRegistry } from "./registry.ts";
import { migrate, pgStore } from "./store-pg.ts";
import { EnvelopeVault, localMasterKey, type KeyVault } from "./vault.ts";
import { TurnkeyVault, turnkeyFromEnv } from "./vault-turnkey.ts";

export interface Runner {
  api: (req: Request) => Promise<Response>;
  /** One pass: deposits into grants, then due workflows. */
  tick(): Promise<{ funded: string[]; started: string[]; missed: number }>;
  baseUrl: string;
  vault: "turnkey" | "envelope";
  chain: "node" | "borsh";
}

export async function boot(e: NodeJS.ProcessEnv = process.env, defaults: { baseUrl: string }): Promise<Runner> {
  const env = (k: string, fallback?: string) => {
    const v = e[k] ?? fallback;
    if (v === undefined || v === "") throw new Error(`${k} is required`);
    return v;
  };
  const pool = new Pool({ connectionString: env("DATABASE_URL") });
  await migrate(pool);
  await migrateRegistry(pool);
  const store = pgStore(pool);
  const registry = pgRegistry(pool);

  const vault: KeyVault = e.TURNKEY_ORGANIZATION_ID
    ? new TurnkeyVault(await turnkeyFromEnv(e), store)
    : new EnvelopeVault(localMasterKey(fromHex(env("RUNNER_MASTER_KEY"))), store);

  const prefix = "kaspatest" as const;
  const networkId = e.WARDA_NETWORK ?? "testnet-10";
  const node = e.WARDA_RPC_JSON || undefined;
  const chainOpts = node ? { url: node, networkId } : { borsh: true, networkId };

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
      ...chainOpts,
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
  const notifier = liveNotifier(e.TELEGRAM_BOT_TOKEN ? { telegramToken: e.TELEGRAM_BOT_TOKEN } : {});
  const grants = liveGrants(openAgent);
  const baseUrl = e.RUNNER_BASE_URL ?? defaults.baseUrl;
  const engine = new Engine({
    store, grants, fees, notifier,
    payments: livePayments(openAgent),
    http: liveHttp,
    approvals: liveApprovals(notifier, () => e.RUNNER_OWNER_TELEGRAM ?? null, "https://wardaprotocol.com/app"),
    networkFee: 2_000_000n,
  });

  /* One chain connection for funding, reopened if it drops. */
  type Client = Awaited<ReturnType<typeof openChain>>["client"];
  let client: Client | null = null;
  const withChain = async <T>(f: (c: Client) => Promise<T>): Promise<T> => {
    try {
      client ??= (await openChain(chainOpts)).client;
      return await f(client);
    } catch (err) {
      try { void client?.close(); } catch { /* already gone */ }
      client = null;
      throw err;
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
    mcp: createMcp({ store, registry, engine, grants, fees }),
    refund: (plan) => refundDeposit({ plan, registry, vault, chain: fundingChain, prefix, now: Date.now() }),
    store, registry, vault, engine, grants, fees, baseUrl,
    tickSecret: env("RUNNER_TICK_SECRET"),
    ...(e.RUNNER_SIGNUP_CODE ? { signupCode: e.RUNNER_SIGNUP_CODE } : {}),
  });

  return {
    api,
    async tick() {
      const funded = await funder.tick();
      const r = await engine.tick();
      return { funded, ...r };
    },
    baseUrl,
    vault: e.TURNKEY_ORGANIZATION_ID ? "turnkey" : "envelope",
    chain: node ? "node" : "borsh",
  };
}

/** A Node (req, res) handler around the fetch-shaped API. */
export function nodeHandler(api: (req: Request) => Promise<Response>, baseUrl: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const out = await api(new Request(baseUrl + (req.url ?? "/"), {
      method: req.method ?? "GET",
      headers,
      ...(chunks.length && req.method !== "GET" && req.method !== "HEAD" ? { body: Buffer.concat(chunks) } : {}),
    }));
    const h: Record<string, string> = {};
    out.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
  };
}
