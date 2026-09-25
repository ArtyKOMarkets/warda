import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { templateForGolden } from "./_golden.ts";
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

/**
 * The SDK still reproduces the SUPERSEDED covenant, byte for byte.
 *
 * `golden-spend.json` is regenerated whenever the covenant moves, and it now
 * holds v5. That is right — the cross-implementation check should cover what
 * is current — and it silently retires the evidence for what is not.
 *
 * v4 is not retired. Eighteen grants are still inside their window and are
 * spendable only through v4's template, so "this SDK builds a v4 spend the
 * Rust compiler agrees with" is a claim somebody may need to rely on for
 * another two hundred days. Losing it is the cost of a regeneration nobody
 * would think twice about, which is exactly the kind of loss that is noticed
 * far too late.
 *
 * So the archived vector is kept and checked, with the four assertions that
 * are claims about bytes rather than about the covenant being current.
 * `_golden.ts` loads v4's template because the vector says v4.
 */
const golden = JSON.parse(readFileSync(new URL("../golden-spend-v4.json", import.meta.url), "utf8"));
/* The template golden was compiled from, not whichever is current.
   See test/_golden.ts: the two were the same file until a covenant
   was frozen, and this comparison is the one that would have broken. */
const template: CovenantTemplate = templateForGolden(golden);

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
    templateId: p.templateId,
    spentTotal: BigInt(p.prevState.spentTotal),
    reserved: BigInt(p.prevState.reserved),
    epochIndex: BigInt(p.prevState.epochIndex),
    epochSpent: BigInt(p.prevState.epochSpent),
    reserveRoot: p.reserveRoot,
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

test("the grant address is the one the compiler produced", () => {
  const plan = planFromGolden();
  const built = buildUnsignedSpend(plan);
  assert.equal(
    toHex(built.entry.scriptPublicKey.script),
    golden.grant.scriptPublicKeyHex,
    "the input's script does not match the state it claims to carry",
  );
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

test("the txid matches, and is known before signing", () => {
  const plan = planFromGolden();
  const built = buildUnsignedSpend(plan);
  const beforeSigning = toHex(transactionId(built.tx));

  assert.equal(beforeSigning, golden.transaction.txid);

  // The reference's own signature, spliced in, must not move the id.
  const signed = attachSignature(plan, built, fromHex(golden.signatureHex));
  assert.equal(toHex(transactionId(signed)), beforeSigning);
});

