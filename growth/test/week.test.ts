import { test } from "node:test";
import assert from "node:assert/strict";
import { kas, nextStep, plan, readPurchase, report, seenFrom, summary, weekLabel, type WeekState } from "../src/week.ts";

test("the plan sizes the child to the records and gives it a real rate limit", () => {
  const p = plan(12);
  assert.equal(p.childBudget, 60_000_000n);
  assert.equal(p.maxPerSpendChild, 5_000_000n);
  assert.equal(p.childEpochLimit, 15_000_000n, "a quarter of the budget per epoch, not the whole of it");
  assert.ok(p.parentBudget > p.childBudget, "the batch grant also carries the fees");
  assert.throws(() => plan(0));
  assert.throws(() => plan(51));
});

test("week labels are ISO weeks", () => {
  assert.equal(weekLabel(new Date("2026-09-21T12:00:00Z")), "2026-W39");
  assert.equal(weekLabel(new Date("2026-01-01T00:00:00Z")), "2026-W01");
  assert.equal(weekLabel(new Date("2027-01-01T00:00:00Z")), "2026-W53");
});

test("a week resumes at the first step it has not finished", () => {
  const s: WeekState = { label: "x", startedAt: "", done: { genesis: { at: "" }, open: { at: "" } } };
  assert.equal(nextStep(s), "scout");
});

test("a purchase file becomes a record, and what was bought is never bought again", () => {
  const p = readPurchase({
    url: "https://warda-growth.vercel.app/verify?url=https%3A%2F%2Fgithub.com%2FAcme%2FPaybot",
    outcome: "bought", txid: "ab".repeat(32), proof: { amountSompi: "5000000" },
    response: { project: "https://github.com/Acme/Paybot", checkedAt: "", findings: [], unverified: [], signals: [] },
  })!;
  assert.equal(p.paidSompi, 5_000_000n);
  assert.ok(p.record);
  assert.deepEqual([...seenFrom([p])], ["acme/paybot"]);
  assert.equal(seenFrom([{ ...p, outcome: "failed" }]).size, 0, "a failed attempt was not bought");
});

test("the summary says nothing was sent, and what it cost", () => {
  const s: WeekState = { label: "2026-W39", startedAt: "", done: { genesis: { at: "", txid: "c".repeat(64) } } };
  const r = report(s, "testnet-10", [], [{ url: "u", outcome: "bought", paidSompi: 5_000_000n }], [], []);
  assert.equal(kas(r.spentSompi), "0.05");
  assert.match(summary(r), /Nothing has been sent to anyone/);
  assert.match(summary(r), /genesis cccccccc/);
});
