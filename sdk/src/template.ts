import { blake2b } from "@noble/hashes/blake2.js";

/**
 * Grant addresses without a compiler.
 *
 * A grant lives at P2SH(covenant compiled with its state) — so the address
 * moves every time the agent spends. JavaScript cannot compile Silverscript,
 * which would make an npm SDK impossible.
 *
 * It does not have to. The state occupies a contiguous, fixed-width slice of
 * the bytecode, so splicing new values into a prefix/suffix template produces
 * output byte-identical to compiling. `warda-deploy template` verifies that
 * equality every time it regenerates this file — if the two ever disagree,
 * every address computed here would be wrong and funds would land somewhere
 * unspendable, so it is checked rather than trusted.
 */

export interface FieldSlot {
  name: string;
  offset: number;
  end: number;
}

export interface CovenantTemplate {
  bytecodeLen: number;
  stateStart: number;
  stateLen: number;
  /** The FULL baseline bytecode. Not prefix+suffix: the state region has push
   *  opcodes interleaved between field slots, and exporting only the ends
   *  would zero them out and silently produce wrong addresses. */
  baselineHex: string;
  fields: FieldSlot[];
  params: Record<string, string | number>;
  addressVectors: {
    label: string;
    spentTotal: number;
    reserved: number;
    epochIndex: number;
    epochSpent: number;
    scriptHash: string;
    address: string;
  }[];
}

export type GrantState = {
  agentKey: string;
  budgetTotal: bigint;
  maxPerSpend: bigint;
  epochLimit: bigint;
  epochLength: bigint;
  recipientsRoot: string;
  notBefore: bigint;
  expiresAt: bigint;
  delegationDepth: bigint;
  spentTotal: bigint;
  reserved: bigint;
  epochIndex: bigint;
  epochSpent: bigint;
};

const HEX32 = new Set(["agentKey", "recipientsRoot"]);

function fromHex(s: string): Uint8Array {
  const c = s.startsWith("0x") ? s.slice(2) : s;
  const o = new Uint8Array(c.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = Number.parseInt(c.slice(i * 2, i * 2 + 2), 16);
  return o;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

/** Little-endian i64, matching the compiler's integer encoding. */
function i64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = v < 0n ? (1n << 64n) + v : v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

/** Rebuild the covenant bytecode for a given state. */
export function bytecodeFor(tpl: CovenantTemplate, state: GrantState): Uint8Array {
  const out = fromHex(tpl.baselineHex);
  if (out.length !== tpl.bytecodeLen) {
    throw new Error(`template baseline is ${out.length} bytes, declared ${tpl.bytecodeLen}`);
  }

  for (const f of tpl.fields) {
    const value = (state as unknown as Record<string, unknown>)[f.name];
    if (value === undefined) throw new Error(`state is missing field ${f.name}`);
    const bytes = HEX32.has(f.name) ? fromHex(value as string) : i64le(value as bigint);
    const width = f.end - f.offset;
    if (bytes.length !== width) {
      throw new Error(`${f.name}: expected ${width} bytes, encoded ${bytes.length}`);
    }
    out.set(bytes, f.offset);
  }

  return out;
}

/** blake2b-256 of the redeem script — what Kaspa's P2SH commits to. */
export function scriptHashFor(tpl: CovenantTemplate, state: GrantState): string {
  return toHex(blake2b.create({ dkLen: 32 }).update(bytecodeFor(tpl, state)).digest());
}
