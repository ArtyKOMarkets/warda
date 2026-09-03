/**
 * Finding a grant that moved more than once.
 *
 * Written against a real failure: the public demo grant took four payments
 * between two polls and the old follower could not take a single step, because
 * it verified each step against the chain and intermediate states are spent.
 * These tests are the shapes that failure came in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { candidateStates, partitionPayments, type Payment } from "../src/follow.ts";
import { successorState } from "../src/spend.ts";
import type { GrantState } from "../src/template.ts";

const base: GrantState = {
  agentKey: "aa".repeat(32),
  budgetTotal: 50_00000000n,
  maxPerSpend: 10_000_000n,
  epochLimit: 50_000_000n,
  epochLength: 1000n,
  recipientsRoot: "bb".repeat(32),
  notBefore: 1_000_000n,
  expiresAt: 2_000_000n,
  delegationDepth: 2n,
  templateId: "cc".repeat(32),
  spentTotal: 0n,
  reserved: 0n,
  epochIndex: 0n,
  epochSpent: 0n,
  reserveRoot: "dd".repeat(32),
};

const key = (s: GrantState) => `${s.spentTotal}:${s.epochIndex}:${s.epochSpent}`;
const pay = (value: bigint, daa: bigint, id?: string): Payment => ({ value, blockDaaScore: daa, id });
const has = (cands: { state: GrantState }[], s: GrantState) =>
  cands.some((c) => key(c.state) === key(s));

// ---- the failure this exists for ----------------------------------------

test("a grant that moved FOUR times is found, which the step-wise walk could not do", () => {
  // The real shape: four payments inside one polling window, all in one epoch.
  const amounts = [5_000_000n, 5_000_000n, 10_000_000n, 3_000_000n];
  let truth = base;
  for (const a of amounts) truth = successorState(truth, a, base.notBefore + 3n * base.epochLength);

  const payments = amounts.map((a, i) => pay(a, base.notBefore + 3n * base.epochLength + BigInt(i)));
  const candidates = candidateStates(base, payments);

  assert.ok(has(candidates, truth), "the true endpoint must be among the candidates");
  assert.equal(truth.spentTotal, 23_000_000n);
  assert.equal(truth.epochIndex, 3n);
  assert.equal(truth.epochSpent, 23_000_000n);
});

test("payments spread across epochs land on the right endpoint", () => {
  let truth = base;
  truth = successorState(truth, 5_000_000n, base.notBefore + 1n * base.epochLength);
  truth = successorState(truth, 7_000_000n, base.notBefore + 4n * base.epochLength);
  truth = successorState(truth, 2_000_000n, base.notBefore + 4n * base.epochLength);

  const payments = [
    pay(5_000_000n, base.notBefore + 1_500n),
    pay(7_000_000n, base.notBefore + 4_100n),
    pay(2_000_000n, base.notBefore + 4_200n),
  ];

  assert.ok(has(candidateStates(base, payments), truth));
  // only the LAST epoch's spending survives into the state
  assert.equal(truth.epochSpent, 9_000_000n);
  assert.equal(truth.spentTotal, 14_000_000n);
});

test("a single payment still works, and is offered first", () => {
  const truth = successorState(base, 5_000_000n, base.notBefore + 2n * base.epochLength);
  const candidates = candidateStates(base, [pay(5_000_000n, base.notBefore + 2_500n)]);

  assert.ok(has(candidates, truth));
  assert.equal(candidates[0]!.applied.length, 1, "fewest payments first");
});

test("the plain reading of what happened is offered before the exhaustive search", () => {
  // Four payments, each in its own epoch, all belonging to this grant. The
  // truth is the natural reading, and it should not be buried behind hundreds
  // of speculative epoch assignments.
  const amounts = [1_000_000n, 2_000_000n, 3_000_000n, 4_000_000n];
  let truth = base;
  const payments: Payment[] = [];
  amounts.forEach((a, i) => {
    const daa = base.notBefore + base.epochLength * BigInt(i + 1) + 10n;
    truth = successorState(truth, a, daa);
    payments.push(pay(a, daa));
  });

  const candidates = candidateStates(base, payments);
  const at = candidates.findIndex((c) => key(c.state) === key(truth));
  assert.ok(at >= 0, "the truth must be found at all");

  // Inside the natural pass, which is at most one candidate per suffix per
  // epoch of slack — so a handful of round trips rather than the hundreds the
  // exhaustive search that follows would cost. The truth here needs all four
  // payments, and the pass offers the shortest suffixes first, so it is near
  // the end of that pass rather than at its start. That is the honest bound.
  const naturalPassSize = payments.length * 3;
  assert.ok(at < naturalPassSize, `truth was candidate ${at}, past the natural pass`);
  assert.ok(candidates.length > naturalPassSize, "and the exhaustive search still follows");
});

// ---- the other bug: vendor addresses outlive grants ---------------------

test("payments mined before the grant opened belong to an earlier grant", () => {
  const older = [pay(20_000_000n, base.notBefore - 5_000n), pay(3_000_000n, base.notBefore - 10n)];
  const ours = [pay(5_000_000n, base.notBefore + 2_500n)];

  const split = partitionPayments(base, [...ours, ...older]);
  assert.equal(split.tooEarly.length, 2);
  assert.equal(split.usable.length, 1);
  assert.equal(split.usable[0]!.value, 5_000_000n);

  // and the true state is still found with the old coins present
  const truth = successorState(base, 5_000_000n, base.notBefore + 2n * base.epochLength);
  assert.ok(has(candidateStates(base, [...older, ...ours]), truth));

  // the poisoned answer is NOT offered: nothing claims we spent the old coins
  assert.ok(
    !candidateStates(base, [...older, ...ours]).some((c) => c.state.spentTotal === 28_000_000n),
    "an earlier grant's payments must never be folded into this one's total",
  );
});

test("order does not matter — the vendor's UTXOs arrive unsorted", () => {
  const payments = [
    pay(7_000_000n, base.notBefore + 4_100n),
    pay(5_000_000n, base.notBefore + 1_500n),
    pay(2_000_000n, base.notBefore + 4_200n),
  ];
  assert.deepEqual(
    candidateStates(base, payments).map((c) => key(c.state)),
    candidateStates(base, [...payments].reverse()).map((c) => key(c.state)),
  );
});

// ---- what is never offered ----------------------------------------------

test("a candidate the covenant would have refused is not a candidate", () => {
  // Three payments of 30,000,000 against a 50,000,000 per-epoch limit: no
  // assignment putting all three in one epoch is reachable.
  const payments = [0n, 1n, 2n].map((i) => pay(30_000_000n, base.notBefore + 3_000n + i));
  for (const c of candidateStates(base, payments)) {
    assert.ok(c.state.epochSpent <= base.epochLimit, `epochSpent ${c.state.epochSpent} over limit`);
    assert.ok(c.state.spentTotal <= base.budgetTotal);
  }
});

test("no candidate claims an epoch the network had not reached", () => {
  const payments = [pay(5_000_000n, base.notBefore + 1_500n)];
  for (const c of candidateStates(base, payments)) {
    assert.ok(c.finalEpoch <= 1n, `claimed epoch ${c.finalEpoch} after a payment mined in epoch 1`);
  }
});

test("the epoch only moves forward, from wherever the manifest already is", () => {
  const advanced: GrantState = { ...base, epochIndex: 7n, epochSpent: 4_000_000n, spentTotal: 9_000_000n };
  const payments = [pay(1_000_000n, base.notBefore + 9_500n)];
  const candidates = candidateStates(advanced, payments);

  assert.ok(candidates.length > 0);
  for (const c of candidates) assert.ok(c.finalEpoch >= 7n, `went back to epoch ${c.finalEpoch}`);

  // staying in epoch 7 carries the spending already recorded there
  const stay = candidates.find((c) => c.finalEpoch === 7n)!;
  assert.equal(stay.state.epochSpent, 5_000_000n);
  assert.equal(stay.state.spentTotal, 10_000_000n);
});

test("nothing at the vendor means nothing to enumerate", () => {
  assert.deepEqual(candidateStates(base, []), []);
  assert.deepEqual(candidateStates(base, [pay(1_000_000n, base.notBefore - 1n)]), []);
});

test("the enumeration stays bounded", () => {
  const payments = Array.from({ length: 25 }, (_, i) =>
    pay(1_000_000n, base.notBefore + 1_000n * BigInt(i + 1)),
  );
  // The cap is a safety rail, and hitting it is the designed behaviour for a
  // vendor holding this many coins — the point is that it stops rather than
  // enumerating for ever.
  const all = candidateStates(base, payments);
  assert.ok(all.length > 0);
  assert.ok(all.length <= 2_000, `${all.length} candidates`);
  assert.equal(candidateStates(base, payments, { limit: 10 }).length, 10);
});

test("every candidate is distinct in the only three fields that decide an address", () => {
  const payments = [1n, 2n, 3n, 4n, 5n].map((i) =>
    pay(1_000_000n * i, base.notBefore + 2_000n * i),
  );
  const keys = candidateStates(base, payments).map((c) => key(c.state));
  assert.equal(new Set(keys).size, keys.length, "duplicate candidates cost a round trip each");
});
