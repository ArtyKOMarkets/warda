/**
 * Which covenant an agent spends under — and what happens when it cannot tell.
 *
 * Written on 26 September 2026, the day after the fleet stopped paying.
 *
 * `sdk/covenant-template.json` went from v4 to v5 in a commit whose subject
 * said every consumer resolves by fingerprint. Every consumer that had been
 * looked at did. `Agent.open` took the packaged template as a DEFAULT, and
 * every live grant was v4, so for twenty-one hours three agents derived v5
 * addresses for v4 grants and reported "no UTXO" about coin that had not
 * moved. Eight purchase attempts, zero successes, nothing on chain wrong.
 *
 * A wrong template cannot be caught downstream, which is the whole reason
 * these tests are here rather than in an integration suite: the address it
 * derives is well-formed, it exists, and it is empty. There is no error to
 * catch. The only place to notice is before the derivation.
 *
 * The rule under test: the MANIFEST decides. Not the package, not the caller.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  scriptHashFor, scriptHashToAddress, templateFingerprint, type CovenantTemplate,
} from "@warda_protocol/kaspa";
import { loadTemplates, templateFor } from "@warda_protocol/kaspa/templates";

import { toGrant } from "../src/grant.ts";
import { Agent } from "../src/agent.ts";
import { memoryStore, type Manifest } from "../src/store.ts";

const repo = (p: string) => fileURLToPath(new URL("../../" + p, import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(repo(p), "utf8")) as Manifest;
const lines = (p: string) =>
  readFileSync(repo(p), "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));

/**
 * The grant that went dark, frozen as it stood — a COPY, not the live file.
 *
 * The first version of this read `growth/listener-grant.json` and pinned the
 * address it derived. That broke within the day, and for the most predictable
 * reason there is: a manifest advances on every spend, so the moment the Listener
 * started paying again the pinned address was stale and two tests went red over
 * nothing. I had written the argument against doing this, in
 * `ops/check-template-guard.mjs`, and then did it anyway four files later.
 *
 * What moves is the STATE. What does not move is the covenant, and the fact that
 * a given state under the wrong covenant lands somewhere else. So the state is a
 * constant here — these are the exact counters at 26 September 05:13 UTC, and the
 * two addresses below are the ones in the purchase logs: `pqt9lyt0…` is what the
 * six failing passes reported, and `pq8y9dpy…` is where `follow-grant` found
 * 126,000,000 sompi sitting untouched.
 *
 * A constant fixture cannot rot into agreement with the code. That is the whole
 * property this file is for.
 */
const AT_THE_OUTAGE = {
  covenant: "b3e5eeefacf2021f",
  covenant_id: "35ce520c1885e9ff4db47a25360140eb674507ef31bc0b98daec7f33e5796ade",
  agent: "1da3d1e26bb993a7cb85a857afa467301d498d0a7bb36d617c37f792e5e8ee41",
  principal: "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f",
  revocation: "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f",
  recipients_root: "144bbc6a7b2cd9b9712e90a9ea1ce92643f23b6bca1b014e04de0f1060a1beb6",
  created_at_daa: 578327427,
  not_before: 578327427,
  expires_at: 584375427,
  budget: 210000000,
  max_per_spend: 5000000,
  epoch_limit: 15000000,
  epoch_length: 432000,
  delegation_depth: 0,
  grant_value: 126000000,
  spent_total: 60000000,
  reserved: 0,
  epoch_index: 3,
  epoch_spent: 15000000,
} as unknown as Manifest;

/** Where that state's coin was, and where the outage said to look for it. */
const UNDER_V4 = "kaspatest:pq8y9dpyca8lcsfe9785wjgalhkhzwg56kwpvh7tlwfw5lehtwp9qq5k2vtdm";
const UNDER_V5 = "kaspatest:pqt9lyt0lsejrrsn26cht7nau39vqfvd2r67nttqzz2wffkzgxfm7e9ctpzj2";

/** The live grant, for the one property about it that does not move. */
const LISTENER = "growth/listener-grant.json";

function addressOf(m: Manifest, recipients: string[], tpl: CovenantTemplate): string {
  const { authority, state } = toGrant(m, recipients, tpl);
  return scriptHashToAddress(scriptHashFor(tpl, { authority, state }), "kaspatest");
}

const PAYEES = () => lines("growth/listener-payees.txt");

test("a v4 manifest resolves to v4, and derives the address its coin was actually at", () => {
  const tpl = templateFor(AT_THE_OUTAGE);
  assert.equal(templateFingerprint(tpl), "b3e5eeefacf2021f");
  assert.equal(tpl.bytecodeLen, 6912, "v4 is 6,912 bytes; v5 is 10,375");
  assert.equal(addressOf(AT_THE_OUTAGE, PAYEES(), tpl), UNDER_V4);
});

test("the same state under the current template derives the address the outage reported", () => {
  const current = loadTemplates()[0] as CovenantTemplate;
  const wrong = addressOf(AT_THE_OUTAGE, PAYEES(), current);
  /* Not skipped when current IS v4 — then the two are equal and the point is
     made trivially. What matters is that the wrong template produces an ADDRESS
     rather than an error, which is the whole shape of the failure. */
  if (templateFingerprint(current) !== "b3e5eeefacf2021f") {
    assert.equal(wrong, UNDER_V5, "v5 derives the address the failing passes named");
    assert.notEqual(wrong, UNDER_V4);
  }
  assert.match(wrong, /^kaspatest:/, "a wrong template yields a valid address, not an error");
});

test("the LIVE grant still resolves to the covenant it was issued under", () => {
  /* The live file, and deliberately no address: it advances on every spend, so
     an assertion about where it is today is an assertion about this morning. The
     covenant is fixed at genesis and is the thing that broke. */
  const m = read(LISTENER);
  assert.equal(m.covenant, "b3e5eeefacf2021f", "the live Listener grant is still v4");
  assert.equal(templateFingerprint(templateFor(m)), m.covenant);
  assert.notEqual(
    addressOf(m, PAYEES(), templateFor(m)),
    addressOf(m, PAYEES(), loadTemplates()[0] as CovenantTemplate),
    "and the current template would still derive somewhere else",
  );
});

test("Agent.open refuses a template pinned against the manifest", async () => {
  const m = read(LISTENER);
  const v5 = loadTemplates().find((t) => templateFingerprint(t) === "157b64e3eeea9c01");
  assert.ok(v5, "v5 archive is loadable");
  await assert.rejects(
    Agent.open({
      store: memoryStore(m),
      recipients: lines("growth/listener-payees.txt"),
      sign: new Uint8Array(32).fill(1),
      /* A chain is never opened: the refusal happens before any connection,
         which is the point — a wrong template must not cost a round trip to
         discover, because the round trip SUCCEEDS and answers "empty". */
      chain: {} as never,
      template: v5,
    }),
    /issued under covenant b3e5eeefacf2021f, and the template loaded is 157b64e3eeea9c01/,
  );
});

test("a manifest naming a covenant nobody holds is refused, not approximated", () => {
  assert.throws(
    () => templateFor({ covenant: "0123456789abcdef" }, "a made-up grant"),
    /no template for it is loaded here/,
  );
});

test("a manifest with no covenant field gets the current template", () => {
  const tpl = templateFor({});
  assert.equal(templateFingerprint(tpl), templateFingerprint(loadTemplates()[0] as CovenantTemplate));
});
