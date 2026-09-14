/**
 * KIP-9 contextual storage mass.
 *
 * This repository has measured mass six times and never computed it: the node
 * prices a transaction, `fee.ts` reads the figure out of the rejection, and
 * that is enough when you are about to broadcast. It stops being enough the
 * moment a transaction has to state its own mass BEFORE anyone sees it —
 * which is what x402's `exact` requires, because their verifier recomputes it
 * and compares.
 *
 * ## Why the formula matters more than the number
 *
 * Storage mass punishes creating small outputs and rewards merging. That is
 * not a fee schedule detail here; it decides the shape of a relayed payment.
 * Measured through this function:
 *
 *     1 in -> 1 out, funded exactly          1,108
 *     1 in -> 2 out, 0.0008 KAS of change   12,510,753
 *
 * At 100 sompi per unit that is 0.0011 KAS against 12.5. So "the funding
 * transaction pays the relay exactly what it will spend" is not tidiness, it
 * is the difference between a viable payment and an impossible one. See
 * `v0.ts` and `x402/RELAY.md`.
 *
 * ## Two formulas, and the one that surprises people
 *
 * The relaxed path — a single output, or a small symmetric transaction —
 * compares the harmonic means of both sides. Everything else compares the
 * outputs' harmonic mean against the inputs' ARITHMETIC mean, which is what
 * makes splitting one large coin into many small ones expensive while merging
 * many into one is nearly free.
 *
 * Mirrors rusty-kaspa. Pinned against `@kaspa-x402/covenant`'s independent
 * implementation in `test/mass.test.ts`, for the same reason the version-0 id
 * is: two implementations that agree are evidence, and one is an assumption.
 */

import type { ScriptPublicKey } from "./tx.ts";

/** Rusty-kaspa's storage mass parameter. */
export const STORAGE_MASS_PARAMETER = 1_000_000_000_000n;

/** A UTXO costs this much to hold, before its script. */
const UTXO_CONST_STORAGE = 63n;
const UTXO_COVENANT_STORAGE = 32n;
const UTXO_UNIT_SIZE = 100n;

export interface MassCell {
  value: bigint;
  scriptPublicKey: ScriptPublicKey;
  /** A covenant binding is 32 more bytes the UTXO set has to carry. */
  hasCovenant?: boolean;
}

/**
 * How many storage units this UTXO occupies.
 *
 * Rounded UP, so a 34-byte P2PK script and a 35-byte P2SH one both cost one
 * unit — the granularity is what keeps ordinary payments from being priced by
 * their script length.
 */
function plurality(cell: MassCell): bigint {
  const script = BigInt(cell.scriptPublicKey.script.length);
  const covenant = cell.hasCovenant ? UTXO_COVENANT_STORAGE : 0n;
  const bytes = UTXO_CONST_STORAGE + script + covenant;
  return (bytes + UTXO_UNIT_SIZE - 1n) / UTXO_UNIT_SIZE;
}

function harmonic(cells: readonly MassCell[], c: bigint): bigint {
  return cells.reduce((sum, cell) => {
    const p = plurality(cell);
    /* Integer division, deliberately, and in this order: the consensus rule is
       floor(C * p² / value) per cell, and computing it any other way — summing
       reciprocals, dividing at the end — gives a different number for the same
       transaction. */
    return sum + (c * p * p) / cell.value;
  }, 0n);
}

export function storageMass(
  inputs: readonly MassCell[],
  outputs: readonly MassCell[],
  parameter: bigint = STORAGE_MASS_PARAMETER,
): bigint {
  if (inputs.length === 0 || outputs.length === 0) {
    throw new Error("storage mass needs at least one input and one output");
  }
  for (const cell of [...inputs, ...outputs]) {
    if (cell.value <= 0n) {
      throw new Error("storage mass is undefined for a zero-value output");
    }
  }

  const outsPlurality = outputs.reduce((n, cell) => n + plurality(cell), 0n);
  const insPlurality = inputs.reduce((n, cell) => n + plurality(cell), 0n);
  const harmonicOuts = harmonic(outputs, parameter);

  /* The relaxed path. One output cannot be a dust attack, and neither can a
     small symmetric transaction, so both sides are compared on equal terms. */
  const relaxed =
    outsPlurality === 1n ||
    (inputs.length <= 2 && (insPlurality === 1n || (outsPlurality === 2n && insPlurality === 2n)));

  if (relaxed) {
    const harmonicIns = harmonic(inputs, parameter);
    return harmonicOuts > harmonicIns ? harmonicOuts - harmonicIns : 0n;
  }

  /* Outputs by harmonic mean, inputs by ARITHMETIC mean. The asymmetry is the
     rule: splitting is expensive, merging is not. */
  const sumIns = inputs.reduce((n, cell) => n + cell.value, 0n);
  const meanIns = sumIns / insPlurality;
  const arithmeticIns = insPlurality * (parameter / (meanIns > 1n ? meanIns : 1n));
  return harmonicOuts > arithmeticIns ? harmonicOuts - arithmeticIns : 0n;
}
