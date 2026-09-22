/**
 * Everything the runner is, wired from environment variables once — shared
 * by the local server (tools/serve.ts) and the hosted function (deploy/).
 *
 * The chain: WARDA_RPC_JSON names a node to use; without it, the runner reads
 * and submits through the public resolvers over borsh, which is what lets a
 * hosted runner exist without anybody's node behind it.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "@neondatabase/serverless";
import { kas } from "@warda_protocol/core";
import { fromHex, openChain, pubkeyToAddress } from "@warda_protocol/kaspa";
import { Agent, type Manifest } from "@warda_protocol/agent";
import { createApi, memberKey } from "./api.ts";
import { claudeDrafter } from "./draft.ts";
import { Engine } from "./engine.ts";
import { Funder, refundDeposit, type FundingChain } from "./funding.ts";
import { liveApprovals, liveGrants, liveHttp, liveNotifier, livePayments, telegramApi, type OpenAgent } from "./live.ts";
import { createMcp } from "./mcp.ts";
import { migrateRegistry, pgRegistry } from "./registry.ts";
import { migrate, pgStore } from "./store-pg.ts";
import { EnvelopeVault, localMasterKey, type KeyVault } from "./vault.ts";
import { TurnkeyVault, turnkeyFromEnv } from "./vault-turnkey.ts";
import { createOps } from "./ops.ts";
import { nudgeLow } from "./nudge.ts";
import { delegate } from "./delegate.ts";

const CONSOLE = "https://www.wardaprotocol.com/app";

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
    previous: (e.RUNNER_FEE_PAYEES_PREVIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    perRunSompi: kas(env("RUNNER_FEE_PER_RUN_KAS", "0.001")),
    settleAtSompi: kas(env("RUNNER_SETTLE_AT_KAS", "0.05")),
    settleBeforeExpiryHours: 24,
  };
  const token = e.TELEGRAM_BOT_TOKEN || undefined;
  const raw = liveNotifier(token ? { telegramToken: token } : {});
  const tgx = token ? telegramApi(token) : null;
  /* Telegram with no chat named goes to whoever owns the agent. */
  const notifier = {
    async notify(channel: "telegram" | "webhook", to: string, text: string, agent?: string) {
      let chat = to;
      if (channel === "telegram" && !chat) {
        const acct = agent ? await registry.ownerOf(agent) : null;
        chat = (acct ? await registry.telegramOf(acct) : null) ?? "";
        if (!chat) throw new Error("the agent's owner has not connected Telegram (console: Put it to work → Connect Telegram)");
      }
      return raw.notify(channel, chat, text);
    },
  };
  let botName: string | null = null;
  const telegram = token
    ? {
        hookSecret: createHash("sha256").update("warda-runner-telegram:" + token).digest("hex").slice(0, 48),
        async username() {
          if (botName) return botName;
          const r = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((x) => x.json() as Promise<{ result?: { username?: string } }>);
          botName = r.result?.username ?? "";
          if (!botName) throw new Error("Telegram did not say what this bot is called");
          return botName;
        },
        send: (chat: string, text: string) => raw.notify("telegram", chat, text),
        answer: (id: string, text: string) => tgx!.answer(id, text),
        edit: (chat: string, messageId: number, text: string) => tgx!.edit(chat, messageId, text),
        /* The console's own account API links its alerts through this same
           bot. Both sides derive the shared secret from the bot token. */
        async site(code: string, chat: string) {
          const siteUrl = (e.WARDA_SITE_URL ?? "https://www.wardaprotocol.com").replace(/\/$/, "");
          const secret = createHash("sha256").update("warda-site-telegram:" + token).digest("hex").slice(0, 48);
          const r = await fetch(`${siteUrl}/api/account?op=tglinked`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-warda": "1", "x-warda-telegram": secret },
            body: JSON.stringify({ code, chat }),
          });
          const j = (await r.json().catch(() => null)) as { ok?: boolean; rules?: number } | null;
          if (!r.ok || !j) throw new Error(`site answered ${r.status}`);
          return { ok: !!j.ok, ...(j.rules != null ? { rules: j.rules } : {}) };
        },
      }
    : undefined;
  /* The operator's alerts: RUNNER_OPS_CHAT is the operator's own Telegram chat
     (deploy/env.sh copies it from ops/alerts.env). Without it, alerts are off. */
  const opsChat = e.RUNNER_OPS_CHAT || "";
  const ops = createOps({
    registry, now: Date.now,
    ...(token && opsChat ? { send: (text: string) => raw.notify("telegram", opsChat, text) } : {}),
  });
  const grants = liveGrants(openAgent);
  const baseUrl = e.RUNNER_BASE_URL ?? defaults.baseUrl;
  const engine = new Engine({
    store, grants, fees, notifier,
    payments: livePayments(openAgent),
    http: liveHttp,
    approvals: liveApprovals(notifier, CONSOLE, tgx ? async (agent, text, id) => {
      const acct = await registry.ownerOf(agent);
      const chat = acct ? await registry.telegramOf(acct) : null;
      if (!chat) throw new Error("no chat");
      await tgx.buttons(chat, text, [[{ text: "✅ Approve", data: `apr:yes:${id}` }, { text: "✖ Deny", data: `apr:no:${id}` }]]);
    } : undefined),
    networkFee: 2_000_000n,
    onFinished: (run) => ops.runFinished(run),
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
  const funder = new Funder({
    registry, vault, chain: fundingChain, prefix,
    onError: (p, msg) => ops.report("funding", `Agent ${p.agent} (${p.status}): ${msg.slice(0, 300)}`),
  });

  const api = createApi({
    funder, prefix,
    ...(e.ANTHROPIC_API_KEY ? { drafter: claudeDrafter({ apiKey: e.ANTHROPIC_API_KEY, ...(e.RUNNER_DRAFT_MODEL ? { model: e.RUNNER_DRAFT_MODEL } : {}) }) } : {}),
    ...(telegram ? { telegram } : {}),
    mcp: createMcp({ store, registry, engine, grants, fees }),
    refund: (plan) => refundDeposit({ plan, registry, vault, chain: fundingChain, prefix, now: Date.now() }),
    store, registry, vault, engine, grants, fees, baseUrl,
    tickSecret: env("RUNNER_TICK_SECRET"),
    ops,
    delegate: (parent, child, terms) =>
      delegate({ registry, vault, chain: fundingChain, prefix, parent, child, terms, now: Date.now() }),
    ...(token ? { nudge: () => nudgeLow({ registry, store, grants, now: Date.now(), consoleUrl: CONSOLE, send: (chat, text) => raw.notify("telegram", chat, text) }) } : {}),
    ...(e.RUNNER_ADMIN_SECRET ? { adminSecret: e.RUNNER_ADMIN_SECRET } : {}),
    ...(e.RUNNER_SIGNUP_CODE ? { signupCode: e.RUNNER_SIGNUP_CODE } : {}),
  });

  return {
    api,
    async tick() {
      await ops.tickSeen(Date.now());
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
