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

/**
 * Read a grant back OUT of its compiled bytecode.
 *
 * The exact inverse of `bytecodeFor`, and the reason it matters is recovery.
 * A grant's address is a hash of this bytecode, so an address reveals nothing;
 * but the bytecode itself travels in the clear inside the signature script of
 * every transaction that spends the grant, because that is what P2SH requires.
 * So any spending transaction carries, in plain sight, the full state of the
 * grant it spent.
 *
 * Without this, a grant is reachable only through a manifest file on somebody's
 * disk: lose it, or let it fall behind, and the coin is still perfectly valid on
 * chain and simply unreachable, because nothing can reconstruct the address. A
 * protocol whose whole argument is that limits live in consensus rather than in
 * your process should not have its recoverability live in your filesystem.
 *
 * Fields are read at the offsets the template records, so this cannot drift
 * from the splice: both sides read the same table.
 */
export function decodeGrant(tpl: CovenantTemplate, bytecode: Uint8Array): Grant {
  if (bytecode.length !== tpl.bytecodeLen) {
    throw new Error(
      `this is ${bytecode.length} bytes and the template describes a ${tpl.bytecodeLen}-byte ` +
        `covenant. A redeem script of the wrong length is a DIFFERENT covenant, not a corrupt ` +
        `one — try the template the grant was issued under.`,
    );
  }

  const authority: Record<string, unknown> = {};
  const state: Record<string, unknown> = {};

  for (const f of tpl.fields) {
    const slices = f.offsets.map((o) => bytecode.slice(o, o + f.width));
    // A value spliced at several offsets must agree at all of them. If it does
    // not, this bytecode was not produced by this template, and decoding it
    // would invent a state that never existed.
    for (let i = 1; i < slices.length; i++) {
      if (toHex(slices[i]!) !== toHex(slices[0]!)) {
        throw new Error(
          `${f.name} differs between its occurrences at ${f.offsets[0]} and ${f.offsets[i]}. ` +
            `The splice writes one value to every occurrence, so this is not a grant of this ` +
            `covenant.`,
        );
      }
    }
    const raw = slices[0]!;
    const target = f.group === "authority" ? authority : state;
    target[f.name] = f.kind === "bytes32" ? toHex(raw) : i64leDecode(raw);
  }

  return { authority, state } as unknown as Grant;
}

/** Two's-complement little-endian, the inverse of the encoder above. */
function i64leDecode(b: Uint8Array): bigint {
  let x = 0n;
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]!);
  // The covenant's integers are signed. Reading a negative as unsigned would
  // turn a small negative into an astronomically large budget.
  return x >= 1n << 63n ? x - (1n << 64n) : x;
}

/**
 * Pull the covenant's redeem script out of a P2SH signature script.
 *
 * Kaspa's P2SH requires the redeem script to be pushed, in the clear, by every
 * transaction that spends the address — the network cannot check the hash
 * otherwise. So a spending transaction publishes the grant it spent whether the
 * spender meant to or not, and that is what makes recovery possible at all.
 *
 * Found by LENGTH rather than by parsing the script: the template knows exactly
 * how many bytes a redeem script of this covenant is, and nothing else in a
 * signature script is remotely that size. Parsing the arguments would mean
 * re-implementing script decoding to find something we can identify by a
 * number we already hold.
 */
export function redeemScriptFrom(sigScript: Uint8Array, tpl: CovenantTemplate): Uint8Array {
  const want = tpl.bytecodeLen;
  // A push this large can only be OP_PUSHDATA2: 0x4d, then a two-byte
  // little-endian length.
  for (let i = 0; i + 3 + want <= sigScript.length; i++) {
    if (sigScript[i] !== 0x4d) continue;
    const len = sigScript[i + 1]! | (sigScript[i + 2]! << 8);
    if (len === want) return sigScript.slice(i + 3, i + 3 + want);
  }
  throw new Error(
    `no ${want}-byte redeem script in this signature script (${sigScript.length} bytes). ` +
      `Either it does not spend a grant of this covenant, or it belongs to a different ` +
      `version of it — try the template the grant was issued under.`,
  );
}

/** The grant a signature script spent, read straight off the wire. */
export function grantFromSignatureScript(sigScript: Uint8Array, tpl: CovenantTemplate): Grant {
  return decodeGrant(tpl, redeemScriptFrom(sigScript, tpl));
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
