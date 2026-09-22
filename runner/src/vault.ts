/**
 * The agent key, and nothing else.
 *
 * The runner holds exactly one kind of key: an agent's. The covenant bounds
 * what that key can do, so the worst a breach of this vault can cost is what
 * the grants it holds could still spend — and the owner can revoke every one
 * of them without the runner. Principal and revocation keys never come here.
 *
 * `EnvelopeVault` seals a fresh 32-byte key per agent with AES-256-GCM under a
 * `MasterKey`. The master key is an interface so a cloud KMS replaces the
 * local one without touching this file. An MPC vault (see DESIGN.md and
 * spike/turnkey-schnorr.ts) implements the same `KeyVault`.
 *
 * Every signature is checked against the agent key on record before it is
 * returned, the same guarantee `externalSigner` gives: a vault that signs with
 * the wrong key fails here, in words, and not on chain after a fee.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { agentPublicKey, signDigest, verifyDigest, toHex, fromHex } from "@warda_protocol/kaspa";
import type { Store } from "./store.ts";

export type Signer = (digest: Uint8Array) => Promise<Uint8Array>;

export interface KeyVault {
  /** Creates the agent's key and returns its x-only public key, hex. */
  create(agent: string): Promise<string>;
  publicKey(agent: string): Promise<string | null>;
  signer(agent: string): Promise<Signer>;
}

export interface MasterKey {
  seal(plain: Uint8Array, context: string): Promise<Uint8Array>;
  open(sealed: Uint8Array, context: string): Promise<Uint8Array>;
}

/**
 * AES-256-GCM under a 32-byte key held by this process. For testnet and local
 * runs. `context` (the agent id) is bound as associated data, so a sealed key
 * copied onto another agent's record does not open.
 */
export function localMasterKey(key: Uint8Array): MasterKey {
  if (key.length !== 32) throw new Error(`a master key is 32 bytes, got ${key.length}`);
  return {
    async seal(plain, context) {
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", key, iv);
      c.setAAD(Buffer.from(context, "utf8"));
      const body = Buffer.concat([c.update(plain), c.final()]);
      return new Uint8Array(Buffer.concat([iv, c.getAuthTag(), body]));
    },
    async open(sealed, context) {
      const b = Buffer.from(sealed);
      const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
      d.setAAD(Buffer.from(context, "utf8"));
      d.setAuthTag(b.subarray(12, 28));
      return new Uint8Array(Buffer.concat([d.update(b.subarray(28)), d.final()]));
    },
  };
}

export class EnvelopeVault implements KeyVault {
  private readonly master: MasterKey;
  private readonly store: Store;
  private readonly now: () => number;

  constructor(master: MasterKey, store: Store, now: () => number = Date.now) {
    this.master = master;
    this.store = store;
    this.now = now;
  }

  async create(agent: string): Promise<string> {
    if (await this.store.getVault(agent)) throw new Error(`agent ${agent} already has a key`);
    const secret = new Uint8Array(randomBytes(32));
    try {
      const publicKey = toHex(agentPublicKey(secret));
      const sealed = await this.master.seal(secret, agent);
      await this.store.putVault({
        agent,
        publicKey,
        sealed: Buffer.from(sealed).toString("base64"),
        createdAt: this.now(),
      });
      return publicKey;
    } finally {
      secret.fill(0);
    }
  }

  async publicKey(agent: string): Promise<string | null> {
    return (await this.store.getVault(agent))?.publicKey ?? null;
  }

  async signer(agent: string): Promise<Signer> {
    const rec = await this.store.getVault(agent);
    if (!rec) throw new Error(`the runner holds no key for agent ${agent}`);
    const pub = fromHex(rec.publicKey);
    return async (digest) => {
      const secret = await this.master.open(new Uint8Array(Buffer.from(rec.sealed, "base64")), agent);
      try {
        const sig = signDigest(digest, secret);
        if (!verifyDigest(sig, digest, pub)) {
          throw new Error(`the vault's key for ${agent} does not match the public key on record`);
        }
        return sig;
      } finally {
        secret.fill(0);
      }
    };
  }
}
