/**
 * `toSafeJson`, checked against the Kaspa SDK that defines the encoding.
 *
 * ## Why this test loads a 10 MB wasm blob
 *
 * Because the alternative is a test that checks our encoder against our
 * understanding of the encoder, which is what every serialization bug in this
 * repository has looked like from the inside. `kaspa-sdk-safe-json-v2.0.0` is
 * not our format. The only thing that can say we produce it correctly is the
 * implementation that named it.
 *
 * So each vector goes out through `toSafeJson` and comes back in through
 * `Transaction.deserializeFromSafeJSON`, and the id the real SDK derives from
 * what it parsed must equal the id recorded when the transaction was built.
 * Three independent computations of the same hash: ours at build time, ours
 * now, and the reference implementation's, over a document that survived a
 * round trip through text.
 *
 * A transaction id is the strongest available check here — it commits to every
 * field of the transaction proper, so a wrong version, sequence, script,
 * value, lock time or payload all fail it. It does NOT commit to the utxo
 * entries, which are carried alongside, so those are asserted field by field
 * against what the SDK parsed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex } from "../src/bytes.ts";
import { fromWire, serializedScriptPublicKey, toSafeJson, type WireTransaction } from "../src/wire.ts";
import type { UtxoEntry } from "../src/tx.ts";

const { Transaction } = await import("kaspa-wasm32-sdk");

/** Every wire file this repository has recorded a txid for. */
const VECTORS = ["js-spend.json", "js-delegation.json", "js-genesis.json", "js-reclaim.json"];

function load(name: string): WireTransaction & { txid: string } {
  return JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8"));
}

function entryFrom(w: WireTransaction & { txid: string }): UtxoEntry {
  const u = w.utxo!;
  return {
    value: BigInt(u.value),
    scriptPublicKey: { version: u.scriptPublicKeyVersion, script: fromHex(u.scriptPublicKeyHex) },
    blockDaaScore: BigInt(u.blockDaaScore),
    isCoinbase: u.isCoinbase,
    covenantId: u.covenantId ? fromHex(u.covenantId) : undefined,
  };
}

for (const name of VECTORS) {
  test(`${name}: the real Kaspa SDK parses our safe JSON to the recorded id`, () => {
    const wire = load(name);
    const safe = toSafeJson(fromWire(wire), [entryFrom(wire)]);

    assert.equal(safe.id, wire.txid, "our own id, before the SDK sees anything");

    const parsed = Transaction.deserializeFromSafeJSON(JSON.stringify(safe));
    assert.equal(
      parsed.id,
      wire.txid,
      `the reference SDK read this transaction back as a different one. Our encoding of ` +
        `some field is wrong, and the id says so without saying which.`,
    );
  });
}

test("the utxo entry survives the round trip, though the id does not cover it", () => {
  const wire = load("js-spend.json");
  const entry = entryFrom(wire);
  const safe = toSafeJson(fromWire(wire), [entry]);
  const parsed = Transaction.deserializeFromSafeJSON(JSON.stringify(safe));

  const utxo = parsed.inputs[0]!.utxo!;
  assert.equal(utxo.amount, entry.value);
  assert.equal(utxo.blockDaaScore, entry.blockDaaScore);
  assert.equal(utxo.isCoinbase, entry.isCoinbase);
  assert.equal(utxo.scriptPublicKey.script, wire.utxo!.scriptPublicKeyHex);
  assert.equal(utxo.scriptPublicKey.version, wire.utxo!.scriptPublicKeyVersion);
});

test("scriptPublicKey goes out SERIALIZED — version first, then script", () => {
  const script = fromHex("20" + "ef".repeat(32) + "ac");
  assert.equal(
    serializedScriptPublicKey({ version: 0, script }),
    "0000" + "20" + "ef".repeat(32) + "ac",
  );
  // the same encoding kaspa-x402's schema pins with its ^0000 pattern
  assert.match(serializedScriptPublicKey({ version: 0, script }), /^0000(?:[0-9a-f]{2})+$/);
  // and a non-zero version is little-endian, not a leading byte
  assert.equal(serializedScriptPublicKey({ version: 1, script }).slice(0, 4), "0100");
});

test("every u64 leaves as a string, because that is what makes it safe", () => {
  const wire = load("js-spend.json");
  const safe = toSafeJson(fromWire(wire), [entryFrom(wire)]);

  for (const [path, value] of [
    ["lockTime", safe.lockTime],
    ["gas", safe.gas],
    ["mass", safe.mass],
    ["inputs[0].sequence", safe.inputs[0]!.sequence],
    ["inputs[0].utxo.amount", safe.inputs[0]!.utxo.amount],
    ["inputs[0].utxo.blockDaaScore", safe.inputs[0]!.utxo.blockDaaScore],
    ["outputs[0].value", safe.outputs[0]!.value],
  ] as const) {
    assert.equal(typeof value, "string", `${path} must be a string`);
  }
  // ...and index/version/sigOpCount are u32 or smaller, so they stay numbers
  assert.equal(typeof safe.version, "number");
  assert.equal(typeof safe.inputs[0]!.index, "number");
  assert.equal(typeof safe.inputs[0]!.sigOpCount, "number");
});

test("entries and inputs must correspond, because each input carries its own", () => {
  const wire = load("js-spend.json");
  assert.throws(() => toSafeJson(fromWire(wire), []), /must correspond/);
});
