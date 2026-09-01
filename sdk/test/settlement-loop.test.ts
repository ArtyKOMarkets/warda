import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { childStateFrom, parentSuccessorState, pushChild, subsetWitness } from "../src/delegate.ts";
import { reabsorbSuccessorState } from "../src/reabsorb.ts";
import { successorState } from "../src/spend.ts";
import { EMPTY_RESERVE } from "../src/keys.ts";
import { RecipientSet } from "../src/recipients.ts";
import { scriptHashFor, templateIdFor, type CovenantTemplate, type GrantState } from "../src/template.ts";

/**
 * Delegation, in both directions.
 *
 * The covenant has had `reabsorb` and `settle` since v4, and every tool that
 * read a manifest hardcoded `reserveRoot: EMPTY_RESERVE`. So a parent that
 * delegated once moved to an address its own manifest could no longer derive:
 * healthy grant, correct chain, and every tool reporting it missing. That is
 * what "one-way in practice" meant — not a missing covenant feature, a field
 * computed correctly and then dropped on the floor.
 *
 * These tests are about the round trip: what a parent's state must be at each
 * step, and that the end of the loop is not where it started but where it
 * should be.
 */

const tpl: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);
const key = (n: number) => n.toString(16).padStart(2, "0").repeat(32);
const authority = { principalKey: key(1), revocationKey: key(1) };

const parent0: GrantState = {
  agentKey: key(2),
  budgetTotal: 300_000_000n,
  maxPerSpend: 50_000_000n,
  epochLimit: 100_000_000n,
  epochLength: 1_000n,
  recipientsRoot: new RecipientSet([key(0xa1), key(0xa2), key(0xa3), key(0xa4)]).rootHex,
  notBefore: 1_000n,
  expiresAt: 900_000n,
  delegationDepth: 2n,
  templateId: templateIdFor(tpl, authority),
  spentTotal: 0n,
  reserved: 0n,
  epochIndex: 0n,
  epochSpent: 0n,
  reserveRoot: EMPTY_RESERVE,
};

const terms = {
  agentKey: key(3),
  budgetTotal: 100_000_000n,
  maxPerSpend: 20_000_000n,
  epochLimit: 40_000_000n,
  delegationDepth: 1n,
};

const addr = (s: GrantState) => scriptHashFor(tpl, { authority, state: s });

test("delegating MOVES the parent, so a manifest that forgets the root is lost", () => {
  const child = childStateFrom(parent0, terms);
  const parent1 = parentSuccessorState(parent0, child);
  assert.notEqual(parent1.reserveRoot, EMPTY_RESERVE);
  // This is the bug, stated as a test: same numbers, empty root, wrong address.
  const forgotten = { ...parent1, reserveRoot: EMPTY_RESERVE };
  assert.notEqual(addr(forgotten), addr(parent1));
});

test("the reserve follows the child exactly", () => {
  const child = childStateFrom(parent0, terms);
  const parent1 = parentSuccessorState(parent0, child);
  // Reserve without coins and the child can pay nobody; coins without reserve
  // and the same KAS is spendable from two addresses, both legitimately.
  assert.equal(parent1.reserved, terms.budgetTotal);
  assert.equal(child.budgetTotal, terms.budgetTotal);
  // Nothing has been SPENT — the coin has not left the grant, only subdivided.
  assert.equal(parent1.spentTotal, parent0.spentTotal);
});

test("settling charges the parent what the child spent, not what it was lent", () => {
  const child0 = childStateFrom(parent0, terms);
  const parent1 = parentSuccessorState(parent0, child0);
  // The child spends a third of its budget and comes home.
  const child1 = successorState(child0, 30_000_000n, 5_000n);
  const parent2 = reabsorbSuccessorState(parent1, child1, EMPTY_RESERVE);

  assert.equal(parent2.spentTotal, 30_000_000n);
  assert.equal(parent2.reserved, 0n);
  assert.equal(parent2.reserveRoot, EMPTY_RESERVE);
  // The unspent 70,000,000 is back in the agent's budget rather than written
  // off — which is the entire difference between settling a child and letting
  // it expire into the principal's hands.
  assert.equal(parent2.budgetTotal - parent2.spentTotal, 270_000_000n);
});

test("the loop does not return the parent to where it started", () => {
  const child0 = childStateFrom(parent0, terms);
  const parent1 = parentSuccessorState(parent0, child0);
  const child1 = successorState(child0, 30_000_000n, 5_000n);
  const parent2 = reabsorbSuccessorState(parent1, child1, EMPTY_RESERVE);
  // The reserve is empty again and the root is back, but the spending is not
  // undone. A settlement that landed on the original address would mean the
  // child's spending had vanished.
  assert.equal(parent2.reserveRoot, parent0.reserveRoot);
  assert.notEqual(addr(parent2), addr(parent0));
});

test("the stack is LIFO, so children settle newest first", () => {
  const a = childStateFrom(parent0, terms);
  const p1 = parentSuccessorState(parent0, a);
  const b = childStateFrom(p1, { ...terms, agentKey: key(4), budgetTotal: 50_000_000n });
  const p2 = parentSuccessorState(p1, b);

  // b is on top: popping it returns the root to where a left it.
  assert.equal(pushChild(p1.reserveRoot, b), p2.reserveRoot);
  // a is underneath, and popping it from here reconstructs nothing.
  assert.notEqual(pushChild(p1.reserveRoot, a), p2.reserveRoot);
});

test("prevRoot is what the build tool must record; it cannot be recovered", () => {
  const a = childStateFrom(parent0, terms);
  const p1 = parentSuccessorState(parent0, a);
  const b = childStateFrom(p1, { ...terms, agentKey: key(4), budgetTotal: 50_000_000n });
  const p2 = parentSuccessorState(p1, b);
  // Settling b needs p1.reserveRoot, which is not in p2's state, not in b's,
  // and not in any transaction — a hash chain pops by preimage. This is why
  // build-delegation writes parent_reserve_root_before onto the child.
  const settled = reabsorbSuccessorState(p2, b, p1.reserveRoot);
  assert.equal(settled.reserveRoot, p1.reserveRoot);
  assert.equal(settled.reserved, a.budgetTotal);
});

// ---- narrowing the allowlist --------------------------------------------

test("a child inheriting the allowlist commits to the same root", () => {
  const child = childStateFrom(parent0, terms);
  assert.equal(child.recipientsRoot, parent0.recipientsRoot);
  // The empty-witness case needs no special branch in the covenant: folding a
  // node through zero siblings returns the node itself.
  const w = subsetWitness(parent0, terms);
  assert.deepEqual(w.proof, { siblings: [], left: [] });
});

test("a narrowed child commits to a NODE, and the witness places it", () => {
  const set = new RecipientSet([key(0xa1), key(0xa2), key(0xa3), key(0xa4)]);
  const half = set.members.slice(0, 2);
  const w = subsetWitness(parent0, { ...terms, recipients: half }, set);
  assert.notEqual(w.root, parent0.recipientsRoot);
  assert.ok(w.proof.siblings.length > 0, "a genuine subset needs a path to the root");
});

test("narrowing without the parent's members is refused, not guessed at", () => {
  assert.throws(
    () => subsetWitness(parent0, { ...terms, recipients: [key(0xa1)] }),
    /a root on its own cannot produce one/,
  );
});

test("a witness through the wrong tree is refused", () => {
  const wrong = new RecipientSet([key(0xb1), key(0xb2)]);
  assert.throws(
    () => subsetWitness(parent0, { ...terms, recipients: wrong.members }, wrong),
    /A witness through the wrong tree proves nothing/,
  );
});
