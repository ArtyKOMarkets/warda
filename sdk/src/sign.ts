import { schnorr } from "@noble/curves/secp256k1.js";
import { concat } from "./bytes.ts";
import { attachSignature, buildUnsignedSpend, type SpendPlan, type UnsignedSpend } from "./spend.ts";
import { SIG_HASH_ALL, type Transaction } from "./tx.ts";

/**
 * Signing an agent spend.
 *
 * BIP340 schnorr over the sighash, plus one trailing byte naming the sighash
 * type. That 65th byte is not optional and not part of the signature: the
 * engine reads it to know which digest to recompute. A 64-byte signature is
 * rejected, and the rejection says nothing about the missing byte.
 *
 * The key here is the AGENT's, not the principal's. That asymmetry is the
 * whole point of the protocol — the principal signs once, at genesis, to
 * create the grant; from then on the agent spends inside it without the
 * principal ever being online, and without the agent's key being able to
 * exceed what the covenant allows.
 */

export const SIGHASH_TYPE_BYTE = SIG_HASH_ALL;

/** Signs a digest and appends the sighash-type byte. */
export function signDigest(digest: Uint8Array, agentSecretKey: Uint8Array): Uint8Array {
  if (digest.length !== 32) throw new Error(`a sighash is 32 bytes, got ${digest.length}`);
  if (agentSecretKey.length !== 32) throw new Error("a secret key is 32 bytes");
  return concat(schnorr.sign(digest, agentSecretKey), Uint8Array.of(SIGHASH_TYPE_BYTE));
}

/** Checks a 65-byte signature against a digest and an x-only public key. */
export function verifyDigest(signature: Uint8Array, digest: Uint8Array, xonlyPublicKey: Uint8Array): boolean {
  if (signature.length !== 65) return false;
  if (signature[64] !== SIGHASH_TYPE_BYTE) return false;
  return schnorr.verify(signature.subarray(0, 64), digest, xonlyPublicKey);
}

/** The x-only public key an agent secret key corresponds to. */
export function agentPublicKey(agentSecretKey: Uint8Array): Uint8Array {
  return schnorr.getPublicKey(agentSecretKey);
}

export interface SignedSpend {
  unsigned: UnsignedSpend;
  signature: Uint8Array;
  tx: Transaction;
}

/**
 * Builds and signs a spend in one step.
 *
 * The signature is verified before it is returned. That costs a verification
 * per spend and catches a class of failure — wrong key, wrong digest — while
 * there is still a readable error to report, rather than as a rejection from
 * a node that will only say the script failed.
 */
export function signSpend(plan: SpendPlan, agentSecretKey: Uint8Array): SignedSpend {
  const unsigned = buildUnsignedSpend(plan);
  const signature = signDigest(unsigned.sighash, agentSecretKey);

  const pub = agentPublicKey(agentSecretKey);
  if (!verifyDigest(signature, unsigned.sighash, pub)) {
    throw new Error("signature failed to verify against its own digest");
  }

  return { unsigned, signature, tx: attachSignature(plan, unsigned, signature) };
}
