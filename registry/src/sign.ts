import { schnorr } from "@noble/curves/secp256k1.js";
import { toHex } from "@warda_protocol/core";
import { listingDigest, type ServiceManifest, type SignedServiceManifest } from "./manifest.ts";

/**
 * Sign a listing with the key the service is paid at.
 *
 * This is the operator's side, and it is deliberately the only thing they have
 * to do that involves a key. They already hold it — it is where their money
 * arrives — so listing costs them no new secret, no account, and no
 * relationship with this project.
 *
 * The signature is 64 bytes, NOT the 65-byte shape a Warda spend carries. See
 * SignedServiceManifest for why the two must never be the same length.
 */
export function signListing(m: ServiceManifest, secretKey: Uint8Array): SignedServiceManifest {
  if (secretKey.length !== 32) throw new Error("a secret key is 32 bytes");
  const pub = toHex(schnorr.getPublicKey(secretKey));
  if (pub !== m.payee.toLowerCase()) {
    throw new Error(
      `this key is not the payee in the manifest.\n` +
        `  manifest says: ${m.payee}\n` +
        `  this key is:   ${pub}\n` +
        `A listing signed by anything other than the key it is paid at proves nothing ` +
        `the registry can use, so it is refused here rather than at the registry.`,
    );
  }
  return { ...m, signature: toHex(schnorr.sign(listingDigest(m), secretKey)) };
}
