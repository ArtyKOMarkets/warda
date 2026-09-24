import { test } from "node:test";
import assert from "node:assert/strict";
import { epochStart, ROLL_SLACK_MS } from "../src/epoch.ts";
import { LISTENER } from "../src/shape.ts";

const H = 12;
const LEN = H * 3_600_000;
const T0 = "2026-09-24T05:13:05.359Z";
const ms = (s: string) => new Date(s).getTime();

test("an epoch that has not ended is returned unchanged, by identity", () => {
  /* Identity, not equality: the caller uses `next === startedAt` to decide
     whether to reset the spend counter, so re-serialising would silently
     zero it every pass. */
  assert.equal(epochStart(T0, ms(T0) + 3_600_000, H), T0);
});

test("the new anchor is on the grid, not at the moment it was noticed", () => {
  const noticed = ms(T0) + LEN + 1_400;      // a pass 1.4s past the boundary
  assert.equal(epochStart(T0, noticed, H), new Date(ms(T0) + LEN).toISOString());
});

test("a pass a few seconds EARLY still rolls", () => {
  /* The bug this whole module exists for. Two passes twelve hours apart land
     on the boundary to the second; without slack, which side they fall on is
     decided by cron jitter, and the losing side is silent. */
  assert.notEqual(epochStart(T0, ms(T0) + LEN - 2_000, H), T0);
});

test("but not arbitrarily early", () => {
  assert.equal(epochStart(T0, ms(T0) + LEN - ROLL_SLACK_MS - 1_000, H), T0);
});

test("a machine that slept for two days lands back on the same grid", () => {
  const woke = ms(T0) + 2 * LEN + 7 * 3_600_000;
  assert.equal(epochStart(T0, woke, H), new Date(ms(T0) + 2 * LEN).toISOString());
});

test("a corrupt anchor does not wedge the pass", () => {
  const now = ms(T0);
  assert.equal(epochStart("not a date", now, H), new Date(now).toISOString());
});

/**
 * The regression, as the schedule actually runs it.
 *
 * Sixteen passes, twelve hours apart, each with a second of jitter either
 * way. Every one of them must find a fresh epoch. Under the old rule -- anchor
 * to `now` -- this failed four times, and each failure was a pass that bought
 * nothing and said nothing.
 */
test("every pass on a 12h schedule gets a fresh epoch", () => {
  let anchor = T0;
  let t = ms(T0);
  const jitter = [1_100, -900, 400, -1_700, 2_000, -300];
  for (let i = 0; i < 16; i++) {
    t += LEN + jitter[i % jitter.length];
    const next = epochStart(anchor, t, H);
    assert.notEqual(next, anchor, `pass ${i + 1} did not roll`);
    /* And the grid never drifts, however the jitter falls. */
    assert.equal((ms(next) - ms(T0)) % LEN, 0, `pass ${i + 1} left the grid`);
    anchor = next;
  }
});

test("an 11h/13h schedule also survives, though it is not the one we run", () => {
  /* Recorded because moving the cron was the first fix proposed, and on the
     OLD rule it was worse than doing nothing: an 11-hour gap never reaches
     the boundary. On this rule the short pass correctly declines to roll and
     the long one catches up, so the schedule stops mattering. */
  let anchor = T0;
  let t = ms(T0);
  let rolled = 0;
  for (let i = 0; i < 16; i++) {
    t += (i % 2 === 0 ? 13 : 11) * 3_600_000;
    const next = epochStart(anchor, t, H);
    if (next !== anchor) rolled++;
    anchor = next;
  }
  assert.ok(rolled >= 12, `only ${rolled} of 16 passes rolled`);
});

test("the hours it is used with are the grant's, not a second copy", () => {
  assert.equal(LISTENER.epochHours, H);
});
