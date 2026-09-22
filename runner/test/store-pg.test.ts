/**
 * The same engine tests' guarantees, against real Postgres (PGlite, in
 * process). What matters most is that the database — not the engine — is
 * what makes a slot run once and an agent's key unreplaceable.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { decode, encode, migrate, pgStore } from "../src/store-pg.ts";
import { parseWorkflow } from "../src/workflow.ts";
import { matches } from "../src/cron.ts";
import type { RunRecord } from "../src/store.ts";

async function fresh() {
  const db = new PGlite();
  await migrate(db);
  await migrate(db); // idempotent
  return pgStore(db);
}

const run = (key: string, id = key): RunRecord => ({
  id, workflowId: "wf_1", agent: "a", key, trigger: "schedule",
  startedAt: 1, status: "running", steps: [], charged: false,
});

test("bigints and parsed cron survive the round trip", async () => {
  const s = await fresh();
  const wf = parseWorkflow(
    { agent: "a", trigger: { type: "schedule", cron: "23 9 * * *" },
      then: [{ type: "pay-x402", url: "https://v.test/x", maxKas: "0.2" }] },
    { id: "wf_1", now: 5 },
  );
  await s.putWorkflow(wf);
  const back = (await s.getWorkflow("wf_1"))!;
  assert.equal((back.actions[0] as { maxSompi: bigint }).maxSompi, 20_000_000n);
  assert.ok(back.trigger.type === "schedule" && matches(back.trigger.cron, new Date("2026-09-22T09:23:00Z")));
  assert.deepEqual(decode(encode({ a: 1n, b: new Set([1, 2]) })), { a: 1n, b: new Set([1, 2]) });
});

test("the database, not the engine, makes a slot run once", async () => {
  const s = await fresh();
  const results = await Promise.all([s.claimRun(run("slot:9", "r1")), s.claimRun(run("slot:9", "r2"))]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal((await s.listRuns("a")).length, 1);
});

test("a run's steps and txid persist through updates", async () => {
  const s = await fresh();
  const r = run("k");
  await s.claimRun(r);
  r.inflight = { action: "pay-x402", status: "submitted", txid: "tx1", sompi: "3000000" };
  await s.updateRun(r);
  assert.equal((await s.listRuns("a"))[0]!.inflight!.txid, "tx1");
});

test("an agent's key record can never be replaced", async () => {
  const s = await fresh();
  const rec = { agent: "a", publicKey: "aa".repeat(32), provider: "turnkey" as const, sealed: "{}", createdAt: 1 };
  await s.putVault(rec);
  await assert.rejects(s.putVault({ ...rec, publicKey: "bb".repeat(32) }), /already has a key/);
  assert.equal((await s.getVault("a"))!.publicKey, "aa".repeat(32));
});

test("cursors, edges, ledgers and approvals", async () => {
  const s = await fresh();
  assert.equal(await s.getCursor("wf_1"), null);
  await s.setCursor("wf_1", 10); await s.setCursor("wf_1", 20);
  assert.equal(await s.getCursor("wf_1"), 20);
  await s.setEdge("wf_1", "firing");
  assert.equal(await s.getEdge("wf_1"), "firing");
  await s.setLedger("a", { owed: 3n, runs: 1, settled: 0n, lastSettlementTxid: null });
  assert.equal((await s.getLedger("a"))!.owed, 3n);
  await s.putApproval({ id: "p1", agent: "a", workflowId: "wf_1", runId: "r", op: "topup", note: "", createdAt: 1, status: "pending" });
  assert.equal((await s.listApprovals("a"))[0]!.op, "topup");
});

test("the registry on Postgres: accounts, ownership, grants, hook secrets", async () => {
  const { migrateRegistry, pgRegistry } = await import("../src/registry.ts");
  const db = new PGlite();
  await migrateRegistry(db);
  const r = pgRegistry(db);
  const a = await r.createAccount(1);
  assert.equal(await r.accountFor(a.apiKey), a.id);
  assert.equal(await r.accountFor("wk_nope"), null);
  assert.equal(await r.claimAgent("bot", a.id, 1), true);
  assert.equal(await r.claimAgent("bot", "someone-else", 2), false);
  assert.equal(await r.ownerOf("bot"), a.id);
  await r.putGrant({ agent: "bot", manifest: { agent: "aa" } as never, recipients: ["x"], updatedAt: 3 });
  assert.deepEqual((await r.getGrant("bot"))!.recipients, ["x"]);
  const s = await r.createHook("wf_1");
  assert.equal(await r.checkHook("wf_1", s), true);
  assert.equal(await r.checkHook("wf_1", s + "x"), false);
  const { rows } = await db.query(`select secret_hash from runner_hooks`);
  assert.notEqual((rows[0] as { secret_hash: string }).secret_hash, s, "only the hash is stored");
});
