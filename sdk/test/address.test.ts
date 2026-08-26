/**
 * Cross-implementation check: does splicing in JavaScript produce the same
 * covenant as compiling in Rust?
 *
 * If it does not, every grant address the SDK derives is wrong and funds go
 * somewhere unspendable. That is a silent, unrecoverable failure, so it gets a
 * test rather than a comment.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bytecodeFor, scriptHashFor, type CovenantTemplate, type GrantState } from "../src/template.ts";

const tpl: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

function stateFrom(v: CovenantTemplate["addressVectors"][number]): GrantState {
  const p = tpl.params;
  return {
    agentKey: String(p.agentKey),
    budgetTotal: BigInt(p.budgetTotal),
    maxPerSpend: BigInt(p.maxPerSpend),
    epochLimit: BigInt(p.epochLimit),
    epochLength: BigInt(p.epochLength),
    recipientsRoot: String(p.recipientsRoot),
    notBefore: BigInt(p.notBefore),
    expiresAt: BigInt(p.expiresAt),
    delegationDepth: BigInt(p.delegationDepth),
    spentTotal: BigInt(v.spentTotal),
    reserved: BigInt(v.reserved),
    epochIndex: BigInt(v.epochIndex),
    epochSpent: BigInt(v.epochSpent),
  };
}

test("the template describes a complete covenant", () => {
  assert.equal(tpl.fields.length, 13, "all thirteen state fields must be mapped");
  const state = tpl.fields.filter((f) => f.offset >= tpl.stateStart && f.end <= tpl.stateStart + tpl.stateLen);
  assert.equal(state.length, 13, "every field must lie inside the declared state slice");
});

test("spliced bytecode matches Rust for every vector", () => {
  for (const v of tpl.addressVectors) {
    const hash = scriptHashFor(tpl, stateFrom(v));
    assert.equal(hash, v.scriptHash, `${v.label}: JS splice disagrees with Rust compile`);
  }
});

test("changing one field changes the script hash", () => {
  // Guards against a splice that silently no-ops — which would make every
  // grant share one address and every test above pass for the wrong reason.
  const base = stateFrom(tpl.addressVectors[0]!);
  const moved = { ...base, spentTotal: base.spentTotal + 1n };
  assert.notEqual(scriptHashFor(tpl, base), scriptHashFor(tpl, moved));
});

test("a wrongly sized field is rejected, not silently truncated", () => {
  const bad = { ...stateFrom(tpl.addressVectors[0]!), agentKey: "aabb" };
  assert.throws(() => bytecodeFor(tpl, bad), /expected 32 bytes/);
});
