/**
 * The landing page's claim that a stranger can check a grant for themselves.
 *
 * ## Why this one earned a test of its own
 *
 * On 16 September `verify.wardaprotocol.com/v1/verify` returned `internal` to
 * every request, for an unknown length of time, while the landing page carried
 * a card saying "Anyone can check a grant without trusting whoever showed it to
 * them" — linking `/health`, which stayed green throughout, because opening a
 * node and deriving an address are different code paths and only the second was
 * broken.
 *
 * Nothing was watching it. It was found by accident, while shipping an
 * unrelated fix, because a before/after reading happened to be taken.
 *
 * ## The branch that matters is the silent one
 *
 * Same lesson as site-claims-decay.test.ts beside this file, which says it
 * better: a check that cannot fire looks exactly like a check with nothing to
 * report. So the assertions with teeth are the three that require ABSENCE —
 * no file, a healthy reading, and a STALE one. A monitor that dies must take
 * the warning down with it rather than leave a page insisting all is well, and
 * must equally not leave a warning standing after the outage ended.
 *
 * Read from `site/src/protocol.html`, the committed source, so this runs on a
 * checkout with no Python and no build step — and fails if somebody edits the
 * script, which is the point.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const page = readFileSync(
  fileURLToPath(new URL("../site/src/protocol.html", import.meta.url)),
  "utf8",
);

const source = page.match(
  /var el = document\.getElementById\("vfy-live"\);[\s\S]*?\.catch\(function \(\) \{\}\);/,
)?.[0];

test("the verify warning is still wired into the page", () => {
  assert.ok(source, "the vfy-live script is gone from site/src/protocol.html");
  assert.match(page, /id="vfy-live"/, "the element it writes into is gone");
});

async function render(status: unknown, ok = true): Promise<{ hidden: boolean; text: string | null }> {
  let text: string | null = null;
  let hidden = true;
  const document = {
    getElementById: () => ({
      set textContent(v: string) { text = v; },
      set hidden(v: boolean) { hidden = v; },
    }),
  };
  const fetchImpl = async () => ({ ok, json: async () => status });
  await new Function(
    "document",
    "window",
    "fetch",
    `return (async () => { ${source} })()`,
  )(document, { fetch: true }, fetchImpl);
  await new Promise((r) => setTimeout(r, 20));
  return { hidden, text };
}

const now = () => new Date().toISOString();
const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const broken = {
  ok: false,
  checkedAt: now(),
  lastOk: "2026-09-16T08:00:00Z",
  reason: "it answered 500 — the shape the missing covenant template produced",
};

test("a fresh failure says so, names the reason, and says since when", async () => {
  const r = await render(broken);
  assert.equal(r.hidden, false);
  assert.match(r.text!, /not answering correctly/);
  assert.match(r.text!, /missing covenant template/);
  assert.match(r.text!, /2026-09-16 08:00/);
});

/**
 * The failure the outage itself would have had: the endpoint is broken and the
 * page must not still be telling people to go and use it. But it must also
 * point at the thing that DOES work, because the claim rests on the local
 * verifier rather than on our hosting.
 */
test("a failure points at the version that does not depend on us", async () => {
  const r = await render(broken);
  assert.match(r.text!, /npx warda-verify/);
});

test("a healthy reading renders NOTHING — the absence is the claim", async () => {
  const r = await render({ ok: true, checkedAt: now(), lastOk: now(), reason: "" });
  assert.equal(r.hidden, true);
  assert.equal(r.text, null);
});

/**
 * The one that catches a dead monitor. A reading over an hour old is a reading
 * from a check that may have stopped running, and a warning nobody re-earned is
 * as misleading as a green light nobody re-earned.
 */
test("a stale failure renders nothing, so a dead monitor takes its own claim down", async () => {
  const r = await render({ ...broken, checkedAt: hoursAgo(2) });
  assert.equal(r.hidden, true);
});

test("no status file at all renders nothing", async () => {
  const r = await render(null, false);
  assert.equal(r.hidden, true);
});

test("a malformed reading is silence, not a crash and not a warning", async () => {
  for (const bad of [{}, { ok: "no" }, { ok: false }, { ok: false, checkedAt: "not a date" }]) {
    const r = await render(bad);
    assert.equal(r.hidden, true, JSON.stringify(bad));
  }
});
