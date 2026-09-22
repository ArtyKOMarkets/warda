import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApi } from "../src/api.ts";
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
  const view: GrantView = {
    address: "kaspatest:grant", status: "ACTIVE", budgetTotal: 200_000_000n, spentTotal: 0n, reserved: 0n,
    maxPerSpend: 50_000_000n, epochRemaining: null, coin: 200_000_000n, payees: [VENDOR, RUNNER], expiresAtMs: now + 7 * 86_400_000,
  };
  const grants = { read: async (a: string) => ((await registry.getGrant(a)) ? structuredClone(view) : null) };
  const fees = { payee: RUNNER, perRunSompi: 1_000_000n, settleAtSompi: 10_000_000n, settleBeforeExpiryHours: 24 };
  const engine = new Engine({
    store, grants, fees, networkFee: 1_500_000n, now: () => now,
    payments: {
      async x402() { return { kind: "free", status: 200 }; },
      async send(_a, to, sompi, on) { sent.push(to); await on("tx", sompi); return { txid: "tx" }; },
    },
    notifier: { notify: async () => {} },
    http: { request: async () => 200 },
    approvals: { announce: async () => {} },
  });
  const api = createApi({
    store, registry, vault, engine, grants, fees, tickSecret: "t".repeat(32), baseUrl: BASE, now: () => now,
    ...(o.signupCode ? { signupCode: o.signupCode } : {}),
  });
  const call = async (method: string, path: string, opts: { key?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
    if (opts.key) headers.authorization = `Bearer ${opts.key}`;
    const res = await api(new Request(BASE + path, {
      method, headers, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    }));
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { call, sent, advance: (ms: number) => void (now += ms) };
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
