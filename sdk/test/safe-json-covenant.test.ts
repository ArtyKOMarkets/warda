/**
 * What `kaspa-sdk-safe-json-v2.0.0` cannot carry, and what that costs.
 *
 * A version-1 transaction id commits to each output's covenant binding —
 * `writeRestPreimage` writes a presence bool and, when set, the authorizing
 * input and the covenant id. The safe-JSON encoding has no field for any of
 * that: its outputs are `{ value, scriptPublicKey }`.
 *
 * So the encoding is lossy for exactly the transactions this protocol
 * produces, and lossy in the one place that matters — a receiver who
 * recomputes the id from it arrives at a different transaction than the one on
 * chain. This is not a defect in `toSafeJson`; it is the format's coverage,
 * and it is pinned here because it is invisible until somebody on the other
 * side derives an id and finds nothing.
 *
 * kaspa-x402's `exact` scheme is the first place it bit: its payload schema
 * forbids the client from supplying `transactionId`, so the verifier must
 * derive one, and for a covenant spend it cannot derive the right one.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromWire, toHex, toSafeJson, transactionId } from "../src/index.ts";

const spend = JSON.parse(
  readFileSync(new URL("../../covenant/deploy/js-spend.json", import.meta.url), "utf8"),
);
const tx = fromWire(spend);

const entries = [
  {
    value: BigInt(spend.utxo.value),
    scriptPublicKey: {
      version: Number(spend.utxo.scriptPublicKeyVersion),
      script: Uint8Array.from(
        (spend.utxo.scriptPublicKeyHex.match(/../g) ?? []).map((b: string) => parseInt(b, 16)),
      ),
    },
    blockDaaScore: BigInt(spend.utxo.blockDaaScore),
    isCoinbase: spend.utxo.isCoinbase,
  },
];

test("the covenant binding is part of the transaction id", () => {
  assert.equal(toHex(transactionId(tx)), spend.txid);

  const stripped = { ...tx, outputs: tx.outputs.map(({ covenant: _c, ...o }) => o) };
  assert.notEqual(
    toHex(transactionId(stripped)),
    spend.txid,
    "if these were equal the binding would not be committed to, and this whole file would be moot",
  );
});

test("safe JSON has nowhere to put it", () => {
  const safe = toSafeJson(tx, entries);
  assert.deepEqual(Object.keys(safe.outputs[0]!), ["value", "scriptPublicKey"]);
  assert.ok(tx.outputs[0]!.covenant, "the fixture's first output is covenant-bound");
});

test("so an id recomputed from safe JSON is not the id on chain", () => {
  // What a receiver can reconstruct from the encoding: outputs with no
  // binding, because the encoding carried none.
  const asReceived = {
    ...tx,
    outputs: tx.outputs.map((o) => ({ value: o.value, scriptPublicKey: o.scriptPublicKey })),
  };
  const derived = toHex(transactionId(asReceived));
  assert.notEqual(derived, spend.txid);
  // And it is not a near miss that a tolerant comparison would forgive.
  assert.notEqual(derived.slice(0, 8), spend.txid.slice(0, 8));
});
