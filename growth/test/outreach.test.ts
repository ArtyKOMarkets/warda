/**
 * Outreach writes only what the record established, to a channel the
 * maintainers published — or writes nothing and says why.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { angleFor, draft, draftsMarkdown, isDraft } from "../src/outreach.ts";
import type { Record as ProjectRecord } from "../src/verify-project.ts";

const API = "https://api.github.com/repos/acme/paybot";
const base = (over: Partial<ProjectRecord> = {}): ProjectRecord => ({
  project: "https://github.com/acme/paybot",
  checkedAt: "2026-09-21T00:00:00Z",
  findings: [
    { fact: "the repository acme/paybot is public", source: API },
    { fact: "it describes itself as \"An agent that buys APIs over x402\"", source: API },
    { fact: "the maintainer lists X/Twitter @acme_dev on their profile", source: "https://api.github.com/users/acme" },
  ],
  unverified: ["whether anyone there wants to pay for anything, which only they can say"],
  signals: ["mentions paying for things: x402, usdc (https://github.com/acme/paybot#readme)", "mentions agents: ai agent (https://github.com/acme/paybot#readme)"],
  ...over,
});

test("x402 on their own pages picks the seller argument", () => {
  assert.equal(angleFor(base()), "sells-over-x402");
});

test("a draft goes to the channel they published, and cites what it relies on", () => {
  const d = draft(base());
  assert.ok(isDraft(d));
  assert.equal(d.channel.kind, "x");
  assert.equal(d.channel.target, "https://x.com/acme_dev");
  assert.ok(d.body.includes("acme/paybot"));
  assert.ok(d.body.includes("x402, usdc"));
  assert.ok(d.body.includes("testnet"), "says it is testnet");
  assert.ok(d.basis.length >= 2 && d.basis.every((b) => b.source.startsWith("https://")));
});

test("it never claims they want it", () => {
  const d = draft(base());
  assert.ok(isDraft(d));
  assert.doesNotMatch(d.body, /you need|you want|you are looking for/i);
});

test("no signal, no draft — with the reason", () => {
  const d = draft(base({ signals: [] }));
  assert.ok(!isDraft(d));
  assert.match(d.reason, /no signal/);
});

test("no published channel, no draft — nobody goes looking for an address", () => {
  const d = draft(base({ findings: base().findings.slice(0, 2) }));
  assert.ok(!isDraft(d));
  assert.match(d.reason, /no channel/);
});

test("an archived project gets nothing", () => {
  const d = draft(base({ findings: [...base().findings, { fact: "it is ARCHIVED, so it is not accepting changes", source: API }] }));
  assert.ok(!isDraft(d));
});

test("discussions are a channel when switched on", () => {
  const f = base().findings.slice(0, 2).concat([{ fact: "GitHub Discussions is switched on, so questions are invited in public", source: API }]);
  const d = draft(base({ findings: f }));
  assert.ok(isDraft(d));
  assert.equal(d.channel.target, "https://github.com/acme/paybot/discussions");
});

test("the markdown lists drafts and the projects with nothing to send", () => {
  const md = draftsMarkdown("2026-W39", [draft(base()), draft(base({ signals: [] }))]);
  assert.match(md, /1 draft, 1 project with nothing to send/);
  assert.match(md, /Nothing here has been sent/);
});
