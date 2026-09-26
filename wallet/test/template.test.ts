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
 * The grant that went dark, and the address it never left.
 *
 * Pinned as a literal on purpose. Every other assertion in this repo about an
 * address derives both sides from the same template, which is exactly how the
 * outage passed through ten tests: a self-consistent pair moves together. A
 * constant does not move. If a future covenant freeze changes what this
 * derives, this line goes red, and it goes red for the same reason the agents
 * went quiet.
 *
 * Verified against the failing purchase logs: the six passes from 25 September
 * 17:13 to 26 September 05:13 each reported "no UTXO at
 * kaspatest:pqt9lyt0lsejrrsn26cht7nau39vqfvd2r67nttqzz2wffkzgxfm7e9ctpzj2",
 * which is what the SAME manifest derives under v5.
 */
const LISTENER = "growth/listener-grant.json";
const LISTENER_ADDRESS =
  "kaspatest:pq8y9dpyca8lcsfe9785wjgalhkhzwg56kwpvh7tlwfw5lehtwp9qq5k2vtdm";
const UNDER_V5 =
  "kaspatest:pqt9lyt0lsejrrsn26cht7nau39vqfvd2r67nttqzz2wffkzgxfm7e9ctpzj2";

function addressOf(m: Manifest, recipients: string[], tpl: CovenantTemplate): string {
  const { authority, state } = toGrant(m, recipients, tpl);
  return scriptHashToAddress(scriptHashFor(tpl, { authority, state }), "kaspatest");
}

test("a v4 manifest resolves to v4, and derives the address its coin is actually at", () => {
  const m = read(LISTENER);
  assert.equal(m.covenant, "b3e5eeefacf2021f", "fixture is the live v4 Listener grant");
  const tpl = templateFor(m);
  assert.equal(templateFingerprint(tpl), "b3e5eeefacf2021f");
  assert.equal(tpl.bytecodeLen, 6912, "v4 is 6,912 bytes; v5 is 10,375");
  assert.equal(addressOf(m, lines("growth/listener-payees.txt"), tpl), LISTENER_ADDRESS);
});

test("the same manifest under the current template derives the address the outage reported", () => {
  const m = read(LISTENER);
  const current = loadTemplates()[0] as CovenantTemplate;
  const wrong = addressOf(m, lines("growth/listener-payees.txt"), current);
  /* Not skipped when current IS v4 — then the two are equal and the point is
     made trivially. What matters is that the wrong template produces an
     ADDRESS rather than an error, which is the whole shape of the failure. */
  if (templateFingerprint(current) !== "b3e5eeefacf2021f") {
    assert.equal(wrong, UNDER_V5, "v5 derives the address the failing passes named");
    assert.notEqual(wrong, LISTENER_ADDRESS);
  }
  assert.match(wrong, /^kaspatest:/, "a wrong template yields a valid address, not an error");
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
