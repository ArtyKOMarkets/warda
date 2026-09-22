import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { fromHex, toHex, verifyDigest } from "@warda_protocol/kaspa";
import { memoryStore } from "../src/store.ts";
import { TurnkeyVault, taprootOutputKey, type TurnkeyApi } from "../src/vault-turnkey.ts";

const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
/** A P2TR-shaped address for a key. No checksum: the vault does not read one. */
function p2tr(key: Uint8Array): string {
  let acc = 0, bits = 0, out = "";
  for (const b of key) {
    acc = ((acc << 8) | b) & 0xffff;
    bits += 8;
    while (bits >= 5) { bits -= 5; out += CH[(acc >> bits) & 31]; }
  }
  if (bits) out += CH[(acc << (5 - bits)) & 31];
  return "tb1p" + out + "qqqqqq";
}

/** Turnkey as observed: signs a raw digest with BIP340 under the address's key. */
function fakeTurnkey(o: { notFoundFor?: number; wrongKey?: boolean } = {}) {
  const secret = new Uint8Array(randomBytes(32));
  const address = p2tr(schnorr.getPublicKey(secret));
  let misses = o.notFoundFor ?? 0;
  const calls: string[] = [];
  const api: TurnkeyApi = {
    async createWallet() {
      calls.push("createWallet");
      return { walletId: "w1", addresses: [address] };
    },
    async signRawPayload(a) {
      calls.push(`sign:${a.hashFunction}`);
      assert.equal(a.signWith, address);
      if (misses-- > 0) throw new Error("Turnkey error 5: Could not find any resource to sign with.");
      const key = o.wrongKey ? new Uint8Array(randomBytes(32)) : secret;
      const sig = schnorr.sign(fromHex(a.payload), key);
      return { r: toHex(sig.subarray(0, 32)), s: toHex(sig.subarray(32)) };
    },
  };
  return { api, address, calls };
}

const quick = { sleep: async () => {} };

test("the output key is read out of a Taproot address", () => {
  const key = new Uint8Array(randomBytes(32));
  assert.equal(toHex(taprootOutputKey(p2tr(key))), toHex(key));
  // The address the spike produced, and the output key it printed.
  assert.equal(
    toHex(taprootOutputKey("tb1pe3cvffhstv9q4jg44r6lse8v9dz68xem0yj24razqwd37njm0kqs88wvk2")),
    "cc70c4a6f05b0a0ac915a8f5f864ec2b45a39b3b7924aa8fa2039b1f4e5b7d81",
  );
  assert.throws(() => taprootOutputKey("tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx"), /not a Taproot/);
});

test("a Turnkey-held key signs sighashes the grant's agent key verifies", async () => {
  const t = fakeTurnkey();
  const store = memoryStore();
  const vault = new TurnkeyVault(t.api, store, quick);
  const pub = await vault.create("agent-010");
  assert.equal(pub, toHex(taprootOutputKey(t.address)));
  const rec = (await store.getVault("agent-010"))!;
  assert.equal(rec.provider, "turnkey");
  assert.doesNotMatch(rec.sealed, /secret|private/i);
  const digest = new Uint8Array(randomBytes(32));
  const sig = await (await vault.signer("agent-010"))(digest);
  assert.equal(sig.length, 65);
  assert.equal(sig[64], 1);
  assert.ok(verifyDigest(sig, digest, fromHex(pub)));
});

test("a new account that is still propagating is retried, briefly", async () => {
  const t = fakeTurnkey({ notFoundFor: 2 });
  const vault = new TurnkeyVault(t.api, memoryStore(), quick);
  await vault.create("a");
  assert.equal(t.calls.filter((c) => c.startsWith("sign")).length, 3);
});

test("a key that has not been seen to sign is never stored", async () => {
  const t = fakeTurnkey({ wrongKey: true });
  const store = memoryStore();
  await assert.rejects(new TurnkeyVault(t.api, store, quick).create("a"), /does not verify/);
  assert.equal(await store.getVault("a"), null);
});

test("each vault refuses the other's records", async () => {
  const t = fakeTurnkey();
  const store = memoryStore();
  await new TurnkeyVault(t.api, store, quick).create("a");
  const { EnvelopeVault, localMasterKey } = await import("../src/vault.ts");
  await assert.rejects(new EnvelopeVault(localMasterKey(new Uint8Array(32)), store).signer("a"), /held by turnkey/);
});
