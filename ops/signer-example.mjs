#!/usr/bin/env node
/**
 * The simplest possible external signer, and a template for a real one.
 *
 *     warda pay $URL --signer "node ops/signer-example.mjs agent.key"
 *
 * The contract is the whole point and it is three lines long:
 *
 *   in    64 hex characters on stdin — the digest, and nothing else
 *   out   128 hex characters on stdout — a BIP340 signature, and nothing else
 *   else  diagnostics on STDERR. Anything on stdout that is not the
 *         signature is read as the signature and rejected.
 *
 * This one keeps the key in a file, which is exactly what --signer exists to
 * avoid, so it is a demonstration rather than a recommendation. Replace the
 * middle line with whatever actually holds your key:
 *
 *   aws kms sign --key-id "$KEY" --message fileb:///dev/stdin \
 *     --message-type DIGEST --signing-algorithm ECDSA_SHA_256
 *   turnkey sign-raw-payload --payload "$DIGEST" --encoding HEXADECIMAL
 *   vault write -field=signature transit/sign/agent input="$B64"
 *
 * Note what this file does NOT do: it does not append the sighash-type byte,
 * and it does not know what it is signing. Warda adds the 65th byte and
 * verifies the result against the public key the grant names before building
 * anything around it — so a signer holding the wrong key fails here, cheaply,
 * rather than as a transaction the network refused.
 */
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1.js";

const keyPath = process.argv[2];
if (!keyPath) {
  console.error("usage: signer-example.mjs <key-file>   (hex secret key, one line)");
  process.exit(2);
}

const hex = (b) => Buffer.from(b).toString("hex");
const bytes = (s) => Uint8Array.from(Buffer.from(s, "hex"));

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const digest = input.trim();
  if (!/^[0-9a-f]{64}$/i.test(digest)) {
    // stderr, not stdout: stdout is the signature channel and nothing else.
    console.error(`expected a 32-byte digest as hex, got ${digest.length} characters`);
    process.exit(1);
  }
  const sk = bytes(readFileSync(keyPath, "utf8").trim());
  process.stdout.write(hex(schnorr.sign(bytes(digest), sk)) + "\n");
});
