/**
 * The verifier answers a manifest with the covenant it names, not the current one.
 *
 * ## Why this is the freeze's last blocker
 *
 * Every address this service reports is derived from a template. It loaded one
 * — whichever was current — and that was correct for exactly as long as there
 * was one covenant with live grants under it.
 *
 * Freezing v5 ends that. The eighteen v4 grants still inside their window
 * would be answered with an address derived from bytecode they do not run:
 * well-formed, on the right network, holding nothing, reported as a grant that
 * was never funded. Not an error — a confident wrong answer, from the service
 * whose entire purpose is that nobody has to trust us.
 *
 * The property is testable TODAY, before the flip, because the archives ship
 * either way: a v5 manifest must already be answered with v5's template while
 * the current one is still v4. If that works now, the flip is a rename.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { templateFingerprint, type CovenantTemplate } from "@warda_protocol/kaspa";
import { loadTemplate, loadTemplates, templateFor } from "../src/template.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string): CovenantTemplate => JSON.parse(readFileSync(here(p), "utf8"));
const V4 = templateFingerprint(read("../../sdk/covenant-template-v4.json"));
const V5 = templateFingerprint(read("../../sdk/covenant-template-v5.json"));

test("the two covenants this has to tell apart really are different", () => {
  assert.notEqual(V4, V5);
});

test("it carries more than one covenant", () => {
  const have = loadTemplates().map(templateFingerprint);
  assert.ok(have.includes(V4), `v4 ${V4} is not loaded; have ${have.join(", ")}`);
  assert.ok(have.includes(V5), `v5 ${V5} is not loaded; have ${have.join(", ")}`);
});

test("a manifest is answered with the covenant it names", () => {
  assert.equal(templateFingerprint(templateFor({ covenant: V4 })), V4);
  assert.equal(templateFingerprint(templateFor({ covenant: V5 })), V5);
});

test("which is not simply the current template in both cases", () => {
  // Without this the two assertions above would both pass against a service
  // that ignored the manifest entirely — whichever covenant happened to be
  // current would satisfy one of them, and the other would look like luck.
  const current = templateFingerprint(loadTemplate());
  const other = current === V4 ? V5 : V4;
  assert.notEqual(templateFingerprint(templateFor({ covenant: other })), current);
});

test("a manifest with no covenant field gets the current one", () => {
  // Deliberate: manifests predate the field, and failing closed against files
  // nobody can go back and edit would take the service down for them.
  assert.equal(templateFingerprint(templateFor({})), templateFingerprint(loadTemplate()));
});

test("a covenant this deployment does not carry is refused, not approximated", () => {
  assert.throws(
    () => templateFor({ covenant: "0000000000000000" }),
    (e: Error) => {
      assert.match(e.message, /0000000000000000/);
      assert.match(e.message, /wrong answer/);
      assert.match(e.message, /versions\.json/);
      return true;
    },
  );
});
