/**
 * Does JavaScript's schnorr agree with the Rust signer the network accepted?
 *
 * Signatures are nondeterministic, so this cannot be a byte comparison. What
 * it can be — and what actually matters — is: the reference's signature must
 * VERIFY against the digest this SDK computes, under the key the vector names.
 * That closes the loop the golden test leaves open, since it proves the digest
 * is the one the accepted transaction was signed over rather than merely a
 * digest both implementations happen to agree on.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import { agentPublicKey, signDigest, signSpend, verifyDigest } from "../src/sign.ts";
import { buildUnsignedSpend, type SpendPlan } from "../src/spend.ts";
import { transactionId } from "../src/tx.ts";
import type { CovenantTemplate, GrantState } from "../src/template.ts";

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

const SECRET = fromHex(golden.key.secretHex);

test("the key in the vector derives the public key the vector names", () => {
  assert.equal(toHex(agentPublicKey(SECRET)), golden.key.xonlyPublicHex);
});

test("the reference signature verifies against the digest THIS SDK computed", () => {
  // The strongest single assertion in the suite: Rust signed a digest, the
  // network accepted the result, and that same signature checks out against a
  // digest JavaScript derived independently.
  const built = buildUnsignedSpend(planFromGolden());
  assert.ok(
    verifyDigest(fromHex(golden.signatureHex), built.sighash, fromHex(golden.key.xonlyPublicHex)),
    "the reference signature does not verify against our digest",
  );
});

test("a signature this SDK produces verifies too", () => {
  const built = buildUnsignedSpend(planFromGolden());
  const sig = signDigest(built.sighash, SECRET);
  assert.equal(sig.length, 65, "64 bytes of signature plus one sighash-type byte");
  assert.equal(sig[64], 0x01, "SIGHASH_ALL");
  assert.ok(verifyDigest(sig, built.sighash, agentPublicKey(SECRET)));
});

test("the sighash-type byte is checked, not decoration", () => {
  const built = buildUnsignedSpend(planFromGolden());
  const sig = signDigest(built.sighash, SECRET);

  const wrongType = Uint8Array.from(sig);
  wrongType[64] = 0x02;
  assert.equal(verifyDigest(wrongType, built.sighash, agentPublicKey(SECRET)), false);

  assert.equal(verifyDigest(sig.subarray(0, 64), built.sighash, agentPublicKey(SECRET)), false);
});

test("signing the wrong digest fails to verify", () => {
  const built = buildUnsignedSpend(planFromGolden());
  const other = Uint8Array.from(built.sighash);
  other[0] ^= 0xff;
  const sig = signDigest(other, SECRET);
  assert.equal(verifyDigest(sig, built.sighash, agentPublicKey(SECRET)), false);
});

test("signSpend produces the reference transaction, up to the nonce", () => {
  const plan = planFromGolden();
  const signed = signSpend(plan, SECRET);

  // Same id, same length, same everything but the 64 signature bytes.
  assert.equal(toHex(transactionId(signed.tx)), golden.transaction.txid);
  assert.equal(
    signed.tx.inputs[0]!.signatureScript.length,
    fromHex(golden.signedSignatureScriptHex).length,
  );

  const ours = toHex(signed.tx.inputs[0]!.signatureScript);
  const theirs = golden.signedSignatureScriptHex as string;
  let differing = 0;
  for (let i = 0; i < ours.length; i += 2) if (ours.slice(i, i + 2) !== theirs.slice(i, i + 2)) differing++;
  assert.ok(
    differing > 0 && differing <= 64,
    `expected the two to differ only inside the 64 signature bytes, got ${differing} differing bytes`,
  );
});

test("signSpend refuses a key that is not the agent's", () => {
  const plan = planFromGolden();
  const wrong = Uint8Array.from(SECRET);
  wrong[0] ^= 0xff;
  // The signature is valid; it just is not the agent's. The covenant would
  // reject it on chain — this catches it before the transaction is broadcast.
  const signed = signSpend(plan, wrong);
  assert.equal(
    verifyDigest(signed.signature, signed.unsigned.sighash, fromHex(golden.key.xonlyPublicHex)),
    false,
  );
});
