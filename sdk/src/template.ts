import { blake2b } from "@noble/hashes/blake2.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { isBytes32Field, STATE_FIELDS } from "./state.ts";
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
  /** Which covenant this grant belongs to, as readInputStateWithTemplate
   *  needs it. Fixed for the grant's life. */
  templateId: string;
  spentTotal: bigint;
  reserved: bigint;
  epochIndex: bigint;
  epochSpent: bigint;
  /** The LIFO stack of outstanding delegated children, as a hash chain.
   *  EMPTY_RESERVE when none — NOT zero, because script encodes zero as the
   *  empty byte string and the covenant's comparison would test nothing. */
  reserveRoot: string;
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

/**
 * Which covenant a template IS.
 *
 * A covenant upgrade changes the bytecode, so the same grant state derives a
 * different address. A tool holding the wrong template does not fail loudly —
 * it derives a plausible address, finds nothing there, and reports the grant
 * missing. Recording this in a manifest and checking it on load turns that
 * into a sentence.
 */
export function templateFingerprint(tpl: CovenantTemplate): string {
  return toHex(blake2b.create({ dkLen: 32 }).update(new TextEncoder().encode(tpl.baselineHex)).digest()).slice(0, 16);
}

/**
 * The covenant's own template hash, as `readInputStateWithTemplate` expects it.
 *
 * blake3 over `len(prefix) || prefix || len(suffix) || suffix`, each length an
 * eight-byte little-endian Script integer. The lengths are in the preimage on
 * purpose: they bind WHERE the state is inserted, so a covenant cannot be
 * passed off as one with a differently-placed state region.
 *
 * Derived rather than stored. It is a property of the COVENANT, so every grant
 * under one template has the same value, and a manifest that recorded it could
 * only ever disagree with the template it was read alongside.
 */
export function templateIdFor(tpl: CovenantTemplate, authority: GrantAuthority): string {
  // The AUTHORITY matters. principalKey and revocationKey are constructor
  // constants compiled into the SUFFIX, not state, so the template hash covers
  // them: two grants with different principals have different template ids.
  //
  // That is a feature once you see it. A parent can only ever reabsorb
  // children that share its authority, which is a binding you would otherwise
  // have to add by hand — and it is why this takes an authority rather than
  // being a property of the covenant alone.
  const code = bytecodeFor(tpl, {
    authority,
    // Any state: the state region sits BETWEEN prefix and suffix, so nothing
    // here reaches the hash.
    // Any state: the region sits BETWEEN prefix and suffix, so nothing here
    // reaches the hash. Built synthetically rather than borrowed from an
    // address vector, which would tie this to whatever fields those happened
    // to record.
    state: placeholderState(),
  });
  const prefix = code.slice(0, tpl.stateStart);
  const suffix = code.slice(tpl.stateStart + tpl.stateLen);
  const len = (n: number) => {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
    return out;
  };
  const pre = new Uint8Array([...len(prefix.length), ...prefix, ...len(suffix.length), ...suffix]);
  return toHex(blake3(pre));
}

/** A well-formed state of the right SHAPE; its values never reach the hash. */
function placeholderState(): GrantState {
  const out: Record<string, unknown> = {};
  for (const name of STATE_FIELDS) {
    out[name] = isBytes32Field(name) ? "00".repeat(32) : 0n;
  }
  return out as unknown as GrantState;
}
