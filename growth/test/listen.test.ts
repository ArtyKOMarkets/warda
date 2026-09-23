/**
 * Listener, against recorded X answers.
 *
 * The cases worth pinning are the ones that decide what reaches Telegram,
 * because every false positive there costs attention and teaches you to stop
 * reading the messages — which is the only way this whole thing actually
 * fails. So: the merge across queries (it drives the biggest score
 * component), posts already reported, promotion, and a search that failed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { explain, listen, score, searchUrl, postsFrom, type Fetcher, type Post, type Query } from "../src/listen.ts";

const Q: Query[] = [
  { label: "x402", q: "x402" },
  { label: "agent wallet", q: "\"agent wallet\"" },
];
const SINCE = "2026-09-23T00:00:00Z";
const now = (hoursAgo = 1) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

function xPost(id: string, text: string, user: Record<string, unknown>, metrics: Record<string, number> = {}, at = now()) {
  return {
    tweet: { id, text, created_at: at, author_id: `u${id}`,
      public_metrics: { like_count: 0, reply_count: 0, retweet_count: 0, ...metrics } },
    user: { id: `u${id}`, username: `dev${id}`, name: `Dev ${id}`, verified: false,
      public_metrics: { followers_count: 5_000 }, ...user },
  };
}

function answers(byLabel: Record<string, { status: number; posts?: ReturnType<typeof xPost>[] }>): Fetcher {
  return async (url) => {
    for (const q of Q) {
      if (url === searchUrl(q, SINCE)) {
        const a = byLabel[q.label]!;
        if (a.status !== 200) return { status: a.status, body: "" };
        return { status: 200, body: JSON.stringify({
          data: (a.posts ?? []).map((p) => p.tweet),
          includes: { users: (a.posts ?? []).map((p) => p.user) },
        }) };
      }
    }
    throw new Error(`unexpected url ${url}`);
  };
}

const base = (over: Partial<Post> = {}): Post => ({
  id: "1", url: "https://x.com/dev/status/1", text: "thinking about agents", at: now(),
  author: { handle: "dev", name: "Dev", followers: 5_000, verified: false },
  likes: 0, replies: 0, reposts: 0, matched: ["x402"], ...over,
});

test("a post two searches found outranks a post one search found", () => {
  const one = score(base({ id: "1", matched: ["x402"] }));
  const two = score(base({ id: "2", matched: ["x402", "agent wallet"] }));
  assert.ok(two.score > one.score, `${two.score} should beat ${one.score}`);
  assert.ok(two.why.some((w) => w.includes("x402, agent wallet")));
});

test("somebody describing their own work outranks somebody commenting", () => {
  const take = score(base({ text: "agents will need payments eventually" }));
  const doing = score(base({ text: "shipped a 402 endpoint for my agent, the budget cap broke" }));
  assert.ok(doing.score > take.score, `${doing.score} should beat ${take.score}`);
  /* The reason, not the wording: first-hand is the thing being rewarded, and
     the first run showed why — `building` alone is what a press release says
     about itself. */
  assert.ok(doing.why.some((w) => w.includes("their own work")), doing.why.join(" "));
});

test("a question scores as an opening", () => {
  const asked = score(base({ text: "how do you stop an agent overspending? anyone tried this" }));
  assert.ok(asked.why.some((w) => w.includes("opening")));
});

test("promotion is pushed under the floor however well it matches", () => {
  const shill = score(base({
    text: "🚀 free $AGENT airdrop, claim now, guaranteed 1000x",
    matched: ["x402", "agent wallet", "agent payments"],
    replies: 40, reposts: 30,
    author: { handle: "pump", name: null, followers: 90_000, verified: true },
  }));
  assert.equal(shill.band, "skip", `scored ${shill.score}: ${shill.why.join(" ")}`);
});

test("replies count for more than likes, because a conversation is the point", () => {
  const liked = score(base({ likes: 400, replies: 0, reposts: 0 }));
  const argued = score(base({ likes: 12, replies: 14, reposts: 2 }));
  assert.ok(argued.score > liked.score, `${argued.score} should beat ${liked.score}`);
});

test("a thread older than two days is not a smaller opportunity, it is none", () => {
  const fresh = score(base({ text: "built an agent wallet, hit a spend cap bug", replies: 10, at: now(2) }));
  const stale = score(base({ text: "built an agent wallet, hit a spend cap bug", replies: 10, at: now(72) }));
  assert.equal(fresh.band, "high");
  assert.ok(stale.score < fresh.score - 5, "the age penalty must be decisive, not cosmetic");
});

test("a muted handle is never reported", () => {
  const s = score(base({ text: "shipped a 402 endpoint, budget cap broke", replies: 30, author: { handle: "WardaProtocol", name: "Warda", followers: 900, verified: false } }),
    { mute: new Set(["wardaprotocol"]) });
  assert.equal(s.band, "skip");
});

test("one post found by both searches is one post with two reasons", async () => {
  const p = xPost("7", "how do you cap what an agent can spend? built a 402 endpoint", {}, { reply_count: 9 });
  const r = await listen(answers({ "x402": { status: 200, posts: [p] }, "agent wallet": { status: 200, posts: [p] } }),
    { since: SINCE, limit: 10 }, Q);
  assert.equal(r.found.length, 1);
  assert.deepEqual(r.found[0]!.post.matched, ["x402", "agent wallet"]);
  /* Two searches each returned it, so two reads were paid for. The bill is
     what was read, not what survived. */
  assert.equal(r.reads, 2);
});

test("a post already reported is not reported again", async () => {
  const p = xPost("7", "how do you cap agent spend? shipped a 402 endpoint", {}, { reply_count: 9 });
  const r = await listen(answers({ "x402": { status: 200, posts: [p] }, "agent wallet": { status: 200 } }),
    { since: SINCE, limit: 10, seen: new Set(["7"]) }, Q);
  assert.equal(r.found.length, 0);
  assert.equal(r.rejected.length, 0);
});

test("a failed search is recorded with its status and costs nothing", async () => {
  const r = await listen(answers({ "x402": { status: 429 }, "agent wallet": { status: 200 } }),
    { since: SINCE, limit: 10 }, Q);
  const bad = r.searched.find((s) => s.label === "x402");
  assert.ok(bad, "the failed search must still be recorded");
  assert.equal(bad.status, 429);
  assert.equal(bad.found, 0);
  assert.equal(r.reads, 0);
});

test("a post with no resolvable author is unusable and dropped", () => {
  const body = JSON.stringify({ data: [{ id: "9", text: "agents and money", created_at: now(), author_id: "missing" }], includes: { users: [] } });
  assert.deepEqual(postsFrom(body, "x402"), []);
});

test("the search asks for the fields the score needs", () => {
  const url = searchUrl(Q[0]!, SINCE);
  for (const need of ["public_metrics", "created_at", "author_id", "expansions=author_id"]) {
    assert.ok(url.includes(encodeURIComponent(need)) || url.includes(need), `${need} missing from ${url}`);
  }
});

test("nothing found is not the same as everything skipped", async () => {
  const dull = xPost("3", "gm", {}, {});
  const r = await listen(answers({ "x402": { status: 200, posts: [dull] }, "agent wallet": { status: 200 } }),
    { since: SINCE, limit: 10 }, Q);
  assert.equal(r.found.length, 0);
  assert.equal(r.rejected.length, 1, "a run that reports nothing must still say what it looked at and rejected");
  assert.equal(r.reads, 1);
});

test("a status says what to do about it, and 401 is not 402", () => {
  assert.match(explain(402), /no credits/);
  assert.match(explain(402), /console\.x\.com/);
  assert.match(explain(401), /token/);
  /* The two that look identical on screen and send you to different places:
     a bad token, and a fine token with an empty balance. */
  assert.notEqual(explain(401), explain(402));
  assert.match(explain(429), /rate limited/i);
  assert.match(explain(503), /X is having trouble/);
  assert.equal(explain(200), "ok");
});

test("the seller's flattened body is read as posts, not as nothing", () => {
  /* The first paid run: three payments, three 200s, zero posts. The seller
     returns the result of postsFrom run on its own side, which has no `data`
     key — so parsing it as X's raw shape found nothing and said nothing. */
  const body = JSON.stringify({
    query: "x402", since: "2026-09-22T12:00:00Z", maxResults: 10, reads: 1, costUsd: 0.005,
    posts: [{
      id: "9", url: "https://x.com/dev/status/9", text: "what stops an agent overspending?",
      at: now(), author: { handle: "dev", name: "Dev", followers: 900, verified: false },
      likes: 1, replies: 2, reposts: 0, matched: ["whatever the seller called it"],
    }],
  });
  const got = postsFrom(body, "agent wallet");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.id, "9");
  assert.equal(got[0]!.author.handle, "dev");
  /* The label is this run's query, not the one the seller recorded. */
  assert.deepEqual(got[0]!.matched, ["agent wallet"]);
});

test("X's raw shape still parses, so reading direct is unaffected", () => {
  const body = JSON.stringify({
    data: [{ id: "1", text: "agents and money", created_at: now(), author_id: "u1",
             public_metrics: { like_count: 2, reply_count: 1, retweet_count: 0 } }],
    includes: { users: [{ id: "u1", username: "dev", name: "Dev", public_metrics: { followers_count: 400 } }] },
  });
  const got = postsFrom(body, "x402");
  assert.equal(got.length, 1);
  assert.equal(got[0]!.url, "https://x.com/dev/status/1");
});

test("a body that is neither shape is no posts, not a crash", () => {
  assert.deepEqual(postsFrom("{}", "x402"), []);
  assert.deepEqual(postsFrom("not json", "x402"), []);
  assert.deepEqual(postsFrom(JSON.stringify({ posts: "no" }), "x402"), []);
});
