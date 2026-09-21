/**
 * Scout, against recorded GitHub answers. The cases worth pinning are the
 * ones that decide what gets paid for: duplicates across queries, projects
 * already bought, forks and toys, and a search that failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { scout, searchUrl, type Query } from "../src/scout.ts";
import type { Fetcher } from "../src/verify-project.ts";

const Q: Query[] = [
  { label: "x402", q: "x402" },
  { label: "agent wallet", q: "\"agent wallet\"" },
];
const repo = (name: string, stars: number, pushed = "2026-09-10T00:00:00Z", extra = {}) =>
  ({ full_name: name, html_url: `https://github.com/${name}`, description: `${name} desc`, stargazers_count: stars, pushed_at: pushed, ...extra });

function answers(byLabel: Record<string, { status: number; items?: unknown[] }>): Fetcher {
  return async (url) => {
    for (const q of Q) {
      if (url === searchUrl(q, "2026-08-01")) {
        const a = byLabel[q.label]!;
        return { status: a.status, body: JSON.stringify({ items: a.items ?? [] }) };
      }
    }
    return { status: 404, body: "" };
  };
}

test("a project found by two searches is one candidate that says both", async () => {
  const r = await scout(answers({
    x402: { status: 200, items: [repo("a/pay", 50), repo("b/only-x402", 400)] },
    "agent wallet": { status: 200, items: [repo("a/pay", 50)] },
  }), { since: "2026-08-01", limit: 10 }, Q);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0]!.fullName, "a/pay", "matching more searches ranks above more stars");
  assert.deepEqual(r.candidates[0]!.matched, ["x402", "agent wallet"]);
});

test("anything bought in an earlier batch is never bought again", async () => {
  const r = await scout(answers({ x402: { status: 200, items: [repo("A/Pay", 50), repo("c/new", 9)] }, "agent wallet": { status: 200 } }),
    { since: "2026-08-01", limit: 10, seen: new Set(["a/pay"]) }, Q);
  assert.deepEqual(r.candidates.map((c) => c.fullName), ["c/new"]);
});

test("forks, archives and projects under the star floor are not candidates", async () => {
  const r = await scout(answers({
    x402: { status: 200, items: [repo("f/fork", 99, undefined, { fork: true }), repo("z/old", 99, undefined, { archived: true }), repo("t/toy", 2)] },
    "agent wallet": { status: 200 },
  }), { since: "2026-08-01", limit: 10 }, Q);
  assert.equal(r.candidates.length, 0);
});

test("a failed search is reported, not mistaken for an empty one", async () => {
  const r = await scout(answers({ x402: { status: 403 }, "agent wallet": { status: 200, items: [repo("w/ok", 10)] } }),
    { since: "2026-08-01", limit: 10 }, Q);
  assert.deepEqual(r.searched.map((s) => [s.label, s.status]), [["x402", 403], ["agent wallet", 200]]);
  assert.equal(r.candidates.length, 1);
});

test("the cut is the limit, because each candidate costs a payment", async () => {
  const items = Array.from({ length: 20 }, (_, i) => repo(`r/${i}`, 10 + i));
  const r = await scout(answers({ x402: { status: 200, items }, "agent wallet": { status: 200 } }), { since: "2026-08-01", limit: 5 }, Q);
  assert.equal(r.candidates.length, 5);
  assert.equal(r.candidates[0]!.fullName, "r/19");
});
