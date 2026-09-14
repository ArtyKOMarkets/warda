/**
 * The relay payload, checked against every rule their verifier applies to it.
 *
 * `#verifyStandardNative` and `assertStandardNativeTransactionEnvelope` live in
 * `packages/demo-gateway`, which is not published — so the envelope assertions
 * are transcribed here from their source rather than imported. That is a copy,
 * and copies rot. What keeps it honest is that the two things a copy cannot
 * fake — the canonical transaction id and the storage mass — come from THEIR
 * published `@kaspa-x402/covenant`, and the envelope rules are the cheap half.
 *
 * Eight payments settled on chain and were refused off it before these rules
 * were readable. The point of this file is that the ninth does not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateKaspaStorageMass, exactV0TransactionId } from "@kaspa-x402/covenant";
import { schnorr } from "@noble/curves/secp256k1.js";
import { fromHex, pubkeyToAddress, toHex } from "@warda_protocol/kaspa";
import { buildRelayPayment, relayFunding, relayPayee, SAFE_JSON_ENCODING } from "../src/relay.ts";

const AGENT = fromHex("11".repeat(32));
const RELAY_KEY = schnorr.getPublicKey(AGENT);
const MERCHANT = fromHex("bb".repeat(32));
const MERCHANT_SCRIPT = "0000" + "20" + toHex(MERCHANT) + "ac";
const AMOUNT = 3_000_000n;
const FEE = 400_000n;

const accepted = (over: Record<string, unknown> = {}) =>
  ({
    scheme: "exact",
    network: "kaspa:testnet-10",
    asset: "KAS",
    payTo: pubkeyToAddress(MERCHANT, "kaspatest"),
    amount: AMOUNT.toString(),
    payToScriptPublicKey: MERCHANT_SCRIPT,
    maxTimeoutSeconds: 120,
    extra: { finality: "accepted" },
    ...over,
  }) as never;

const source = {
  outpoint: { transactionId: fromHex("aa".repeat(32)), index: 1 },
  value: relayFunding(AMOUNT, FEE),
  publicKey: RELAY_KEY,
};

const sign = (d: Uint8Array) => schnorr.sign(d, AGENT);
const build = (over: Record<string, unknown> = {}) =>
  buildRelayPayment({ source, accepted: accepted(over) }, sign);

interface SafeTx {
  id: string;
  version: number;
  inputs: {
    previousOutpoint: { transactionId: string; index: number };
    signatureScript: string;
    sequence: string;
    sigOpCount: number;
    computeBudget?: number;
    utxo: { amount: string; scriptPublicKey: string };
  }[];
  outputs: { value: string; scriptPublicKey: string; covenant: null }[];
  lockTime: string;
  subnetworkId: string;
  gas: string;
  payload: string;
  storageMass: string;
}

const parsed = async (over: Record<string, unknown> = {}) =>
  JSON.parse((await build(over)).safeJson) as SafeTx;

test("the payload satisfies every rule their standard-native envelope applies", async () => {
  const tx = await parsed();

  assert.equal(tx.version, 0, "version must be 0");
  assert.equal(tx.lockTime, "0");
  assert.equal(tx.subnetworkId, "00".repeat(20));
  assert.equal(tx.gas, "0");
  assert.equal(tx.payload, "");
  assert.ok(tx.inputs.length >= 1);
  assert.ok(tx.outputs.length >= 1 && tx.outputs.length <= 2, "merchant output and optional change only");

  for (const input of tx.inputs) {
    assert.equal(input.computeBudget, undefined, "a v0 input carries no compute budget");
    assert.equal(input.sigOpCount, 1, "sigOpCount must be exactly 1");
    assert.ok(input.utxo.scriptPublicKey.startsWith("0000"), "input script version must be 0");
    /* The check that killed every earlier attempt, and the one no redeem
       script can satisfy: 66 bytes, a 65-byte push, SIGHASH_ALL at the end. */
    const sig = fromHex(input.signatureScript);
    assert.equal(sig.length, 66);
    assert.equal(sig[0], 0x41);
    assert.equal(sig[65], 0x01);
  }
  for (const output of tx.outputs) {
    assert.ok(output.scriptPublicKey.startsWith("0000"), "output script version must be 0");
    assert.equal(output.covenant, null, "covenant must be null, not absent");
  }

  const ins = tx.inputs.reduce((n, i) => n + BigInt(i.utxo.amount), 0n);
  const outs = tx.outputs.reduce((n, o) => n + BigInt(o.value), 0n);
  assert.ok(outs <= ins, "outputs must not exceed inputs");
  assert.equal(ins - outs, FEE, "the funding overage is the fee, exactly");
});

test("the id and the storage mass are the ones they will recompute", async () => {
  const tx = await parsed();

  assert.equal(
    tx.id,
    exactV0TransactionId({
      version: 0,
      inputs: tx.inputs.map((i) => ({
        previousOutpoint: { txid: i.previousOutpoint.transactionId, index: i.previousOutpoint.index },
        signatureScript: i.signatureScript,
        sequence: i.sequence,
        sigOpCount: i.sigOpCount,
        utxo: i.utxo,
      })),
      outputs: tx.outputs.map((o) => ({ amount: o.value, scriptPublicKey: o.scriptPublicKey })),
      lockTime: tx.lockTime,
      subnetworkId: tx.subnetworkId,
      gas: tx.gas,
      payload: tx.payload,
    }),
    "a recomputed id that disagrees is a payment refused after it settles",
  );

  assert.equal(
    BigInt(tx.storageMass),
    calculateKaspaStorageMass({
      inputs: tx.inputs.map((i) => ({ ...i.utxo, hasCovenant: false })),
      outputs: tx.outputs.map((o) => ({ amount: o.value, scriptPublicKey: o.scriptPublicKey, hasCovenant: false })),
    }),
  );
});

test("the payload indices are the ones a one-in-one-out payment forces", async () => {
  const built = await build();
  assert.equal(built.paymentOutputIndex, 0);
  assert.equal(built.inputIndex, 0);
  assert.equal(SAFE_JSON_ENCODING, "kaspa-sdk-safe-json-v2.0.0");
});

test("a script-hash payee is refused here, not by a covenant later", async () => {
  /* A grant pays x-only KEYS, so a script-hash vendor is unpayable from a
     grant by any route — the relay does not change that. Saying so names the
     real reason instead of surfacing as a failed inclusion proof. */
  const p2sh = "kaspatest:prw9hklems02v8apxlx5m6y0d90e0j6657ztr3c3cjqf0wsnwsxz2fs9n0jxr";
  assert.throws(() => relayPayee(accepted({ payTo: p2sh })), (e: Error) => {
    assert.match(e.message, /address version 8/);
    assert.match(e.message, /not a Schnorr pay-to-pubkey address/);
    /* The version byte is what distinguishes them: a P2SH payload is ALSO 32
       bytes, so a check written on length accepts exactly what it exists to
       reject. */
    assert.match(e.message, /script-hash payee cannot be paid from a grant/);
    return true;
  });
});

test("a payee script that disagrees with the vendor's is refused before signing", async () => {
  await assert.rejects(
    () => build({ payToScriptPublicKey: "0000" + "20" + "cc".repeat(32) + "ac" }),
    /is not the one the vendor advertised/,
  );
});

test("a quote with no script to cross-check against is still payable", async () => {
  assert.equal((await parsed({ payToScriptPublicKey: undefined })).outputs[0]!.scriptPublicKey, MERCHANT_SCRIPT);
});

test("funding that cannot cover the invoice is refused before anything is signed", async () => {
  await assert.rejects(
    () => buildRelayPayment({ source: { ...source, value: AMOUNT - 1n }, accepted: accepted() }, sign),
    /cannot cover the amount/,
  );
  assert.throws(() => relayFunding(AMOUNT, 0n), /positive fee/);
});
