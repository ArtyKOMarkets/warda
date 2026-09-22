import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApi } from "../src/api.ts";
import { createMcp } from "../src/mcp.ts";
import { Engine } from "../src/engine.ts";
import type { GrantView } from "../src/grant.ts";
import { memoryRegistry } from "../src/registry.ts";
import { memoryStore } from "../src/store.ts";
import { EnvelopeVault, localMasterKey } from "../src/vault.ts";
import { toRecipientSet } from "@warda_protocol/agent";

const VENDOR = "16e6af2030f7e4510d1a417391a7ff7ccad21864f17eef7ee035f0453e21a033";
const RUNNER = "3c693f61fbc35d1fd4dcec2bbbab692be38656e6fd5a4077ee495afcb23535a1";
const BASE = "https://runner.test";

function bench(o: { signupCode?: string } = {}) {
  const store = memoryStore();
  const registry = memoryRegistry();
  const vault = new EnvelopeVault(localMasterKey(new Uint8Array(randomBytes(32))), store);
  let now = Date.parse("2026-09-22T09:00:00Z");
  const sent: string[] = [];
  const tg: [string, string][] = [];
  const view: GrantView = {
    address: "kaspatest:grant", status: "ACTIVE", budgetTotal: 200_000_000n, spentTotal: 0n, reserved: 0n,
    maxPerSpend: 50_000_000n, epochRemaining: null, coin: 200_000_000n, payees: [VENDOR, RUNNER], expiresAtMs: now + 7 * 86_400_000,
  };
  const grants = { read: async (a: string) => ((await registry.getGrant(a)) ? structuredClone(view) : null) };
  const fees = { payee: RUNNER, perRunSompi: 1_000_000n, settleAtSompi: 10_000_000n, settleBeforeExpiryHours: 24 };
  const engine = new Engine({
    store, grants, fees, networkFee: 1_500_000n, now: () => now,
    payments: {
      async x402(_a, _req, limit, on) {
        if (3_000_000n > limit) return { kind: "refused", reason: "over the limit" };
        await on("tx402", 3_000_000n);
        return { kind: "paid", status: 200, txid: "tx402", sompi: 3_000_000n, body: '{"fact":"blocks converge"}' };
      },
      async send(_a, to, sompi, on) { sent.push(to); await on("tx", sompi); return { txid: "tx" }; },
    },
    notifier: { notify: async () => {} },
    http: { request: async () => 200 },
    approvals: { announce: async () => {} },
  });
  const api = createApi({
    store, registry, vault, engine, grants, fees, tickSecret: "t".repeat(32), baseUrl: BASE, now: () => now,
    mcp: createMcp({ store, registry, engine, grants, fees, now: () => now }),
    telegram: { hookSecret: "hooksecret", username: async () => "warda_test_bot", send: async (chat, text) => void tg.push([chat, text]) },
    ...(o.signupCode ? { signupCode: o.signupCode } : {}),
  });
  const call = async (method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    const res = await api(new Request(BASE + path, {
      method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }));
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any>, headers: res.headers };
  };
  return { call, sent, tg, registry, advance: (ms: number) => void (now += ms) };
}

async function onboarded(recipients = [VENDOR, RUNNER]) {
  const b = bench();
  const acct = await b.call("POST", "/v1/accounts", { body: {} });
  const key = acct.body.apiKey as string;
  const agent = await b.call("POST", "/v1/agents", { key, body: { id: "shop-bot" } });
  const manifest = { agent: agent.body.agentKey, recipients_root: toRecipientSet(recipients).rootHex, max_per_spend: 50_000_000 };
  const reg = await b.call("PUT", "/v1/agents/shop-bot/grant", { key, body: { manifest, recipients } });
  return { ...b, key, agent, reg };
}

test("the whole onboarding: account, agent key, grant, workflow, run", async () => {
  const b = await onboarded();
  assert.equal(b.agent.status, 201);
  assert.match(b.agent.body.agentKey, /^[0-9a-f]{64}$/);
  assert.equal(b.reg.status, 200);
  assert.equal(b.reg.body.feePayeeOnAllowlist, true);
  const wf = await b.call("POST", "/v1/workflows", { key: b.key, body: {
    agent: "shop-bot", name: "pay the vendor", trigger: { type: "manual" }, then: [{ type: "send", to: VENDOR, kas: "0.1" }],
  } });
  assert.equal(wf.status, 201, JSON.stringify(wf.body));
  const run = await b.call("POST", `/v1/workflows/${wf.body.workflow.id}/run`, { key: b.key, headers: { "idempotency-key": "k1" } });
  assert.equal(run.status, 202);
  const again = await b.call("POST", `/v1/workflows/${wf.body.workflow.id}/run`, { key: b.key, headers: { "idempotency-key": "k1" } });
  assert.equal(again.body.run, null, "the same idempotency key does not run twice");
  const runs = await b.call("GET", "/v1/agents/shop-bot/runs", { key: b.key });
  assert.equal(runs.body.runs[0].status, "ok");
  assert.deepEqual(b.sent, [VENDOR]);
});

test("a grant that names a key the runner does not hold is refused", async () => {
  const b = bench();
  const key = (await b.call("POST", "/v1/accounts", { body: {} })).body.apiKey;
  await b.call("POST", "/v1/agents", { key, body: { id: "bot-1" } });
  const r = await b.call("PUT", "/v1/agents/bot-1/grant", { key, body: {
    manifest: { agent: "ab".repeat(32), recipients_root: toRecipientSet([VENDOR]).rootHex, max_per_spend: 1 },
    recipients: [VENDOR],
  } });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /could not sign/);
});

test("recipients that do not hash to the grant's root are refused", async () => {
  const b = bench();
  const key = (await b.call("POST", "/v1/accounts", { body: {} })).body.apiKey;
  const a = await b.call("POST", "/v1/agents", { key, body: { id: "bot-2" } });
  const r = await b.call("PUT", "/v1/agents/bot-2/grant", { key, body: {
    manifest: { agent: a.body.agentKey, recipients_root: toRecipientSet([VENDOR]).rootHex, max_per_spend: 1 },
    recipients: [VENDOR, RUNNER],
  } });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /recipients_root/);
});

test("a spending workflow on a grant that cannot pay the runner is refused, a notifying one is not", async () => {
  const b = await onboarded([VENDOR]);
  assert.equal(b.reg.body.feePayeeOnAllowlist, false);
  const spend = await b.call("POST", "/v1/workflows", { key: b.key, body: {
    agent: "shop-bot", trigger: { type: "manual" }, then: [{ type: "send", to: VENDOR, kas: "0.1" }] } });
  assert.equal(spend.status, 422);
  assert.match(spend.body.error, /fee/);
  const notify = await b.call("POST", "/v1/workflows", { key: b.key, body: {
    agent: "shop-bot", trigger: { type: "grant", when: "budget-below", percent: 20 },
    then: [{ type: "notify", channel: "telegram", to: "1", text: "low" }] } });
  assert.equal(notify.status, 201);
});

test("payees and amounts are checked against the grant when the workflow is created", async () => {
  const b = await onboarded();
  const stranger = await b.call("POST", "/v1/workflows", { key: b.key, body: {
    agent: "shop-bot", trigger: { type: "manual" }, then: [{ type: "send", to: "ff".repeat(32), kas: "0.1" }] } });
  assert.equal(stranger.status, 422);
  const big = await b.call("POST", "/v1/workflows", { key: b.key, body: {
    agent: "shop-bot", trigger: { type: "manual" }, then: [{ type: "pay-x402", url: "https://v.test/x", maxKas: "1" }] } });
  assert.equal(big.status, 422);
  assert.match(big.body.error, /cap/);
});

test("another account's agent does not exist, as far as you can tell", async () => {
  const b = await onboarded();
  const other = (await b.call("POST", "/v1/accounts", { body: {} })).body.apiKey;
  assert.equal((await b.call("GET", "/v1/agents/shop-bot", { key: other })).status, 404);
  assert.equal((await b.call("GET", "/v1/agents/shop-bot")).status, 401);
});

test("a webhook fires only with its secret, and once per idempotency key", async () => {
  const b = await onboarded();
  const wf = await b.call("POST", "/v1/workflows", { key: b.key, body: {
    agent: "shop-bot", trigger: { type: "webhook" },
    if: [{ field: "trigger.body.event", op: "==", value: "paid" }],
    then: [{ type: "send", to: VENDOR, kas: "0.1" }] } });
  const { url, secret } = wf.body.webhook;
  const path = new URL(url).pathname;
  assert.equal((await b.call("POST", path, { body: { event: "paid" }, headers: { "x-warda-hook": "wrong" } })).status, 404);
  const h = { "x-warda-hook": secret, "idempotency-key": "evt_1" };
  assert.equal((await b.call("POST", path, { body: { event: "paid" }, headers: h })).status, 202);
  await b.call("POST", path, { body: { event: "paid" }, headers: h });
  assert.equal(b.sent.length, 1);
});

test("tick needs the scheduler's secret", async () => {
  const b = bench();
  assert.equal((await b.call("POST", "/v1/tick")).status, 401);
  const ok = await b.call("POST", "/v1/tick", { headers: { authorization: `Bearer ${"t".repeat(32)}` } });
  assert.equal(ok.status, 200);
});

test("signup is invite-only when a code is set", async () => {
  const b = bench({ signupCode: "kaspa" });
  assert.equal((await b.call("POST", "/v1/accounts", { body: { code: "nope" } })).status, 403);
  assert.equal((await b.call("POST", "/v1/accounts", { body: { code: "kaspa" } })).status, 201);
});

test("creating an agent with funding returns a deposit, and the runner's fee payee is added for you", async () => {
  const b = bench();
  const key = (await b.call("POST", "/v1/accounts", { body: {} })).body.apiKey;
  const r = await b.call("POST", "/v1/agents", { key, body: { id: "funded-bot", funding: {
    principal: "02" + "cd".repeat(32),
    limits: { budgetKas: "1", maxPerPaymentKas: "0.2", days: 7 },
    payees: [VENDOR],
  } } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.deposit.address, /^kaspatest:q/);
  assert.equal(r.body.deposit.amountKas, "1.11");
  assert.match(r.body.deposit.note, /controls this deposit/);
  assert.equal(r.body.grant.principal, "cd".repeat(32), "a compressed key from a wallet is reduced to x-only");
  assert.ok(r.body.grant.warning, "principal doubling as revocation is flagged");
  assert.deepEqual(r.body.grant.payees.sort(), [VENDOR, RUNNER].sort());
  const got = await b.call("GET", "/v1/agents/funded-bot", { key });
  assert.equal(got.body.funding.status, "awaiting-deposit");
});

test("preflight requests are answered, and every response allows the console's origin", async () => {
  const b = bench();
  const r = await b.call("OPTIONS", "/v1/agents");
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("access-control-allow-origin"), "*");
  assert.equal(r.headers.get("access-control-allow-private-network"), "true");
});

test("MCP: an agent token reads its authority and pays inside its grant, and nothing else", async () => {
  const b = await onboarded();
  const tok = await b.call("POST", "/v1/agents/shop-bot/token", { key: b.key, body: {} });
  assert.equal(tok.status, 201);
  const t = tok.body.mcp.token as string;
  assert.match(t, /^wat_/);
  const rpc = (method: string, params: unknown = {}, token = t) =>
    b.call("POST", "/mcp", { body: { jsonrpc: "2.0", id: 1, method, params }, headers: { authorization: `Bearer ${token}` } });
  assert.equal((await rpc("tools/list", {}, "wat_nope")).status, 401);
  assert.equal((await b.call("POST", "/mcp", { key: b.key, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status, 401,
    "an account key is not an agent token");
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.match(init.body.result.instructions, /shop-bot/);
  const tools = (await rpc("tools/list")).body.result.tools.map((x: { name: string }) => x.name);
  assert.deepEqual(tools, ["get_authority", "pay", "list_workflows", "run_workflow", "list_runs"]);
  const auth = JSON.parse((await rpc("tools/call", { name: "get_authority", arguments: {} })).body.result.content[0].text);
  assert.equal(auth.perPaymentCapKas, "0.5");
  const paid = await rpc("tools/call", { name: "pay", arguments: { url: "https://v.test/fact", max_kas: "0.05" } });
  const r = JSON.parse(paid.body.result.content[0].text);
  assert.equal(r.status, "ok");
  assert.equal(r.txid, "tx402");
  assert.equal(r.served, '{"fact":"blocks converge"}');
  const cheap = await rpc("tools/call", { name: "pay", arguments: { url: "https://v.test/fact", max_kas: "0.01" } });
  assert.equal(cheap.body.result.isError, true, "a price above max_kas is refused, not paid");
  const runs = JSON.parse((await rpc("tools/call", { name: "list_runs", arguments: { limit: 5 } })).body.result.content[0].text);
  assert.equal(runs.length, 2);
  assert.equal((await b.call("POST", "/mcp", { body: { jsonrpc: "2.0", method: "notifications/initialized" }, headers: { authorization: `Bearer ${t}` } })).status, 202);
});

test("the agent list, in detail: state, money, jobs, last run", async () => {
  const b = await onboarded();
  await b.call("POST", "/v1/workflows", { key: b.key, body: {
    agent: "shop-bot", trigger: { type: "manual" }, then: [{ type: "send", to: VENDOR, kas: "0.1" }] } });
  const plain = await b.call("GET", "/v1/agents", { key: b.key });
  assert.deepEqual(plain.body.agents, ["shop-bot"]);
  const d = await b.call("GET", "/v1/agents?detail=1", { key: b.key });
  const row = d.body.agents[0];
  assert.equal(row.agent, "shop-bot");
  assert.equal(row.state, "active");
  assert.equal(row.spendableKas, "2");
  assert.equal(row.jobs, 1);
  assert.equal(row.lastRun, null);
});

test("Telegram: a one-time /start link connects the owner's chat, and nothing else can", async () => {
  const b = await onboarded();
  assert.deepEqual((await b.call("GET", "/v1/telegram", { key: b.key })).body, { available: true, connected: false });
  const link = await b.call("POST", "/v1/telegram/link", { key: b.key, body: {} });
  const code = /start=([\w-]+)$/.exec(link.body.url)![1]!;
  assert.match(link.body.url, /^https:\/\/t\.me\/warda_test_bot\?start=/);
  const hook = (body: unknown, secret = "hooksecret") =>
    b.call("POST", "/v1/telegram/hook", { body, headers: { "x-telegram-bot-api-secret-token": secret } });
  await hook({ message: { chat: { id: 42 }, text: `/start ${code}` } }, "forged");
  assert.equal((await b.call("GET", "/v1/telegram", { key: b.key })).body.connected, false, "a forged hook changes nothing");
  await hook({ message: { chat: { id: 42 }, text: `/start ${code}` } });
  assert.equal((await b.call("GET", "/v1/telegram", { key: b.key })).body.connected, true);
  assert.match(b.tg.at(-1)![1], /Connected/);
  await hook({ message: { chat: { id: 99 }, text: `/start ${code}` } });
  assert.match(b.tg.at(-1)![1], /expired or was already used/);
  const acct = await b.registry.ownerOf("shop-bot");
  assert.equal(await b.registry.telegramOf(acct!), "42");
});
