import { blake2b } from "@noble/hashes/blake2.js";
import { fromHex, toHex } from "./bytes.ts";

/**
 * Grant addresses without a compiler.
 *
 * A grant lives at P2SH(covenant compiled with its state) — so the address
 * moves every time the agent spends. JavaScript cannot compile Silverscript,
 * which would make an npm SDK impossible.
 *
 * It does not have to. Every constructor value that can vary lands in a
 * fixed-width slice of the bytecode, so splicing new values into a template
 * produces output byte-identical to compiling. `warda-deploy template`
 * verifies that equality every time it regenerates this file — if the two ever
 * disagree, every address computed here would be wrong and funds would land
 * somewhere unspendable, so it is checked rather than trusted.
 *
 * Two properties of the layout are easy to assume wrongly, and both were:
 *
 *   A value can appear MORE THAN ONCE. `principalKey` is embedded three
 *   times — the revoke and reclaim entrypoints each check it. Writing only
 *   the first occurrence leaves a covenant that answers to two different
 *   principals, so every occurrence is written.
 *
 *   Not every constructor value is spliceable. `maxProofDepth` and `maxFee`
 *   have value-dependent widths, so they are compiled in; they describe which
 *   template you are holding, not what you can change about it.
 */

export interface FieldSlot {
  name: string;
  group: "authority" | "state";
  kind: "bytes32" | "int64";
  width: number;
  /** Every position this value occupies. Never just the first. */
  offsets: number[];
}

export interface CovenantTemplate {
  bytecodeLen: number;
  /** Values compiled in rather than spliced. A grant that changes one of
   *  these needs a different template, not a different splice. */
  baked: { maxProofDepth: number; maxFee: number };
  stateStart: number;
  stateLen: number;
  /** The FULL baseline bytecode. Not prefix+suffix: the state region has push
   *  opcodes interleaved between field slots, and exporting only the ends
   *  would zero them out and silently produce wrong addresses. */
  baselineHex: string;
  baseline: Record<string, string | number>;
  fields: FieldSlot[];
  addressVectors: {
    label: string;
    authority: GrantAuthority;
    state: GrantState;
    scriptHash: string;
    address: string;
  }[];
}

/** The parts of a grant the agent can never change, at any state. */
export interface GrantAuthority {
  /** Who may reclaim after expiry, and who the covenant answers to. */
  principalKey: string;
  /** Who may revoke. Usually the principal, but not necessarily. */
  revocationKey: string;
}

/** The parts the address moves with. */
export interface GrantState {
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
}

export interface Grant {
  authority: GrantAuthority;
  state: GrantState;
}

export { toHex };

/** Little-endian i64, matching the compiler's fixed-width state encoding. */
function i64le(v: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let x = v < 0n ? (1n << 64n) + v : v;
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function encodeField(f: FieldSlot, value: unknown): Uint8Array {
  if (f.kind === "bytes32") {
    if (typeof value !== "string") throw new Error(`${f.name}: expected a hex string`);
    const bytes = fromHex(value);
    if (bytes.length !== f.width) {
      throw new Error(`${f.name}: expected ${f.width} bytes, got ${bytes.length}`);
    }
    return bytes;
  }
  if (typeof value !== "bigint") throw new Error(`${f.name}: expected a bigint`);
  const bytes = i64le(value);
  if (bytes.length !== f.width) {
    throw new Error(`${f.name}: expected ${f.width} bytes, encoded ${bytes.length}`);
  }
  return bytes;
}

/** Rebuild the covenant bytecode for a given grant. */
export function bytecodeFor(tpl: CovenantTemplate, grant: Grant): Uint8Array {
  const out = fromHex(tpl.baselineHex);
  if (out.length !== tpl.bytecodeLen) {
    throw new Error(`template baseline is ${out.length} bytes, declared ${tpl.bytecodeLen}`);
  }

  for (const f of tpl.fields) {
    const source = f.group === "authority" ? grant.authority : grant.state;
    const value = (source as unknown as Record<string, unknown>)[f.name];
    if (value === undefined) throw new Error(`grant is missing ${f.group} field ${f.name}`);
    const bytes = encodeField(f, value);
    // Every occurrence, not the first.
    for (const offset of f.offsets) out.set(bytes, offset);
  }

  return out;
}

/** blake2b-256 of the redeem script — what Kaspa's P2SH commits to. */
export function scriptHashFor(tpl: CovenantTemplate, grant: Grant): string {
  return toHex(blake2b.create({ dkLen: 32 }).update(bytecodeFor(tpl, grant)).digest());
}
