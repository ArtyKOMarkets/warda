/**
 * The vault: one key, encrypted at rest, unwrapped only in the worker.
 *
 * ## What is in here, and what deliberately is not
 *
 * ONE secret: the principal key. In Warda it is principal, revocation and
 * funder at once — it receives what comes back on exit, it is the only key
 * that can end a grant, and it pays for genesis. It is also the only key in
 * the protocol that nothing bounds, which is exactly why it is worth
 * protecting properly and why it is the only thing this extension holds.
 *
 * AGENT keys are not stored. An agent key is generated when a grant is issued,
 * shown once, and handed to whoever runs the agent. That is not a
 * simplification to be fixed later: an agent's key is already bounded by a
 * covenant the network enforces, so it can live on the machine that spends it,
 * and putting it here would put the bounded and the unbounded key behind the
 * same passphrase for no gain.
 *
 * ## Why the unlocked key goes in storage.session and not a variable
 *
 * An MV3 service worker is terminated after ~30 seconds idle. A module-level
 * variable therefore locks the wallet every time the user looks away — not
 * security, just a passphrase prompt every thirty seconds, which teaches the
 * habit of typing it without reading the screen.
 *
 * `chrome.storage.session` is Chrome's answer: in memory, never written to
 * disk, cleared when the browser closes. `setAccessLevel(TRUSTED_CONTEXTS)`
 * is the default and is set explicitly anyway, because the value of that line
 * is that someone changing it has to mean it.
 *
 * ## Parameters
 *
 * PBKDF2-SHA256 at 600,000 iterations is OWASP's floor, and it is a floor
 * rather than a target: it is what WebCrypto offers everywhere without a wasm
 * dependency, and a wasm dependency in a wallet is a supply chain in a wallet.
 * Argon2id would be better and is the first thing to revisit.
 */

const VERSION = 1;
const ITERATIONS = 600_000;
const VAULT_KEY = "vault";
const SESSION_KEY = "unlocked";
const LOCK_ALARM = "warda-autolock";

/** Minutes of no activity before the key is dropped. */
export const DEFAULT_LOCK_MINUTES = 15;

export interface VaultBlob {
  v: number;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
  /** The public key, kept in the clear so a locked console can still show whose it is. */
  publicKey: string;
  createdAt: string;
}

const enc = new TextEncoder();

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function fromHex(h: string): Uint8Array {
  if (h.length % 2 !== 0) throw new Error("odd-length hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function readVault(): Promise<VaultBlob | null> {
  const got = await chrome.storage.local.get(VAULT_KEY);
  return (got[VAULT_KEY] as VaultBlob | undefined) ?? null;
}

export async function hasVault(): Promise<boolean> {
  return (await readVault()) !== null;
}

/**
 * Create the vault. `secret` is the 32-byte principal key.
 *
 * Refuses to overwrite. A console that silently replaced an existing vault
 * would destroy the only key that can revoke every grant it ever issued, and
 * the user would find out at the moment they most needed it.
 */
export async function create(secret: Uint8Array, publicKey: string, passphrase: string): Promise<VaultBlob> {
  if (secret.length !== 32) throw new Error(`a principal key is 32 bytes; got ${secret.length}`);
  if (await hasVault()) {
    throw new Error(
      "this console already holds a principal key. Replacing it would destroy the only key " +
        "that can end the grants it issued. Remove it deliberately first.",
    );
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, secret as BufferSource),
  );
  const blob: VaultBlob = {
    v: VERSION,
    kdf: "PBKDF2-SHA256",
    iterations: ITERATIONS,
    salt: toHex(salt),
    iv: toHex(iv),
    ciphertext: toHex(ct),
    publicKey,
    createdAt: new Date().toISOString(),
  };
  await chrome.storage.local.set({ [VAULT_KEY]: blob });
  return blob;
}

/** Wrong passphrase and corrupt vault are the same observation: the tag fails. */
export async function unlock(passphrase: string, lockMinutes = DEFAULT_LOCK_MINUTES): Promise<string> {
  const blob = await readVault();
  if (!blob) throw new Error("there is no key in this console yet");
  const key = await deriveKey(passphrase, fromHex(blob.salt), blob.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(blob.iv) as BufferSource },
      key,
      fromHex(blob.ciphertext) as BufferSource,
    );
  } catch {
    throw new Error("that passphrase does not open this vault");
  }
  const secret = new Uint8Array(plain);
  await chrome.storage.session.set({ [SESSION_KEY]: toHex(secret) });
  secret.fill(0);
  await touch(lockMinutes);
  return blob.publicKey;
}

/**
 * The unlocked secret, or null.
 *
 * Everything that signs goes through here, in the worker. Nothing returns it
 * across a message boundary — see `messages.ts` for why that is structural
 * rather than a convention.
 */
export async function secret(): Promise<Uint8Array | null> {
  const got = await chrome.storage.session.get(SESSION_KEY);
  const hex = got[SESSION_KEY] as string | undefined;
  return hex ? fromHex(hex) : null;
}

export async function isUnlocked(): Promise<boolean> {
  return (await secret()) !== null;
}

export async function lock(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.alarms.clear(LOCK_ALARM);
}

/** Push the auto-lock out. Called on every message from the UI. */
export async function touch(lockMinutes = DEFAULT_LOCK_MINUTES): Promise<void> {
  if (!(await isUnlocked())) return;
  await chrome.alarms.create(LOCK_ALARM, { delayInMinutes: lockMinutes });
}

export function isLockAlarm(name: string): boolean {
  return name === LOCK_ALARM;
}

/**
 * Called once on startup. The access level is already the default; setting it
 * explicitly means a future change to it is a diff somebody has to write.
 */
export async function harden(): Promise<void> {
  await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
}

/** Deleting the vault is deliberate and destructive; the caller confirms. */
export async function destroy(): Promise<void> {
  await lock();
  await chrome.storage.local.remove(VAULT_KEY);
}
