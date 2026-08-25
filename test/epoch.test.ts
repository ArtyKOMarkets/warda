import test from "node:test";
import assert from "node:assert/strict";
import { validateSpend } from "../src/validate.ts";
import { epochIndexAt } from "../src/epoch.ts";
import { kas } from "../src/amounts.ts";
import { rootGrant, freshState, honestSpend, SEARCH_API } from "./fixtures.ts";

test("epoch index advances every epoch_length of DAA", () => {
  const g = rootGrant(); // notBefore 1_000_000, epochLength 1000
  assert.equal(epochIndexAt(g, 1_000_000n), 0n);
  assert.equal(epochIndexAt(g, 1_000_999n), 0n);
  assert.equal(epochIndexAt(g, 1_001_000n), 1n);
  assert.equal(epochIndexAt(g, 1_002_500n), 2n);
});

test("the epoch limit binds within an epoch", () => {
  const g = rootGrant();
  let s = freshState(g);
  // Five spends of 2 KAS = the 10 KAS epoch limit exactly.
  for (let i = 0; i < 5; i++) {
    const v = validateSpend(g, s, honestSpend(g, s, kas("2"), SEARCH_API, 1_000_500n));
    assert.ok(v.ok, `spend ${i + 1} rejected: ${v.failures.join(", ")}`);
    s = v.expectedSuccessor!;
  }
  const sixth = validateSpend(g, s, honestSpend(g, s, kas("2"), SEARCH_API, 1_000_500n));
  assert.equal(sixth.ok, false);
  assert.ok(sixth.failures.includes("EXCEEDS_EPOCH_LIMIT"));
});

test("a new epoch resets the epoch spend", () => {
  const g = rootGrant();
  let s = freshState(g);
  for (let i = 0; i < 5; i++) {
    s = validateSpend(g, s, honestSpend(g, s, kas("2"), SEARCH_API, 1_000_500n)).expectedSuccessor!;
  }
  const nextEpoch = validateSpend(g, s, honestSpend(g, s, kas("2"), SEARCH_API, 1_001_500n));
  assert.ok(nextEpoch.ok, nextEpoch.failures.join(", "));
  assert.equal(nextEpoch.expectedSuccessor!.epochIndex, 1n);
  assert.equal(nextEpoch.expectedSuccessor!.epochSpent, kas("2"));
  assert.equal(nextEpoch.expectedSuccessor!.spentTotal, kas("12"));
});

test("KNOWN PROPERTY: fixed epochs permit 2x the limit across a boundary", () => {
  // Documented in spec section 16. This test exists so the behaviour is
  // pinned deliberately rather than discovered later as a bug report.
  const g = rootGrant();
  let s = freshState(g);
  for (let i = 0; i < 5; i++) {
    s = validateSpend(g, s, honestSpend(g, s, kas("2"), SEARCH_API, 1_000_999n)).expectedSuccessor!;
  }
  assert.equal(s.epochSpent, kas("10"));
  for (let i = 0; i < 5; i++) {
    const v = validateSpend(g, s, honestSpend(g, s, kas("2"), SEARCH_API, 1_001_000n));
    assert.ok(v.ok, `boundary spend ${i + 1} rejected: ${v.failures.join(", ")}`);
    s = v.expectedSuccessor!;
  }
  // 20 KAS moved across two adjacent DAA scores, one epoch apart.
  assert.equal(s.spentTotal, kas("20"));
});

test("the total budget still binds across epochs", () => {
  const g = rootGrant({ budgetTotal: kas("6") } as never);
  let s = freshState(g);
  for (let e = 0; e < 3; e++) {
    const daa = 1_000_000n + BigInt(e) * 1000n;
    const v = validateSpend(g, s, honestSpend(g, s, kas("2"), SEARCH_API, daa));
    assert.ok(v.ok);
    s = v.expectedSuccessor!;
  }
  const over = validateSpend(g, s, honestSpend(g, s, kas("2"), SEARCH_API, 1_003_000n));
  assert.equal(over.ok, false);
  assert.ok(over.failures.includes("EXCEEDS_AVAILABLE_BUDGET"));
});
