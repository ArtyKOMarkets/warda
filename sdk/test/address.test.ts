/**
 * Cross-implementation check: does splicing in JavaScript produce the same
 * covenant as compiling in Rust?
 *
 * If it does not, every grant address the SDK derives is wrong and funds go
 * somewhere unspendable. That is a silent, unrecoverable failure, so it gets a
 * test rather than a comment.
 *
 * This file used to hold the authority fields fixed, because the template only
 * exported the state ones. Every vector shared one principal key, so a splice
 * that ignored the principal entirely passed all of them. The vectors below
 * now vary the authority too — that is the difference between checking the
 * splice and checking the part of the splice you happened to write.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { bytecodeFor, scriptHashFor, templateIdFor, type CovenantTemplate, type Grant } from "../src/template.ts";

const tpl: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

function grantFrom(v: CovenantTemplate["addressVectors"][number]): Grant {
  return {
    authority: {
      principalKey: v.authority.principalKey,
      revocationKey: v.authority.revocationKey,
    },
    state: {
      agentKey: v.state.agentKey,
      budgetTotal: BigInt(v.state.budgetTotal),
      maxPerSpend: BigInt(v.state.maxPerSpend),
      epochLimit: BigInt(v.state.epochLimit),
      epochLength: BigInt(v.state.epochLength),
      recipientsRoot: v.state.recipientsRoot,
      notBefore: BigInt(v.state.notBefore),
      expiresAt: BigInt(v.state.expiresAt),
      delegationDepth: BigInt(v.state.delegationDepth),
      templateId: v.state.templateId,
      spentTotal: BigInt(v.state.spentTotal),
      reserved: BigInt(v.state.reserved),
      epochIndex: BigInt(v.state.epochIndex),
      epochSpent: BigInt(v.state.epochSpent),
      reserveRoot: v.state.reserveRoot,
    },
  };
}

test("the template maps every value a grant can vary", () => {
  const state = tpl.fields.filter((f) => f.group === "state");
  const authority = tpl.fields.filter((f) => f.group === "authority");
  assert.equal(state.length, 15, "all fifteen state fields must be mapped");
  assert.deepEqual(
    authority.map((f) => f.name).sort(),
    ["principalKey", "revocationKey"],
    "the keys that govern the grant must be spliceable, or the SDK can only address one principal",
  );

  for (const f of state) {
    for (const offset of f.offsets) {
      assert.ok(
        offset >= tpl.stateStart && offset + f.width <= tpl.stateStart + tpl.stateLen,
        `${f.name} at ${offset} falls outside the declared state slice`,
      );
    }
  }
});

test("a value embedded more than once is mapped at every occurrence", () => {
  // principalKey is checked by both the revoke and reclaim entrypoints.
  // Splicing only the first occurrence leaves a covenant that answers to two
  // different principals — the old one still holds the reclaim right.
  const principal = tpl.fields.find((f) => f.name === "principalKey")!;
  assert.ok(
    principal.offsets.length > 1,
    "principalKey is embedded more than once; a single offset would leave stale copies",
  );
});

test("spliced bytecode matches Rust for every vector", () => {
  for (const v of tpl.addressVectors) {
    assert.equal(scriptHashFor(tpl, grantFrom(v)), v.scriptHash, `${v.label}: JS splice disagrees with Rust compile`);
  }
});

test("the vectors actually vary the authority", () => {
  // Without this the suite could pass while ignoring authority entirely, which
  // is exactly how the gap survived the first time.
  const principals = new Set(tpl.addressVectors.map((v) => v.authority.principalKey));
  const revocations = new Set(tpl.addressVectors.map((v) => v.authority.revocationKey));
  assert.ok(principals.size > 1, "no vector varies the principal key");
  assert.ok(revocations.size > 1, "no vector varies the revocation key");
});

test("changing one field changes the script hash", () => {
  // Guards against a splice that silently no-ops — which would make every
  // grant share one address and every test above pass for the wrong reason.
  const base = grantFrom(tpl.addressVectors[0]!);
  for (const mutate of [
    (g: Grant): Grant => ({ ...g, state: { ...g.state, spentTotal: g.state.spentTotal + 1n } }),
    (g: Grant): Grant => ({ ...g, authority: { ...g.authority, principalKey: "ff".repeat(32) } }),
    (g: Grant): Grant => ({ ...g, authority: { ...g.authority, revocationKey: "ee".repeat(32) } }),
  ]) {
    assert.notEqual(scriptHashFor(tpl, base), scriptHashFor(tpl, mutate(base)));
  }
});

test("a wrongly sized field is rejected, not silently truncated", () => {
  const base = grantFrom(tpl.addressVectors[0]!);
  assert.throws(
    () => bytecodeFor(tpl, { ...base, state: { ...base.state, agentKey: "aabb" } }),
    /expected 32 bytes/,
  );
  assert.throws(
    () => bytecodeFor(tpl, { ...base, authority: { ...base.authority, principalKey: "aabb" } }),
    /expected 32 bytes/,
  );
});

test("the baked parameters are recorded, so a mismatched template is detectable", () => {
  // maxProofDepth and maxFee are not spliceable — they change the bytecode's
  // length. A caller holding the wrong template gets wrong addresses with no
  // error, so the template has to say which one it is.
  assert.equal(typeof tpl.baked.maxProofDepth, "number");
  assert.equal(typeof tpl.baked.maxFee, "number");
  assert.ok(tpl.baked.maxProofDepth > 0);
});

test("every vector's templateId is the one this SDK derives from its authority", () => {
  // The vectors carry templateId as DATA, and the splice tests above read it
  // rather than deriving it. That is the right call for a splice test — it
  // checks the SDK against the compiler — but it means a templateId that is
  // not the covenant's true template hash would sit in every vector and pass
  // everything, which is exactly what happened: the Rust side derived the id
  // from the principal alone, while both keys are compiled into the suffix the
  // hash covers. Eight vectors, all wrong, all green.
  //
  // So derive it here and require agreement. This is the only test that would
  // have failed, and the only one that will fail if the two derivations drift
  // apart again.
  for (const v of tpl.addressVectors) {
    assert.equal(
      templateIdFor(tpl, v.authority),
      v.state.templateId,
      `vector ${(v as { label?: string }).label ?? "?"}: derived id disagrees with the compiled one`,
    );
  }
});

test("the template id depends on the revocation key, not just the principal", () => {
  // The property the bug violated, pinned directly. Both keys are constructor
  // constants in the SUFFIX, so both are inside the preimage; an id keyed on
  // the principal alone would make two genuinely different covenants claim the
  // same identity, and `readInputStateWithTemplate` would accept a child whose
  // revocation key is not its parent's.
  const P = "41".repeat(32);
  assert.notEqual(
    templateIdFor(tpl, { principalKey: P, revocationKey: "42".repeat(32) }),
    templateIdFor(tpl, { principalKey: P, revocationKey: P }),
  );
});
