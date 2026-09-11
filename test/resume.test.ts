/**
 * Which unfinished purchases may be redeemed, and which must never be.
 *
 * Every test here is really the same assertion from a different angle: a
 * resume must not be able to turn into a second purchase. The money is already
 * spent by the time any of this runs, so the failure mode on the wrong side of
 * these branches is paying twice for one thing.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { findResumable, UNFINISHED } from "../agents/tools/resume.ts";

const URL_A = "https://vendor.example/fact";
const URL_B = "https://vendor.example/other";

function dirWith(records: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "warda-resume-"));
  records.forEach((r, i) => {
    // ISO-ish names, because findResumable orders by filename on purpose.
    const name = `2026-09-11T10-0${i}-00-000Z.json`;
    writeFileSync(join(dir, name), JSON.stringify(r, null, 2));
  });
  return dir;
}

const paid = (url: string, txid: string, outcome = "paid-pending") => ({
  url,
  outcome,
  txid,
  proof: { header: `hdr-${txid}`, txid, amountSompi: "3000000", payTo: "kaspatest:qqvendor" },
});

test("a missing directory is a first run, not a failure", () => {
  assert.equal(findResumable(join(tmpdir(), "warda-does-not-exist-" + Date.now()), URL_A), null);
});

test("an unfinished purchase for this url is found", () => {
  const dir = dirWith([paid(URL_A, "aa")]);
  const p = findResumable(dir, URL_A);
  assert.equal(p?.txid, "aa");
  assert.equal(p?.header, "hdr-aa");
  assert.equal(p?.amountSompi, "3000000");
});

test("a purchase for a DIFFERENT url is not redeemed against this one", () => {
  const dir = dirWith([paid(URL_B, "bb")]);
  assert.equal(findResumable(dir, URL_A), null);
});

test("a completed purchase is not resumable", () => {
  const dir = dirWith([{ ...paid(URL_A, "cc"), outcome: "bought" }]);
  assert.equal(findResumable(dir, URL_A), null);
});

test("a refusal never paid, so there is nothing to redeem", () => {
  const dir = dirWith([{ url: URL_A, outcome: "refused", reason: "timelock" }]);
  assert.equal(findResumable(dir, URL_A), null);
});

test("an already-redeemed record is not redeemed a second time", () => {
  const dir = dirWith([{ ...paid(URL_A, "dd"), resolvedBy: { at: "2026-09-11T10:05:00Z", status: 200 } }]);
  assert.equal(findResumable(dir, URL_A), null);
});

test("a record with no proof cannot be resumed, whatever it says happened", () => {
  const dir = dirWith([{ url: URL_A, outcome: "paid-then-failed", txid: "ee" }]);
  assert.equal(findResumable(dir, URL_A), null);
});

test("two unfinished purchases redeem the NEWER one", () => {
  const dir = dirWith([paid(URL_A, "old"), paid(URL_A, "new")]);
  assert.equal(findResumable(dir, URL_A)?.txid, "new");
});

test("a truncated record is skipped, not thrown on", () => {
  const dir = dirWith([paid(URL_A, "good")]);
  writeFileSync(join(dir, "2026-09-11T10-09-00-000Z.json"), '{"url": "https://ven');
  assert.equal(findResumable(dir, URL_A)?.txid, "good");
});

test("every resumable outcome means money moved and goods did not", () => {
  // The set is allow-list shaped so that an outcome nobody has invented yet is
  // not silently resumable. This pins that intent.
  assert.deepEqual([...UNFINISHED].sort(), ["paid-but-refused", "paid-pending", "paid-then-failed"]);
  assert.equal(UNFINISHED.has("bought"), false);
  assert.equal(UNFINISHED.has("refused"), false);
  assert.equal(UNFINISHED.has("failed"), false);
});

test("a directory of unrelated files is ignored", () => {
  const dir = dirWith([paid(URL_A, "ff")]);
  mkdirSync(join(dir, "notes"));
  writeFileSync(join(dir, "README.txt"), "not a record");
  assert.equal(findResumable(dir, URL_A)?.txid, "ff");
});
