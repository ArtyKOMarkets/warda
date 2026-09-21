/**
 * What Researcher sells, against recorded answers.
 *
 * The fetch is injected for the obvious reason — a service tested against the
 * live internet is a service whose tests fail when GitHub rate-limits — and
 * for a less obvious one: the cases worth pinning are the ones where the
 * network answers BADLY, and those are hard to arrange on purpose.
 *
 * The rule every test here checks is the same one: a fact must carry the URL
 * it came from, and anything not established must be named rather than
 * rounded into a score.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { repoOf, verifyProject, type Fetcher } from "../src/verify-project.ts";

const NOW = new Date("2026-09-13T12:00:00Z");

function answers(map: Record<string, { status: number; body: string }>): Fetcher {
  return async (url) => map[url] ?? { status: 404, body: "" };
}

const REPO = "https://github.com/kaspanet/rusty-kaspa";
const API = "https://api.github.com/repos/kaspanet/rusty-kaspa";

const META = JSON.stringify({
  full_name: "kaspanet/rusty-kaspa",
  description: "Kaspa full node",
  language: "Rust",
  stargazers_count: 512,
  pushed_at: "2026-09-10T08:00:00Z",
  archived: false,
});

const README = (text: string) =>
  JSON.stringify({ encoding: "base64", content: Buffer.from(text).toString("base64"),
                   html_url: `${REPO}#readme` });

test("a repo url is recognised, and anything else is not", () => {
  assert.deepEqual(repoOf(REPO), { owner: "kaspanet", name: "rusty-kaspa" });
  assert.deepEqual(repoOf("https://github.com/kaspanet/rusty-kaspa.git"), { owner: "kaspanet", name: "rusty-kaspa" });
  assert.equal(repoOf("https://github.com/kaspanet"), null);
  assert.equal(repoOf("https://example.com/a/b"), null);
  assert.equal(repoOf("not a url"), null);
});

test("every finding carries the url it came from", async () => {
  const r = await verifyProject(REPO, answers({
    [API]: { status: 200, body: META },
    [`${API}/readme`]: { status: 200, body: README("a node") },
  }), NOW);
  assert.ok(r.findings.length >= 4);
  for (const f of r.findings) {
    assert.match(f.source, /^https:\/\//, `"${f.fact}" has no source anyone can open`);
  }
  assert.ok(r.findings.some((f) => f.fact.includes("512 stars")));
  assert.ok(r.findings.some((f) => /last pushed 2026-09-10, which is 3 days ago/.test(f.fact)));
});

/**
 * The half a score would hide.
 *
 * "82/100" is a number nobody can check. These two sentences are the honest
 * version of the same claim, and they are the reason this is worth buying from
 * a stranger.
 */
test("what cannot be established is named, always", async () => {
  const r = await verifyProject(REPO, answers({
    [API]: { status: 200, body: META },
    [`${API}/readme`]: { status: 200, body: README("") },
  }), NOW);
  assert.ok(r.unverified.some((u) => /only they can say/.test(u)),
    "whether anyone wants to pay is not a thing a researcher can verify");
  assert.ok(r.unverified.some((u) => /welcome being contacted/.test(u)));
});

test("signals are words that were seen, never conclusions", async () => {
  const r = await verifyProject(REPO, answers({
    [API]: { status: 200, body: META },
    [`${API}/readme`]: { status: 200, body: README("We support x402 for our AI agent tooling.") },
  }), NOW);
  assert.ok(r.signals.some((s) => s.startsWith("mentions paying for things") && s.includes("x402")));
  assert.ok(r.signals.some((s) => s.startsWith("mentions agents") && s.includes("ai agent")));
  // Where it was seen, so the buyer can go and read the sentence around it.
  assert.ok(r.signals.every((s) => s.includes("#readme")));
});

test("an archived project says so, because it is the thing that matters most", async () => {
  const r = await verifyProject(REPO, answers({
    [API]: { status: 200, body: JSON.stringify({ ...JSON.parse(META), archived: true }) },
    [`${API}/readme`]: { status: 200, body: README("") },
  }), NOW);
  assert.ok(r.findings.some((f) => /ARCHIVED/.test(f.fact)));
});

/**
 * A project that is not there is a RESULT, not a failure.
 *
 * A buyer paid for this answer. Throwing would look like the service breaking
 * and would be refunded as a bug, when in fact the question was answered.
 */
test("a repo that does not exist is a finding, not an exception", async () => {
  const r = await verifyProject(REPO, answers({}), NOW);
  assert.ok(r.findings.some((f) => /no public repository/.test(f.fact)));
  assert.equal(r.unverified.length > 0, true);
});

test("GitHub failing is reported as a fact about the request, not about the project", async () => {
  const r = await verifyProject(REPO, answers({ [API]: { status: 403, body: "rate limited" } }), NOW);
  assert.ok(r.findings.some((f) => /HTTP 403/.test(f.fact)));
  assert.ok(r.unverified.some((u) => /a fact about the request, not about it/.test(u)));
});

test("a non-GitHub project is still answered, with less", async () => {
  const r = await verifyProject("https://example.com/thing", answers({
    "https://example.com/thing": { status: 200, body: "<title>Paying agents, metered</title>" },
  }), NOW);
  assert.ok(r.findings.some((f) => /answers HTTP 200/.test(f.fact)));
  assert.ok(r.findings.some((f) => /its title is "Paying agents, metered"/.test(f.fact)));
  assert.ok(r.signals.some((s) => s.includes("metered")));
  assert.ok(r.unverified.some((u) => /no commit history/.test(u)));
});

test("a url that answers nothing at all does not throw", async () => {
  const r = await verifyProject("https://nowhere.invalid", async () => { throw new Error("ENOTFOUND"); }, NOW);
  assert.ok(r.findings.some((f) => /could not be reached at all/.test(f.fact)));
});

test("a channel the maintainer published is a finding; no email is ever looked for", async () => {
  const record = await verifyProject(REPO, answers({
    [API]: { status: 200, body: JSON.stringify({ ...JSON.parse(META), topics: ["x402", "ai-agents"], has_discussions: true }) },
    [`${API}/readme`]: { status: 200, body: README("An AI agent that pays per call.") },
    "https://api.github.com/users/kaspanet": { status: 200, body: JSON.stringify({ type: "Organization", twitter_username: "kaspanet", email: "x@y.z" }) },
  }), NOW);
  const facts = record.findings.map((f) => f.fact).join("\n");
  assert.match(facts, /X\/Twitter @kaspanet/);
  assert.match(facts, /Discussions is switched on/);
  assert.match(facts, /its topics are x402, ai-agents/);
  assert.doesNotMatch(facts, /x@y\.z/);
  assert.ok(!record.unverified.some((u) => u.startsWith("who to contact")));
  assert.ok(record.signals.some((s) => s.startsWith("mentions paying for things") && s.includes("x402")));
});
