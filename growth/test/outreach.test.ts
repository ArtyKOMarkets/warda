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
  assert.ok(d.body.includes("paybot"));
  assert.ok(d.body.length < 500, `an X message is a DM, not a letter (${d.body.length})`);
  assert.match(d.body, /testnet/i, "says it is testnet");
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

test("payments infrastructure is pitched as a complement, not a customer", () => {
  const f = [base().findings[0]!, { fact: "it describes itself as \"Python SDK to interact with the Nevermined Payments Protocol\"", source: API }, base().findings[2]!];
  const d = draft(base({ findings: f }));
  assert.ok(isDraft(d));
  assert.equal(d.angle, "payments-infra");
  assert.match(d.body, /complementary/);
});

test("no description, no draft", () => {
  const d = draft(base({ findings: [base().findings[0]!, base().findings[2]!] }));
  assert.ok(!isDraft(d));
  assert.match(d.reason, /does not say what it is/);
});

test("a directory of APIs is not a prospect because it lists x402 ones", () => {
  const f = [base().findings[0]!, { fact: "it describes itself as \"Every public API in one place — aggregated, deduped\"", source: API }, base().findings[2]!];
  const d = draft(base({ findings: f }));
  assert.ok(!isDraft(d));
  assert.match(d.reason, /directory or list/);
});

test("a website channel gets the long form", () => {
  const f = base().findings.slice(0, 2).concat([{ fact: "their profile links https://acme.dev", source: "https://api.github.com/users/acme" }]);
  const d = draft(base({ findings: f }));
  assert.ok(isDraft(d));
  assert.equal(d.channel.kind, "website");
  assert.match(d.body, /^Hi,\n/);
  assert.match(d.body, /x402/);
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

test("a DM goes to the handle the website links, not the one on GitHub", () => {
  const f = [...base().findings, { fact: "its website links X @acme_now", source: "https://acme.dev" }];
  const d = draft(base({ findings: f }));
  assert.ok(isDraft(d));
  assert.equal(d.channel.target, "https://x.com/acme_now");
});
