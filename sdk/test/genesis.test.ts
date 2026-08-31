/**
 * Creating a grant, checked against the tool that creates them for real.
 *
 * The load-bearing part of genesis is the covenant id, and its failure mode is
 * quiet: a wrong id still produces a well-formed transaction, still pays into
 * a plausible address, and only reveals itself when the agent's first spend is
 * refused for reasons that look like a covenant bug. So it gets its own
 * vector and its own assertions.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import { attachGenesisSignature, buildGenesis, covenantId, type GenesisPlan } from "../src/genesis.ts";
import { agentPublicKey, signDigest, verifyDigest } from "../src/sign.ts";
import { transactionId } from "../src/tx.ts";
import type { CovenantTemplate, Grant } from "../src/template.ts";

const golden = JSON.parse(readFileSync(new URL("../golden-genesis.json", import.meta.url), "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

function grantFromGolden(): Grant {
  const p = golden.params;
  return {
    authority: { principalKey: p.principalKey, revocationKey: p.revocationKey },
    state: {
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
      spentTotal: BigInt(p.initialState.spentTotal),
      reserved: BigInt(p.initialState.reserved),
      epochIndex: BigInt(p.initialState.epochIndex),
      epochSpent: BigInt(p.initialState.epochSpent),
      reserveRoot: p.reserveRoot,
    },
  };
}

function planFromGolden(): GenesisPlan {
  return {
    template,
    grant: grantFromGolden(),
    funding: {
      outpointTransactionId: fromHex(golden.funding.outpointTransactionId),
      outpointIndex: golden.funding.outpointIndex,
      value: BigInt(golden.funding.value),
      scriptPublicKey: {
        version: golden.funding.scriptPublicKeyVersion,
        script: fromHex(golden.funding.scriptPublicKeyHex),
      },
      blockDaaScore: BigInt(golden.funding.blockDaaScore),
      isCoinbase: golden.funding.isCoinbase,
    },
    grantValue: BigInt(golden.grant.value),
    fee: BigInt(golden.spend.fee),
    computeBudget: golden.spend.computeBudget,
  };
}

const SECRET = fromHex(golden.key.secretHex);

test("the covenant id matches the one the deploy tool computed", () => {
  const built = buildGenesis(planFromGolden());
  assert.equal(
    toHex(built.covenantId),
    golden.covenantId.value,
    "a wrong covenant id produces a well-formed transaction whose grant nothing can ever spend",
  );
});

test("the covenant id is computed WITHOUT the binding it goes into", () => {
  // If the binding were included, the id would depend on itself. This checks
  // the order is real rather than accidentally right: hashing the bound output
  // must give a different answer than the one the tool recorded.
  const plan = planFromGolden();
  const built = buildGenesis(plan);
  const bound = built.tx.outputs[0]!;
  assert.ok(bound.covenant, "the grant output should carry a binding");

  const withBinding = covenantId(
    { transactionId: plan.funding.outpointTransactionId, index: plan.funding.outpointIndex },
    [{ index: 0, output: bound }],
  );
  // Same inputs either way — the hash never reads `covenant`, which is the
  // point. If this ever differs, the hasher started reading the binding.
  assert.equal(toHex(withBinding), golden.covenantId.value);
});

test("the covenant id commits to the output, not just the outpoint", () => {
  const plan = planFromGolden();
  const base = buildGenesis(plan);
  const moved = buildGenesis({ ...plan, grantValue: plan.grantValue - 1n });
  assert.notEqual(toHex(base.covenantId), toHex(moved.covenantId), "value must change the id");

  const elsewhere = buildGenesis({
    ...plan,
    funding: { ...plan.funding, outpointIndex: plan.funding.outpointIndex + 1 },
  });
  assert.notEqual(toHex(base.covenantId), toHex(elsewhere.covenantId), "outpoint must change the id");
});

test("the grant lands at the address the compiler produced", () => {
  const built = buildGenesis(planFromGolden());
  assert.equal(toHex(built.grantScriptPublicKey.script), golden.grant.scriptPublicKeyHex);
});

test("the digest and the transaction id are the reference's", () => {
  const built = buildGenesis(planFromGolden());
  assert.equal(toHex(built.sighash), golden.sighashHex);
  assert.equal(toHex(transactionId(built.tx)), golden.transaction.txid);
});

test("the reference signature verifies against the digest THIS SDK computed", () => {
  const built = buildGenesis(planFromGolden());
  // The recorded script is a single data push: 0x41 then 65 bytes.
  const script = fromHex(golden.signedSignatureScriptHex);
  assert.equal(script[0], 0x41);
  assert.ok(
    verifyDigest(script.subarray(1), built.sighash, fromHex(golden.key.xonlyPublicHex)),
    "the reference signature does not verify against our digest",
  );
});

test("signing does not move the transaction id", () => {
  // Signature scripts are excluded from the txid preimage, so a principal can
  // know a grant's funding txid before committing to sign it.
  const built = buildGenesis(planFromGolden());
  const before = toHex(transactionId(built.tx));
  const signed = attachGenesisSignature(built, signDigest(built.sighash, SECRET));
  assert.equal(toHex(transactionId(signed)), before);
  assert.equal(before, golden.transaction.txid);
});

test("outputs match: the grant is bound, the change is not", () => {
  const built = buildGenesis(planFromGolden());
  for (const [i, expected] of golden.transaction.outputs.entries()) {
    const actual = built.tx.outputs[i]!;
    assert.equal(actual.value, BigInt(expected.value), `output ${i} value`);
    assert.equal(toHex(actual.scriptPublicKey.script), expected.scriptPublicKeyHex, `output ${i} spk`);
    if (expected.covenant === null) {
      assert.equal(actual.covenant, undefined, "change must carry no binding");
    } else {
      assert.equal(toHex(actual.covenant!.covenantId), expected.covenant.covenantId);
      assert.equal(actual.covenant!.authorizingInput, expected.covenant.authorizingInput);
    }
  }
  assert.equal(built.changeValue, BigInt(golden.spend.changeValue));
});

test("a grant cannot be created at a non-zero state", () => {
  // Almost always a caller reusing a live grant's state by mistake — and the
  // address it would fund is not the one they think.
  const plan = planFromGolden();
  assert.throws(
    () => buildGenesis({ ...plan, grant: { ...plan.grant, state: { ...plan.grant.state, spentTotal: 1n } } }),
    /zero state/,
  );
});

test("underfunding is refused before anything is signed", () => {
  const plan = planFromGolden();
  assert.throws(
    () => buildGenesis({ ...plan, grantValue: plan.funding.value }),
    /less than grant/,
  );
});

test("the key in the vector is the principal the grant names", () => {
  assert.equal(toHex(agentPublicKey(SECRET)), golden.key.xonlyPublicHex);
  assert.equal(golden.params.principalKey, golden.key.xonlyPublicHex);
});
