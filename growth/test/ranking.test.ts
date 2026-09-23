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
