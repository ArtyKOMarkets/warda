import { concat, hash32, u16le, u32le, u64le } from "./bytes.ts";
import { HashWriter, ZERO_HASH } from "./hashers.ts";

/**
 * Version-1 Kaspa transactions: serialization, txid, and the signature hash.
 *
 * Three things here are specific to version 1 and easy to get wrong by
 * porting a version-0 implementation:
 *
 *   1. An input commits to a COMPUTE BUDGET, not a sigop count. The sigop
 *      fields are gone from the sighash entirely — not zeroed, ABSENT.
 *   2. An output commits to its covenant binding. This is the mechanism that
 *      makes a covenant spend un-rewritable, and it is the single field a
 *      second implementation is most likely to omit. Omitting it produces a
 *      signature the engine refuses, and the failure looks exactly like a
 *      covenant bug rather than a signing bug.
 *   3. The txid is blake3, in two stages, and excludes the signature scripts,
 *      the payload, and the mass — so it is stable across signing.
 */

export const SUBNETWORK_ID_NATIVE = new Uint8Array(20);
export const SIG_HASH_ALL = 0x01;

export interface ScriptPublicKey {
  version: number;
  script: Uint8Array;
}

export interface CovenantBinding {
  authorizingInput: number;
  covenantId: Uint8Array;
}

export interface TransactionOutpoint {
  transactionId: Uint8Array;
  index: number;
}

export interface TransactionInput {
  previousOutpoint: TransactionOutpoint;
  signatureScript: Uint8Array;
  sequence: bigint;
  /** Version-1 inputs carry this instead of a sigop count. */
  computeBudget: number;
}

export interface TransactionOutput {
  value: bigint;
  scriptPublicKey: ScriptPublicKey;
  covenant?: CovenantBinding;
}

export interface Transaction {
  version: number;
  inputs: TransactionInput[];
  outputs: TransactionOutput[];
  lockTime: bigint;
  subnetworkId: Uint8Array;
  gas: bigint;
  payload: Uint8Array;
}

export interface UtxoEntry {
  value: bigint;
  scriptPublicKey: ScriptPublicKey;
  blockDaaScore: bigint;
  isCoinbase: boolean;
  covenantId?: Uint8Array;
}

// ---- signature hash ------------------------------------------------------

function hashScriptPublicKey(w: HashWriter, spk: ScriptPublicKey): void {
  w.writeU16(spk.version).writeVarBytes(spk.script);
}

function hashOutput(w: HashWriter, out: TransactionOutput, version: number): void {
  w.writeU64(out.value);
  hashScriptPublicKey(w, out.scriptPublicKey);
  if (version >= 1) {
    w.writeBool(out.covenant !== undefined);
    if (out.covenant) {
      w.writeU16(out.covenant.authorizingInput).update(out.covenant.covenantId);
    }
  }
}

function previousOutputsHash(tx: Transaction): Uint8Array {
  const w = HashWriter.blake2b("TransactionSigningHash");
  for (const input of tx.inputs) {
    w.update(input.previousOutpoint.transactionId).writeU32(input.previousOutpoint.index);
  }
  return w.digest();
}

function sequencesHash(tx: Transaction): Uint8Array {
  const w = HashWriter.blake2b("TransactionSigningHash");
  for (const input of tx.inputs) w.writeU64(input.sequence);
  return w.digest();
}

function outputsHash(tx: Transaction): Uint8Array {
  const w = HashWriter.blake2b("TransactionSigningHash");
  for (const output of tx.outputs) hashOutput(w, output, tx.version);
  return w.digest();
}

function payloadHash(tx: Transaction): Uint8Array {
  // Native subnetwork with an empty payload short-circuits to the zero hash
  // rather than hashing an empty string — those are different values.
  const isNative = tx.subnetworkId.every((b) => b === 0);
  if (isNative && tx.payload.length === 0) return ZERO_HASH;
  return HashWriter.blake2b("TransactionSigningHash").writeVarBytes(tx.payload).digest();
}

/**
 * The digest a signer signs, for SIGHASH_ALL. Other sighash types zero out
 * whole sections; this SDK only builds all-or-nothing agent spends, so
 * supporting them would be dead code that still had to be kept correct.
 */
export function sighash(tx: Transaction, inputIndex: number, entry: UtxoEntry): Uint8Array {
  if (tx.version < 1) throw new Error("this SDK builds version-1 transactions only");
  const input = tx.inputs[inputIndex];
  if (!input) throw new Error(`no input at index ${inputIndex}`);

  const w = HashWriter.blake2b("TransactionSigningHash");
  w.writeU16(tx.version).update(previousOutputsHash(tx)).update(sequencesHash(tx));
  // Version >= 1 omits the sig-op-counts hash entirely.
  w.update(input.previousOutpoint.transactionId).writeU32(input.previousOutpoint.index);
  hashScriptPublicKey(w, entry.scriptPublicKey);
  w.writeU64(entry.value).writeU64(input.sequence);
  // Version >= 1 omits the per-input sig-op-count byte entirely.
  w.update(outputsHash(tx))
    .writeU64(tx.lockTime)
    .update(tx.subnetworkId)
    .writeU64(tx.gas)
    .update(payloadHash(tx))
    .writeU8(SIG_HASH_ALL);
  return w.digest();
}

// ---- transaction id ------------------------------------------------------

/**
 * The `rest` preimage: the transaction with payload, signature scripts and
 * the mass commitment excluded. Because signature scripts are excluded, the
 * txid is known before signing — which is what lets a caller chain a spend
 * onto a transaction it has not broadcast yet.
 */
function writeRestPreimage(w: HashWriter, tx: Transaction): void {
  w.update(u16le(tx.version)).writeLen(tx.inputs.length);
  for (const input of tx.inputs) {
    w.update(input.previousOutpoint.transactionId).update(u32le(input.previousOutpoint.index));
    w.writeVarBytes(new Uint8Array(0)); // signature script excluded
    w.update(u64le(input.sequence));
    // The compute budget is part of the MASS commitment, which this preimage
    // excludes -- so it is omitted here even though the input carries it.
  }

  w.writeLen(tx.outputs.length);
  for (const output of tx.outputs) {
    w.update(u64le(output.value))
      .update(u16le(output.scriptPublicKey.version))
      .writeVarBytes(output.scriptPublicKey.script);
    if (tx.version >= 1) {
      w.writeBool(output.covenant !== undefined);
      if (output.covenant) {
        w.writeU16(output.covenant.authorizingInput).update(output.covenant.covenantId);
      }
    }
  }

  w.update(u64le(tx.lockTime)).update(tx.subnetworkId).update(u64le(tx.gas));
  w.writeVarBytes(new Uint8Array(0)); // payload excluded
}

/** blake3 keyed with "PayloadDigest" over an empty payload; precomputed upstream. */
const ZERO_PAYLOAD_DIGEST = hash32(
  "9c0ca2acb45e92ffe6ceb4ae29188b35c82d9676cdd3ce067fd6ccc30a9c4a38",
);

export function transactionId(tx: Transaction): Uint8Array {
  if (tx.version < 1) throw new Error("this SDK builds version-1 transactions only");

  const payloadDigest =
    tx.payload.length === 0
      ? ZERO_PAYLOAD_DIGEST
      : HashWriter.blake3("PayloadDigest").update(tx.payload).digest();

  const rest = HashWriter.blake3("TransactionRest");
  writeRestPreimage(rest, tx);

  return HashWriter.blake3("TransactionV1Id").update(payloadDigest).update(rest.digest()).digest();
}

// ---- helpers -------------------------------------------------------------

/** P2SH: the script hash of the redeem script, wrapped in OP_BLAKE2B ... OP_EQUAL. */
export function payToScriptHashScript(scriptHash: Uint8Array): ScriptPublicKey {
  if (scriptHash.length !== 32) throw new Error("a script hash is 32 bytes");
  return { version: 0, script: concat(Uint8Array.of(0xaa, 0x20), scriptHash, Uint8Array.of(0x87)) };
}

/** P2PK against a 32-byte x-only schnorr key. */
export function payToPubkeyScript(xonly: Uint8Array): ScriptPublicKey {
  if (xonly.length !== 32) throw new Error("an x-only public key is 32 bytes");
  return { version: 0, script: concat(Uint8Array.of(0x20), xonly, Uint8Array.of(0xac)) };
}
