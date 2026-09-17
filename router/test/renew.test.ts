import { test } from "node:test";
import assert from "node:assert/strict";
import { authorityLeft, renewVerdict, spendableLeft, type RenewInput } from "../src/index.ts";

/* Agent #006's shape: 3 KAS budget, 0.25 max per spend, one purchase made. */
const KAS = 100_000_000n;
const grant = (over: Partial<RenewInput["grant"]> = {}) => ({
  budgetTotal: 3n * KAS,
  spentTotal: 3_000_000n,
  reserved: 0n,
  held: 295_000_000n,
  expiresAt: 598_641_927n,
  ...over,
});
const funder = (largest: bigint, total = largest) => ({ largest, total });
const NOW = 572_750_091n;

const ask = (over: Partial<RenewInput> = {}): RenewInput => ({
  grant: grant(),
  funder: funder(10n * KAS),
  below: 25_000_000n,
  needed: 3n * KAS + 1_000_000n,
  now: NOW,
  ...over,
});

test("a working grant is not due", () => {
  const v = renewVerdict(ask());
  assert.equal(v.due, false);
  /* 2.97 KAS of authority is unspent and the coin holds 2.95 — the difference
     went to the fee of the one payment it made, which is why the coin is the
     binding limit on a grant that has done anything at all. */
  assert.equal(authorityLeft(grant()), 297_000_000n);
  assert.equal(v.left, 295_000_000n);
});

/**
 * The reason `left` is a minimum and not a subtraction.
 *
 * Authority and coin come apart in both directions, and either one alone
 * reports an agent as healthy in a state where it cannot pay for anything.
 */
test("a grant with authority left and no coin is due", () => {
  const v = renewVerdict(ask({ grant: grant({ held: 1_000_000n }) }));
  assert.equal(authorityLeft(grant({ held: 1_000_000n })), 297_000_000n);
  assert.equal(v.left, 1_000_000n, "the coin is the binding limit here");
  assert.equal(v.due, true);
});

test("a grant with coin left and no authority is due", () => {
  const g = grant({ spentTotal: 3n * KAS });
  assert.equal(spendableLeft(g), 0n);
  assert.equal(renewVerdict(ask({ grant: g })).due, true);
});

test("reserved coin is not spendable and counts against the threshold", () => {
  const g = grant({ reserved: 290_000_000n });
  assert.equal(authorityLeft(g), 7_000_000n);
  assert.equal(renewVerdict(ask({ grant: g })).left, 7_000_000n);
});

test("overspend never reads as negative authority", () => {
  assert.equal(authorityLeft(grant({ spentTotal: 10n * KAS })), 0n);
});

/* The threshold is inclusive: AT the per-payment cap it can still make exactly
   one more payment of that size, and one is the last one. */
test("exactly at the threshold is due", () => {
  const g = grant({ held: 25_000_000n, spentTotal: 275_000_000n });
  assert.equal(spendableLeft(g), 25_000_000n);
  assert.equal(renewVerdict(ask({ grant: g })).due, true);
});

test("one sompi above the threshold is not", () => {
  const g = grant({ held: 25_000_001n, spentTotal: 274_999_999n });
  assert.equal(renewVerdict(ask({ grant: g })).due, false);
});

/**
 * Expiry is not a threshold. A grant past its term refuses every spend whatever
 * its counters say, so a full budget does not make it healthy.
 */
test("an expired grant is due however much is left", () => {
  const v = renewVerdict(ask({ now: 598_641_927n }));
  assert.equal(v.due, true);
  assert.equal(v.expired, true);
  assert.equal(v.left, 295_000_000n, "nearly everything left — and still finished");
});

test("the block the term ends on is already over", () => {
  assert.equal(renewVerdict(ask({ now: 598_641_926n })).due, false);
  assert.equal(renewVerdict(ask({ now: 598_641_927n })).due, true);
});

/* Genesis takes ONE input. Enough in total is not enough. */
test("a funder rich in small coins cannot pay for a successor", () => {
  const v = renewVerdict(ask({ grant: grant({ held: 0n }), funder: funder(KAS, 50n * KAS) }));
  assert.equal(v.due, true);
  assert.equal(v.fundable, false);
  assert.equal(v.due && !v.fundable && v.obstacle, "not-in-one-coin");
});

test("a funder that is simply short says so, and by how much in one coin", () => {
  const v = renewVerdict(ask({ grant: grant({ held: 0n }), funder: funder(KAS, KAS) }));
  assert.equal(v.due && !v.fundable && v.obstacle, "short");
  assert.equal(v.due && !v.fundable && v.shortBy, 2n * KAS + 1_000_000n);
});

test("exactly the needed amount in one coin is fundable", () => {
  const needed = 3n * KAS + 1_000_000n;
  const v = renewVerdict(ask({ grant: grant({ held: 0n }), funder: funder(needed), needed }));
  assert.equal(v.due && v.fundable, true);
});

test("one sompi short is not fundable, however healthy the balance looks", () => {
  const needed = 3n * KAS + 1_000_000n;
  const v = renewVerdict(
    ask({ grant: grant({ held: 0n }), funder: funder(needed - 1n, 900n * KAS), needed }),
  );
  assert.equal(v.due && !v.fundable && v.shortBy, 1n);
});

/**
 * A healthy grant is never asked about the funder. Reporting "short" for an
 * agent that needs nothing would send somebody to an exchange at 3am for a
 * grant that has 2.9 KAS left.
 */
test("a funder with nothing does not make a working grant due", () => {
  const v = renewVerdict(ask({ funder: funder(0n, 0n) }));
  assert.equal(v.due, false);
});

test("what stays at the old grant is reported, and it is the coin not the authority", () => {
  const v = renewVerdict(ask({ grant: grant({ held: 12_345n, spentTotal: 3n * KAS }) }));
  assert.equal(v.stranded, 12_345n);
});

test("a successor with no budget is a mistake, not a verdict", () => {
  assert.throws(() => renewVerdict(ask({ needed: 0n })), /not a successor/);
  assert.throws(() => renewVerdict(ask({ below: -1n })), /negative/);
});
