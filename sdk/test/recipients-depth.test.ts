/**
 * The check that stands between a marketplace allowlist and an unspendable
 * grant.
 *
 * `maxProofDepth` is unrolled into the bytecode rather than spliced into it, so
 * it is a property of the TEMPLATE and no grant built on that template can
 * exceed it. A set that does exceed it fails nowhere visible: the root hashes,
 * the address derives, the funding lands. It fails on every spend afterwards.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RecipientSet, assertRecipientsFitTemplate } from "../src/index.ts";

const key = (n: number) => new Uint8Array(32).fill(n);
const template = (maxProofDepth: number) => ({ baked: { maxProofDepth } });

function setOf(n: number): RecipientSet {
  return new RecipientSet(Array.from({ length: n }, (_, i) => key(i + 1)));
}

test("the deployed template's four unrolls carry sixteen payees", () => {
  assert.equal(setOf(16).depth, 4);
  assert.doesNotThrow(() => assertRecipientsFitTemplate(template(4), setOf(16)));
});

test("seventeen payees need a fifth step, and are refused", () => {
  assert.equal(setOf(17).depth, 5);
  assert.throws(
    () => assertRecipientsFitTemplate(template(4), setOf(17)),
    /at most 16/,
  );
});

test("the refusal says what happens if it is ignored", () => {
  assert.throws(
    () => assertRecipientsFitTemplate(template(4), setOf(64)),
    (e: unknown) => /unspendable to every payee|fund normally/.test((e as Error).message),
  );
});

test("one payee needs no proof at all", () => {
  assert.equal(setOf(1).depth, 0);
  assert.doesNotThrow(() => assertRecipientsFitTemplate(template(0), setOf(1)));
});

test("a deeper template carries more", () => {
  assert.doesNotThrow(() => assertRecipientsFitTemplate(template(16), setOf(64)));
});
