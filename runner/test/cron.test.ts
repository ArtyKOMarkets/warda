import { test } from "node:test";
import assert from "node:assert/strict";
import { matches, minimumIntervalMs, parseCron, slotsBetween } from "../src/cron.ts";

const at = (iso: string) => new Date(iso);

test("fields, ranges, lists and steps", () => {
  const c = parseCron("*/15 9-17 * * 1-5");
  assert.ok(matches(c, at("2026-09-22T09:30:00Z"))); // Tuesday
  assert.ok(!matches(c, at("2026-09-22T09:31:00Z")));
  assert.ok(!matches(c, at("2026-09-26T09:30:00Z"))); // Saturday
  assert.ok(matches(parseCron("0 0 * * 7"), at("2026-09-27T00:00:00Z"))); // 7 is Sunday
});

test("day of month OR day of week when both are restricted", () => {
  const c = parseCron("0 12 1 * 1");
  assert.ok(matches(c, at("2026-10-01T12:00:00Z"))); // the 1st, a Thursday
  assert.ok(matches(c, at("2026-09-28T12:00:00Z"))); // a Monday
  assert.ok(!matches(c, at("2026-09-29T12:00:00Z")));
});

test("bad schedules say which field is wrong", () => {
  assert.throws(() => parseCron("0 9 * *"), /five fields/);
  assert.throws(() => parseCron("61 * * * *"), /minute/);
  assert.throws(() => parseCron("0 9 * * mon"), /day of week/);
});

test("slots come newest first and stop at the window", () => {
  const c = parseCron("0 * * * *");
  const t0 = Date.parse("2026-09-22T00:30:00Z");
  const t1 = Date.parse("2026-09-22T03:10:00Z");
  assert.deepEqual(
    slotsBetween(c, t0, t1).map((t) => new Date(t).toISOString()),
    ["2026-09-22T03:00:00.000Z", "2026-09-22T02:00:00.000Z", "2026-09-22T01:00:00.000Z"],
  );
  assert.deepEqual(slotsBetween(c, t1, t1), []);
});

test("minimum interval", () => {
  assert.equal(minimumIntervalMs(parseCron("* * * * *")), 60_000);
  assert.equal(minimumIntervalMs(parseCron("23 9 * * *")), 86_400_000);
});
