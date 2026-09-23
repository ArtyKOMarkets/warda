/**
 * The store is the only thing standing between one payment and unlimited
 * reports, so the property it has to have is the one a unit test can actually
 * assert: a txid recorded by one instance is refused by the NEXT one, because
 * the instance that matters is the one after the restart.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSpent } from "../spent.mjs";

const TX = "a".repeat(64);
const TX2 = "b".repeat(64);
const where = async () => join(await mkdtemp(join(tmpdir(), "spent-")), "spent.log");

test("an unseen payment is not spent", async () => {
  const s = fileSpent(await where());
  assert.equal(await s.has(TX), false);
});

test("a recorded payment is refused by a later process", async () => {
  const path = await where();
  const first = fileSpent(path);
  await first.add(TX);
  assert.equal(first.has(TX), true);

  /* The whole point: a fresh store over the same file, as after a restart. */
  const second = fileSpent(path);
  assert.equal(second.has(TX), true, "a restart must not reopen a served payment");
  assert.equal(second.has(TX2), false, "and must not refuse one that was never made");
  assert.equal(second.count(), 1);
});

test("case does not decide whether a payment was served", async () => {
  const path = await where();
  const s = fileSpent(path);
  await s.add(TX.toUpperCase());
  assert.equal(s.has(TX), true);
  assert.equal(fileSpent(path).has(TX.toUpperCase()), true);
});

test("a line that is not a transaction id is skipped, and the rest still load", async () => {
  const path = await where();
  await writeFile(path, `\n# a note somebody added\n${TX}\nnot-a-txid\n${TX2}\n`);
  const s = fileSpent(path);
  assert.equal(s.count(), 2);
  assert.equal(s.has(TX), true);
  assert.equal(s.has(TX2), true);
});

test("the file is append-only — a second sale does not lose the first", async () => {
  const path = await where();
  const s = fileSpent(path);
  await s.add(TX);
  await s.add(TX2);
  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.deepEqual(lines, [TX, TX2]);
});

test("a missing file is an empty store, not a crash", async () => {
  const s = fileSpent(join(await mkdtemp(join(tmpdir(), "spent-")), "deep", "spent.log"));
  assert.equal(s.count(), 0);
  await s.add(TX);            // creates the directory on the way
  assert.equal(s.has(TX), true);
});
