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
  assert.deepEqual(names, [
    "warda_build_spend",
    "warda_check_delegation",
    "warda_check_spend",
    "warda_grant_authority",
  ]);
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

test("warda_build_spend returns bytes to sign, and never a signature", async () => {
  // Wiring, not arithmetic — mcp/test/build.test.ts proves the bytes are the
  // ones the network accepted. What matters here is that the tool is reachable
  // and that its answer is inert: a digest, not a signed transaction.
  const c = await connect();
  const r = await call(c, "warda_build_spend", {
    grant: GRANT,
    amountKas: "1",
    recipient: ALLOWED,
    daaScore: "1000700",
    utxo: {
      transactionId: "09".repeat(32),
      index: 0,
      valueSompi: "10000000000",
      blockDaaScore: "1000000",
      isCoinbase: false,
      covenantId: "07".repeat(32),
    },
  });

  assert.equal(r.built, true);
  assert.equal(r.sighashHex.length, 64, "a digest is 32 bytes");
  assert.match(r.enforcement, /signs nothing/);
  assert.match(r.successorNote, /DIFFERENT address/);

  // The signature slot must still be empty. If this server ever returned a
  // filled one it would mean it had held a key.
  const sigscript = r.transaction.inputs[0].signatureScriptHex as string;
  assert.ok(sigscript.includes("41" + "00".repeat(65)), "the 65-byte signature push should be all zeros");

  // And the whole answer must be free of key material. `signatureScriptHex`
  // is expected and legitimate — the zeros check above is what proves that
  // slot is empty; this catches a key leaking in by any other name.
  const body = JSON.stringify(r);
  assert.ok(!/secret|privatekey|"sk"|seed/i.test(body), "no key material in the response");
});

test("warda_build_spend still builds when the advisory verdict says no", async () => {
  // A local rule that is too strict must not be able to block a payment the
  // chain would accept. The verdict is reported; it does not gate the build.
  const c = await connect();
  const r = await call(c, "warda_build_spend", {
    grant: GRANT,
    amountKas: "20", // over the 2 KAS per-spend cap
    recipient: ALLOWED,
    daaScore: "1000700",
    utxo: {
      transactionId: "09".repeat(32),
      index: 0,
      valueSompi: "10000000000",
      blockDaaScore: "1000000",
      isCoinbase: false,
      covenantId: "07".repeat(32),
    },
  });

  assert.equal(r.built, true, "the transaction should still be assembled");
  assert.equal(r.advisory.permitted, false);
  const codes = r.advisory.reasons.map((x: { code: string }) => x.code);
  assert.ok(codes.includes("EXCEEDS_MAX_PER_SPEND"));
});

test("warda_build_spend refuses an unlisted payee rather than faking a proof", async () => {
  const c = await connect();
  const r = await call(c, "warda_build_spend", {
    grant: GRANT,
    amountKas: "1",
    recipient: ATTACKER,
    daaScore: "1000700",
    utxo: {
      transactionId: "09".repeat(32),
      index: 0,
      valueSompi: "10000000000",
      blockDaaScore: "1000000",
      isCoinbase: false,
      covenantId: "07".repeat(32),
    },
  });

  assert.equal(r.built, false);
  assert.match(r.error, /not on this grant's allowlist/);
  // Still tells the agent what it CAN do, rather than only what it cannot.
  assert.equal(r.largestPermittedSpendKas, "2");
});
