import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine, type Payments } from "../src/engine.ts";
import type { GrantView } from "../src/grant.ts";
import { memoryStore, type Approval } from "../src/store.ts";
import { parseWorkflow } from "../src/workflow.ts";

const KAS = 100_000_000n;
const RUNNER = "kaspatest:runner";
const VENDOR = "kaspatest:vendor";

function world(o: { price?: bigint; failAfterSubmit?: boolean; start?: number } = {}) {
  let now = o.start ?? Date.parse("2026-09-22T09:00:30Z");
  const g: GrantView = {
    address: "kaspatest:grant",
    status: "ACTIVE",
    budgetTotal: 2n * KAS,
    spentTotal: 0n,
    reserved: 0n,
    maxPerSpend: KAS / 2n,
    epochRemaining: null,
    coin: 2n * KAS,
    payees: [VENDOR, RUNNER],
    expiresAtMs: now + 30 * 86_400_000,
  };
  let readable = true;
  const sent: { to: string; sompi: bigint; txid: string }[] = [];
  const limits: bigint[] = [];
  const notes: string[] = [];
  const announced: Approval[] = [];
  let n = 0;
  const spend = (s: bigint) => {
    g.spentTotal += s;
    g.coin -= s + 1_500_000n;
    return `tx${++n}`;
  };
  const payments: Payments = {
    async x402(_a, _req, limit, onSubmitted) {
      limits.push(limit);
      const price = o.price ?? KAS / 10n;
      if (price > limit) return { kind: "refused", reason: `asks ${price}, limit ${limit}` };
      const txid = spend(price);
      await onSubmitted(txid, price);
      if (o.failAfterSubmit) throw new Error("vendor timed out");
      return { kind: "paid", status: 200, txid, sompi: price };
    },
    async send(_a, to, sompi, onSubmitted) {
      const txid = spend(sompi);
      sent.push({ to, sompi, txid });
      await onSubmitted(txid, sompi);
      return { txid };
    },
  };
  const store = memoryStore();
  const engine = new Engine({
    store,
    grants: { read: async () => (readable ? structuredClone(g) : null) },
    payments,
    notifier: { notify: async (_c, _t, text) => void notes.push(text) },
    http: { request: async () => 200 },
    approvals: { announce: async (a) => void announced.push(a) },
    fees: { payee: RUNNER, perRunSompi: 1_000_000n, settleAtSompi: 3_000_000n, settleBeforeExpiryHours: 24 },
    networkFee: 1_500_000n,
    now: () => now,
  });
  return {
    g, store, engine, sent, limits, notes, announced,
    advance: (ms: number) => void (now += ms),
    setReadable: (r: boolean) => void (readable = r),
    now: () => now,
  };
}

const wf = (w: world, body: Record<string, unknown>, id = "wf_1") =>
  parseWorkflow({ agent: "agent-009", ...body }, { id, now: w.now() });
type world = ReturnType<typeof world>;

test("a schedule runs its slot once, and a restart does not pay again", async () => {
  const w = world();
  await w.engine.add(wf(w, { trigger: { type: "schedule", cron: "23 9 * * *" },
    then: [{ type: "pay-x402", url: "https://v.test/digest", maxKas: "0.2" },
           { type: "notify", channel: "telegram", to: "1", text: "{{grant.availableKas}} left, {{run.lastTxid}}" }] }));
  w.advance(23 * 60_000);
  const r1 = await w.engine.tick();
  assert.equal(r1.started.length, 1);
  assert.deepEqual(w.notes, ["1.9 left, tx1"]);
  await w.store.setCursor("wf_1", w.now() - 60 * 60_000); // as if the cursor were lost
  const r2 = await w.engine.tick();
  assert.equal(r2.started.length, 0, "the same slot must not run twice");
  assert.equal(w.g.spentTotal, KAS / 10n);
});

test("a runner that was down runs only the latest missed slot", async () => {
  const w = world();
  await w.engine.add(wf(w, { trigger: { type: "schedule", cron: "0 * * * *" },
    then: [{ type: "notify", channel: "telegram", to: "1", text: "hi" }] }));
  w.advance(5 * 3_600_000);
  const r = await w.engine.tick();
  assert.equal(r.started.length, 1);
  assert.equal(r.missed, 4);
  const runs = await w.store.listRuns("agent-009");
  assert.equal(runs.filter((x) => x.status === "missed").length, 4);
});

test("the workflow's maximum narrows the grant's, and a refusal spends and charges nothing", async () => {
  const w = world({ price: 30_000_000n });
  await w.engine.add(wf(w, { trigger: { type: "manual" },
    then: [{ type: "pay-x402", url: "https://v.test/x", maxKas: "0.2" }] }));
  const id = await w.engine.fire("wf_1", "manual");
  const [run] = await w.store.listRuns("agent-009");
  assert.equal(run!.id, id);
  assert.equal(run!.status, "refused");
  assert.equal(w.limits[0], 20_000_000n);
  assert.equal(run!.charged, false);
  assert.equal(w.g.spentTotal, 0n);
});

test("send refuses a payee the grant never committed to", async () => {
  const w = world();
  await w.engine.add(wf(w, { trigger: { type: "manual" }, then: [{ type: "send", to: "kaspatest:stranger", kas: "0.1" }] }));
  await w.engine.fire("wf_1", "manual");
  const [run] = await w.store.listRuns("agent-009");
  assert.equal(run!.status, "refused");
  assert.match(run!.steps[0]!.detail!, /allowlist/);
  assert.equal(w.sent.length, 0);
});

test("#005: broadcast then failure is undelivered, keeps the txid, and is never re-paid", async () => {
  const w = world({ failAfterSubmit: true });
  await w.engine.add(wf(w, { trigger: { type: "webhook" }, then: [{ type: "pay-x402", url: "https://v.test/x", maxKas: "0.2" }] }));
  await w.engine.fire("wf_1", "webhook", { key: "delivery-1" });
  const [run] = await w.store.listRuns("agent-009");
  assert.equal(run!.status, "undelivered");
  assert.equal(run!.steps[0]!.txid, "tx1");
  assert.match(run!.steps[0]!.detail!, /do not pay again/);
  assert.equal(await w.engine.fire("wf_1", "webhook", { key: "delivery-1" }), null);
  assert.equal(w.g.spentTotal, KAS / 10n);
});

test("fees accrue per run, are not spendable, and settle in one payment", async () => {
  const w = world();
  await w.engine.add(wf(w, { trigger: { type: "manual" }, then: [{ type: "notify", channel: "telegram", to: "1", text: "x" }] }));
  await w.engine.fire("wf_1", "manual");
  await w.engine.fire("wf_1", "manual");
  assert.equal((await w.store.getLedger("agent-009"))!.owed, 2_000_000n);
  assert.equal(w.sent.length, 0, "too small to be worth a network fee");
  await w.engine.fire("wf_1", "manual");
  assert.deepEqual(w.sent.map((s) => [s.to, s.sompi]), [[RUNNER, 3_000_000n]]);
  const l = (await w.store.getLedger("agent-009"))!;
  assert.equal(l.owed, 0n);
  assert.equal(l.settled, 3_000_000n);
  assert.equal(l.lastSettlementTxid, "tx1");
});

test("owed fees are committed: a workflow cannot spend them", async () => {
  const w = world({ price: 40_000_000n });
  w.g.spentTotal = 2n * KAS - 40_000_000n;
  await w.store.setLedger("agent-009", { owed: 1_000_000n, runs: 1, settled: 0n, lastSettlementTxid: null });
  await w.engine.add(wf(w, { trigger: { type: "manual" }, then: [{ type: "pay-x402", url: "https://v.test/x", maxKas: "0.5" }] }));
  await w.engine.fire("wf_1", "manual");
  assert.equal(w.limits[0], 39_000_000n);
  assert.equal((await w.store.listRuns("agent-009"))[0]!.status, "refused");
});

test("a grant trigger fires on the transition, holds through undecided, and re-arms", async () => {
  const w = world();
  await w.engine.add(wf(w, { trigger: { type: "grant", when: "budget-below", percent: 20 },
    then: [{ type: "approval", op: "topup", note: "running low" }] }));
  assert.equal((await w.engine.tick()).started.length, 0);
  w.g.spentTotal = 17n * KAS / 10n; // 15% left
  assert.equal((await w.engine.tick()).started.length, 1);
  assert.equal(w.announced.length, 1);
  assert.equal(w.announced[0]!.op, "topup");
  w.setReadable(false);
  assert.equal((await w.engine.tick()).started.length, 0);
  w.setReadable(true);
  assert.equal((await w.engine.tick()).started.length, 0, "still firing; no repeat");
  w.g.spentTotal = 0n;
  await w.engine.tick();
  w.g.spentTotal = 19n * KAS / 10n;
  w.advance(1);
  assert.equal((await w.engine.tick()).started.length, 1, "re-armed after clearing");
});

test("an unreadable grant is undecided and nothing runs", async () => {
  const w = world();
  w.setReadable(false);
  await w.engine.add(wf(w, { trigger: { type: "manual" }, then: [{ type: "send", to: VENDOR, kas: "0.1" }] }));
  await w.engine.fire("wf_1", "manual");
  const [run] = await w.store.listRuns("agent-009");
  assert.equal(run!.status, "undecided");
  assert.equal(w.sent.length, 0);
});

test("conditions gate a run, and a skipped run is not charged", async () => {
  const w = world();
  await w.engine.add(wf(w, { trigger: { type: "webhook" },
    if: [{ field: "trigger.body.event", op: "==", value: "order.paid" }, { field: "grant.availableKas", op: ">=", value: 1 }],
    then: [{ type: "send", to: VENDOR, kas: "0.1" }] }));
  await w.engine.fire("wf_1", "webhook", { key: "a", body: { event: "order.created" } });
  await w.engine.fire("wf_1", "webhook", { key: "b", body: { event: "order.paid" } });
  const runs = await w.store.listRuns("agent-009");
  assert.deepEqual(runs.map((r) => r.status).sort(), ["ok", "skipped"]);
  assert.equal(runs.find((r) => r.status === "skipped")!.charged, false);
  assert.equal(w.sent.length, 1);
});
