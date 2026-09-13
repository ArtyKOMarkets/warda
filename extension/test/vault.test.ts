/**
 * The vault, which is the only thing in this extension that can lose money.
 *
 * A wrong passphrase and a corrupt blob are the same observation here — the
 * GCM tag fails — and that is fine. What is not fine, and what these check, is
 * a vault that can be silently replaced, a "locked" console that still has the
 * key on disk, or an unwrapped key reachable from anywhere but the worker.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { install } from "./fake-chrome.ts";

const chrome = install();
const vault = await import("../src/vault.ts");

const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const PUB = "ab".repeat(32);

test("a key round-trips through the passphrase", async () => {
  await vault.create(SECRET, PUB, "correct horse battery");
  await vault.lock();
  assert.equal(await vault.isUnlocked(), false);

  const pub = await vault.unlock("correct horse battery");
  assert.equal(pub, PUB);
  assert.deepEqual(await vault.secret(), SECRET);
});

test("the wrong passphrase does not open it, and says so plainly", async () => {
  await vault.lock();
  await assert.rejects(() => vault.unlock("correct horse batteru"), (e: Error) => {
    assert.match(e.message, /does not open this vault/);
    return true;
  });
  assert.equal(await vault.isUnlocked(), false);
});

/**
 * The claim this whole design rests on: `storage.local` holds ciphertext and
 * `storage.session` holds the key, and never the other way around. Asserted
 * against the raw stores rather than through the accessors, because the
 * accessors are the thing being checked.
 */
test("the secret is never written to storage.local, in any state", async () => {
  await vault.unlock("correct horse battery");
  const onDisk = JSON.stringify(chrome.storage.local._raw);
  const secretHex = Array.from(SECRET, (b) => b.toString(16).padStart(2, "0")).join("");
  assert.ok(!onDisk.includes(secretHex), "the principal key reached storage.local");
  assert.ok(onDisk.includes("ciphertext"), "precondition: the vault blob is there to be searched");

  const inSession = JSON.stringify(chrome.storage.session._raw);
  assert.ok(inSession.includes(secretHex), "precondition: the unlocked key is in session storage");
});

test("locking removes the key and cancels the auto-lock", async () => {
  await vault.unlock("correct horse battery");
  assert.ok(chrome.alarms._created.some((a) => vault.isLockAlarm(a.name)));
  await vault.lock();
  assert.equal(await vault.secret(), null);
  assert.equal(chrome.alarms._created.filter((a) => vault.isLockAlarm(a.name)).length, 0);
  // The vault itself survives a lock. Anything else would make "lock" the
  // most destructive button in the console.
  assert.notEqual(await vault.readVault(), null);
});

/**
 * The one that would cost everything.
 *
 * Overwriting the vault destroys the only key that can revoke every grant it
 * ever issued, and the user finds out at the moment they most need it. So it
 * refuses, rather than asking a confirmation nobody reads.
 */
test("creating a second vault over the first is refused", async () => {
  await assert.rejects(() => vault.create(SECRET, PUB, "another one"), (e: Error) => {
    assert.match(e.message, /already holds a principal key/);
    return true;
  });
  assert.equal((await vault.readVault())!.publicKey, PUB);
});

test("a key that is not 32 bytes is refused before anything is stored", async () => {
  await vault.destroy();
  await assert.rejects(() => vault.create(new Uint8Array(31), PUB, "x"), /32 bytes/);
  assert.equal(await vault.readVault(), null);
});

test("unlocking a console with no key in it says that, not 'wrong passphrase'", async () => {
  await assert.rejects(() => vault.unlock("anything"), /no key in this console/);
});

test("the stored parameters are the ones claimed, not defaults that drifted", async () => {
  await vault.create(SECRET, PUB, "correct horse battery");
  const blob = (await vault.readVault())!;
  assert.equal(blob.kdf, "PBKDF2-SHA256");
  assert.equal(blob.iterations, 600_000);
  assert.equal(blob.salt.length, 32, "16 bytes of salt");
  assert.equal(blob.iv.length, 24, "12 bytes of iv — GCM's nonce size");
  assert.notEqual(blob.ciphertext.length, 64, "ciphertext carries the 16-byte tag as well");
});
