/**
 * Signing without holding the key.
 *
 * Every test here is the same worry from a different side: an external signer
 * is a stranger, and the only thing that makes trusting one safe is checking
 * what it hands back BEFORE a transaction is built around it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { schnorr } from "@noble/curves/secp256k1.js";

import { agentPublicKey, externalSigner, fromHex, toHex, verifyDigest } from "../src/index.ts";

const SK = fromHex("11".repeat(32));
const PUB = agentPublicKey(SK);
const OTHER = fromHex("22".repeat(32));
const OTHER_PUB = agentPublicKey(OTHER);
const DIGEST = fromHex("ab".repeat(32));

/** A signer that behaves. */
const honest = (sk: Uint8Array) => async (hex: string) => toHex(schnorr.sign(fromHex(hex.trim()), sk));

test("a signature from the right key is returned", async () => {
  const sign = externalSigner({ command: "unused", publicKey: PUB, run: honest(SK) });
  const sig = await sign(DIGEST);
  assert.equal(sig.length, 65, "BIP340 plus the sighash-type byte");
  assert.ok(verifyDigest(sig, DIGEST, PUB));
});

test("the public key may be given as hex, as the manifest carries it", async () => {
  const sign = externalSigner({ command: "unused", publicKey: toHex(PUB), run: honest(SK) });
  assert.ok(verifyDigest(await sign(DIGEST), DIGEST, PUB));
});

test("the digest reaches the signer as hex, and nothing else does", async () => {
  let seen = "";
  const sign = externalSigner({
    command: "unused", publicKey: PUB,
    run: async (input) => { seen = input; return toHex(schnorr.sign(fromHex(input.trim()), SK)); },
  });
  await sign(DIGEST);
  assert.equal(seen.trim(), toHex(DIGEST));
});

/**
 * The one that matters. A signer holding the wrong key produces a perfectly
 * well-formed signature, and without this check the first sign of trouble is
 * a transaction the network refused — after a fee, and looking like a
 * covenant bug rather than a misconfigured signer.
 */
test("a signature from the WRONG key is refused, before anything is built", async () => {
  const sign = externalSigner({ command: "unused", publicKey: PUB, run: honest(OTHER) });
  await assert.rejects(() => sign(DIGEST), (e: Error) => {
    assert.match(e.message, /not this agent's/);
    assert.match(e.message, /Nothing was broadcast/);
    return true;
  });
  // And it really was a valid signature — just somebody else's.
  const theirs = fromHex(await honest(OTHER)(toHex(DIGEST)));
  assert.ok(verifyDigest(new Uint8Array([...theirs, 1]), DIGEST, OTHER_PUB));
});

test("output that is not a signature is reported with what was printed", async () => {
  const sign = externalSigner({
    command: "kms-sign --key x", publicKey: PUB,
    run: async () => "error: could not assume role\n",
  });
  await assert.rejects(() => sign(DIGEST), (e: Error) => {
    assert.match(e.message, /did not return a signature/);
    assert.match(e.message, /could not assume role/);
    // The likeliest cause of a signer that "works but prints junk".
    assert.match(e.message, /diagnostics to stderr/);
    return true;
  });
});

test("silence is reported as silence, not as a parse error", async () => {
  const sign = externalSigner({ command: "x", publicKey: PUB, run: async () => "" });
  await assert.rejects(() => sign(DIGEST), (e: Error) => /\(nothing\)/.test(e.message));
});

test("trailing whitespace from a shell is tolerated", async () => {
  const sign = externalSigner({
    command: "x", publicKey: PUB,
    run: async (i) => "  " + toHex(schnorr.sign(fromHex(i.trim()), SK)) + "  \n\n",
  });
  assert.ok(verifyDigest(await sign(DIGEST), DIGEST, PUB));
});

test("a public key of the wrong size is refused at construction, not at signing", () => {
  assert.throws(
    () => externalSigner({ command: "x", publicKey: fromHex("aa".repeat(33)), run: honest(SK) }),
    /x-only public key \(32 bytes\); got 33/,
  );
});
