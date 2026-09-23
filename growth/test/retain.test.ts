/**
 * The retention rule. X lets you keep Post IDs; Post objects come with a
 * 24-hour obligation to reflect deletions, and refreshing a tuning fixture
 * forever costs a read per post forever.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStale, prune, pruneDir, stripped, KEEP_MS, type SavedRun } from "../src/retain.ts";
import type { Post } from "../src/listen.ts";

const post = (id: string): Post => ({
  id, url: `https://x.com/dev/status/${id}`, text: "what stops an agent overspending?",
  at: new Date().toISOString(),
  author: { handle: "dev", name: "Dev Person", followers: 4_000, verified: true },
  likes: 9, replies: 3, reposts: 1, matched: ["agent wallet"],
});
const run = (at: string): SavedRun => ({ at, posts: [post("1"), post("2")] });

test("a run from this morning keeps its content", () => {
  assert.equal(isStale(run(new Date().toISOString())), false);
});

test("a run from two days ago does not", () => {
  assert.equal(isStale(run(new Date(Date.now() - 2 * KEEP_MS).toISOString())), true);
});

test("pruning keeps what is ours and drops what is X's", () => {
  const p = stripped(post("1"));
  assert.equal(p.id, "1", "the ID is the thing the policy lets us keep");
  assert.equal(p.url, "https://x.com/dev/status/1");
  assert.equal(p.author.handle, "dev", "the handle is in the URL either way");
  assert.equal(p.text, "");
  assert.equal(p.author.name, null);
  assert.equal(p.author.followers, 0);
  assert.equal(p.likes, 0);
  assert.deepEqual(p.matched, ["agent wallet"], "why we looked is our note, not X's content");
});

test("a pruned run is not pruned again, and says when it was", () => {
  const old = run(new Date(Date.now() - 2 * KEEP_MS).toISOString());
  const done = prune(old);
  assert.ok(done.pruned);
  assert.equal(isStale(done), false);
});

test("a run with no timestamp is treated as stale, not as fresh", () => {
  /* The safe direction: a file we cannot date might be from any day, and
     keeping content because we are unsure is the wrong way to be unsure. */
  assert.equal(isStale({ posts: [post("1")] }), true);
});

test("a directory is walked, and it reports what it changed", () => {
  const dir = mkdtempSync(join(tmpdir(), "runs-"));
  writeFileSync(join(dir, "fresh.json"), JSON.stringify(run(new Date().toISOString())));
  writeFileSync(join(dir, "old.json"), JSON.stringify(run(new Date(Date.now() - 2 * KEEP_MS).toISOString())));
  writeFileSync(join(dir, "notjson.txt"), "ignore me");
  writeFileSync(join(dir, "broken.json"), "{ not json");

  const done = pruneDir(dir);
  assert.deepEqual(done.map((d) => d.file), ["old.json"]);
  assert.equal(done[0]!.posts, 2);

  const after = JSON.parse(readFileSync(join(dir, "old.json"), "utf8")) as SavedRun;
  assert.equal(after.posts[0]!.text, "");
  assert.equal(after.posts[0]!.id, "1");
  const untouched = JSON.parse(readFileSync(join(dir, "fresh.json"), "utf8")) as SavedRun;
  assert.notEqual(untouched.posts[0]!.text, "");
});
