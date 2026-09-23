import { test } from "node:test";
import assert from "node:assert/strict";
import { alert, ANGLES, summary } from "../src/alert.ts";
import { QUERIES, score, type Post } from "../src/listen.ts";

const post = (over: Partial<Post> = {}): Post => ({
  id: "1", url: "https://x.com/dev/status/1",
  text: "how do you stop an agent overspending? built a 402 endpoint and the cap broke",
  at: new Date(Date.now() - 40 * 60_000).toISOString(),
  author: { handle: "dev", name: "Dev", followers: 5_000, verified: false },
  likes: 3, replies: 9, reposts: 1, matched: ["x402"], ...over,
});

test("every query has an angle, so adding one without is visible", () => {
  for (const q of QUERIES) {
    assert.ok(ANGLES[q.label], `no angle written for query "${q.label}"`);
  }
});

test("no angle claims more than Warda can defend today", () => {
  for (const [label, text] of Object.entries(ANGLES)) {
    assert.doesNotMatch(text, /\baudited\b/i, `${label} claims an audit`);
    assert.doesNotMatch(text, /\bproduction\b/i, `${label} claims production use`);
    assert.doesNotMatch(text, /\bsecure\b/i, `${label} claims security`);
  }
});

test("the message carries the link, the reasons and no score", () => {
  const a = alert(score(post()));
  assert.ok(a.text.includes("https://x.com/dev/status/1"));
  assert.ok(a.text.includes("Why:"));
  assert.ok(a.text.includes("40m old"));
  assert.doesNotMatch(a.text, /score/i);
});

test("a post no written angle fits says so rather than inventing one", () => {
  const a = alert(score(post({ matched: ["something new"] })));
  assert.equal(a.angle, null);
  assert.match(a.text, /your words/);
});

test("the angle comes from a query that actually found the post", () => {
  const a = alert(score(post({ matched: ["unknown", "agent wallet"] })));
  assert.equal(a.angle, "agent wallet");
});

test("a post full of Markdown characters is still a whole message", () => {
  const a = alert(score(post({ text: "*agents* _need_ [limits](x) `now` __really__" })));
  assert.ok(a.text.includes("*agents* _need_"), "text is passed through, not escaped away");
});

test("a very long post is cut, not sent whole", () => {
  const a = alert(score(post({ text: "x".repeat(2000) })));
  assert.ok(a.text.length < 900, `message was ${a.text.length} characters`);
  assert.ok(a.text.includes("…"));
});

test("a pass that found nothing still reports what it cost", () => {
  const s = summary({ searched: 3, reads: 24, sent: 0, skipped: 24, costUsd: 0.12, spentKas: 0.15 });
  assert.match(s, /0 sent/);
  assert.match(s, /24 posts read/);
  assert.match(s, /\$0\.120 to X/);
});
