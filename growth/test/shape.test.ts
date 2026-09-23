/**
 * The Listener's numbers have to agree with each other. These are the
 * relations the runbook states in prose, asserted — a budget that does not
 * match the epochs it is made of is not a preference, it is a mistake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { LISTENER, derived, kas, DAA_PER_SECOND, USD_PER_READ } from "../src/shape.ts";

test("the epoch limit is a whole number of searches", () => {
  assert.equal(derived.searchesPerEpoch, 3);
  assert.equal(LISTENER.epochLimitSompi % LISTENER.priceSompi, 0,
    "an epoch that affords two and a half searches wastes the half every epoch");
});

test("the budget is exactly the epochs it is made of", () => {
  assert.equal(derived.epochsPerTerm, 14);
  assert.equal(derived.budgetFromEpochs, LISTENER.budgetSompi,
    `budget ${kas(LISTENER.budgetSompi)} KAS should be ${derived.epochsPerTerm} × ${kas(LISTENER.epochLimitSompi)}`);
});

test("the epoch matches the cadence, so the allowance refills when a pass needs it", () => {
  /* Twice daily. An epoch shorter than the cadence makes the limit
     unreachable; longer lets one broken pass spend the next pass's share. */
  assert.equal(24 / LISTENER.epochHours, 2);
});

test("the DAA figures are what the covenant will be given", () => {
  assert.equal(derived.epochLengthDaa, 432_000);
  assert.equal(derived.termDaa, 6_048_000);
  assert.equal(derived.epochLengthDaa, LISTENER.epochHours * 3600 * DAA_PER_SECOND);
});

test("a term costs what the runbook says it costs", () => {
  assert.equal(derived.searchesPerTerm, 42);
  assert.equal(derived.readsPerTerm, 420);
  assert.equal(derived.usdPerTerm, 2.1);
  assert.equal(USD_PER_READ, 0.005);
});

test("one search's price covers one search's reads", () => {
  const costUsd = LISTENER.maxResults * USD_PER_READ;
  assert.equal(costUsd, 0.05);
  assert.ok(kas(LISTENER.priceSompi) >= 0.02,
    "below Kaspa's storage-mass floor no buyer could pay it");
});
