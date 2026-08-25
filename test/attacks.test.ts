/**
 * Phase 7 of the spec: a deliberately malicious agent. Every attack here
 * must fail, and must fail for the stated reason. If any test in this file
 * ever passes an attack, the protocol claim is false.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateSpend, validateDelegation, revoke } from "../src/validate.ts";
import { createGrant, available } from "../src/grant.ts";
import { RecipientSet } from "../src/merkle.ts";
import { kas } from "../src/amounts.ts";
import {
  rootGrant, freshState, honestSpend, ALLOWED,
  SEARCH_API, ATTACKER, AGENT_B, REVOKER, hex32,
} from "./fixtures.ts";

const DAA = 1_000_500n;

test("baseline: an honest spend is accepted", () => {
  const g = rootGrant();
  const s = freshState(g);
  const v = validateSpend(g, s, honestSpend(g, s, kas("0.05"), SEARCH_API, DAA));
  assert.ok(v.ok, `expected accept, got ${v.failures.join(", ")}`);
});

test("ATTACK 1 — overspend past max_per_spend is rejected", () => {
  const g = rootGrant();
  const s = freshState(g);
  const v = validateSpend(g, s, honestSpend(g, s, kas("20"), SEARCH_API, DAA));
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("EXCEEDS_MAX_PER_SPEND"));
  assert.ok(v.failures.includes("EXCEEDS_EPOCH_LIMIT"));
});

test("ATTACK 2 — payment to an unlisted recipient is rejected", () => {
  const g = rootGrant();
  const s = freshState(g);
  const req = honestSpend(g, s, kas("1"), ATTACKER, DAA);
  const v = validateSpend(g, s, req);
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ["RECIPIENT_NOT_AUTHORIZED"]);
});

test("ATTACK 2b — a valid proof for a different recipient does not transfer", () => {
  const g = rootGrant();
  const s = freshState(g);
  const req = honestSpend(g, s, kas("1"), SEARCH_API, DAA);
  req.recipient = ATTACKER; // keep the good proof, swap the payee
  const v = validateSpend(g, s, req);
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("RECIPIENT_NOT_AUTHORIZED"));
});

test("ATTACK 3 — spending after expiry is rejected", () => {
  const g = rootGrant();
  const s = freshState(g);
  const v = validateSpend(g, s, honestSpend(g, s, kas("1"), SEARCH_API, 1_007_001n));
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("EXPIRED"));
});

test("ATTACK 3b — spending before not_before is rejected", () => {
  const g = rootGrant();
  const s = freshState(g);
  const v = validateSpend(g, s, honestSpend(g, s, kas("1"), SEARCH_API, 999_999n));
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("NOT_YET_VALID"));
});

test("ATTACK 4 — rewriting the successor budget is rejected", () => {
  const g = rootGrant();
  const s = freshState(g);
  const req = honestSpend(g, s, kas("2"), SEARCH_API, DAA);
  req.successor.spentTotal = 0n; // spend the money, keep the budget
  const v = validateSpend(g, s, req);
  assert.equal(v.ok, false);
  assert.deepEqual(v.failures, ["INVALID_SUCCESSOR"]);
});

test("ATTACK 4b — inflating the successor budget is rejected", () => {
  const g = rootGrant();
  const s = freshState(g);
  const req = honestSpend(g, s, kas("2"), SEARCH_API, DAA);
  req.successor.spentTotal = -kas("400"); // negative spend = more budget
  const v = validateSpend(g, s, req);
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("INVALID_SUCCESSOR"));
});

test("ATTACK 4c — releasing reserved funds in the successor is rejected", () => {
  const g = rootGrant();
  const s = { ...freshState(g), reserved: kas("25") };
  const req = honestSpend(g, s, kas("1"), SEARCH_API, DAA);
  req.successor.reserved = 0n; // reclaim what was delegated to a child
  const v = validateSpend(g, s, req);
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("INVALID_SUCCESSOR"));
});

test("ATTACK 5 — replaying a spend against the advanced state is rejected", () => {
  const g = rootGrant();
  const s0 = freshState(g);
  const req = honestSpend(g, s0, kas("2"), SEARCH_API, DAA);

  const first = validateSpend(g, s0, req);
  assert.ok(first.ok);
  const s1 = first.expectedSuccessor!;

  // Identical transaction, resubmitted. The state it commits to is stale.
  const replay = validateSpend(g, s1, req);
  assert.equal(replay.ok, false);
  assert.ok(replay.failures.includes("INVALID_SUCCESSOR"));
});

test("ATTACK 6 — delegation escalation is rejected", () => {
  const parent = rootGrant();
  const ps = freshState(parent);
  const child = createGrant({
    version: 1, parentId: parent.grantId,
    principalKey: parent.principalKey, agentKey: AGENT_B, revocationKey: REVOKER,
    assetId: "KAS",
    budgetTotal: kas("50"),
    maxPerSpend: kas("5"),      // parent allows 2
    epochLimit: kas("20"),      // parent allows 10
    epochLength: parent.epochLength,
    recipientsRoot: parent.recipientsRoot, recipientsDepth: parent.recipientsDepth,
    notBefore: parent.notBefore, expiresAt: parent.expiresAt,
    delegationDepth: 1, nonce: hex32(0x02),
  });
  const v = validateDelegation(parent, ps, {
    parentId: parent.grantId, child, daaScore: DAA,
    parentSuccessor: { ...ps, reserved: child.budgetTotal },
  });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_MAX_PER_SPEND_EXCEEDS_PARENT"));
  assert.ok(v.failures.includes("CHILD_EPOCH_LIMIT_EXCEEDS_PARENT"));
});

test("ATTACK 6b — a child outliving its parent is rejected", () => {
  const parent = rootGrant();
  const ps = freshState(parent);
  const child = createGrant({
    version: 1, parentId: parent.grantId,
    principalKey: parent.principalKey, agentKey: AGENT_B, revocationKey: REVOKER,
    assetId: "KAS", budgetTotal: kas("10"), maxPerSpend: kas("1"),
    epochLimit: kas("5"), epochLength: parent.epochLength,
    recipientsRoot: parent.recipientsRoot, recipientsDepth: parent.recipientsDepth,
    notBefore: parent.notBefore,
    expiresAt: parent.expiresAt + 1n,
    delegationDepth: 1, nonce: hex32(0x03),
  });
  const v = validateDelegation(parent, ps, {
    parentId: parent.grantId, child, daaScore: DAA,
    parentSuccessor: { ...ps, reserved: child.budgetTotal },
  });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_OUTLIVES_PARENT"));
});

test("ATTACK 6c — a child widening the recipient set is rejected", () => {
  const parent = rootGrant();
  const ps = freshState(parent);
  const wider = new RecipientSet([...ALLOWED.recipients, ATTACKER]);
  const child = createGrant({
    version: 1, parentId: parent.grantId,
    principalKey: parent.principalKey, agentKey: AGENT_B, revocationKey: REVOKER,
    assetId: "KAS", budgetTotal: kas("10"), maxPerSpend: kas("1"),
    epochLimit: kas("5"), epochLength: parent.epochLength,
    recipientsRoot: wider.root, recipientsDepth: wider.depth,
    notBefore: parent.notBefore, expiresAt: parent.expiresAt,
    delegationDepth: 1, nonce: hex32(0x04),
  });
  const v = validateDelegation(parent, ps, {
    parentId: parent.grantId, child, daaScore: DAA,
    // Witnesses the attacker as a member, but no valid proof exists for it
    // in the parent tree — so the widening cannot be justified.
    recipientWitness: {
      mode: "subset",
      members: [...wider.recipients].map((r) => ({
        recipient: r,
        proof: ALLOWED.proof(ALLOWED.recipients[0]!),
      })),
    },
    parentSuccessor: { ...ps, reserved: child.budgetTotal },
  });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_RECIPIENTS_NOT_SUBSET"));
});

test("ATTACK 7 — delegating more than the parent still has is rejected", () => {
  const parent = rootGrant();
  const ps = { ...freshState(parent), spentTotal: kas("90") };
  const child = createGrant({
    version: 1, parentId: parent.grantId,
    principalKey: parent.principalKey, agentKey: AGENT_B, revocationKey: REVOKER,
    assetId: "KAS",
    budgetTotal: kas("25"),   // only 10 KAS remains
    maxPerSpend: kas("1"), epochLimit: kas("5"), epochLength: parent.epochLength,
    recipientsRoot: parent.recipientsRoot, recipientsDepth: parent.recipientsDepth,
    notBefore: parent.notBefore, expiresAt: parent.expiresAt,
    delegationDepth: 1, nonce: hex32(0x05),
  });
  const v = validateDelegation(parent, ps, {
    parentId: parent.grantId, child, daaScore: DAA,
    parentSuccessor: { ...ps, reserved: child.budgetTotal },
  });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_BUDGET_EXCEEDS_PARENT"));
});

test("ATTACK 8 — spending from a revoked grant is rejected", () => {
  const g = rootGrant();
  const s = revoke(freshState(g));
  const v = validateSpend(g, s, honestSpend(g, s, kas("1"), SEARCH_API, DAA));
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("REVOKED"));
});

test("ATTACK 9 — delegation depth cannot be extended", () => {
  const parent = rootGrant({ delegationDepth: 0 } as never);
  const ps = freshState(parent);
  const child = createGrant({
    version: 1, parentId: parent.grantId,
    principalKey: parent.principalKey, agentKey: AGENT_B, revocationKey: REVOKER,
    assetId: "KAS", budgetTotal: kas("10"), maxPerSpend: kas("1"),
    epochLimit: kas("5"), epochLength: parent.epochLength,
    recipientsRoot: parent.recipientsRoot, recipientsDepth: parent.recipientsDepth,
    notBefore: parent.notBefore, expiresAt: parent.expiresAt,
    delegationDepth: 0, nonce: hex32(0x06),
  });
  const v = validateDelegation(parent, ps, {
    parentId: parent.grantId, child, daaScore: DAA,
    parentSuccessor: { ...ps, reserved: child.budgetTotal },
  });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("DELEGATION_DEPTH_EXHAUSTED"));
});

test("conservation — delegating never increases total authority", () => {
  const parent = rootGrant();
  const ps = freshState(parent);
  const childBudget = kas("25");
  const child = createGrant({
    version: 1, parentId: parent.grantId,
    principalKey: parent.principalKey, agentKey: AGENT_B, revocationKey: REVOKER,
    assetId: "KAS", budgetTotal: childBudget, maxPerSpend: kas("2"),
    epochLimit: kas("5"), epochLength: parent.epochLength,
    recipientsRoot: parent.recipientsRoot, recipientsDepth: parent.recipientsDepth,
    notBefore: parent.notBefore, expiresAt: parent.expiresAt,
    delegationDepth: 1, nonce: hex32(0x07),
  });
  const v = validateDelegation(parent, ps, {
    parentId: parent.grantId, child, daaScore: DAA,
    parentSuccessor: { ...ps, reserved: childBudget },
  });
  assert.ok(v.ok, v.failures.join(", "));

  const parentAfter = available(parent, v.expectedSuccessor!);
  assert.equal(parentAfter + childBudget, parent.budgetTotal);
});
