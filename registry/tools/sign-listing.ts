/**
 * Sign a service listing with the key the service is paid at.
 *
 *     node --experimental-strip-types registry/tools/sign-listing.ts \
 *       listing.json --key covenant/deploy/demo-vendor.key \
 *       > .well-known/warda-service.json
 *
 * `listing.json` is the manifest WITHOUT a signature. The output is what you
 * publish at https://your-domain/.well-known/warda-service.json.
 *
 * The key never leaves this process and never appears in the output. What it
 * emits is public by construction: a signature is meant to be read by
 * strangers, and everything else in the file is already on your website.
 *
 * It refuses more than it needs to, on purpose. Every refusal here is a
 * refusal the registry would make later, at a distance, to somebody who cannot
 * see why — and a listing that is invalid for an invisible reason is worse than
 * one that was never made.
 */
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";
import { toHex } from "@warda_protocol/core";
import { signListing, checkOrigin, wellKnownFor, type ServiceManifest } from "../src/index.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const keyAt = args.indexOf("--key");
const keyFile = keyAt >= 0 ? args[keyAt + 1] : undefined;

if (!file || !keyFile) {
  console.error(
    "sign-listing.ts <listing.json> --key <secret.key>\n\n" +
      "  <listing.json>  the manifest without a signature\n" +
      "  --key           32 bytes of hex: the secret for the payee in the manifest\n\n" +
      "Publish the output at <your endpoint's origin>/.well-known/warda-service.json",
  );
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(file, "utf8")) as ServiceManifest;
if ("signature" in manifest) {
  delete (manifest as Record<string, unknown>).signature;
}

const hex = readFileSync(keyFile, "utf8").trim();
if (!/^[0-9a-f]{64}$/i.test(hex)) {
  console.error(`${keyFile} is not 32 bytes of hex. A .pub file is not a secret key.`);
  process.exit(1);
}
const secret = Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));

/* Named before signing, because "this key is not the payee" is the single most
   likely mistake and the message it produces at the registry is far away from
   whoever can fix it. */
const derived = toHex(schnorr.getPublicKey(secret));
if (derived !== manifest.payee?.toLowerCase()) {
  console.error(
    `the key in ${keyFile} is not the payee this manifest names.\n` +
      `  manifest payee: ${manifest.payee}\n` +
      `  this key:       ${derived}\n` +
      `A listing is a statement by the key the service is PAID at. Any other key ` +
      `signs a statement nobody asked for.`,
  );
  process.exit(1);
}

/* Where this will have to be served from, checked now rather than discovered
   after publishing. The origin binding is not a formality: a manifest served
   anywhere else is a manifest anyone could have copied. */
const where = wellKnownFor(manifest.endpoint);
const originProblems = checkOrigin(manifest, where);
if (originProblems.length > 0) {
  console.error(`this manifest cannot be served anywhere that would satisfy the registry: ${originProblems.join(", ")}`);
  process.exit(1);
}

const signed = signListing(manifest, secret);
console.error(`signed by ${derived}\npublish this at:\n  ${where}`);
console.log(JSON.stringify(signed, null, 2));
