import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { fromHex, verifyDigest } from "@warda_protocol/kaspa";
import { EnvelopeVault, localMasterKey } from "../src/vault.ts";
import { memoryStore } from "../src/store.ts";

test("a vault key signs sighashes the grant's agent key verifies", async () => {
  const store = memoryStore();
  const vault = new EnvelopeVault(localMasterKey(new Uint8Array(randomBytes(32))), store);
  const pub = await vault.create("agent-009");
  const digest = new Uint8Array(randomBytes(32));
  const sig = await (await vault.signer("agent-009"))(digest);
  assert.equal(sig.length, 65);
  assert.ok(verifyDigest(sig, digest, fromHex(pub)));
  assert.equal((await store.getVault("agent-009"))!.sealed.includes(pub), false);
});

test("a second key for the same agent is refused", async () => {
  const vault = new EnvelopeVault(localMasterKey(new Uint8Array(32)), memoryStore());
  await vault.create("a");
  await assert.rejects(vault.create("a"), /already has a key/);
});

test("a sealed key moved to another agent's record does not open", async () => {
  const store = memoryStore();
  const master = localMasterKey(new Uint8Array(randomBytes(32)));
  const vault = new EnvelopeVault(master, store);
  await vault.create("a");
  const rec = (await store.getVault("a"))!;
  await store.putVault({ ...rec, agent: "b" });
  await assert.rejects((await vault.signer("b"))(new Uint8Array(32)));
});

test("the wrong master key does not open anything", async () => {
  const store = memoryStore();
  await new EnvelopeVault(localMasterKey(new Uint8Array(randomBytes(32))), store).create("a");
  const other = new EnvelopeVault(localMasterKey(new Uint8Array(randomBytes(32))), store);
  await assert.rejects((await other.signer("a"))(new Uint8Array(32)));
});
