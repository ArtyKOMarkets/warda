/**
 * The plan decides what gets bought, so these pin the cases where it would
 * otherwise spend money it does not have or stop looking at half the topics.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/rotate.ts";
import type { Query } from "../src/listen.ts";

const Q: Query[] = ["a", "b", "c", "d", "e"].map((l) => ({ label: l, q: l }));
const PRICE = 5_000_000;
const base = { queries: Q, cursor: 0, priceSompi: PRICE, epochRemainingSompi: 3 * PRICE };

test("it buys what the epoch can afford and no more", () => {
  const p = plan(base);
  assert.equal(p.searches, 3);
  assert.deepEqual(p.queries.map((q) => q.label), ["a", "b", "c"]);
});

test("the next pass picks up where this one stopped", () => {
  const first = plan(base);
  const second = plan({ ...base, cursor: first.nextCursor });
  assert.deepEqual(second.queries.map((q) => q.label), ["d", "e", "a"]);
});

test("a full rotation covers every query and then repeats", () => {
  let cursor = 0;
  const seen: string[] = [];
  for (let i = 0; i < 2; i++) {
    const p = plan({ ...base, cursor });
    seen.push(...p.queries.map((q) => q.label));
    cursor = p.nextCursor;
  }
  assert.deepEqual([...new Set(seen)].sort(), ["a", "b", "c", "d", "e"]);
});

test("a pinned query runs on every pass, wherever the cursor is", () => {
  for (const cursor of [0, 1, 2, 3, 4]) {
    const p = plan({ ...base, cursor, always: ["a"] });
    assert.ok(p.queries.some((q) => q.label === "a"), `cursor ${cursor} dropped the pinned query`);
  }
});

test("a pinned query is not also bought by the rotation", () => {
  const p = plan({ ...base, cursor: 0, always: ["a"] });
  assert.equal(p.queries.filter((q) => q.label === "a").length, 1);
});

test("no epoch allowance left means nothing is bought, and it says so", () => {
  const p = plan({ ...base, epochRemainingSompi: PRICE - 1 });
  assert.equal(p.searches, 0);
  assert.match(p.why, /nothing affordable/);
  assert.equal(p.nextCursor, base.cursor, "a pass that bought nothing must not advance the rotation");
});

test("the budget binds even when the epoch would allow more", () => {
  const p = plan({ ...base, epochRemainingSompi: 5 * PRICE, budgetRemainingSompi: 2 * PRICE });
  assert.equal(p.searches, 2);
});

test("plenty of room buys every query once, not the same one twice", () => {
  const p = plan({ ...base, epochRemainingSompi: 50 * PRICE });
  assert.equal(p.searches, Q.length);
  assert.equal(new Set(p.queries.map((q) => q.label)).size, Q.length);
});

test("a cursor from a longer query list cannot index off the end", () => {
  const p = plan({ ...base, cursor: 99 });
  assert.equal(p.searches, 3);
  assert.ok(p.queries.every((q) => q));
});

test("more pinned queries than the epoch affords drops by the written order", () => {
  const p = plan({ ...base, epochRemainingSompi: 2 * PRICE, always: ["a", "b", "c"] });
  assert.deepEqual(p.queries.map((q) => q.label), ["a", "b"]);
});
