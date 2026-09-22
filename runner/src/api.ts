/**
 * The runner's HTTP API, as one fetch handler: `(Request) => Response`.
 *
 * The same function runs on Vercel, under `node:http` locally (server.ts),
 * and in the tests with no server at all. It decides who may do what; the
 * engine decides what happens; the covenant decides what is allowed.
 *
 *   POST  /v1/accounts                     → { account, apiKey }  (once)
 *   POST  /v1/agents          { id }       → the agent key the grant must name
 *   GET   /v1/agents
 *   GET   /v1/agents/:id                   → key, grant, fees owed, workflows
 *   PUT   /v1/agents/:id/grant { manifest, recipients }
 *   GET   /v1/agents/:id/runs
 *   GET   /v1/agents/:id/approvals
 *   POST  /v1/workflows       <workflow JSON>
 *   GET   /v1/workflows?agent=
 *   PATCH /v1/workflows/:id   { enabled }
 *   POST  /v1/workflows/:id/run
 *   POST  /v1/hooks/:id       (X-Warda-Hook: <secret>, Idempotency-Key)
 *   POST  /v1/tick            (Authorization: Bearer <tick secret>)
 *
 * Every request but signup, hooks and tick carries `Authorization: Bearer
 * wk_…`. An agent, a workflow or a run that belongs to another account is a
 * 404, not a 403: whether it exists is not this caller's business.
 */
import { toRecipientSet, type Manifest } from "@warda_protocol/agent";
import { formatKas } from "@warda_protocol/core";
import type { Engine } from "./engine.ts";
import type { FeePolicy } from "./fees.ts";
import { emptyLedger } from "./fees.ts";
import { memberKey, spendable, type GrantReader } from "./grant.ts";
import type { Registry } from "./registry.ts";
import type { Store } from "./store.ts";
import type { KeyVault } from "./vault.ts";
import { parseWorkflow, spends, WorkflowError, type Workflow } from "./workflow.ts";
import { kas } from "@warda_protocol/core";
import { createPlan, depositUri, type Funder, type Plan } from "./funding.ts";
import type { NetworkPrefix } from "@warda_protocol/kaspa";

export interface ApiDeps {
  store: Store;
  registry: Registry;
  vault: KeyVault;
  engine: Engine;
  grants: GrantReader;
  fees: FeePolicy;
  tickSecret: string;
  /** If set, signup needs `{ code }` matching it. The beta is invite-only. */
  signupCode?: string;
  baseUrl: string;
  /** Turns deposits into grants; run on every tick. */
  funder?: Pick<Funder, "tick">;
  /** Returns a deposit to the owner's principal key (funding.ts refundDeposit). */
  refund?: (plan: Plan) => Promise<{ txid: string; value: bigint }[]>;
  /** Telegram: the bot that tells owners about their agents. */
  telegram?: {
    hookSecret: string;
    username(): Promise<string>;
    send(chat: string, text: string): Promise<void>;
  };
  /** The per-agent MCP endpoint, served at /mcp. */
  mcp?: (req: Request) => Promise<Response>;
  prefix?: NetworkPrefix;
  now?: () => number;
  id?: (prefix: string) => string;
}

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const json = (status: number, body: unknown) =>
  new Response(
    JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Set ? [...v] : v), 2),
    { status, headers: { "content-type": "application/json", "cache-control": "no-store" } },
  );

const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/;

export { memberKey };

export function createApi(d: ApiDeps): (req: Request) => Promise<Response> {
  const now = d.now ?? Date.now;
  let n = 0;
  const id = d.id ?? ((p: string) => `${p}_${now().toString(36)}${(n++).toString(36)}`);

  const body = async (req: Request): Promise<Record<string, unknown>> => {
    try {
      const b = await req.json();
      if (typeof b !== "object" || b === null || Array.isArray(b)) throw new Error();
      return b as Record<string, unknown>;
    } catch {
      throw new HttpError(400, "the body must be a JSON object");
    }
  };

  const account = async (req: Request): Promise<string> => {
    const m = /^Bearer\s+(wk_[\w-]+)$/.exec(req.headers.get("authorization") ?? "");
    const acct = m ? await d.registry.accountFor(m[1]!) : null;
    if (!acct) throw new HttpError(401, "an API key is required: Authorization: Bearer wk_…");
    return acct;
  };

  const ownAgent = async (acct: string, agent: string) => {
    if ((await d.registry.ownerOf(agent)) !== acct) throw new HttpError(404, `no agent ${agent}`);
  };

  const ownWorkflow = async (acct: string, wfId: string): Promise<Workflow> => {
    const wf = await d.store.getWorkflow(wfId);
    if (!wf || (await d.registry.ownerOf(wf.agent)) !== acct) throw new HttpError(404, `no workflow ${wfId}`);
    return wf;
  };

  const feePayeeKey = memberKey(d.fees.payee);

  const routes: [string, RegExp, (req: Request, m: RegExpExecArray, url: URL) => Promise<Response>][] = [
    ["POST", /^\/v1\/accounts$/, async (req) => {
      if (d.signupCode) {
        const b = await body(req);
        if (b.code !== d.signupCode) throw new HttpError(403, "the runner beta is invite-only; that code is not it");
      }
      const a = await d.registry.createAccount(now());
      return json(201, {
        account: a.id,
        apiKey: a.apiKey,
        note: "This key is shown once and stored only as a hash. It can create and run workflows; it can never move an owner's funds.",
      });
    }],

    ["POST", /^\/v1\/agents$/, async (req) => {
      const acct = await account(req);
      const b = await body(req);
      const agent = typeof b.id === "string" ? b.id : id("agent");
      if (!AGENT_ID.test(agent)) throw new HttpError(400, "an agent id is 3–40 letters, digits, - or _");
      if (!(await d.registry.claimAgent(agent, acct, now()))) throw new HttpError(409, `agent ${agent} already exists`);
      const publicKey = await d.vault.create(agent);
      if (b.funding !== undefined) {
        const f = b.funding as Record<string, any>;
        const lim = (f.limits ?? {}) as Record<string, unknown>;
        const toKas = (v: unknown, name: string) => {
          try { return kas(String(v)); } catch { throw new HttpError(400, `funding.limits.${name} must be a KAS amount like "0.5"`); }
        };
        const payees = Array.isArray(f.payees) ? (f.payees as unknown[]).map(String) : [];
        if (payees.length === 0) throw new HttpError(400, "funding.payees must list who the agent may pay");
        const strip = (k: unknown) => {
          const h = String(k ?? "").toLowerCase();
          return /^0[23][0-9a-f]{64}$/.test(h) ? h.slice(2) : h;
        };
        const principal = strip(f.principal);
        const revocation = f.revocation ? strip(f.revocation) : principal;
        const members = [...new Set([...payees.map(memberKey), memberKey(d.fees.payee)])];
        const maxPer = toKas(lim.maxPerPaymentKas, "maxPerPaymentKas");
        let plan;
        try {
          plan = await createPlan({
            vault: d.vault, registry: d.registry, agent, agentKey: publicKey, principal, revocation,
            limits: {
              budget: toKas(lim.budgetKas, "budgetKas"),
              maxPerSpend: maxPer,
              epochLimit: lim.epochKas !== undefined ? toKas(lim.epochKas, "epochKas") : maxPer * 5n,
              epochLength: 1000n,
              days: Number(lim.days ?? 30),
            },
            recipients: members, prefix: d.prefix ?? "kaspatest", now: now(),
          });
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        return json(201, {
          agent,
          agentKey: publicKey,
          deposit: {
            address: plan.depositAddress,
            amountKas: formatKas(BigInt(plan.required)),
            uri: depositUri(plan),
            status: plan.status,
            note:
              "Send exactly this, in one payment, from any wallet or exchange. The runner turns it into the grant in one " +
              "transaction: the whole amount goes into the grant, whose principal and revocation are YOUR keys. Until " +
              "that transaction confirms (usually under a minute), the runner controls this deposit.",
          },
          grant: {
            principal, revocation,
            ...(revocation === principal ? { warning: "revocation is your principal key: whoever can stop this grant can also take it. Fine on testnet; use a separate key on mainnet." } : {}),
            payees: members,
          },
        });
      }
      return json(201, {
        agent,
        agentKey: publicKey,
        next: {
          grant: {
            agent: publicKey,
            payees: `every address the agent may pay, plus the runner's fee payee ${d.fees.payee}`,
            note: "The runner holds this agent key and nothing else. Create the grant from your own wallet, naming this key as the agent and a revocation key the runner has never seen.",
          },
          register: `PUT ${d.baseUrl}/v1/agents/${agent}/grant`,
        },
      });
    }],

    ["GET", /^\/v1\/agents$/, async (req, _m, url) => {
      const acct = await account(req);
      const ids = await d.registry.agentsOf(acct);
      if (url.searchParams.get("detail") !== "1") return json(200, { agents: ids });
      /* One row per agent for the console's list: where its money is, what it
         does, and when it last did it. Grants are read from the chain, so an
         agent whose grant cannot be read says so rather than showing zero. */
      const rows = await Promise.all(ids.map(async (agent) => {
        /* One retry: a grant read in the instant a payment moves it finds its
           old address empty, which is "undecided", not a problem. */
        const read = async () => (await d.grants.read(agent)) ??
          (await new Promise((r) => setTimeout(r, 1500)), await d.grants.read(agent));
        const [plan, grant, ledger, workflows, runs] = await Promise.all([
          d.registry.getPlan(agent),
          read(),
          d.store.getLedger(agent),
          d.store.listWorkflows(agent),
          d.store.listRuns(agent, 1),
        ]);
        const owed = (ledger ?? emptyLedger()).owed;
        const last = runs[0];
        return {
          agent,
          state: grant ? grant.status.toLowerCase()
            : plan && plan.status !== "funded" ? plan.status
            : last && last.status === "running" ? "paying"
            : "undecided",
          spendableKas: grant ? formatKas(spendable(grant, owed)) : null,
          budgetKas: grant ? formatKas(grant.budgetTotal) : plan ? formatKas(BigInt(plan.limits.budget)) : null,
          spentKas: grant ? formatKas(grant.spentTotal) : null,
          endsAt: grant?.expiresAtMs ?? null,
          jobs: workflows.filter((w) => !w.id.startsWith("mcp-")).length,
          jobsOn: workflows.filter((w) => !w.id.startsWith("mcp-") && w.enabled).length,
          lastRun: last ? { at: last.startedAt, status: last.status, trigger: last.trigger } : null,
        };
      }));
      return json(200, { agents: rows });
    }],

    ["GET", /^\/v1\/agents\/([\w-]+)$/, async (req, m) => {
      const acct = await account(req);
      const agent = m[1]!;
      await ownAgent(acct, agent);
      const [key, grant, ledger, workflows, plan, record] = await Promise.all([
        d.vault.publicKey(agent),
        d.grants.read(agent),
        d.store.getLedger(agent),
        d.store.listWorkflows(agent),
        d.registry.getPlan(agent),
        d.registry.getGrant(agent),
      ]);
      return json(200, {
        agent,
        agentKey: key,
        funding: plan
          ? {
              status: plan.status,
              address: plan.depositAddress,
              amountKas: formatKas(BigInt(plan.required)),
              uri: depositUri(plan),
              seenKas: plan.seen ? formatKas(BigInt(plan.seen)) : "0",
              ...(plan.genesisTxid ? { genesisTxid: plan.genesisTxid } : {}),
              ...(plan.note ? { note: plan.note } : {}),
            }
          : null,
        grant: grant ?? { undecided: "no grant registered, or the chain did not confirm the one on record" },
        feesOwed: formatKas((ledger ?? emptyLedger()).owed),
        workflows: workflows.filter((w) => !w.id.startsWith("mcp-")).map(summary),
        /* The grant as it stands now — it moves after every spend — so the
           owner can revoke it with their own key and nobody else's tool. */
        ...(record ? { manifest: record.manifest, recipients: record.recipients } : {}),
      });
    }],

    ["PUT", /^\/v1\/agents\/([\w-]+)\/grant$/, async (req, m) => {
      const acct = await account(req);
      const agent = m[1]!;
      await ownAgent(acct, agent);
      const b = await body(req);
      const manifest = b.manifest as Manifest | undefined;
      const recipients = b.recipients;
      if (!manifest || typeof manifest !== "object") throw new HttpError(400, "manifest is required: the grant JSON genesis wrote");
      if (!Array.isArray(recipients) || recipients.some((r) => typeof r !== "string")) {
        throw new HttpError(400, "recipients must be the list of addresses or keys the grant committed to");
      }
      const key = await d.vault.publicKey(agent);
      if (manifest.agent !== key) {
        throw new HttpError(422, `this grant names agent key ${String(manifest.agent).slice(0, 16)}…, and the key the runner holds for ${agent} is ${String(key).slice(0, 16)}…. The runner could not sign for it.`);
      }
      let root: string;
      try {
        root = toRecipientSet(recipients as string[]).rootHex;
      } catch (e) {
        throw new HttpError(400, `recipients: ${(e as Error).message}`);
      }
      if (root !== manifest.recipients_root) {
        throw new HttpError(422, "these recipients do not hash to the grant's recipients_root, so no payment could prove its payee against them");
      }
      await d.registry.putGrant({ agent, manifest, recipients: recipients as string[], updatedAt: now() });
      const view = await d.grants.read(agent);
      const members = (recipients as string[]).map(memberKey);
      return json(200, {
        agent,
        registered: true,
        onChain: view ? "confirmed" : "undecided — the chain did not confirm this grant yet; runs will wait",
        feePayeeOnAllowlist: members.includes(feePayeeKey),
      });
    }],

    ["POST", /^\/v1\/agents\/([\w-]+)\/token$/, async (req, m) => {
      const acct = await account(req);
      await ownAgent(acct, m[1]!);
      const t = await d.registry.createAgentToken(m[1]!);
      return json(201, {
        agent: m[1],
        mcp: {
          url: `${d.baseUrl}/mcp`,
          token: t,
          config: { mcpServers: { [`warda-${m[1]}`]: { url: `${d.baseUrl}/mcp`, headers: { Authorization: `Bearer ${t}` } } } },
        },
        note: "Shown once. This token acts as this one agent: it can read its authority and pay inside its grant, and nothing else.",
      });
    }],

    ["POST", /^\/v1\/agents\/([\w-]+)\/refund$/, async (req, m) => {
      const acct = await account(req);
      await ownAgent(acct, m[1]!);
      const plan = await d.registry.getPlan(m[1]!);
      if (!plan) throw new HttpError(404, `${m[1]} was not funded through a deposit`);
      if (!d.refund) throw new HttpError(501, "this runner cannot send refunds");
      try {
        const sent = await d.refund(plan);
        return json(200, {
          refunded: sent.map((x) => ({ txid: x.txid, kas: formatKas(x.value) })),
          to: "your principal key — the one you gave when you created the agent",
        });
      } catch (e) {
        throw new HttpError(409, (e as Error).message);
      }
    }],

    ["GET", /^\/v1\/agents\/([\w-]+)\/runs$/, async (req, m, url) => {
      const acct = await account(req);
      await ownAgent(acct, m[1]!);
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? 50)));
      return json(200, { runs: await d.store.listRuns(m[1]!, limit) });
    }],

    ["GET", /^\/v1\/agents\/([\w-]+)\/approvals$/, async (req, m) => {
      const acct = await account(req);
      await ownAgent(acct, m[1]!);
      return json(200, { approvals: await d.store.listApprovals(m[1]!) });
    }],

    ["POST", /^\/v1\/workflows$/, async (req) => {
      const acct = await account(req);
      const raw = await body(req);
      let wf: Workflow;
      try {
        wf = parseWorkflow(raw, { id: id("wf"), now: now() });
      } catch (e) {
        if (e instanceof WorkflowError) throw new HttpError(400, e.message);
        throw e;
      }
      await ownAgent(acct, wf.agent);
      const g = await d.registry.getGrant(wf.agent);
      if (!g) throw new HttpError(409, `register ${wf.agent}'s grant first: PUT /v1/agents/${wf.agent}/grant`);
      const members = g.recipients.map(memberKey);
      if (spends(wf) && !members.includes(feePayeeKey)) {
        throw new HttpError(422,
          `this workflow spends, and ${wf.agent}'s grant cannot pay the runner's fee: ${d.fees.payee} is not on its allowlist. ` +
          `An allowlist is fixed when a grant is created, so this grant can run notify, http and approval workflows only.`);
      }
      const cap = BigInt(g.manifest.max_per_spend);
      for (const a of wf.actions) {
        if (a.type === "send" && !members.includes(memberKey(a.to))) {
          throw new HttpError(422, `${a.to} is not on ${wf.agent}'s allowlist; no transaction can pay it`);
        }
        const amt = a.type === "send" ? a.sompi : a.type === "pay-x402" ? a.maxSompi : 0n;
        if (amt > cap) throw new HttpError(422, `${formatKas(amt)} KAS is over the grant's per-payment cap of ${formatKas(cap)} KAS`);
      }
      await d.engine.add(wf);
      const out: Record<string, unknown> = { workflow: summary(wf) };
      if (wf.trigger.type === "webhook") {
        const secret = await d.registry.createHook(wf.id);
        out.webhook = { url: `${d.baseUrl}/v1/hooks/${wf.id}`, header: "X-Warda-Hook", secret, note: "shown once" };
      }
      return json(201, out);
    }],

    ["GET", /^\/v1\/workflows$/, async (req, _m, url) => {
      const acct = await account(req);
      const agent = url.searchParams.get("agent");
      const agents = agent ? [agent] : await d.registry.agentsOf(acct);
      if (agent) await ownAgent(acct, agent);
      const all = (await Promise.all(agents.map((a) => d.store.listWorkflows(a)))).flat();
      return json(200, { workflows: all.map(summary) });
    }],

    ["PATCH", /^\/v1\/workflows\/([\w-]+)$/, async (req, m) => {
      const acct = await account(req);
      const wf = await ownWorkflow(acct, m[1]!);
      const b = await body(req);
      if (typeof b.enabled !== "boolean") throw new HttpError(400, "only { enabled: true|false } can be changed; a workflow's actions are replaced by creating a new one");
      wf.enabled = b.enabled;
      await d.store.putWorkflow(wf);
      return json(200, { workflow: summary(wf) });
    }],

    ["POST", /^\/v1\/workflows\/([\w-]+)\/run$/, async (req, m) => {
      const acct = await account(req);
      const wf = await ownWorkflow(acct, m[1]!);
      const key = req.headers.get("idempotency-key") ?? undefined;
      const run = await d.engine.fire(wf.id, "manual", key ? { key } : {});
      return json(run ? 202 : 200, run ? { run } : { run: null, note: "already ran for this Idempotency-Key" });
    }],

    ["POST", /^\/v1\/hooks\/([\w-]+)$/, async (req, m) => {
      const wfId = m[1]!;
      const secret = req.headers.get("x-warda-hook") ?? "";
      if (!secret || !(await d.registry.checkHook(wfId, secret))) throw new HttpError(404, `no webhook ${wfId}`);
      let payload: unknown = null;
      const text = await req.text();
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = text; }
      }
      const key = req.headers.get("idempotency-key") ?? undefined;
      const run = await d.engine.fire(wfId, "webhook", { body: payload, ...(key ? { key } : {}) });
      return json(202, { run });
    }],

    ["GET", /^\/v1\/telegram$/, async (req) => {
      const acct = await account(req);
      const chat = await d.registry.telegramOf(acct);
      return json(200, { available: !!d.telegram, connected: !!chat });
    }],

    ["POST", /^\/v1\/telegram\/link$/, async (req) => {
      const acct = await account(req);
      if (!d.telegram) throw new HttpError(501, "this runner has no Telegram bot configured");
      const code = await d.registry.createTelegramLink(acct, now());
      const bot = await d.telegram.username();
      return json(201, {
        url: `https://t.me/${bot}?start=${code}`,
        note: "Open it and press Start. The link works once, for 15 minutes.",
      });
    }],

    /* Telegram calls this; it proves itself with the secret token given to
       setWebhook. Always 200 — a refusal would only make Telegram retry. */
    ["POST", /^\/v1\/telegram\/hook$/, async (req) => {
      const tg = d.telegram;
      if (!tg || req.headers.get("x-telegram-bot-api-secret-token") !== tg.hookSecret) return json(200, { ok: true });
      const u = (await req.json().catch(() => null)) as { message?: { chat?: { id?: number | string }; text?: string } } | null;
      const chat = u?.message?.chat?.id;
      const text = String(u?.message?.text ?? "");
      const m = /^\/start\s+([\w-]{8,})$/.exec(text.trim());
      if (chat === undefined) return json(200, { ok: true });
      if (!m) {
        await tg.send(String(chat), "This bot tells you about your Warda agents. Connect it from the console: New agent → Put it to work → Connect Telegram.").catch(() => {});
        return json(200, { ok: true });
      }
      const acct = await d.registry.consumeTelegramLink(m[1]!, now());
      if (!acct) {
        await tg.send(String(chat), "That link has expired or was already used. Make a new one in the console.").catch(() => {});
        return json(200, { ok: true });
      }
      await d.registry.setTelegram(acct, String(chat));
      const n = (await d.registry.agentsOf(acct)).length;
      await tg.send(String(chat), `Connected. Warda will tell you here about your ${n} agent${n === 1 ? "" : "s"}: low budgets, endings, and anything that needs your signature. It can never move your funds.`).catch(() => {});
      return json(200, { ok: true });
    }],

    ["POST", /^\/v1\/tick$/, async (req) => {
      const ok = d.tickSecret.length >= 16 && req.headers.get("authorization") === `Bearer ${d.tickSecret}`;
      if (!ok) throw new HttpError(401, "tick is for the scheduler");
      const funded = d.funder ? await d.funder.tick() : [];
      return json(200, { ...(await d.engine.tick()), funded });
    }],
  ];

  const cors = (r: Response) => {
    // API keys travel in a header, never a cookie, so any origin may call
    // this; what it can do is what the key can do. Private-Network lets a
    // page on wardaprotocol.com reach a runner on localhost during the beta.
    r.headers.set("access-control-allow-origin", "*");
    r.headers.set("access-control-allow-headers", "authorization, content-type, idempotency-key, x-warda-hook, mcp-protocol-version, mcp-session-id");
    r.headers.set("access-control-allow-methods", "GET, POST, PUT, PATCH, OPTIONS");
    r.headers.set("access-control-allow-private-network", "true");
    return r;
  };

  return async (req: Request): Promise<Response> => cors(await route(req));

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });
    if (url.pathname === "/mcp" && d.mcp) return d.mcp(req);
    try {
      for (const [method, re, fn] of routes) {
        const m = re.exec(url.pathname);
        if (m && req.method === method) return await fn(req, m, url);
      }
      return json(404, { error: `no route ${req.method} ${url.pathname}` });
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      const msg = (e as Error).message ?? String(e);
      return json(500, { error: msg });
    }
  }
}

function summary(wf: Workflow) {
  return {
    id: wf.id,
    agent: wf.agent,
    name: wf.name,
    enabled: wf.enabled,
    trigger: wf.trigger.type === "schedule" ? { type: "schedule", cron: wf.trigger.cron.source } : wf.trigger,
    actions: wf.actions.map((a) => a.type),
  };
}
