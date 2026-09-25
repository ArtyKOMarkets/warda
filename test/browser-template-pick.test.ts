/**
 * The page in the browser picks the same covenant the SDK would.
 *
 * `/verify` derives addresses with no node and no server — that is its whole
 * claim — so it carries its own blake2b and its own copy of the rules. Now it
 * carries its own `fingerprintOf` too, and a second implementation of a
 * definition is one that can drift.
 *
 * Drift here is invisible in the worst way. If the page computed a fingerprint
 * that disagreed with the SDK's, it would not fail: it would fail to MATCH,
 * fall through to "this page does not carry that covenant", and tell a visitor
 * their perfectly ordinary manifest belongs to something else. Or worse, in
 * the other direction, match the wrong one.
 *
 * So the two are compared against the real templates, here, rather than by
 * somebody reading both functions and agreeing they look the same.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { templateFingerprint, type CovenantTemplate } from "../sdk/src/template.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const read = (p: string) => readFileSync(here(p), "utf8");

/* The two fragments site/build.py inlines into the page, loaded the way the
   page loads them: concatenated into one scope. */
const browser = new Function(
  read("../site/src/_crypto.js") + read("../site/src/verify-core.js") +
    "; return { fingerprintOf: fingerprintOf, pickTemplate: pickTemplate };",
)() as {
  fingerprintOf: (t: CovenantTemplate) => string;
  pickTemplate: (ts: CovenantTemplate[], m: { covenant?: string }) => CovenantTemplate;
};

const TEMPLATES = ["v1", "v2", "v3", "v4", "v5"].map(
  (v) => JSON.parse(read(`../sdk/covenant-template-${v}.json`)) as CovenantTemplate,
);

test("every template fingerprints the same in the browser as in the SDK", () => {
  for (const tpl of TEMPLATES) {
    assert.equal(
      browser.fingerprintOf(tpl),
      templateFingerprint(tpl),
      `the page and the SDK disagree about a ${tpl.bytecodeLen}-byte covenant`,
    );
  }
});

test("the page picks the covenant a manifest names", () => {
  for (const tpl of TEMPLATES) {
    const fp = templateFingerprint(tpl);
    assert.equal(templateFingerprint(browser.pickTemplate(TEMPLATES, { covenant: fp })), fp);
  }
});

test("a manifest with no covenant field gets the first — the current one", () => {
  const first = TEMPLATES[0] as CovenantTemplate;
  assert.equal(
    templateFingerprint(browser.pickTemplate(TEMPLATES, {})),
    templateFingerprint(first),
  );
});

test("a covenant the page does not carry is refused, not approximated", () => {
  assert.throws(
    () => browser.pickTemplate(TEMPLATES, { covenant: "0000000000000000" }),
    /wrong answer/,
  );
});
