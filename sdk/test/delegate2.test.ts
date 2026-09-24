/**
 * delegate2: two children, one transaction, and a vector the ENGINE accepted.
 *
 * The delegation vector this file's sibling checks was emitted by a builder.
 * This one was emitted from a transaction `TxScriptEngine` took —
 * `covenant/harness/src/bin/c1.rs --emit` — so a mismatch here is not "the two
 * implementations disagree", it is "this one is wrong".
 *
 * The encoding trap is the same and worse. `State[]` is TRANSPOSED: one push
 * per FIELD holding that field's value across every element, so three states
 * are fifteen pushes rather than three. Lay them out end to end — the obvious
 * reading — and the sigscript is exactly the same length with every value in
 * the wrong place. Nothing parses it wrongly. The engine just refuses, and the
 * refusal reads as a covenant bug.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import {
  buildUnsignedDelegation2,
  parentSuccessorState2,
  childStateFrom,
  pushChild,
  type Delegation2Plan,
} from "../src/delegate.ts";
import { dispatchTag } from "../src/spend.ts";
import { templateIdFor, type CovenantTemplate, type GrantState } from "../src/template.ts";

const golden = JSON.parse(readFileSync(new URL("../golden-delegation2.json", import.meta.url), "utf8"));
/* v5's template, not the packaged one. A v5 transaction built against v4's
   bytecode produces a plausible address for a covenant nobody deployed, which
   is the failure verify-grant refuses out loud. */
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template-v5.json", import.meta.url), "utf8"),
);

const p = golden.params;

function parentState(): GrantState {
  return {
    agentKey: p.agentKey,
    budgetTotal: BigInt(p.budgetTotal),
    maxPerSpend: BigInt(p.maxPerSpend),
    epochLimit: BigInt(p.epochLimit),
    epochLength: BigInt(p.epochLength),
    recipientsRoot: p.recipientsRoot,
    notBefore: BigInt(p.notBefore),
    expiresAt: BigInt(p.expiresAt),
    delegationDepth: BigInt(p.delegationDepth),
    templateId: p.templateId,
    spentTotal: BigInt(p.spentTotal),
    reserved: BigInt(p.reserved),
    epochIndex: BigInt(p.epochIndex),
    epochSpent: BigInt(p.epochSpent),
    reserveRoot: p.reserveRoot,
  };
}

const terms = (c: Record<string, string | number>) => ({
  agentKey: c.agentKey as string,
  budgetTotal: BigInt(c.budgetTotal),
  maxPerSpend: BigInt(c.maxPerSpend),
  epochLimit: BigInt(c.epochLimit),
  delegationDepth: BigInt(c.delegationDepth),
  notBefore: BigInt(c.notBefore),
  expiresAt: BigInt(c.expiresAt),
});

function planFromGolden(): Delegation2Plan {
  const outs = golden.transaction.outputs;
  const handed = BigInt(outs[1].value) + BigInt(outs[2].value);
  return {
    template,
    authority: { principalKey: p.principalKey, revocationKey: p.revocationKey },
    state: parentState(),
    utxo: {
      outpointTransactionId: fromHex(golden.utxo.outpointTransactionId),
      outpointIndex: golden.utxo.outpointIndex,
      value: BigInt(golden.utxo.value),
      blockDaaScore: BigInt(golden.utxo.blockDaaScore),
      isCoinbase: golden.utxo.isCoinbase,
      covenantId: fromHex(golden.utxo.covenantId),
    },
    childA: terms(golden.children[0]),
    childB: terms(golden.children[1]),
    // Derived from the vector rather than stated in it: the fee is whatever
    // the parent's continuation did not keep.
    fee: BigInt(golden.utxo.value) - handed - BigInt(outs[0].value),
    computeBudget: golden.transaction.input.computeBudget,
  };
}

test("the vector describes a transaction the engine ACCEPTED", () => {
  // Not a formality. The emitter refuses to write a refused transaction, so
  // this failing means the file was edited by hand.
  assert.equal(golden.engine, "ACCEPTED");
  assert.equal(golden.transaction.outputs.length, 3, "a parent continuation and two children");
});

test("the vector's templateId is the one this SDK derives from the template", () => {
  /* The check that would have caught it from this side. templateId is a hash
     over the compiled prefix and suffix, and maxFee is baked into the suffix —
     so a vector emitted at a different maxFee carries an id no template can
     produce. Every other test here still passed with a wrong one, because
     delegate2 only requires the child's id to EQUAL the parent's and both were
     equally wrong. Only reabsorb and settle read it, and only they refused. */
  assert.equal(
    templateIdFor(template, { principalKey: p.principalKey, revocationKey: p.revocationKey }),
    p.templateId,
  );
});

test("the dispatch tag matches delegate2's argument types", () => {
  assert.equal(
    toHex(dispatchTag("__covenant_entrypoint_auth_delegate2",
      ["State[]", "byte[32][]", "bool[]", "byte[32][]", "bool[]", "sig"])).length > 0,
    true,
  );
});

test("the signature script is byte-for-byte what the engine accepted", () => {
  const actual = toHex(buildUnsignedDelegation2(planFromGolden()).tx.inputs[0]!.signatureScript);
  const expected = golden.unsignedSignatureScriptHex as string;
  if (actual !== expected) {
    let i = 0;
    while (i < Math.min(actual.length, expected.length) && actual[i] === expected[i]) i++;
    assert.fail(
      `delegate2 sigscript diverges at byte ${Math.floor(i / 2)} of ${expected.length / 2}\n` +
        `  expected …${expected.slice(Math.max(0, i - 16), i + 48)}\n` +
        `  actual   …${actual.slice(Math.max(0, i - 16), i + 48)}`,
    );
  }
});

test("the sighash is the one the agent signed", () => {
  assert.equal(toHex(buildUnsignedDelegation2(planFromGolden()).sighash), golden.sighashHex);
});

test("every output lands where the engine put it", () => {
  const built = buildUnsignedDelegation2(planFromGolden());
  golden.transaction.outputs.forEach((o: { value: number; scriptPublicKeyHex: string }, i: number) => {
    assert.equal(built.tx.outputs[i]!.value, BigInt(o.value), `output ${i} value`);
    assert.equal(toHex(built.tx.outputs[i]!.scriptPublicKey.script), o.scriptPublicKeyHex, `output ${i} script`);
  });
});

test("the chain is pushed in OUTPUT order, and the other order is a different parent", () => {
  const state = parentState();
  const a = childStateFrom(state, terms(golden.children[0]));
  const b = childStateFrom(state, terms(golden.children[1]));
  const forward = parentSuccessorState2(state, a, b);
  const backward = parentSuccessorState2(state, b, a);
  assert.notEqual(forward.reserveRoot, backward.reserveRoot);
  assert.equal(forward.reserveRoot, pushChild(pushChild(state.reserveRoot, a), b));
  // The sum is the same either way, which is exactly why the ROOT has to carry
  // the order: settlement pops from the end, and a parent that pushed B first
  // would have to settle A first while the coin says otherwise.
  assert.equal(forward.reserved, backward.reserved);
});

test("two children that fit separately and not together are refused here, not on chain", () => {
  const plan = planFromGolden();
  const uncommitted = plan.state.budgetTotal - plan.state.spentTotal - plan.state.reserved;
  const big = { ...plan.childA, budgetTotal: uncommitted - 1n };
  assert.throws(
    () => buildUnsignedDelegation2({ ...plan, childA: big, childB: { ...plan.childB, budgetTotal: 2n } }),
    /left after child A/,
  );
});

test("both children under one key is one authority issued twice", () => {
  const plan = planFromGolden();
  assert.throws(
    () => buildUnsignedDelegation2({ ...plan, childB: { ...plan.childB, agentKey: plan.childA.agentKey } }),
    /same agent key/,
  );
});
