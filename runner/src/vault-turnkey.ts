/**
 * The agent key held by Turnkey — the runner never sees it at all.
 *
 * Proven by spike/turnkey-schnorr.ts on 22 September 2026: Turnkey's
 * `signRawPayload` with a Taproot (P2TR) account as `signWith` and
 * HASH_FUNCTION_NO_OP returns a 64-byte BIP340 signature over OUR 32-byte
 * digest, valid under the address's **tweaked output key**. Kaspa's covenant
 * checks a BIP340 signature against whatever x-only key the grant names, so a
 * grant whose agent key IS that output key is spendable by Turnkey and by
 * nothing else.
 *
 * (A Spark account also passed, untweaked. P2TR is used because it is the
 * standard, documented Schnorr path; Spark is the fallback if that changes.)
 *
 * Three checks make this safe to depend on:
 *
 * 1. At creation, one signature over a random digest must verify under the
 *    key read out of the address before the key is returned. A grant is
 *    never created for a key that has not been seen to sign.
 * 2. Every signature is verified against the grant's agent key before it
 *    leaves this file, as `externalSigner` does.
 * 3. "Could not find any resource to sign with" right after creation is
 *    Turnkey propagating the new account; it is retried, briefly. Any other
 *    refusal is not.
 */
import { randomBytes } from "node:crypto";
import { SIG_HASH_ALL, fromHex, toHex, verifyDigest } from "@warda_protocol/kaspa";
import type { Store } from "./store.ts";
import type { KeyVault, Signer } from "./vault.ts";

/** The two Turnkey calls this needs, typed structurally so tests can fake them. */
export interface TurnkeyApi {
  createWallet(a: {
    walletName: string;
    accounts: { curve: string; pathFormat: string; path: string; addressFormat: string }[];
  }): Promise<{ walletId: string; addresses: string[] }>;
  signRawPayload(a: {
    signWith: string;
    payload: string;
    encoding: string;
    hashFunction: string;
  }): Promise<{ r: string; s: string }>;
}

export interface TurnkeyVaultOptions {
  /** P2TR format. Only the bech32 prefix differs; the key and its tweak do not. */
  addressFormat?: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR" | "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR";
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
}

interface Ref {
  walletId: string;
  address: string;
}

/** The 32-byte witness program of a v1 segwit (P2TR) address: its output key. */
export function taprootOutputKey(address: string): Uint8Array {
  const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const sep = address.lastIndexOf("1");
  const data = address.slice(sep + 1).split("").map((c) => CH.indexOf(c));
  if (sep < 1 || data.some((d) => d < 0)) throw new Error(`not a bech32 address: ${address}`);
  if (data[0] !== 1) throw new Error(`${address} is not a Taproot (witness v1) address`);
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  for (const w of data.slice(1, -6)) {
    acc = ((acc << 5) | w) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  if (out.length !== 32) throw new Error(`${address} carries ${out.length} bytes, not a 32-byte output key`);
  return Uint8Array.from(out);
}

export class TurnkeyVault implements KeyVault {
  private readonly api: TurnkeyApi;
  private readonly store: Store;
  private readonly format: string;
  private readonly path: string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly retries: number;

  constructor(api: TurnkeyApi, store: Store, o: TurnkeyVaultOptions = {}) {
    this.api = api;
    this.store = store;
    this.format = o.addressFormat ?? "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR";
    this.path = this.format.includes("MAINNET") ? "m/86'/0'/0'/0/0" : "m/86'/1'/0'/0/0";
    this.now = o.now ?? Date.now;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.retries = o.retries ?? 5;
  }

  async create(agent: string): Promise<string> {
    if (await this.store.getVault(agent)) throw new Error(`agent ${agent} already has a key`);
    const w = await this.api.createWallet({
      walletName: `warda-${agent}`,
      accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: this.path, addressFormat: this.format }],
    });
    const address = w.addresses[0];
    if (!address) throw new Error("Turnkey created a wallet with no account");
    const key = taprootOutputKey(address);

    // Check 1: seen to sign before anything is built on it.
    const probe = new Uint8Array(randomBytes(32));
    const sig = await this.sign({ walletId: w.walletId, address }, probe);
    if (!verifyDigest(sig, probe, key)) {
      throw new Error(
        `Turnkey's signature from ${address} does not verify under the key in that address. ` +
          `No grant should be made for it; nothing has been stored.`,
      );
    }
    const publicKey = toHex(key);
    await this.store.putVault({
      agent,
      publicKey,
      provider: "turnkey",
      sealed: JSON.stringify({ walletId: w.walletId, address } satisfies Ref),
      createdAt: this.now(),
    });
    return publicKey;
  }

  async publicKey(agent: string): Promise<string | null> {
    return (await this.store.getVault(agent))?.publicKey ?? null;
  }

  async signer(agent: string): Promise<Signer> {
    const rec = await this.store.getVault(agent);
    if (!rec) throw new Error(`the runner holds no key for agent ${agent}`);
    if (rec.provider !== "turnkey") throw new Error(`agent ${agent}'s key is not held by Turnkey`);
    const ref = JSON.parse(rec.sealed) as Ref;
    const pub = fromHex(rec.publicKey);
    return async (digest) => {
      const sig = await this.sign(ref, digest);
      // Check 2.
      if (!verifyDigest(sig, digest, pub)) {
        throw new Error(`Turnkey signed with a key other than agent ${agent}'s; refusing to use it`);
      }
      return sig;
    };
  }

  private async sign(ref: Ref, digest: Uint8Array): Promise<Uint8Array> {
    if (digest.length !== 32) throw new Error(`a sighash is 32 bytes, got ${digest.length}`);
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await this.api.signRawPayload({
          signWith: ref.address,
          payload: toHex(digest),
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_NO_OP",
        });
        const rs = fromHex(r.r.padStart(64, "0") + r.s.padStart(64, "0"));
        const out = new Uint8Array(65);
        out.set(rs, 0);
        out[64] = SIG_HASH_ALL;
        return out;
      } catch (e) {
        // Check 3.
        if (/Could not find any resource/i.test((e as Error).message) && attempt < this.retries) {
          await this.sleep(1000 * attempt);
          continue;
        }
        throw e;
      }
    }
  }
}

/**
 * A client from the environment: TURNKEY_ORGANIZATION_ID,
 * TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY. Imported lazily so the
 * envelope vault and the tests never load Turnkey's SDK.
 */
export async function turnkeyFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<TurnkeyApi> {
  const need = (k: string) => {
    const v = env[k];
    if (!v) throw new Error(`${k} is not set`);
    return v;
  };
  const { Turnkey } = await import("@turnkey/sdk-server");
  const client = new Turnkey({
    apiBaseUrl: env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com",
    apiPublicKey: need("TURNKEY_API_PUBLIC_KEY"),
    apiPrivateKey: need("TURNKEY_API_PRIVATE_KEY"),
    defaultOrganizationId: need("TURNKEY_ORGANIZATION_ID"),
  }).apiClient();
  return client as unknown as TurnkeyApi;
}
