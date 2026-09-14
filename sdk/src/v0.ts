/**
 * An ordinary version-0 payment, because x402 `exact` will not take anything else.
 *
 * Every other transaction this SDK builds is version 1 and carries a covenant
 * binding — that is the point of the protocol. This file is the exception, and
 * it exists for one reason: x402's `exact` scheme requires the payer's input to
 * be a bare P2PK unlocked by a single 66-byte Schnorr push, and its outputs to
 * carry no covenant. A grant spend is neither, under any version, and no redeem
 * script gets through — the reference verifier reads the public key out of a
 * P2PK script or throws.
 *
 * So a bounded payer reaches such a vendor in two transactions: the covenant
 * spend pays a relay key it holds, and THIS pays the merchant from that coin.
 * `x402/RELAY.md` has the argument and what it costs.
 *
 * ## Why this is a narrow type rather than a version field
 *
 * `Transaction` could have grown a `version: 0` branch. It would have been
 * fewer lines and worse: the covenant binding, the compute budget and the
 * successor output are meaningless here, and every one of them would have
 * become a field that is sometimes-present with rules elsewhere. The type below
 * can only express the shape `exact` accepts — one P2PK input, one or two P2PK
 * outputs, nothing else — so the checks that would otherwise be assertions are
 * simply unrepresentable.
 *
 * ## Why there is no change output
 *
 * Not an optimisation. KIP-9 storage mass on a small change output is brutal:
 * measured through kaspa-x402's own `calculateKaspaStorageMass`, one input to
 * one output costs 1,108 mass, and the same payment with 0.0008 KAS of change
 * costs 12,510,753 — a fee floor of 12.5 KAS against 0.0011. So the funding
 * transaction pays this one exactly what it will spend, and it spends all of
 * it. `amount` goes to the payee; everything above it is the fee.
 */

import { u16le, u32le, u64le } from "./bytes.ts";
import { HashWriter, ZERO_HASH } from "./hashers.ts";
import { payToPubkeyScript, type TransactionOutpoint } from "./tx.ts";

const SIG_HASH_ALL = 0x01;
/** One signature, one sigop. `exact` requires exactly this and rejects 0 or 2. */
const SIG_OP_COUNT = 1;
const NATIVE_SUBNETWORK = new Uint8Array(20);

export interface OrdinaryPayment {
  /** The coin being spent: an ordinary P2PK output whose key the payer holds. */
  source: {
    outpoint: TransactionOutpoint;
    value: bigint;
    /** x-only key the coin pays to. The script is derived, never supplied. */
    publicKey: Uint8Array;
  };
  /** x-only key of the payee. */
  payee: Uint8Array;
  /** What the payee receives. Everything above it in `source.value` is fee. */
  amount: bigint;
}

export interface SignedOrdinaryPayment {
  payment: OrdinaryPayment;
  /** Known before signing — a v0 id excludes signature scripts, as v1 does. */
  id: Uint8Array;
  sighash: Uint8Array;
  /** 66 bytes: a 65-byte push of the signature, then SIGHASH_ALL. */
  signatureScript: Uint8Array;
  fee: bigint;
}

/**
 * The script, not the `ScriptPublicKey`.
 *
 * Version is written separately by both hashers, and it is always 0 here: a
 * version-0 payment with a version-1 script is not a thing `exact` accepts, so
 * carrying the pair around would only let the two drift.
 */
function spkOf(key: Uint8Array): Uint8Array {
  return payToPubkeyScript(key).script;
}

/** The one output, as the hashers see it. Kept in one place so both agree. */
function writeOutputs(w: HashWriter, p: OrdinaryPayment): void {
  w.writeU64(p.amount).writeU16(0).writeVarBytes(spkOf(p.payee));
}

export function ordinaryPaymentFee(p: OrdinaryPayment): bigint {
  const fee = p.source.value - p.amount;
  if (p.amount <= 0n) throw new Error("an ordinary payment must be positive");
  if (fee < 0n) {
    throw new Error(
      `the coin holds ${p.source.value} sompi and the payment is ${p.amount}: ` +
        `it cannot cover the amount, let alone a fee.`,
    );
  }
  return fee;
}

/**
 * The digest the payer signs.
 *
 * Version 0 differs from version 1 in exactly three places, and all three are
 * the sig-op count: v0 hashes a digest of every input's count after the
 * sequences, writes the count again per input, and omits the covenant flag from
 * each output. Version 1 dropped the first two and added the third.
 */
export function ordinaryPaymentSighash(p: OrdinaryPayment): Uint8Array {
  ordinaryPaymentFee(p);
  const prevOutputs = HashWriter.blake2b("TransactionSigningHash")
    .update(p.source.outpoint.transactionId)
    .writeU32(p.source.outpoint.index)
    .digest();
  const sequences = HashWriter.blake2b("TransactionSigningHash").writeU64(0n).digest();
  const sigOpCounts = HashWriter.blake2b("TransactionSigningHash")
    .writeU8(SIG_OP_COUNT)
    .digest();
  const outputs = (() => {
    const w = HashWriter.blake2b("TransactionSigningHash");
    writeOutputs(w, p);
    return w.digest();
  })();

  return HashWriter.blake2b("TransactionSigningHash")
    .writeU16(0)
    .update(prevOutputs)
    .update(sequences)
    .update(sigOpCounts)
    .update(p.source.outpoint.transactionId)
    .writeU32(p.source.outpoint.index)
    .writeU16(0)
    .writeVarBytes(spkOf(p.source.publicKey))
    .writeU64(p.source.value)
    .writeU64(0n)
    .writeU8(SIG_OP_COUNT)
    .update(outputs)
    .writeU64(0n)
    .update(NATIVE_SUBNETWORK)
    .writeU64(0n)
    /* Native subnetwork with an empty payload short-circuits to the zero hash
       rather than hashing an empty string. They are different values, and this
       is the same rule version 1 follows. */
    .update(ZERO_HASH)
    .writeU8(SIG_HASH_ALL)
    .digest();
}

/**
 * The transaction id, which is a single keyed hash rather than version 1's
 * two-stage payload-digest construction.
 *
 * Signature scripts are excluded, so the id is known before signing — which is
 * what lets the funding transaction be built against it and broadcast first.
 */
export function ordinaryPaymentId(p: OrdinaryPayment): Uint8Array {
  ordinaryPaymentFee(p);
  const w = HashWriter.blake2b("TransactionID");
  w.update(u16le(0))
    .writeLen(1)
    .update(p.source.outpoint.transactionId)
    .update(u32le(p.source.outpoint.index))
    .writeVarBytes(new Uint8Array(0))
    .update(u64le(0n))
    .writeLen(1);
  writeOutputs(w, p);
  return w
    .update(u64le(0n))
    .update(NATIVE_SUBNETWORK)
    .update(u64le(0n))
    .writeVarBytes(new Uint8Array(0))
    .digest();
}

/**
 * Sign it, and produce the 66 bytes `exact` insists on.
 *
 * `signDigest` is passed in rather than imported so this file never needs to
 * know how the key is held — the same reason `externalSigner` exists.
 */
export function signOrdinaryPayment(
  p: OrdinaryPayment,
  sign: (digest: Uint8Array) => Uint8Array,
): SignedOrdinaryPayment {
  const fee = ordinaryPaymentFee(p);
  const sighash = ordinaryPaymentSighash(p);
  const signature = sign(sighash);
  if (signature.length !== 64) {
    throw new Error(`a Schnorr signature is 64 bytes, got ${signature.length}`);
  }
  /* 0x41 is a push of 65 bytes: the signature, then the sighash type. The
     verifier checks this length and these two bytes exactly, so anything
     cleverer is a rejection. */
  const signatureScript = new Uint8Array(66);
  signatureScript[0] = 0x41;
  signatureScript.set(signature, 1);
  signatureScript[65] = SIG_HASH_ALL;

  return { payment: p, id: ordinaryPaymentId(p), sighash, signatureScript, fee };
}
