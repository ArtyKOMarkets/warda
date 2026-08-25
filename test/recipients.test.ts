/**
 * The recipient-subset witness. See the block comment on validateDelegation
 * for why a root alone cannot decide the subset relation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateDelegation, MAX_SUBSET_MEMBERS } from "../src/validate.ts";
import { createGrant, initialState } from "../src/grant.ts";
import { RecipientSet } from "../src/merkle.ts";
import { kas } from "../src/amounts.ts";
import type { Grant, RecipientWitness } from "../src/types.ts";
import { rootGrant, ALLOWED, SEARCH_API, DATA_API, COMPUTE_API, ATTACKER, REVOKER, hex32 } from "./fixtures.ts";

const DAA = 1_000_500n;
let nonce = 0x50;

function childOf(parent: Grant, recipients: RecipientSet, over: Partial<Grant> = {}): Grant {
  return createGrant({
    version: 1, parentId: parent.grantId, principalKey: parent.principalKey,
    agentKey: hex32(nonce), revocationKey: REVOKER, assetId: "KAS",
    budgetTotal: kas("10"), maxPerSpend: kas("1"), epochLimit: kas("5"),
    epochLength: parent.epochLength,
    recipientsRoot: recipients.root, recipientsDepth: recipients.depth,
    notBefore: parent.notBefore, expiresAt: parent.expiresAt,
    delegationDepth: 1, nonce: hex32(nonce++),
    ...over,
  } as Omit<Grant, "grantId">);
}

function delegate(parent: Grant, child: Grant, witness?: RecipientWitness) {
  const ps = initialState(parent);
  return validateDelegation(parent, ps, {
    parentId: parent.grantId, child, daaScore: DAA,
    recipientWitness: witness,
    parentSuccessor: { ...ps, reserved: child.budgetTotal },
  });
}

/** Witness naming `members`, proofs taken from the parent's tree. */
function subsetWitness(parentSet: RecipientSet, members: string[]): RecipientWitness {
  const sorted = [...members].sort();
  return {
    mode: "subset",
    members: sorted.map((r) => ({
      recipient: r,
      proof: parentSet.has(r) ? parentSet.proof(r) : parentSet.proof(parentSet.recipients[0]!),
    })),
  };
}

test("inherit — identical roots is accepted", () => {
  const parent = rootGrant();
  const v = delegate(parent, childOf(parent, ALLOWED), { mode: "inherit" });
  assert.ok(v.ok, v.failures.join(", "));
});

test("inherit — is the default when no witness is supplied", () => {
  const parent = rootGrant();
  const v = delegate(parent, childOf(parent, ALLOWED));
  assert.ok(v.ok, v.failures.join(", "));
});

test("inherit — a different root is rejected", () => {
  const parent = rootGrant();
  const other = new RecipientSet([SEARCH_API, DATA_API]);
  const v = delegate(parent, childOf(parent, other), { mode: "inherit" });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_RECIPIENTS_NOT_SUBSET"));
});

test("subset — a genuine narrowing is accepted", () => {
  const parent = rootGrant();
  const narrowed = new RecipientSet([SEARCH_API, DATA_API]);
  const v = delegate(parent, childOf(parent, narrowed), subsetWitness(ALLOWED, [SEARCH_API, DATA_API]));
  assert.ok(v.ok, v.failures.join(", "));
});

test("subset — a single recipient is accepted", () => {
  const parent = rootGrant();
  const one = new RecipientSet([COMPUTE_API]);
  const v = delegate(parent, childOf(parent, one), subsetWitness(ALLOWED, [COMPUTE_API]));
  assert.ok(v.ok, v.failures.join(", "));
});

test("subset — smuggling an outsider in is rejected", () => {
  const parent = rootGrant();
  const wider = new RecipientSet([SEARCH_API, ATTACKER]);
  const v = delegate(parent, childOf(parent, wider), {
    mode: "subset",
    members: [SEARCH_API, ATTACKER].sort().map((r) => ({
      recipient: r,
      proof: ALLOWED.proof(SEARCH_API), // no valid proof exists for the attacker
    })),
  });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_RECIPIENTS_NOT_SUBSET"));
});

test("subset — committing to a wider root than witnessed is rejected", () => {
  const parent = rootGrant();
  // Witness one recipient, commit to the full parent set.
  const v = delegate(parent, childOf(parent, ALLOWED), subsetWitness(ALLOWED, [SEARCH_API]));
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_RECIPIENTS_NOT_SUBSET"));
});

test("subset — non-canonical ordering is rejected", () => {
  const parent = rootGrant();
  const narrowed = new RecipientSet([SEARCH_API, DATA_API]);
  const w = subsetWitness(ALLOWED, [SEARCH_API, DATA_API]);
  if (w.mode === "subset") w.members.reverse();
  const v = delegate(parent, childOf(parent, narrowed), w);
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_RECIPIENTS_NOT_CANONICAL"));
});

test("subset — duplicate members are rejected", () => {
  const parent = rootGrant();
  const one = new RecipientSet([SEARCH_API]);
  const v = delegate(parent, childOf(parent, one), {
    mode: "subset",
    members: [
      { recipient: SEARCH_API, proof: ALLOWED.proof(SEARCH_API) },
      { recipient: SEARCH_API, proof: ALLOWED.proof(SEARCH_API) },
    ],
  });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_RECIPIENTS_NOT_CANONICAL"));
});

test("subset — an empty member list is rejected", () => {
  const parent = rootGrant();
  const v = delegate(parent, childOf(parent, ALLOWED), { mode: "subset", members: [] });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_RECIPIENTS_NOT_SUBSET"));
});

test("subset — more members than the cap is rejected", () => {
  const many = Array.from({ length: MAX_SUBSET_MEMBERS + 1 }, (_, i) => hex32(i + 1));
  const bigSet = new RecipientSet(many);
  const parent = rootGrant({ recipientsRoot: bigSet.root, recipientsDepth: bigSet.depth } as never);
  const v = delegate(parent, childOf(parent, bigSet), subsetWitness(bigSet, many));
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_RECIPIENTS_TOO_MANY"));
});

test("subset — narrowing does not excuse the other attenuation rules", () => {
  const parent = rootGrant();
  const narrowed = new RecipientSet([SEARCH_API]);
  const child = childOf(parent, narrowed, { maxPerSpend: kas("5") }); // parent allows 2
  const v = delegate(parent, child, subsetWitness(ALLOWED, [SEARCH_API]));
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes("CHILD_MAX_PER_SPEND_EXCEEDS_PARENT"));
});
