/**
 * Our KIP-9 storage mass against kaspa-x402's independent implementation.
 *
 * The same argument as `v0.test.ts`: their verifier recomputes this figure and
 * refuses a transaction whose payload disagrees, so a difference of one unit is
 * a payment that settles on chain and is rejected off it. Two implementations
 * that agree are evidence; one is an assumption.
 *
 * The cases below are chosen to cross the branch boundary rather than to be
 * plausible — the relaxed path and the arithmetic path disagree by four orders
 * of magnitude on the same amounts, so an implementation that took the wrong
 * one would still look sane on any single example.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateKaspaStorageMass } from "@kaspa-x402/covenant";
import { fromHex, toHex } from "../src/bytes.ts";
import { payToPubkeyScript, payToScriptHashScript } from "../src/tx.ts";
import { storageMass, type MassCell } from "../src/mass.ts";

const P2PK = payToPubkeyScript(fromHex("bb".repeat(32)));
const P2SH = payToScriptHashScript(fromHex("cc".repeat(32)));

const theirs = (cells: readonly MassCell[]) =>
  cells.map((c) => ({
    amount: c.value.toString(),
    scriptPublicKey: "0000" + toHex(c.scriptPublicKey.script),
    hasCovenant: c.hasCovenant ?? false,
  }));

const cell = (value: bigint, spk = P2PK, hasCovenant = false): MassCell => ({
  value,
  scriptPublicKey: spk,
  hasCovenant,
});

const CASES: [string, MassCell[], MassCell[]][] = [
  ["one in, one out, funded exactly", [cell(3_010_000n)], [cell(3_000_000n)]],
  ["one in, two out, tiny change", [cell(3_100_000n)], [cell(3_000_000n), cell(80_000n)]],
  ["one in, two out, fat change", [cell(800_000_000n)], [cell(3_000_000n), cell(790_000_000n)]],
  ["a grant spend: covenant successor beside a payee", [cell(100_000_000n, P2SH, true)], [cell(96_900_000n, P2SH, true), cell(3_000_000n)]],
  ["seven coins merged into one", Array.from({ length: 7 }, () => cell(50_000_000n)), [cell(349_000_000n)]],
  ["one coin split into seven", [cell(350_000_000n)], Array.from({ length: 7 }, () => cell(49_900_000n))],
  ["two in two out, the symmetric relaxed case", [cell(5_000_000n), cell(5_000_000n)], [cell(4_900_000n), cell(4_900_000n)]],
  ["three in two out, which is NOT relaxed", [cell(5_000_000n), cell(5_000_000n), cell(5_000_000n)], [cell(7_400_000n), cell(7_400_000n)]],
  ["dust-sized output", [cell(100_000_000n)], [cell(1_000n)]],
  ["a single sompi", [cell(100_000_000n)], [cell(1n)]],
];

test("every shape agrees with kaspa-x402's independent implementation", () => {
  for (const [label, inputs, outputs] of CASES) {
    assert.equal(
      storageMass(inputs, outputs),
      calculateKaspaStorageMass({ inputs: theirs(inputs), outputs: theirs(outputs) }),
      `disagreed on: ${label}`,
    );
  }
});

/**
 * The number that decides the relay's shape, asserted rather than described.
 *
 * If this ever stops being true the two-transaction design stops being viable,
 * and it should fail here rather than as a transaction nobody can afford to
 * broadcast.
 */
test("a change output is four orders of magnitude more expensive than none", () => {
  const exact = storageMass([cell(3_010_000n)], [cell(3_000_000n)]);
  const withChange = storageMass([cell(3_100_000n)], [cell(3_000_000n), cell(80_000n)]);
  assert.equal(exact, 1_108n);
  assert.ok(withChange > exact * 10_000n, `change cost ${withChange} against ${exact}`);
});

test("merging is cheap and splitting is not, which is the whole asymmetry", () => {
  const merge = storageMass(Array.from({ length: 7 }, () => cell(50_000_000n)), [cell(349_000_000n)]);
  const split = storageMass([cell(350_000_000n)], Array.from({ length: 7 }, () => cell(49_900_000n)));
  assert.ok(merge < split, `merge ${merge} should cost less than split ${split}`);
});

test("a zero-value output has no defined mass, and says so", () => {
  assert.throws(() => storageMass([cell(1_000n)], [cell(0n)]), /zero-value/);
  assert.throws(() => storageMass([], [cell(1_000n)]), /at least one input/);
});
