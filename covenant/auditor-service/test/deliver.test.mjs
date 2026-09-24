/**
 * The bug that sold nothing and kept the money.
 *
 * On 24 September 2026 the first paid request this service ever took settled
 * 0.04 KAS and returned a 502: the deliver callback read the covenant off its
 * argument, and `priced` calls it with `{ txid }` rather than the request. The
 * payment was already in spent.log by then — `settle` records before it
 * delivers — so it could not be presented again.
 *
 * These tests are about the wiring, not the compiler. `analyse` is a stub,
 * because what failed was never the analysis.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { makeDeliver, withSource } from "../deliver.mjs";

const analyse = async (source) => `SCANNED:${source}`;
const report = (text, when) => `<html>${when}|${text}</html>`;
const at = () => new Date("2026-09-24T11:50:00Z");

test("the covenant reaches deliver from the scope, not from its argument", async () => {
  const deliver = makeDeliver(analyse, report, at);
  const out = await withSource("covenant source", () => deliver({ txid: "abc" }));
  assert.match(out.html, /SCANNED:covenant source/);
  assert.match(out.html, /2026-09-24 11:50 UTC/);
});

test("what priced actually passes is ignored — including the shape that broke it", async () => {
  const deliver = makeDeliver(analyse, report, at);
  /* The old handler read `req.__source`. Anything that reads its argument
     would take this decoy instead of the covenant that was paid for. */
  const out = await withSource("the real one", () => deliver({ txid: "abc", __source: "a decoy" }));
  assert.match(out.html, /SCANNED:the real one/);
  assert.doesNotMatch(out.html, /decoy/);
});

test("outside a scope it throws rather than analysing undefined", async () => {
  const deliver = makeDeliver(analyse, report, at);
  await assert.rejects(() => deliver({ txid: "abc" }), /no covenant in scope/);
});

test("an empty body is not a covenant either", async () => {
  const deliver = makeDeliver(analyse, report, at);
  await assert.rejects(() => withSource("   ", () => deliver({ txid: "abc" })), /no covenant in scope/);
});

test("two deliveries in flight do not cross their covenants", async () => {
  /* A module-level variable would pass every test above and fail this one,
     which is the whole reason the scope is an AsyncLocalStorage. */
  const slow = async (source) => {
    await new Promise((r) => setTimeout(r, source === "first" ? 30 : 1));
    return `SCANNED:${source}`;
  };
  const deliver = makeDeliver(slow, report, at);
  const [a, b] = await Promise.all([
    withSource("first", () => deliver({ txid: "1" })),
    withSource("second", () => deliver({ txid: "2" })),
  ]);
  assert.match(a.html, /SCANNED:first/);
  assert.match(b.html, /SCANNED:second/);
});
