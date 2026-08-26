import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import { dispatchTag, buildUnsignedSpend, attachSignature, successorState, spendSignatureScript, type SpendPlan } from "../src/spend.ts";
import { sighash, transactionId } from "../src/tx.ts";
import { serializeI64, ScriptBuilder } from "../src/script.ts";
import type { CovenantTemplate, GrantState } from "../src/template.ts";

/**
 * The golden vector.
 *
 * These bytes were produced by the same Rust construction path that built the
 * spend testnet-10 accepted. Matching them is not "agreeing with another
 * implementation of the same guess" — it is agreeing with something the
 * network has already validated.
 *
 * What is compared, and what deliberately is not:
 *
 *   compared   the unsigned signature script (every argument, serialized) and
 *              the sighash (the digest, which commits to the covenant
 *              bindings on the outputs). Get those right and a signature over
 *              that digest is correct by construction.
 *
 *   not        the signature bytes themselves. Schnorr signing draws a random
 *              nonce, so two CORRECT implementations disagree here. Asserting
 *              on them would be a test that fails for the wrong reason.
 */

const golden = JSON.parse(readFileSync(new URL("../golden-spend.json", import.meta.url), "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

function planFromGolden(): SpendPlan {
  const p = golden.params;
  const state: GrantState = {
    agentKey: p.agentKey,
    budgetTotal: BigInt(p.budgetTotal),
    maxPerSpend: BigInt(p.maxPerSpend),
    epochLimit: BigInt(p.epochLimit),
    epochLength: BigInt(p.epochLength),
    recipientsRoot: p.recipientsRoot,
    notBefore: BigInt(p.notBefore),
    expiresAt: BigInt(p.expiresAt),
    delegationDepth: BigInt(p.delegationDepth),
    spentTotal: BigInt(p.prevState.spentTotal),
    reserved: BigInt(p.prevState.reserved),
    epochIndex: BigInt(p.prevState.epochIndex),
    epochSpent: BigInt(p.prevState.epochSpent),
  };

  return {
    template,
    authority: { principalKey: p.principalKey, revocationKey: p.revocationKey },
    state,
    utxo: {
      outpointTransactionId: fromHex(golden.utxo.outpointTransactionId),
      outpointIndex: golden.utxo.outpointIndex,
      value: BigInt(golden.utxo.value),
      blockDaaScore: BigInt(golden.utxo.blockDaaScore),
      isCoinbase: golden.utxo.isCoinbase,
      covenantId: fromHex(golden.utxo.covenantId),
    },
    amount: BigInt(golden.spend.amount),
    recipient: fromHex(golden.recipients.target),
    proof: {
      siblings: golden.recipients.proof.siblings.map((s: string) => fromHex(s)),
      left: golden.recipients.proof.left,
    },
    claimedDaa: BigInt(golden.spend.claimedDaa),
    fee: BigInt(golden.spend.fee),
    computeBudget: golden.spend.computeBudget,
  };
}

test("the ABI this SDK hardcodes is the ABI the compiler emitted", () => {
  assert.equal(golden.abi.entrypoint, "__covenant_entrypoint_auth_spend");
  assert.deepEqual(
    golden.abi.inputs.map((i: { typeName: string }) => i.typeName),
    ["State", "int", "byte[32]", "byte[32][]", "bool[]", "int", "sig"],
    "argument types changed; the dispatch tag and the sigscript layout both move with them",
  );
});

test("the dispatch tag is derivable, not copied", () => {
  // If this only ever read golden.abi.dispatchTag, the SDK would need the
  // vector at runtime. Deriving it means an application ships without it.
  const derived = dispatchTag(
    golden.abi.entrypoint,
    golden.abi.inputs.map((i: { typeName: string }) => i.typeName),
  );
  assert.equal(toHex(derived), golden.abi.dispatchTag);
});

test("the grant address is the one the compiler produced", () => {
  const plan = planFromGolden();
  const built = buildUnsignedSpend(plan);
  assert.equal(
    toHex(built.entry.scriptPublicKey.script),
    golden.grant.scriptPublicKeyHex,
    "the input's script does not match the state it claims to carry",
  );
});

test("the successor lands at a DIFFERENT address, the one the state implies", () => {
  const plan = planFromGolden();
  const built = buildUnsignedSpend(plan);
  const successorSpk = toHex(built.tx.outputs[0]!.scriptPublicKey.script);

  assert.equal(successorSpk, golden.successor.scriptPublicKeyHex);
  assert.notEqual(
    successorSpk,
    golden.grant.scriptPublicKeyHex,
    "sending the continuation back to the input's own address makes it unspendable",
  );
});

test("the successor state matches what the covenant will compute", () => {
  const plan = planFromGolden();
  const next = successorState(plan.state, plan.amount, plan.claimedDaa);
  assert.equal(next.spentTotal, BigInt(golden.params.nextState.spentTotal));
  assert.equal(next.reserved, BigInt(golden.params.nextState.reserved));
  assert.equal(next.epochIndex, BigInt(golden.params.nextState.epochIndex));
  assert.equal(next.epochSpent, BigInt(golden.params.nextState.epochSpent));
});

test("the unsigned signature script is byte-for-byte the reference", () => {
  const plan = planFromGolden();
  const built = buildUnsignedSpend(plan);
  const actual = toHex(built.tx.inputs[0]!.signatureScript);

  if (actual !== golden.unsignedSignatureScriptHex) {
    // A 3,325-byte diff is unreadable; say WHERE it first diverges instead.
    const expected = golden.unsignedSignatureScriptHex as string;
    let i = 0;
    while (i < Math.min(actual.length, expected.length) && actual[i] === expected[i]) i++;
    assert.fail(
      `sigscript diverges at byte ${Math.floor(i / 2)} of ${expected.length / 2}\n` +
        `  expected …${expected.slice(Math.max(0, i - 16), i + 32)}\n` +
        `  actual   …${actual.slice(Math.max(0, i - 16), i + 32)}`,
    );
  }
});

test("the sighash is the digest the reference signed", () => {
  const plan = planFromGolden();
  const built = buildUnsignedSpend(plan);
  assert.equal(
    toHex(built.sighash),
    golden.sighashHex,
    "a wrong digest yields a signature the engine refuses, and the failure looks like a covenant bug",
  );
});

test("the covenant binding is load-bearing in the digest", () => {
  // Not a copy of the harness's on-chain test — this one proves the JS
  // sighash actually reads the binding, so an implementation that dropped the
  // field could not pass the previous test by coincidence.
  const plan = planFromGolden();
  const built = buildUnsignedSpend(plan);

  const stripped = { ...built.tx, outputs: [{ ...built.tx.outputs[0]!, covenant: undefined }, built.tx.outputs[1]!] };
  assert.notEqual(
    toHex(sighash(stripped, 0, built.entry)),
    golden.sighashHex,
    "dropping the covenant binding did not change the digest — it is not being hashed",
  );
});

test("the txid matches, and is known before signing", () => {
  const plan = planFromGolden();
  const built = buildUnsignedSpend(plan);
  const beforeSigning = toHex(transactionId(built.tx));

  assert.equal(beforeSigning, golden.transaction.txid);

  // The reference's own signature, spliced in, must not move the id.
  const signed = attachSignature(plan, built, fromHex(golden.signatureHex));
  assert.equal(toHex(transactionId(signed)), beforeSigning);
});

test("splicing a real signature changes only the signature", () => {
  const plan = planFromGolden();
  const signed = toHex(spendSignatureScript(plan, fromHex(golden.signatureHex)));
  assert.equal(signed, golden.signedSignatureScriptHex);
  assert.equal(signed.length, (golden.unsignedSignatureScriptHex as string).length);
});

test("outputs match in value and script", () => {
  const plan = planFromGolden();
  const built = buildUnsignedSpend(plan);
  assert.equal(built.tx.outputs.length, golden.transaction.outputs.length);
  for (const [i, expected] of golden.transaction.outputs.entries()) {
    const actual = built.tx.outputs[i]!;
    assert.equal(actual.value, BigInt(expected.value), `output ${i} value`);
    assert.equal(actual.scriptPublicKey.version, expected.scriptPublicKeyVersion, `output ${i} spk version`);
    assert.equal(toHex(actual.scriptPublicKey.script), expected.scriptPublicKeyHex, `output ${i} spk`);
    if (expected.covenant === null) {
      assert.equal(actual.covenant, undefined, `output ${i} should carry no covenant binding`);
    } else {
      assert.equal(actual.covenant!.authorizingInput, expected.covenant.authorizingInput);
      assert.equal(toHex(actual.covenant!.covenantId), expected.covenant.covenantId);
    }
  }
});

// ---- the encodings underneath, tested where failures are readable ---------

test("script numbers use sign-magnitude little-endian, and zero is empty", () => {
  const cases: [bigint, string][] = [
    [0n, ""],
    [1n, "01"],
    [127n, "7f"],
    // 128 needs a padding byte: 0x80 alone would read as negative zero.
    [128n, "8000"],
    [255n, "ff00"],
    [256n, "0001"],
    [-1n, "81"],
    [-128n, "8080"],
    [1_000_000n, "40420f"],
  ];
  for (const [value, expected] of cases) {
    assert.equal(toHex(serializeI64(value)), expected, `serializeI64(${value})`);
  }
});

test("small integers fold into opcodes, and larger pushes do not", () => {
  const small = new ScriptBuilder().addI64(5n).drain();
  assert.equal(toHex(small), "55", "5 should become OP_5, not a data push");

  const negativeOne = new ScriptBuilder().addI64(-1n).drain();
  assert.equal(toHex(negativeOne), "4f", "-1 should become OP_1NEGATE");

  const zero = new ScriptBuilder().addI64(0n).drain();
  assert.equal(toHex(zero), "00", "0 should become OP_0, not a push of an empty string");

  // The same folding applies to addData: a single byte in 1..16 is NOT a push.
  const folded = new ScriptBuilder().addData(Uint8Array.of(3)).drain();
  assert.equal(toHex(folded), "53", "a one-byte payload of 3 is OP_3");

  const notFolded = new ScriptBuilder().addData(Uint8Array.of(17)).drain();
  assert.equal(toHex(notFolded), "0111", "17 is outside the small-integer range");
});

test("pushes pick the smallest canonical opcode", () => {
  const b = (n: number) => toHex(new ScriptBuilder().addData(new Uint8Array(n).fill(0xaa)).drain()).slice(0, 6);
  assert.equal(b(75).slice(0, 2), "4b", "75 bytes still fits a direct OpData push");
  assert.equal(b(76).slice(0, 4), "4c4c", "76 bytes needs OP_PUSHDATA1");
  assert.equal(b(256).slice(0, 6), "4d0001", "256 bytes needs OP_PUSHDATA2, length little-endian");
});
