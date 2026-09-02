import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { toHex } from "../src/bytes.ts";
import { transactionId } from "../src/tx.ts";
import { fromWire, toWire, type WireTransaction } from "../src/wire.ts";

/**
 * `fromWire` is the inverse of `toWire`, and the thing that makes it worth
 * testing is that a wrong inverse does not throw. It produces a transaction
 * that is subtly not the one on the wire — a swapped byte order, a dropped
 * covenant binding — and the failure surfaces as a signature that will not
 * verify, or a node rejection about script units.
 *
 * The txid is the check: it is a hash over the whole structure, so a
 * transaction that recomputes to the id its own file recorded is the same
 * transaction in every field the id covers.
 *
 * These three files are real transactions this SDK built and broadcast:
 * a genesis, a delegation, and a spend from a delegated child.
 */
for (const name of ["js-genesis.json", "js-delegation.json", "js-child-spend.json"]) {
  test(`fromWire round-trips ${name}`, () => {
    const wire = JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), "utf8")) as WireTransaction;
    const tx = fromWire(wire);
    assert.equal(toHex(transactionId(tx)), wire.txid);

    // And back out again, so the two directions agree about every field the
    // wire form carries rather than only the ones the id commits to.
    const again = toWire(tx, {
      // These files predate `utxos`; the single-input shorthand is all they
      // carry, which is exactly why toWire still writes both.
      value: BigInt((wire.utxos?.[0] ?? wire.utxo)!.value),
      scriptPublicKey: { version: 0, script: new Uint8Array() },
      blockDaaScore: 0n,
      isCoinbase: false,
    });
    assert.deepEqual(again.inputs, wire.inputs);
    assert.deepEqual(again.outputs, wire.outputs);
    assert.equal(again.lockTime, wire.lockTime);
    assert.equal(again.payloadHex, wire.payloadHex);
    assert.equal(again.subnetworkId, wire.subnetworkId);
  });
}
