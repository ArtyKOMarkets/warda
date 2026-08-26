/**
 * Drives the real MCP server over an in-memory transport — same registration,
 * same schemas, same handlers a framework would reach. Testing the helper
 * functions directly would not prove the tools are wired correctly.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";

const GRANT = {
  agentKey: "22".repeat(32),
  principalKey: "11".repeat(32),
  revocationKey: "44".repeat(32),
  budgetKas: "100",
  maxPerSpendKas: "2",
  epochLimitKas: "10",
  epochLength: "1000",
  recipients: ["a1".repeat(32), "a2".repeat(32), "a3".repeat(32)],
  notBefore: "1000000",
  expiresAt: "1007000",
  delegationDepth: 2,
  nonce: "01".repeat(32),
};
const DAA = "1000500";
const ALLOWED = "a1".repeat(32);
const ATTACKER = "ee".repeat(32);

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([buildServer().connect(b), client.connect(a)]);
  return client;
}

const call = async (c: Client, name: string, args: Record<string, unknown>) =>
  JSON.parse(((await c.callTool({ name, arguments: args })) as any).content[0].text);

test("the tools a framework would discover are registered", async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["warda_check_delegation", "warda_check_spend", "warda_grant_authority"]);
});

test("authority reports the BINDING constraint, not just the budget", async () => {
  const c = await connect();
  const r = await call(c, "warda_grant_authority", { grant: GRANT, daaScore: DAA });
  assert.equal(r.availableKas, "100");
  assert.equal(r.epochRemainingKas, "10");
  // The number an agent actually needs: min(available, epoch left, per-spend).
  assert.equal(r.largestPermittedSpendKas, "2");
});

test("a legitimate payment is permitted", async () => {
  const c = await connect();
  const r = await call(c, "warda_check_spend", {
    grant: GRANT, amountKas: "0.05", recipient: ALLOWED, daaScore: DAA,
  });
  assert.equal(r.permitted, true);
  assert.deepEqual(r.reasons, []);
});

test("an unlisted payee is refused, and says why in words", async () => {
  const c = await connect();
  const r = await call(c, "warda_check_spend", {
    grant: GRANT, amountKas: "1", recipient: ATTACKER, daaScore: DAA,
  });
  assert.equal(r.permitted, false);
  assert.equal(r.recipientOnAllowlist, false);
  const codes = r.reasons.map((x: { code: string }) => x.code);
  assert.ok(codes.includes("RECIPIENT_NOT_AUTHORIZED"));
  assert.match(r.reasons[0].explanation, /allowlist/);
});

test("an overspend is refused with an actionable explanation", async () => {
  const c = await connect();
  const r = await call(c, "warda_check_spend", {
    grant: GRANT, amountKas: "20", recipient: ALLOWED, daaScore: DAA,
  });
  assert.equal(r.permitted, false);
  const cap = r.reasons.find((x: { code: string }) => x.code === "EXCEEDS_MAX_PER_SPEND");
  assert.ok(cap, "should name the per-spend cap");
  assert.match(cap.explanation, /Split it|raise the cap/);
});

test("every answer states that it is advisory", async () => {
  // The one thing this server must never imply is that it enforces anything.
  const c = await connect();
  for (const args of [
    { name: "warda_check_spend", arguments: { grant: GRANT, amountKas: "1", recipient: ALLOWED, daaScore: DAA } },
    { name: "warda_check_delegation", arguments: { parent: GRANT, childBudgetKas: "25", childMaxPerSpendKas: "1", childEpochLimitKas: "5", childAgentKey: "99".repeat(32), daaScore: DAA } },
  ]) {
    const r = JSON.parse(((await c.callTool(args)) as any).content[0].text);
    assert.match(r.enforcement, /Advisory/);
  }
});

test("a narrower child is permitted and the parent reserves it", async () => {
  const c = await connect();
  const r = await call(c, "warda_check_delegation", {
    parent: GRANT, childBudgetKas: "25", childMaxPerSpendKas: "1",
    childEpochLimitKas: "5", childAgentKey: "99".repeat(32), daaScore: DAA,
  });
  assert.equal(r.permitted, true, JSON.stringify(r.reasons));
  assert.equal(r.parentReservesKas, "25");
  assert.equal(r.parentRemainingAfterKas, "75");
});

test("a child that widens any axis is refused", async () => {
  const c = await connect();
  const r = await call(c, "warda_check_delegation", {
    parent: GRANT, childBudgetKas: "25",
    childMaxPerSpendKas: "10", // parent allows 2
    childEpochLimitKas: "5", childAgentKey: "99".repeat(32), daaScore: DAA,
  });
  assert.equal(r.permitted, false);
  const codes = r.reasons.map((x: { code: string }) => x.code);
  assert.ok(codes.includes("CHILD_MAX_PER_SPEND_EXCEEDS_PARENT"));
});
