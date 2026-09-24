/**
 * The storage-mass pre-flight, against a rejection the network actually made.
 *
 * On 24 September 2026 the first run of one-job.ts got through a genesis and
 * two delegations and was refused at the first purchase: VERIFY held 0.12 KAS,
 * its 0.04 KAS payment massed 583,334 against a ceiling of 500,000, and no
 * money moved. Nothing about the grant was exceeded — the covenant was fine.
 *
 * That number is the fixture. A mass calculation that stops reproducing it has
 * stopped describing the network, and the pre-flight built on it is then worth
 * nothing.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { MASS_CEILING, PLAN, preflight, type Plan } from "../src/one-job-plan.ts";

/** What the script was carrying when the network refused it. */
const REFUSED: Plan = {
  parentBudget: 50_000_000n,
  parentMaxPerSpend: 5_000_000n,
  parentWindowDaa: 2_592_000n,
  research: { budget: 15_000_000n, cap: 5_000_000n, epoch: 10_000_000n },
  verify: { budget: 12_000_000n, cap: 4_000_000n, epoch: 8_000_000n },
  childWindowDaa: 864_000n,
};

test("it reproduces the mass the network quoted, to the unit", () => {
  const rows = preflight(REFUSED);
  const buyVerify = rows.find((r) => r.step === "buy verify");
  assert.ok(buyVerify);
  assert.equal(buyVerify.mass, 583_334n);
});

test("the pre-flight would have refused that plan before the genesis", () => {
  const over = preflight(REFUSED).filter((r) => r.mass > MASS_CEILING);
  assert.deepEqual(over.map((r) => r.step), ["buy verify"]);
});

test("every transaction the shipped plan implies is under the ceiling", () => {
  for (const row of preflight(PLAN)) {
    assert.ok(row.mass <= MASS_CEILING, `${row.step} massed ${row.mass}`);
  }
});

test("the floor is under what the grant has LEFT, not under the payment", () => {
  /* The larger payment is the one that passes, because it comes out of a
     larger grant. Anything that reads the rule as a dust limit on the amount
     gets this backwards — which is exactly how the first run was sized. */
  const rows = preflight(REFUSED);
  const research = rows.find((r) => r.step === "buy research")!;  // pays 0.05
  const verify = rows.find((r) => r.step === "buy verify")!;      // pays 0.04
  assert.ok(research.mass < verify.mass);
  assert.ok(research.mass <= MASS_CEILING);
  assert.ok(verify.mass > MASS_CEILING);
});

test("a worker cannot be given less than its own price plus the fee", () => {
  const broke: Plan = { ...REFUSED, verify: { ...REFUSED.verify, budget: 5_000_000n } };
  assert.throws(() => preflight(broke), /price plus the fee/);
});
