import { concat, fromHex } from "./bytes.ts";
import type { ScriptBuilder } from "./script.ts";
import type { GrantState } from "./template.ts";

/**
 * How a State reaches the covenant.
 *
 * There are two encodings, and they are not the same. Which one applies
 * depends on whether the State is a scalar argument or an element of an
 * array, and getting them crossed produces a sigscript that is well-formed,
 * the wrong length, and rejected with no indication of why.
 *
 *   SCALAR (a lone `State` argument, as in spend)
 *     The struct is flattened onto the stack: each field pushed in
 *     declaration order, with no length prefix and no marker. Integers use
 *     the script-number encoding, so they are MINIMAL — 0 becomes OP_0, 5
 *     becomes OP_5, and 1,000,000 takes three bytes.
 *
 *   ARRAY ELEMENT (a `State[]` argument, as in delegate)
 *     The compiler transposes: it pushes one array per FIELD, holding that
 *     field's value across every element. So `State[2]` is thirteen pushes,
 *     not two. Inside those arrays every element must be the same width, so
 *     integers are FIXED at 8 bytes little-endian — the opposite of minimal.
 *
 * Field ORDER is load-bearing and invisible in both. Swap two same-typed
 * fields and the script still runs, on the wrong values.
 */

export const STATE_FIELDS = [
  "agentKey",
  "budgetTotal",
  "maxPerSpend",
  "epochLimit",
  "epochLength",
  "recipientsRoot",
  "notBefore",
  "expiresAt",
  "delegationDepth",
  "spentTotal",
  "reserved",
  "epochIndex",
  "epochSpent",
] as const;

export type StateFieldName = (typeof STATE_FIELDS)[number];

const BYTES32_FIELDS = new Set<string>(["agentKey", "recipientsRoot"]);

export function isBytes32Field(name: string): boolean {
  return BYTES32_FIELDS.has(name);
}

function hex32(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string") throw new Error(`${label}: expected a hex string`);
  const bytes = fromHex(value);
  if (bytes.length !== 32) throw new Error(`${label}: expected 32 bytes, got ${bytes.length}`);
  return bytes;
}

/** Fixed-width little-endian i64 — the array-element encoding. */
function i64le(value: unknown, label: string): Uint8Array {
  if (typeof value !== "bigint") throw new Error(`${label}: expected a bigint`);
  const out = new Uint8Array(8);
  let x = value < 0n ? (1n << 64n) + value : value;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function fieldOf(state: GrantState, name: string): unknown {
  const value = (state as unknown as Record<string, unknown>)[name];
  if (value === undefined) throw new Error(`state is missing field ${name}`);
  return value;
}

/** Pushes a State as a SCALAR argument: one push per field, minimal integers. */
export function pushState(b: ScriptBuilder, state: GrantState): void {
  for (const name of STATE_FIELDS) {
    const value = fieldOf(state, name);
    if (isBytes32Field(name)) b.addData(hex32(value, name));
    else b.addI64(value as bigint);
  }
}

/**
 * Pushes a `State[]` argument: one push per FIELD, each holding that field's
 * value across every element, with integers fixed at 8 bytes.
 *
 * The transposition is the part worth staring at. A `State[2]` argument is
 * thirteen pushes — `[parent.agentKey, child.agentKey]`, then
 * `[parent.budgetTotal, child.budgetTotal]`, and so on. Laying the two states
 * out one after the other instead would produce the same total byte count with
 * every value in the wrong place.
 */
export function pushStateArray(b: ScriptBuilder, states: GrantState[]): void {
  if (states.length === 0) throw new Error("a State[] argument must not be empty");
  for (const name of STATE_FIELDS) {
    const encoded = states.map((s) =>
      isBytes32Field(name) ? hex32(fieldOf(s, name), name) : i64le(fieldOf(s, name), name),
    );
    b.addData(concat(...encoded));
  }
}
