/**
 * The guard that stops a tool deriving an address from the wrong covenant.
 *
 * ## Why the mismatch is worse than an error
 *
 * A grant's address is the hash of its script, so a manifest and a template
 * from two different covenants do not fail to produce an address — they
 * produce a DIFFERENT one. It is well-formed, it is on the right network, and
 * nothing has ever been paid to it. A tool that derives it reports a funded
 * grant as empty, and `topup` would send the balance there.
 *
 * This was harmless for as long as `sdk/covenant-template.json` never changed.
 * Freezing a covenant is precisely the act of changing it, so the guard exists
 * before the flip rather than after the first wrong answer.
 *
 * ## What is asserted
 *
 * The mismatch throws, the match does not, and a manifest with no `covenant`
 * field passes — that last one is a deliberate hole, not an oversight:
 * manifests predate the field and refusing them would fail closed against
 * files nobody can go back and edit.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertTemplateForManifest,
  templateFingerprint,
  type CovenantTemplate,
} from "../sdk/src/template.ts";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const template: CovenantTemplate = JSON.parse(
  readFileSync(here("../sdk/covenant-template.json"), "utf8"),
);
const other: CovenantTemplate = JSON.parse(
  readFileSync(here("../sdk/covenant-template-v3.json"), "utf8"),
);

test("the two templates really are different covenants", () => {
  // Without this the three tests below could all pass against one file.
  assert.notEqual(templateFingerprint(template), templateFingerprint(other));
});

test("a manifest from another covenant is refused", () => {
  const m = { covenant: templateFingerprint(other) };
  assert.throws(
    () => assertTemplateForManifest(template, m, "grant.json"),
    (e: Error) => {
      assert.match(e.message, /grant\.json/);
      assert.match(e.message, new RegExp(m.covenant));
      assert.match(e.message, new RegExp(templateFingerprint(template)));
      // It has to say what to do about it, or it is a puzzle rather than an
      // error: the archived template is nameable and versions.json names it.
      assert.match(e.message, /--template/);
      assert.match(e.message, /versions\.json/);
      return true;
    },
  );
});

test("a manifest from this covenant is accepted", () => {
  assertTemplateForManifest(template, { covenant: templateFingerprint(template) });
});

test("a manifest with no covenant field is accepted, deliberately", () => {
  assertTemplateForManifest(template, {});
});
