import test from "node:test";
import assert from "node:assert/strict";
import { RecipientSet, verifyInclusion } from "../src/merkle.ts";
import { SEARCH_API, DATA_API, COMPUTE_API, ATTACKER, ALLOWED, hex32 } from "./fixtures.ts";

test("every member proves inclusion", () => {
  for (const r of [SEARCH_API, DATA_API, COMPUTE_API]) {
    assert.ok(verifyInclusion(r, ALLOWED.proof(r), ALLOWED.root));
  }
});

test("a non-member has no valid proof", () => {
  assert.throws(() => ALLOWED.proof(ATTACKER));
  const stolen = ALLOWED.proof(SEARCH_API);
  assert.equal(verifyInclusion(ATTACKER, stolen, ALLOWED.root), false);
});

test("set ordering does not change the root", () => {
  const a = new RecipientSet([SEARCH_API, DATA_API, COMPUTE_API]);
  const b = new RecipientSet([COMPUTE_API, SEARCH_API, DATA_API]);
  assert.equal(a.root, b.root);
});

test("different sets give different roots", () => {
  const a = new RecipientSet([SEARCH_API, DATA_API]);
  const b = new RecipientSet([SEARCH_API, COMPUTE_API]);
  assert.notEqual(a.root, b.root);
});

test("duplicates and empty sets are rejected at construction", () => {
  assert.throws(() => new RecipientSet([SEARCH_API, SEARCH_API]));
  assert.throws(() => new RecipientSet([]));
});

test("subset relation", () => {
  const sub = new RecipientSet([SEARCH_API]);
  assert.ok(sub.isSubsetOf(ALLOWED));
  assert.equal(new RecipientSet([ATTACKER]).isSubsetOf(ALLOWED), false);
});

test("proofs verify at every set size from 1 to 33", () => {
  // The odd-node promotion bug only shows at sizes where a level has an odd
  // count. A single 3-element case caught it; this sweep keeps it caught.
  for (let n = 1; n <= 33; n++) {
    const members = Array.from({ length: n }, (_, i) => hex32(i + 1));
    const set = new RecipientSet(members);
    for (const m of members) {
      assert.ok(
        verifyInclusion(m, set.proof(m), set.root),
        `size ${n}: proof failed for ${m.slice(0, 4)}`,
      );
    }
    assert.equal(
      verifyInclusion(hex32(0xff), { index: 0, siblings: set.proof(members[0]!).siblings }, set.root),
      false,
      `size ${n}: non-member accepted`,
    );
  }
});

test("a tampered sibling breaks the proof", () => {
  const set = new RecipientSet([SEARCH_API, DATA_API, COMPUTE_API]);
  const p = set.proof(DATA_API);
  if (p.siblings.length > 0) {
    const bad = { ...p, siblings: [{ ...p.siblings[0]!, hash: hex32(0x99) }, ...p.siblings.slice(1)] };
    assert.equal(verifyInclusion(DATA_API, bad, set.root), false);
  }
});

test("flipping a sibling's side breaks the proof", () => {
  const set = new RecipientSet(Array.from({ length: 8 }, (_, i) => hex32(i + 1)));
  const target = set.recipients[3]!;
  const p = set.proof(target);
  const flipped = { ...p, siblings: p.siblings.map((s, i) => (i === 0 ? { ...s, left: !s.left } : s)) };
  assert.equal(verifyInclusion(target, flipped, set.root), false);
});
