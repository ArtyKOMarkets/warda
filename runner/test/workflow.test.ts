import { test } from "node:test";
import assert from "node:assert/strict";
import { authorityOf, parseWorkflow, WorkflowError } from "../src/workflow.ts";

const meta = { id: "wf_1", now: 0 };

test("a daily purchase parses to sompi", () => {
  const wf = parseWorkflow(
    {
      agent: "agent-009",
      trigger: { type: "schedule", cron: "23 9 * * *" },
      if: [{ field: "grant.availableKas", op: ">=", value: 0.5 }],
      then: [
        { type: "pay-x402", url: "https://warda-demo-api.vercel.app/digest", maxKas: "0.2" },
        { type: "notify", channel: "telegram", to: "@me", text: "done" },
      ],
    },
    meta,
  );
  assert.equal(wf.actions[0]!.type, "pay-x402");
  assert.equal((wf.actions[0] as { maxSompi: bigint }).maxSompi, 20_000_000n);
  assert.equal(authorityOf(wf), "agent");
});

test("owner operations exist only as approvals", () => {
  assert.throws(
    () => parseWorkflow({ agent: "a", trigger: { type: "manual" }, then: [{ type: "revoke" }] }, meta),
    /approval/,
  );
  const wf = parseWorkflow(
    { agent: "a", trigger: { type: "grant", when: "budget-below", percent: 20 }, then: [{ type: "approval", op: "topup" }] },
    meta,
  );
  assert.equal(authorityOf(wf), "owner");
});

test("refusals are specific", () => {
  const bad = (then: unknown[], trigger: unknown = { type: "manual" }) => () =>
    parseWorkflow({ agent: "a", trigger, then }, meta);
  assert.throws(bad([{ type: "pay-x402", url: "http://x.test", maxKas: "1" }]), /https/);
  assert.throws(bad([{ type: "send", to: "kaspatest:q", kas: "-1" }]), /positive KAS/);
  assert.throws(bad([{ type: "send", to: "kaspatest:q", kas: "0.000000001" }]), /positive KAS/);
  assert.throws(bad([]), /at least one action/);
  assert.throws(bad([{ type: "notify", channel: "sms", to: "x", text: "y" }]), /telegram or webhook/);
  assert.throws(bad([{ type: "http", url: "https://x.test" }], { type: "schedule", cron: "* * * *" }), WorkflowError);
});
