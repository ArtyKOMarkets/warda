import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/ops.ts";
import type { RunRecord } from "../src/store.ts";

const run = (o: Partial<RunRecord>): RunRecord => ({
  id: "r", workflowId: "w", agent: "a", key: "k", trigger: "manual", startedAt: 0, status: "ok", steps: [], charged: false, ...o,
});

test("classify: the runner's faults and stuck money, not owners' refusals", () => {
  assert.equal(classify(run({ status: "ok" })), null);
  assert.equal(classify(run({ status: "refused", steps: [{ action: "send", status: "refused", detail: "over the cap" }] })), null);
  assert.equal(classify(run({ status: "skipped" })), null);
  assert.equal(classify(run({ status: "failed", steps: [{ action: "send", status: "failed", detail: "Turnkey error 7: You don't have sufficient permissions" }] }))!.kind, "signing");
  assert.equal(classify(run({ status: "undecided", note: "the grant could not be read, so nothing was run" }))!.kind, "chain");
  assert.equal(classify(run({ status: "undelivered" }))!.kind, "undelivered");
  assert.equal(classify(run({ status: "failed", steps: [{ action: "http", status: "failed", detail: "HTTP 500" }] }))!.kind, "run-failed");
});
