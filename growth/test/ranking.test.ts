/**
 * The ranking, against posts from the first real run.
 *
 * These are not invented cases. Every one is a post the live search returned
 * on 23 September 2026, and the assertions are the judgements a person made
 * reading that output: four of the six it surfaced were marketing or news,
 * and the best post in the run was cut.
 *
 * Kept as a test rather than fixed once and forgotten, because the next
 * change to the weights will be made for a good reason and these are what
 * stop it undoing this one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { score, type Post } from "../src/listen.ts";

const mins = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const p = (text: string, over: Partial<Post> = {}): Post => ({
  id: "1", url: "https://x.com/x/status/1", text, at: mins(40),
  author: { handle: "someone", name: null, followers: 3_000, verified: false },
  likes: 0, replies: 0, reposts: 0, matched: ["agent wallet"], ...over,
});

/* The post the first run cut, and the reason the weights changed. */
const SAFEGUARDS = p("@AEON_Community What safeguards exist against hacking/unauthorized transactions when giving an agent a wallet?");
/* A press release. The old rule read "Is Building" as somebody building. */
const PRESS = p("BAI Is Building The Connection Layer Between AI Models, Users, And Autonomous Agents");
/* A headline ending in a question mark. The old rule read it as an opening. */
const HEADLINE = p("BLACKROCK MAKES A BET ON WEB4? BlackRock has released a study titled The Machine-Native Economy", { matched: ["machine payments"] });
/* A launch. Relevant, adjacent, and nowhere to reply. */
const LAUNCH = p("Agents shouldn't have to wait for a human to click confirm to get work done. Introducing our agent wallet", { replies: 2, reposts: 3 });
/* A real thread. It was the one good result the old rule found. */
const REAL = p("My agent has a wallet and a real-world job: keeping my phone topped up", { replies: 24, reposts: 2, author: { handle: "mr", name: null, followers: 4_000, verified: false } });
/* Dead on topic, from the first run, scored 1 by the old rule. */
const CONSENT = p("Delegated consent is the missing UX and policy layer for agentic payments. Clear limits on what an agent can spend", { matched: ["agent payments"] });

test("the question Warda answers outranks everything else in the run", () => {
  const q = score(SAFEGUARDS).score;
  for (const [name, other] of [["press release", PRESS], ["headline", HEADLINE], ["launch", LAUNCH]] as const) {
    assert.ok(q > score(other).score, `${name} (${score(other).score}) should not beat the safeguards question (${q})`);
  }
  assert.equal(score(SAFEGUARDS).band, "high", `scored ${q}: ${score(SAFEGUARDS).why.join(" ")}`);
});

test("a press release is not somebody building", () => {
  const s = score(PRESS);
  assert.equal(s.band, "skip", `scored ${s.score}: ${s.why.join(" ")}`);
  assert.ok(!s.why.some((w) => w.includes("their own work")));
});

test("a headline ending in a question mark is not an opening", () => {
  const s = score(HEADLINE);
  assert.ok(!s.why.some((w) => w.includes("actually asking")), s.why.join(" "));
  assert.equal(s.band, "skip", `scored ${s.score}: ${s.why.join(" ")}`);
});

test("a launch announcement is penalised, however relevant", () => {
  const s = score(LAUNCH);
  assert.ok(s.why.some((w) => w.includes("launch announcement")), s.why.join(" "));
  assert.equal(s.band, "skip", `scored ${s.score}`);
});

test("a real thread about their own agent still ranks high", () => {
  assert.equal(score(REAL).band, "high", score(REAL).why.join(" "));
});

test("a fresh post with no replies is an opening, not a dud", () => {
  const fresh = score(p("my agent kept overspending so I capped it", { at: mins(30) }));
  const stale = score(p("my agent kept overspending so I capped it", { at: mins(10 * 60) }));
  assert.ok(fresh.why.some((w) => w.includes("early")), fresh.why.join(" "));
  assert.ok(fresh.score > stale.score);
});

test("the post about delegated consent clears the floor now", () => {
  const s = score(CONSENT);
  assert.notEqual(s.band, "skip", `scored ${s.score}: ${s.why.join(" ")}`);
});

test("our own account is muted, underscore and all", () => {
  const ours = p("AI agents can already act. They can call APIs.", {
    author: { handle: "Warda_protocol", name: "Warda", followers: 900, verified: false },
  });
  assert.equal(score(ours, { mute: new Set(["warda_protocol"]) }).band, "skip");
});

/* ------------------------------------------------------------------------ *
 * The second real run. Three posts reached the top six on keywords and a
 * clock alone, and the best organic post in the first run fell out of it.
 * ------------------------------------------------------------------------ */

test("keywords and a clock are not a reason to interrupt somebody", () => {
  /* Two queries matched by coincidence plus being recent is five points and
     nothing about the post. It cleared the floor in run 2, three times. */
  const s = score(p("@jerrymuse66 first move made. i turned the map into actual targets: Circle Agent Stack",
    { matched: ["x402", "agent wallet"] }));
  assert.ok(s.score >= 5, `expected it to still SCORE ${s.score}`);
  assert.equal(s.band, "skip", s.why.join(" "));
  assert.ok(s.why.some((w) => w.includes("only the search")), s.why.join(" "));
});

test("a post about their own agent counts even with a handle in the way", () => {
  /* Run 1 scored this 9. The rewrite required `my` immediately before the
     noun, so "My @CreaoAI agent" stopped matching and run 2 scored it 5 and
     cut it — the best organic post in either run, lost to a regression. */
  const s = score(p("My @CreaoAI agent has a wallet and a real-world job: keeping my phone topped up",
    { replies: 24, reposts: 2 }));
  assert.ok(s.why.some((w) => w.includes("their own work")), s.why.join(" "));
  assert.equal(s.band, "high", `scored ${s.score}`);
});

test("the same line posted twice is one candidate", async () => {
  const { listen, searchUrl } = await import("../src/listen.ts");
  const q = [{ label: "kaspa", q: "kaspa" }];
  const twice = (id: string) => ({
    id, text: "Kaspa is purpose-built for the agentic money use case BlackRock just described https://t.co/a",
    created_at: mins(20), author_id: "u1",
    public_metrics: { like_count: 1, reply_count: 0, retweet_count: 0 },
  });
  const fetcher = async (url: string) => url === searchUrl(q[0]!, "2026-09-23T00:00:00Z")
    ? { status: 200, body: JSON.stringify({
        data: [twice("1"), { ...twice("2"), text: twice("2").text.replace("/a", "/b") }],
        includes: { users: [{ id: "u1", username: "dup", name: "D", public_metrics: { followers_count: 900 } }] },
      }) }
    : { status: 0, body: "" };
  const r = await listen(fetcher, { since: "2026-09-23T00:00:00Z", limit: 10 }, q);
  assert.equal(r.found.length + r.rejected.length, 1, "the repost should have folded into the first");
});

/* ------------------------------------------------------------------------ *
 * 24 September. The pass read 28 posts and the two that were unmistakably
 * the audience — working developers, replying to each other, about paid MCPs
 * being a mess — both scored 3 and were banded `skip`, below five posts of
 * bold-unicode reply-farming. The lane the post was found in turned out to
 * predict who wrote it better than anything in the text did.
 * ------------------------------------------------------------------------ */

test("a developer saying it hurts, in the lane developers use, is the whole point", () => {
  const s = score(p("@RhysSullivan @maria_rcks even mcp man doens't know of the horrors of paid mcps",
    { matched: ["paid MCP"] }));
  assert.notEqual(s.band, "skip", s.why.join(" "));
  assert.ok(s.score >= 6, `scored ${s.score}: a band without points cannot clear the floor`);
});

test("the same complaint outside the developer lane is not a reason to interrupt", () => {
  /* Crypto is full of people saying things are broken. PAIN counts where the
     population was measured, and nowhere else. */
  const s = score(p("@someone the whole agent payments space is a mess honestly",
    { matched: ["agent payments"] }));
  assert.equal(s.band, "skip", s.why.join(" "));
});

test("a reply opening with handles is still a question", () => {
  /* Nearly every reply on X opens with the handles it answers, so an `^`
     anchor matches almost nothing in a corpus that is mostly replies. This
     exact post was missed for that reason. */
  const s = score(p("@gen_z_PE @maria_rcks @pendev Is MCP access a separate charge, or included in an existing paid plan? Those feel quite different when you already pay for the app.",
    { matched: ["paid MCP"] }));
  assert.ok(s.why.some((w) => w.includes("actually asking")), s.why.join(" "));
  assert.notEqual(s.band, "skip", s.why.join(" "));
});

test("a headline typeset in mathematical bold was not written to anybody", () => {
  const s = score(p("\u{1D5D4}\u{1D5E5}\u{1D5D5}\u{1D5DC}\u{1D5E7}\u{1D5E5}\u{1D5E8}\u{1D5E0} IS QUIETLY BUILDING x402 agent payments",
    { matched: ["x402", "agent payments"] }));
  assert.ok(s.score < 0, `scored ${s.score}`);
  assert.equal(s.band, "skip", s.why.join(" "));
});
