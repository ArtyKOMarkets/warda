/**
 * Sign and broadcast a transaction an MCP client assembled.
 *
 *   WARDA_SK=$(cat agent.key) node --experimental-strip-types \
 *     tools/finish-spend.ts built.json --rpc ws://127.0.0.1:18210 --submit
 *
 * ## The gap this closes
 *
 * `warda_build_spend` returns an unsigned transaction, a sighash to sign, and
 * instructions ending "splice it into the signature script in place of the 65
 * zero bytes". That is correct and deliberate: an MCP server that signed would
 * be a custodian, and the whole claim is that nothing sits between the agent
 * and the network.
 *
 * But nothing shipped did the splicing. An agent could ask what it may spend,
 * be told, build the transaction — and then stop, holding bytes it had no way
 * to complete. The refusal to sign was principled; the missing last step was
 * an omission.
 *
 * So this is the piece that belongs on the agent's own machine, next to its
 * key, which is exactly where the server refuses to be.
 *
 * ## Why it does not just take a signature
 *
 * It could accept a hex signature and splice it, leaving signing to whatever
 * holds the key. It does that too — `--signature` — but the common case is an
 * agent whose key is a file on the same box, and making that the awkward path
 * would push people toward pasting keys into a chat window to get them signed
 * somewhere else.
 */
import { readFileSync } from "node:fs";

import { fromHex, toHex } from "../src/bytes.ts";
import { NodeClient } from "../src/node.ts";
import { fromWire } from "../src/wire.ts";
import { signDigest, verifyDigest, agentPublicKey } from "../src/sign.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const path = process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!path) {
  console.error(
    "usage: finish-spend.ts <warda_build_spend output>.json [--signature hex] [--rpc url] [--submit]",
  );
  process.exit(2);
}
const built = JSON.parse(readFileSync(path, "utf8"));

if (built.built === false) {
  console.error(`this transaction was never built: ${built.error ?? "no reason given"}`);
  process.exit(1);
}
const sighashHex: string | undefined = built.sighashHex;
const tx = built.transaction;
if (!sighashHex || !tx) {
  console.error(
    "this file has no sighashHex and transaction. Pass the JSON that warda_build_spend returned,\n" +
      "not a manifest and not a receipt.",
  );
  process.exit(1);
}

// The advisory verdict travels with the build. Refusing to sign something the
// covenant will refuse is cheaper than finding out from a node, and much
// cheaper than finding out from a node that says "script units".
if (built.advisory && built.advisory.permitted === false) {
  console.error("the build's own advisory says this spend is not permitted:");
  for (const r of built.advisory.reasons ?? []) {
    console.error(`  ${r.code}: ${r.explanation}`);
  }
  console.error("\nNot signed. Pass --force to sign it anyway and let the network refuse it.");
  if (!process.argv.includes("--force")) process.exit(1);
}

let signature: Uint8Array;
const supplied = flag("signature");
if (supplied) {
  signature = fromHex(supplied);
  if (signature.length !== 65) {
    console.error(`a signature is 64 bytes plus the sighash type byte; got ${signature.length}`);
    process.exit(1);
  }
} else {
  const secretHex = process.env.WARDA_SK;
  if (!secretHex) {
    console.error(
      "WARDA_SK is not set and no --signature was given.\n" +
        "This is the agent's own key. It is used here and sent nowhere: the digest is signed\n" +
        "locally and only the signature goes into the transaction.",
    );
    process.exit(1);
  }
  const secret = fromHex(secretHex.trim());
  const digest = fromHex(sighashHex);
  const sig64 = signDigest(digest, secret);
  if (!verifyDigest(sig64, digest, agentPublicKey(secret))) {
    console.error("the signature did not verify against its own key — refusing to broadcast it");
    process.exit(1);
  }
  signature = new Uint8Array(65);
  signature.set(sig64, 0);
  signature[64] = 0x01; // SIGHASH_ALL
}

/**
 * The splice.
 *
 * The signature script is fixed-width and carries 65 zero bytes where the
 * signature goes, so nothing shifts. Located rather than assumed: the offset
 * depends on the covenant's argument order, and a hardcoded index would be
 * right until the day an entrypoint changed and then be wrong silently.
 */
const script = fromHex(tx.inputs[0].signatureScriptHex);
const hex = tx.inputs[0].signatureScriptHex as string;

/**
 * Finding the slot.
 *
 * Looking for 65 zero bytes alone is not enough: a covenant's signature script
 * carries the grant's state, and a fresh grant is mostly zeros — spentTotal,
 * reserved, epochIndex, epochSpent are all eight zero bytes each, and they sit
 * next to each other. The first real MCP build hit exactly that and this tool
 * refused rather than guess, which was the right refusal and a useless one.
 *
 * The push opcode disambiguates it. A 65-byte push is within the direct-push
 * range, so the placeholder is 0x41 followed by 65 zeros, and 0x41 is not a
 * value any adjacent state field can supply — the fields are 8 or 32 bytes and
 * are pushed with their own opcodes.
 */
const SLOT = "41" + "00".repeat(65);
const at = hex.indexOf(SLOT);
if (at < 0) {
  console.error(
    "no 65-byte zero push in the signature script — this transaction is already signed,\n" +
      "or it was not built by warda_build_spend.",
  );
  process.exit(1);
}
if (hex.indexOf(SLOT, at + 1) >= 0) {
  console.error(
    "more than one 65-byte zero push: which is the signature slot is ambiguous, and guessing\n" +
      "would produce a transaction that fails verification for no visible reason.",
  );
  process.exit(1);
}
// +1 byte for the opcode itself.
script.set(signature, at / 2 + 1);
tx.inputs[0].signatureScriptHex = toHex(script);

console.error(`signed  : input 0, signature spliced at byte ${at / 2 + 1}`);
console.error(`sighash : ${sighashHex}`);
if (built.successorScriptHash) {
  console.error(`moves to: script hash ${built.successorScriptHash}`);
}

process.stdout.write(JSON.stringify(tx, null, 2) + "\n");

if (process.argv.includes("--submit")) {
  const client = await NodeClient.connect({ url: flag("rpc") });
  try {
    // MCP returns the WIRE form; submitTransaction takes the internal one.
    const txid = await client.submitTransaction(fromWire(tx));
    console.error(`\nSUBMITTED: ${txid}`);
  } catch (e) {
    console.error(`\nNOT SUBMITTED: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    client.close();
  }
} else {
  console.error(`\n(not broadcast — add --submit)`);
}
