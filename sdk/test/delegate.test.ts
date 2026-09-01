/**
 * Delegation: the half that makes a grant more than a spending cap.
 *
 * The encoding here is where a second implementation goes wrong, and it goes
 * wrong quietly. `delegate` takes `State[]`, and the compiler TRANSPOSES a
 * struct array: one push per FIELD holding that field's value across every
 * element. So `State[2]` is thirteen pushes, not two.
 *
 * Lay the two states out one after the other instead — the obvious reading —
 * and you get a sigscript of exactly the same length with every value in the
 * wrong place. No parser complains. The engine just refuses it, and the
 * refusal looks like a covenant bug.
 *
 * That is what a golden vector is for.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import {
  attachDelegationSignature,
  buildUnsignedDelegation,
  childStateFrom,
  delegateSignatureScript,
  parentSuccessorState,
  subsetWitness,
  pushChild,
  type DelegationPlan,
} from "../src/delegate.ts";
import { RecipientSet } from "../src/recipients.ts";
import { ScriptBuilder } from "../src/script.ts";
import { dispatchTag } from "../src/spend.ts";
import { pushState, pushStateArray } from "../src/state.ts";
import { signDigest, verifyDigest } from "../src/sign.ts";
import { transactionId } from "../src/tx.ts";
import type { CovenantTemplate, GrantState } from "../src/template.ts";

const golden = JSON.parse(readFileSync(new URL("../golden-delegation.json", import.meta.url), "utf8"));
// The member LIST lives in the spend vector; the delegation vector records only
// the root. Both commit to the same set — asserted below, so a divergence
// shows up here rather than as an unprovable witness.
const spendGolden = JSON.parse(readFileSync(new URL("../golden-spend.json", import.meta.url), "utf8"));
const recipientSet = new RecipientSet(spendGolden.recipients.members.map((m: string) => fromHex(m)));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

function parentState(): GrantState {
  const p = golden.params;
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
    spentTotal: BigInt(p.prevState.spentTotal),
    reserved: BigInt(p.prevState.reserved),
    epochIndex: BigInt(p.prevState.epochIndex),
    epochSpent: BigInt(p.prevState.epochSpent),
    reserveRoot: p.reserveRoot,
  };
}

function planFromGolden(): DelegationPlan {
  return {
    template,
    authority: { principalKey: golden.params.principalKey, revocationKey: golden.params.revocationKey },
    state: parentState(),
    utxo: {
      outpointTransactionId: fromHex(golden.utxo.outpointTransactionId),
      outpointIndex: golden.utxo.outpointIndex,
      value: BigInt(golden.utxo.value),
      blockDaaScore: BigInt(golden.utxo.blockDaaScore),
      isCoinbase: golden.utxo.isCoinbase,
      covenantId: fromHex(golden.utxo.covenantId),
    },
    child: {
      agentKey: golden.child.agentKey,
      budgetTotal: BigInt(golden.child.budgetTotal),
      maxPerSpend: BigInt(golden.child.maxPerSpend),
      epochLimit: BigInt(golden.child.epochLimit),
      delegationDepth: BigInt(golden.child.delegationDepth),
    },
    fee: BigInt(golden.spend.fee),
    computeBudget: golden.spend.computeBudget,
  };
}

const SECRET = fromHex(golden.key.secretHex);

test("the ABI this SDK hardcodes is the ABI the compiler emitted", () => {
  assert.equal(golden.abi.entrypoint, "__covenant_entrypoint_auth_delegate");
  assert.deepEqual(
    golden.abi.inputs.map((i: { typeName: string }) => i.typeName),
    // v4 added the subset witness, which is how a delegation narrows WHO the
    // child may pay. Two array arguments, between the states and the
    // signature; both empty when the child inherits the whole allowlist.
    ["State[]", "byte[32][]", "bool[]", "sig"],
    "argument types changed; the dispatch tag and the sigscript layout move with them",
  );
  assert.equal(
    toHex(dispatchTag(golden.abi.entrypoint, ["State[]", "byte[32][]", "bool[]", "sig"])),
    golden.abi.dispatchTag,
  );
});

test("the signature script is byte-for-byte the reference", () => {
  const plan = planFromGolden();
  const actual = toHex(buildUnsignedDelegation(plan).tx.inputs[0]!.signatureScript);
  const expected = golden.unsignedSignatureScriptHex as string;

  if (actual !== expected) {
    let i = 0;
    while (i < Math.min(actual.length, expected.length) && actual[i] === expected[i]) i++;
    assert.fail(
      `delegation sigscript diverges at byte ${Math.floor(i / 2)} of ${expected.length / 2}\n` +
        `  expected …${expected.slice(Math.max(0, i - 16), i + 32)}\n` +
        `  actual   …${actual.slice(Math.max(0, i - 16), i + 32)}`,
    );
  }
});

test("a State[] is TRANSPOSED, not concatenated", () => {
  // The failure this guards against is invisible: concatenating the two states
  // produces the same byte COUNT with every value in the wrong slot. So the
  // test asserts the two layouts differ, and that ours is the reference's.
  const plan = planFromGolden();
  const child = childStateFrom(plan.state, plan.child);
  const parentNext = parentSuccessorState(plan.state, child);

  const transposed = new ScriptBuilder();
  pushStateArray(transposed, [parentNext, child]);

  // The naive reading: each state flattened in turn, as a scalar argument.
  const concatenated = new ScriptBuilder();
  pushState(concatenated, parentNext);
  pushState(concatenated, child);

  const a = toHex(transposed.drain());
  const b = toHex(concatenated.drain());
  assert.notEqual(a, b, "if these matched, the test could not tell the layouts apart");
  assert.ok(golden.unsignedSignatureScriptHex.startsWith(a), "the reference uses the transposed layout");
  assert.ok(!golden.unsignedSignatureScriptHex.startsWith(b), "the reference is not concatenated");
});

test("integers are fixed-width inside an array, minimal outside one", () => {
  // Two encodings for the same value, and crossing them is the whole hazard.
  // A scalar 0 is OP_0, one byte. Inside an array it is eight zero bytes,
  // because every element must be the same width.
  const zeroish: GrantState = { ...parentState(), spentTotal: 0n, reserved: 0n };

  const scalar = new ScriptBuilder();
  pushState(scalar, zeroish);
  const asScalar = toHex(scalar.drain());
  assert.ok(asScalar.includes("00"), "a scalar zero folds to OP_0");

  const array = new ScriptBuilder();
  pushStateArray(array, [zeroish]);
  const asArray = toHex(array.drain());
  assert.ok(asArray.includes("08" + "00".repeat(8)), "an array element pushes a full 8-byte zero");
  assert.notEqual(asScalar, asArray);
});

test("the parent reserves exactly what the child receives", () => {
  const plan = planFromGolden();
  const built = buildUnsignedDelegation(plan);

  assert.equal(
    built.parentSuccessorState.reserved,
    plan.state.reserved + plan.child.budgetTotal,
    "reserve must grow by the child's budget",
  );
  assert.equal(
    built.tx.outputs[1]!.value,
    plan.child.budgetTotal,
    "coins must follow authority exactly — not a sompi more or less",
  );
  assert.equal(BigInt(golden.conservation.parentReservedAfter), built.parentSuccessorState.reserved);
});

test("the parent moves ONLY its reserve and its reserve stack", () => {
  // The covenant checks every other field for equality. A successor that
  // quietly raised its own cap while delegating would be refused, and this
  // catches it here rather than on chain.
  const plan = planFromGolden();
  const before = plan.state;
  const child = childStateFrom(before, plan.child);
  const after = parentSuccessorState(before, child);

  const moves = new Set(["reserved", "reserveRoot"]);
  for (const [key, value] of Object.entries(before)) {
    if (moves.has(key)) continue;
    assert.equal((after as unknown as Record<string, unknown>)[key], value, `${key} must not move`);
  }

  // Both of the two that may move MUST move. Reserve accounting alone was the
  // v3 behaviour, and it is what let a parent release a reserve without
  // naming which child it was releasing.
  assert.equal(after.reserved, before.reserved + child.budgetTotal);
  assert.notEqual(after.reserveRoot, before.reserveRoot, "the child must be pushed onto the stack");
  assert.equal(after.reserveRoot, pushChild(before.reserveRoot, child));
});

test("the child starts spent-out-of-nothing and inherits what it does not narrow", () => {
  const plan = planFromGolden();
  const child = childStateFrom(plan.state, plan.child);

  assert.equal(child.spentTotal, 0n);
  assert.equal(child.reserved, 0n);
  assert.equal(child.epochIndex, 0n);
  assert.equal(child.epochSpent, 0n);

  // Inherited, not invented — a field forgotten in the narrowing is one the
  // child SHARES with its parent.
  assert.equal(child.recipientsRoot, plan.state.recipientsRoot);
  assert.equal(child.epochLength, plan.state.epochLength);
  assert.equal(child.notBefore, plan.state.notBefore);
  assert.equal(child.expiresAt, plan.state.expiresAt);
});

test("all three addresses are the ones the compiler produced", () => {
  const plan = planFromGolden();
  const built = buildUnsignedDelegation(plan);

  assert.equal(toHex(built.entry.scriptPublicKey.script), golden.parent.scriptPublicKeyHex);
  assert.equal(
    toHex(built.parentSuccessorScriptPublicKey.script),
    golden.parentSuccessor.scriptPublicKeyHex,
  );
  assert.equal(toHex(built.childScriptPublicKey.script), golden.childGrant.scriptPublicKeyHex);

  // Three distinct addresses. If any two collided, one of the two grants would
  // be unreachable.
  const seen = new Set([
    golden.parent.scriptPublicKeyHex,
    golden.parentSuccessor.scriptPublicKeyHex,
    golden.childGrant.scriptPublicKeyHex,
  ]);
  assert.equal(seen.size, 3);
});

test("both outputs carry the PARENT's covenant id", () => {
  // The child is a branch of this covenant's lineage, not a new covenant that
  // resembles it. A fresh id on the child would sever it from the parent.
  const plan = planFromGolden();
  const built = buildUnsignedDelegation(plan);
  for (const [i, out] of built.tx.outputs.entries()) {
    assert.ok(out.covenant, `output ${i} must be bound`);
    assert.equal(toHex(out.covenant!.covenantId), golden.utxo.covenantId, `output ${i} covenant id`);
    assert.equal(out.covenant!.authorizingInput, 0);
  }
});

test("the digest and the transaction id are the reference's", () => {
  const plan = planFromGolden();
  const built = buildUnsignedDelegation(plan);
  assert.equal(toHex(built.sighash), golden.sighashHex);
  assert.equal(toHex(transactionId(built.tx)), golden.transaction.txid);
});

test("the reference signature verifies against the digest THIS SDK computed", () => {
  const plan = planFromGolden();
  const built = buildUnsignedDelegation(plan);
  assert.ok(
    verifyDigest(fromHex(golden.signatureHex), built.sighash, fromHex(golden.key.xonlyPublicHex)),
    "the reference signature does not verify against our digest",
  );
});

test("signing does not move the transaction id", () => {
  const plan = planFromGolden();
  const built = buildUnsignedDelegation(plan);
  const signed = attachDelegationSignature(plan, built, signDigest(built.sighash, SECRET));
  assert.equal(toHex(transactionId(signed)), golden.transaction.txid);
  assert.equal(
    toHex(delegateSignatureScript(plan, fromHex(golden.signatureHex))),
    golden.signedSignatureScriptHex,
  );
});

test("a delegation carries no lock time", () => {
  // Only a spend needs to claim a height, because only a spend consumes an
  // epoch allowance. A delegation that claimed one would be refusing itself
  // until the chain caught up, for nothing.
  const built = buildUnsignedDelegation(planFromGolden());
  assert.equal(built.tx.lockTime, 0n);
});

// ---- refusals, each naming what it prevents ------------------------------

test("a child cannot be given more than the parent has uncommitted", () => {
  const plan = planFromGolden();
  const tooBig = {
    ...plan,
    child: { ...plan.child, budgetTotal: plan.state.budgetTotal + 1n },
  };
  assert.throws(() => buildUnsignedDelegation(tooBig), /exceeds the parent's uncommitted/);
});

test("uncommitted accounts for what is already spent and reserved", () => {
  // The parent's budget is not what it can delegate. Authority already spent
  // or handed to another child is gone.
  const plan = planFromGolden();
  const busy = {
    ...plan,
    state: { ...plan.state, spentTotal: 600_000_000n, reserved: 300_000_000n },
  };
  // 1,000,000,000 less 900,000,000 leaves 100,000,000.
  assert.throws(
    () => buildUnsignedDelegation({ ...busy, child: { ...busy.child, budgetTotal: 100_000_001n } }),
    /exceeds the parent's uncommitted/,
  );
  assert.doesNotThrow(() =>
    buildUnsignedDelegation({ ...busy, child: { ...busy.child, budgetTotal: 100_000_000n } }),
  );
});

test("a child cannot widen any axis", () => {
  const plan = planFromGolden();
  const widen = (patch: Partial<DelegationPlan["child"]>, pattern: RegExp) =>
    assert.throws(() => buildUnsignedDelegation({ ...plan, child: { ...plan.child, ...patch } }), pattern);

  widen({ maxPerSpend: plan.state.maxPerSpend + 1n }, /raise the per-spend cap/);
  widen({ epochLimit: plan.state.epochLimit + 1n }, /raise the epoch limit/);
  // Equal is not enough: the depth must strictly decrease or the tree could
  // delegate forever.
  widen({ delegationDepth: plan.state.delegationDepth }, /strictly less/);
});

test("a zero-budget child is refused", () => {
  const plan = planFromGolden();
  assert.throws(
    () => buildUnsignedDelegation({ ...plan, child: { ...plan.child, budgetTotal: 0n } }),
    /positive budget/,
  );
});

test("a UTXO too small to fund the child is refused before signing", () => {
  const plan = planFromGolden();
  const thin = { ...plan, utxo: { ...plan.utxo, value: plan.child.budgetTotal } };
  assert.throws(() => buildUnsignedDelegation(thin), /not enough for a child/);
});

// ---- attenuating the validity window -------------------------------------
//
// The covenant permits six attenuation axes; the SDK exposed four. The window
// was the pair that was missing, and it is the one that matters most for a
// short-lived lane: it is the only attenuation that ends BY ITSELF, with
// nobody online to revoke anything.

test("a child's window may be narrowed from both ends", () => {
  const plan = planFromGolden();
  const open = plan.state.notBefore + 100n;
  const end = plan.state.expiresAt - 100n;
  const built = buildUnsignedDelegation({
    ...plan,
    child: { ...plan.child, notBefore: open, expiresAt: end },
  });
  assert.equal(built.childState.notBefore, open);
  assert.equal(built.childState.expiresAt, end);
  // And the parent is untouched: a delegation reserves, it does not reshape.
  assert.equal(built.parentSuccessorState.notBefore, plan.state.notBefore);
  assert.equal(built.parentSuccessorState.expiresAt, plan.state.expiresAt);
});

test("omitting the window inherits it; passing a falsy one is still the caller's word", () => {
  const plan = planFromGolden();
  const inherited = buildUnsignedDelegation(plan);
  assert.equal(inherited.childState.notBefore, plan.state.notBefore);
  assert.equal(inherited.childState.expiresAt, plan.state.expiresAt);

  // `??` rather than `||`, and the difference is observable precisely here:
  // an explicit 0n is out of range and must be REPORTED. Under `||` it would
  // be replaced by the parent's value and the call would quietly succeed,
  // swallowing the caller's mistake and building a child they did not ask for.
  assert.throws(
    () => buildUnsignedDelegation({ ...plan, child: { ...plan.child, notBefore: 0n } }),
    /cannot open before its parent/,
    "an explicit 0n must be range-checked, not treated as absent",
  );
});

test("a child cannot outlive its parent, or open before it", () => {
  // This is what stops delegation being a way to extend a grant past its own
  // term — a child that outlived its parent would still be spendable after
  // the principal had reclaimed everything reachable.
  const plan = planFromGolden();
  assert.throws(
    () => buildUnsignedDelegation({ ...plan, child: { ...plan.child, expiresAt: plan.state.expiresAt + 1n } }),
    /cannot outlive/,
  );
  assert.throws(
    () => buildUnsignedDelegation({ ...plan, child: { ...plan.child, notBefore: plan.state.notBefore - 1n } }),
    /cannot open before/,
  );
});

test("a window that opens after it ends is refused, though the covenant allows it", () => {
  // Both covenant bounds hold, so the chain would accept it — and produce a
  // grant that can never be spent from and can only be reclaimed. Cheaper to
  // refuse than to fund.
  const plan = planFromGolden();
  assert.throws(
    () =>
      buildUnsignedDelegation({
        ...plan,
        child: { ...plan.child, notBefore: plan.state.expiresAt - 1n, expiresAt: plan.state.notBefore + 1n },
      }),
    /can never spend/,
  );
});

// ---- narrowing who a child may pay ---------------------------------------

test("a child given no recipients inherits the parent's whole allowlist", () => {
  // The empty-witness case, and the behaviour every child had before v4.
  const plan = planFromGolden();
  const child = childStateFrom(plan.state, plan.child);
  assert.equal(child.recipientsRoot, plan.state.recipientsRoot);
  assert.deepEqual(subsetWitness(plan.state, plan.child).proof, { siblings: [], left: [] });
});

test("a narrowed child commits to a subtree, and carries the path to prove it", () => {
  const plan = planFromGolden();
  const set = recipientSet;
  const pair = [set.members[2]!, set.members[3]!];

  const w = subsetWitness(plan.state, { ...plan.child, recipients: pair }, set);
  assert.notEqual(w.root, plan.state.recipientsRoot, "narrowing must change the root");
  assert.ok(w.proof.siblings.length > 0, "a narrowed child needs a witness");

  // The node the child commits to is the root of a set containing exactly
  // those members — which is why the child can still prove payments to them.
  assert.equal(w.root, new RecipientSet(pair).rootHex);
});

test("a child cannot be narrowed to somebody its parent cannot pay", () => {
  // Narrowing only ever shrinks. Extending is not a thing the witness can
  // express — there is no path from a foreign leaf to the parent's root — and
  // saying so here beats a script failure.
  const plan = planFromGolden();
  const set = recipientSet;
  assert.throws(
    () => subsetWitness(plan.state, { ...plan.child, recipients: ["cc".repeat(32)] }, set),
    /not in this recipient set|never extend/,
  );
});

test("a non-contiguous selection is refused with the reason", () => {
  // A witness covers a SUBTREE, so the members must form an aligned run. This
  // is a real constraint on how a parent orders its allowlist, and it is worth
  // failing loudly rather than silently widening to a covering node.
  const plan = planFromGolden();
  const set = recipientSet;
  assert.throws(
    () => subsetWitness(plan.state, { ...plan.child, recipients: [set.members[0]!, set.members[2]!] }, set),
    /contiguous/,
  );
});

test("narrowing without the parent's set is refused, not guessed", () => {
  const plan = planFromGolden();
  const set = recipientSet;
  assert.throws(
    () => subsetWitness(plan.state, { ...plan.child, recipients: [set.members[2]!] }, undefined),
    /needs the parent's RecipientSet/,
  );
});

test("both goldens commit to the same recipient set", () => {
  // The narrowing tests take the member list from the spend vector and the
  // root from the delegation vector. If those ever diverge the witnesses
  // become unprovable, and the failure would look like a bug in the tree.
  assert.equal(recipientSet.rootHex, golden.params.recipientsRoot);
});
