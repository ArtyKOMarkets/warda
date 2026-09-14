/**
 * Our version-0 payment against kaspa-x402's canonical encoder.
 *
 * This is the same argument the borsh submit path makes, in the other
 * direction. There, a foreign encoder serialises a transaction we built and the
 * transaction id proves they agree. Here, a foreign VERIFIER will recompute
 * what we built and compare — `if (transaction.id !== transactionId) throw` in
 * their `#verifyStandardNative` — so the id and the digest are the whole
 * interface, and a disagreement is a payment that settles on chain and is
 * refused off it. Which is exactly what happened for eight attempts before the
 * rule was readable.
 *
 * `@kaspa-x402/covenant` is a devDependency and not a runtime one on purpose.
 * Depending on it to PAY would make their encoder the definition of what we
 * sign, and the point of a second implementation is that it can disagree.
 * Depending on it to TEST is what makes the disagreement visible here rather
 * than on chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exactV0SchnorrSignatureEvidence, exactV0TransactionId } from "@kaspa-x402/covenant";
import { schnorr } from "@noble/curves/secp256k1.js";
import { fromHex, toHex } from "../src/bytes.ts";
import { payToPubkeyScript } from "../src/tx.ts";
import {
  ordinaryPaymentFee,
  ordinaryPaymentId,
  ordinaryPaymentSighash,
  signOrdinaryPayment,
  type OrdinaryPayment,
} from "../src/v0.ts";

const SECRET = fromHex("11".repeat(32));
const MINE = schnorr.getPublicKey(SECRET);
const PAYEE = fromHex("bb".repeat(32));

/** The serialized form their parser takes: two bytes of version, then script. */
const serialized = (key: Uint8Array) => "0000" + toHex(payToPubkeyScript(key).script);

function payment(over: Partial<OrdinaryPayment> = {}): OrdinaryPayment {
  return {
    source: {
      outpoint: { transactionId: fromHex("aa".repeat(32)), index: 0 },
      value: 3_010_000n,
      publicKey: MINE,
    },
    payee: PAYEE,
    amount: 3_000_000n,
    ...over,
  };
}

/** The same payment in their reference shape, so both sides see one thing. */
function theirs(p: OrdinaryPayment, signatureScript: string) {
  return {
    version: 0 as const,
    inputs: [
      {
        previousOutpoint: { txid: toHex(p.source.outpoint.transactionId), index: p.source.outpoint.index },
        signatureScript,
        sequence: "0",
        sigOpCount: 1,
        utxo: { amount: p.source.value.toString(), scriptPublicKey: serialized(p.source.publicKey) },
      },
    ],
    outputs: [{ amount: p.amount.toString(), scriptPublicKey: serialized(p.payee) }],
    lockTime: "0",
    subnetworkId: "00".repeat(20),
    gas: "0",
    payload: "",
  };
}

const UNSIGNED = "41" + "00".repeat(64) + "01";

test("the transaction id agrees with kaspa-x402's canonical encoder", () => {
  const p = payment();
  assert.equal(toHex(ordinaryPaymentId(p)), exactV0TransactionId(theirs(p, UNSIGNED)));
});

test("the id is stable across signing, so the funder can be built against it", () => {
  const p = payment();
  const before = toHex(ordinaryPaymentId(p));
  const signed = signOrdinaryPayment(p, (d) => schnorr.sign(d, SECRET));
  assert.equal(toHex(signed.id), before);
  /* And theirs moves no more than ours does — a v0 id excludes signature
     scripts, which is the property the two-transaction relay rests on: the
     funding transaction pays a coin the payment already knows how to spend. */
  assert.equal(before, exactV0TransactionId(theirs(p, toHex(signed.signatureScript))));
});

test("the digest we sign is the digest they verify against", () => {
  const p = payment();
  const signed = signOrdinaryPayment(p, (d) => schnorr.sign(d, SECRET));
  const evidence = exactV0SchnorrSignatureEvidence(theirs(p, toHex(signed.signatureScript)), 0);

  assert.equal(evidence.digest, toHex(signed.sighash));
  /* They read the public key out of the funding script rather than taking it
     from the payload, so a payment signed by the wrong key is not a bad
     signature to them — it is a signature by somebody else. */
  assert.equal(evidence.publicKey, toHex(MINE));
  assert.equal(
    schnorr.verify(fromHex(evidence.signature), fromHex(evidence.digest), fromHex(evidence.publicKey)),
    true,
  );
});

test("several amounts, because one agreement could be a coincidence", () => {
  for (const [value, amount] of [
    [2_000_000n, 1_000_000n],
    [100_000_001n, 100_000_000n],
    [4_294_967_297n, 4_294_967_296n],
    [21_000_000n, 20_000_000n],
  ] as const) {
    const p = payment({ source: { ...payment().source, value }, amount });
    assert.equal(
      toHex(ordinaryPaymentId(p)),
      exactV0TransactionId(theirs(p, UNSIGNED)),
      `id disagreed at ${amount} of ${value}`,
    );
    const signed = signOrdinaryPayment(p, (d) => schnorr.sign(d, SECRET));
    assert.equal(
      exactV0SchnorrSignatureEvidence(theirs(p, toHex(signed.signatureScript)), 0).digest,
      toHex(signed.sighash),
      `digest disagreed at ${amount} of ${value}`,
    );
  }
});

test("a payment that cannot cover itself is refused before anything is signed", () => {
  assert.throws(() => ordinaryPaymentFee(payment({ amount: 4_000_000n })), /cannot cover the amount/);
  assert.throws(() => ordinaryPaymentFee(payment({ amount: 0n })), /must be positive/);
});
