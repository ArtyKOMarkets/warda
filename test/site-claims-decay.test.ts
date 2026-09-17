/**
 * The landing page's live claim, exercised in all four of its states.
 *
 * ## Why this is a test and not a glance
 *
 * The interoperability paragraph on the landing page describes one afternoon:
 * a vendor nobody here controls took a payment on 14 September. It would read
 * exactly the same on the day their facilitator stopped answering, which makes
 * it indistinguishable from a false claim. Agent #005 buys from them again
 * every morning and writes the outcome; the script under test turns that file
 * into the one sentence beneath the paragraph.
 *
 * The state that matters is the SILENT one. A reading older than a day and a
 * half must render nothing, so that a monitor which has died takes the claim
 * down with it instead of leaving a green line nobody re-earned. That failure
 * — a check that cannot fire looking exactly like a check with nothing to
 * report — has happened twice in this repository already: a cron job removed
 * by not being asked for again, and a status element deleted along with the
 * section it belonged to.
 *
 * So the branch this exists for is the one that asserts ABSENCE, which is
 * precisely the branch nobody notices is broken by looking at the page.
 *
 * ## Against the source, not the build
 *
 * `site/src/protocol.html` is what is committed; `site/web/` is generated. Reading
 * the source means this runs on a checkout with no Python and no build step,
 * and it fails if somebody edits the script — which is the point.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const page = readFileSync(
  fileURLToPath(new URL("../site/src/protocol.html", import.meta.url)),
  "utf8",
);

/* The script is lifted out by its anchor rather than by line number, so moving
   it around the file is fine and deleting it is not. */
const source = page.match(
  /var el = document\.getElementById\("interop-live"\);[\s\S]*?\.catch\(function \(\) \{\}\);/,
)?.[0];

test("the live interop claim is still wired into the page", () => {
  assert.ok(source, "the interop-live script is gone from site/src/protocol.html");
  assert.match(page, /id="interop-live"/, "the element it writes into is gone");
});

/** Run the page's own script against a status file, and report what it said. */
async function render(status: unknown): Promise<{ hidden: boolean; text: string | null }> {
  let text: string | null = null;
  let hidden = true;
  const document = {
    getElementById: () => ({
      set textContent(v: string) { text = v; },
      set hidden(v: boolean) { hidden = v; },
    }),
  };
  const fetchImpl = async () => ({ ok: true, json: async () => status });
  await new Function(
    "document",
    "window",
    "fetch",
    `return (async () => { ${source} })()`,
  )(document, { fetch: true }, fetchImpl);
  /* The script is a promise chain with no handle to await. One tick is enough:
     the fake fetch resolves immediately. */
  await new Promise((r) => setTimeout(r, 20));
  return { hidden, text };
}

const served = {
  checkedAt: new Date().toISOString(),
  ok: true,
  txid: "647f648451c864073ba0d9c1ed4de56461ee392f7d5bbbb9bd9c1273a4876474",
  paidSompi: "20000000",
  remaining: 255610240,
};

test("a purchase today says so, with the transaction", async () => {
  const { hidden, text } = await render(served);
  assert.equal(hidden, false);
  assert.match(text!, /Still true on \d{4}-\d{2}-\d{2}/);
  assert.match(text!, /647f648451c86407/, "the claim names the transaction that backs it");
});

test("a reading older than a day and a half renders NOTHING", async () => {
  /* The whole reason this file exists. A dead monitor must take the claim with
     it; a stale green is worse than silence, because silence is honest about
     not knowing and green is not. */
  const stale = { ...served, checkedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() };
  const { hidden, text } = await render(stale);
  assert.equal(hidden, true, "a stale reading must not render");
  assert.equal(text, null);
});

test("a missing or unreadable status file renders nothing either", async () => {
  for (const bad of [null, {}, { ok: true }, { checkedAt: "not a date", ok: true }]) {
    const { hidden } = await render(bad);
    assert.equal(hidden, true, `rendered something for ${JSON.stringify(bad)}`);
  }
});

test("the grant refusing is reported as the grant, not as the vendor", async () => {
  /* A budget running out is the covenant doing its job and is the expected end
     of this agent. Reporting it as an interop failure would make the page cry
     wolf about the one thing it is trying to demonstrate. */
  const { hidden, text } = await render({
    checkedAt: new Date().toISOString(),
    ok: false,
    refusedByGrant: true,
    error: "budget",
  });
  assert.equal(hidden, false);
  assert.match(text!, /covenant refused/);
  assert.match(text!, /Nothing was paid/);
  assert.doesNotMatch(text!, /does not reproduce/);
});

test("a paid-and-unserved purchase says so on the page, in public", async () => {
  /* The page is not allowed to only report good news about its own claim. */
  const { hidden, text } = await render({
    checkedAt: new Date().toISOString(),
    ok: false,
    refusedByGrant: false,
    txid: "7e59e4a13cf0638abebfe5532e1723522975522ba1c93b678c3bcbf14b58c160",
    error: "invalid_transaction_state",
  });
  assert.equal(hidden, false);
  assert.match(text!, /does not reproduce/);
  assert.match(text!, /7e59e4a13cf0638a/, "and names the payment that went unanswered");
});
