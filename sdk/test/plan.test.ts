/**
 * The path a live spend actually takes.
 *
 * `warda-deploy plan` finds the grant and writes down what this SDK needs;
 * `spendPlanFrom` turns that into bytes. Every live spend goes through it, and
 * a mistake here is only visible on chain — so it is exercised offline by
 * synthesising a plan from the golden vector and requiring the same bytes the
 * network accepted.
 *
 * The recipients tree gets its own attention. It is built by DIFFERENT code
 * than the Rust tool's, from a plain member list, and a divergence would make
 * every proof a proof about a different tree.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import { spendPlanFrom, type SpendPlanDocument } from "../src/plan.ts";
import { RecipientSet } from "../src/recipients.ts";
import { signSpend } from "../src/sign.ts";
import { buildUnsignedSpend } from "../src/spend.ts";
import { transactionId } from "../src/tx.ts";
import type { CovenantTemplate } from "../src/template.ts";

const golden = JSON.parse(readFileSync(new URL("../golden-spend.json", import.meta.url), "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

/** Exactly the shape `warda-deploy plan` writes. */
function planDocument(): SpendPlanDocument {
  const p = golden.params;
  return {
    authority: { principalKey: p.principalKey, revocationKey: p.revocationKey },
    state: {
      agentKey: p.agentKey,
      budgetTotal: p.budgetTotal,
      maxPerSpend: p.maxPerSpend,
      epochLimit: p.epochLimit,
      epochLength: p.epochLength,
      recipientsRoot: p.recipientsRoot,
      notBefore: p.notBefore,
      expiresAt: p.expiresAt,
      delegationDepth: p.delegationDepth,
      spentTotal: p.prevState.spentTotal,
      reserved: p.prevState.reserved,
      epochIndex: p.prevState.epochIndex,
      epochSpent: p.prevState.epochSpent,
    },
    utxo: {
      outpointTransactionId: golden.utxo.outpointTransactionId,
      outpointIndex: golden.utxo.outpointIndex,
      value: golden.utxo.value,
      blockDaaScore: golden.utxo.blockDaaScore,
      isCoinbase: golden.utxo.isCoinbase,
      covenantId: golden.utxo.covenantId,
    },
    recipients: { members: golden.recipients.members, target: golden.recipients.target },
    spend: {
      amount: golden.spend.amount,
      claimedDaa: golden.spend.claimedDaa,
      fee: golden.spend.fee,
      computeBudget: golden.spend.computeBudget,
    },
  };
}

test("a plan produces the bytes the network accepted", () => {
  const built = buildUnsignedSpend(spendPlanFrom(planDocument(), template));
  assert.equal(toHex(built.tx.inputs[0]!.signatureScript), golden.unsignedSignatureScriptHex);
  assert.equal(toHex(built.sighash), golden.sighashHex);
  assert.equal(toHex(transactionId(built.tx)), golden.transaction.txid);
});

test("signing a plan end to end gives the reference transaction", () => {
  const plan = spendPlanFrom(planDocument(), template);
  const signed = signSpend(plan, fromHex(golden.key.secretHex));
  assert.equal(toHex(transactionId(signed.tx)), golden.transaction.txid);
});

test("a member list that does not hash to the grant's root is refused", () => {
  // Silent otherwise: the proof would be valid, for a tree the grant never
  // committed to, and the covenant would reject it for no visible reason.
  const doc = planDocument();
  doc.recipients.members = [...doc.recipients.members, "cc".repeat(32)];
  assert.throws(() => spendPlanFrom(doc, template), /but the grant commits to/);
});

test("an unlisted target gets no proof, borrowed or otherwise", () => {
  const doc = planDocument();
  doc.recipients.target = "ee".repeat(32);
  assert.throws(() => spendPlanFrom(doc, template), /no proof places it in the tree/);
});

// ---- the tree itself -----------------------------------------------------

test("the tree reproduces the root the covenant carries", () => {
  const set = new RecipientSet(golden.recipients.members);
  assert.equal(set.rootHex, golden.params.recipientsRoot);
});

test("the proof matches the one the Rust tool recorded", () => {
  const set = new RecipientSet(golden.recipients.members);
  const proof = set.proof(golden.recipients.target);
  assert.deepEqual(proof.siblings.map(toHex), golden.recipients.proof.siblings);
  assert.deepEqual(proof.left, golden.recipients.proof.left);
});

test("ordering is canonical, so member order cannot change the root", () => {
  const forwards = new RecipientSet(golden.recipients.members);
  const backwards = new RecipientSet([...golden.recipients.members].reverse());
  assert.equal(forwards.rootHex, backwards.rootHex);
});

test("odd sets promote rather than duplicate, at every size", () => {
  // Duplicating the last node lets two different member sets share a root
  // (CVE-2012-2459). Promotion also means a level can be SKIPPED, which is
  // why proofs carry a side flag instead of relying on index parity — so the
  // sweep runs over odd sizes specifically.
  const roots = new Set<string>();
  for (let n = 1; n <= 17; n++) {
    const members = Array.from({ length: n }, (_, i) =>
      Uint8Array.from({ length: 32 }, (_, j) => (j === 0 ? i + 1 : 0xb0)),
    );
    const set = new RecipientSet(members);
    roots.add(set.rootHex);
    for (const m of members) {
      const proof = set.proof(m);
      assert.equal(proof.siblings.length, proof.left.length, `n=${n}: sides must match siblings`);
    }
  }
  assert.equal(roots.size, 17, "every set size must yield a distinct root");
});

test("a set rejects duplicates and wrong-sized members", () => {
  const one = "a1".repeat(32);
  assert.throws(() => new RecipientSet([one, one]), /duplicate/);
  assert.throws(() => new RecipientSet(["aabb"]), /32-byte/);
  assert.throws(() => new RecipientSet([]), /must not be empty/);
});
