/**
 * SPIKE — can Turnkey sign a Kaspa sighash?
 *
 * Kaspa signs a raw 32-byte sighash with BIP340 Schnorr. Turnkey's raw
 * signing is ECDSA; its Schnorr is reached through Taproot (P2TR) accounts,
 * where it tweaks the key before signing. If a P2TR account signs our digest
 * and the signature verifies against the address's OUTPUT key, then a grant
 * whose agent key IS that output key can be spent by Turnkey — and the runner
 * never holds the agent key at all.
 *
 * Run (needs a Turnkey organisation and an API key pair; free tier is fine):
 *
 *   cd runner/spike && npm init -y >/dev/null && npm i @turnkey/sdk-server
 *   TURNKEY_ORGANIZATION_ID=… TURNKEY_KEY_FILE=~/Downloads/key.json \
 *     node --experimental-strip-types turnkey-schnorr.ts
 *
 * or TURNKEY_API_PUBLIC_KEY / TURNKEY_API_PRIVATE_KEY in place of the file.
 *
 * PASS means: build TurnkeyVault. FAIL means: EnvelopeVault + KMS to mainnet.
 * The Turnkey call names below are from their docs and have NOT been run here.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { schnorr } from "@noble/curves/secp256k1.js";

/* Keys can come from the JSON file the dashboard gives you (TURNKEY_KEY_FILE)
   or from the environment. The file's field names are matched loosely, and
   only the field NAMES are ever printed — never a value. */
const fromFile: Record<string, string> = {};
if (process.env.TURNKEY_KEY_FILE) {
  const raw = JSON.parse(readFileSync(process.env.TURNKEY_KEY_FILE.replace(/^~/, homedir()), "utf8"));
  const flat = (o: unknown, out: Record<string, string>) => {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") out[k.toLowerCase().replace(/[^a-z]/g, "")] = v; else flat(v, out);
    }
    return out;
  };
  const f = flat(raw, {});
  const pick = (...names: string[]) => names.map((n) => f[n]).find(Boolean);
  const pub = pick("apipublickey", "publickey", "public");
  const priv = pick("apiprivatekey", "privatekey", "private");
  const org = pick("organizationid", "orgid", "defaultorganizationid");
  if (pub) fromFile.TURNKEY_API_PUBLIC_KEY = pub;
  if (priv) fromFile.TURNKEY_API_PRIVATE_KEY = priv;
  if (org) fromFile.TURNKEY_ORGANIZATION_ID = org;
  console.log(`key file fields: ${Object.keys(f).join(", ")}`);
}
const need = (k: string) => {
  const v = process.env[k] || fromFile[k];
  if (!v) throw new Error(`set ${k} (or put it in the file TURNKEY_KEY_FILE points at)`);
  return v;
};

/** bech32m decode of a tb1p/bc1p address to its 32-byte witness program. */
function taprootOutputKey(addr: string): Uint8Array {
  const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = addr.slice(addr.lastIndexOf("1") + 1).split("").map((c) => CH.indexOf(c));
  if (data.some((d) => d < 0)) throw new Error(`not bech32: ${addr}`);
  const words = data.slice(1, -6); // drop the witness version and the checksum
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  if (out.length !== 32) throw new Error(`witness program is ${out.length} bytes, expected 32`);
  return Uint8Array.from(out);
}

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

const { Turnkey } = (await import("@turnkey/sdk-server" as string)) as {
  Turnkey: new (o: Record<string, string>) => { apiClient(): Record<string, (a: unknown) => Promise<any>> };
};
const tk = new Turnkey({
  apiBaseUrl: "https://api.turnkey.com",
  apiPublicKey: need("TURNKEY_API_PUBLIC_KEY"),
  apiPrivateKey: need("TURNKEY_API_PRIVATE_KEY"),
  defaultOrganizationId: need("TURNKEY_ORGANIZATION_ID"),
}).apiClient();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* Three ways Turnkey might produce a BIP340 signature over OUR digest:
     P2TR   — tweaked key, checked against the address's output key
     SPARK  — Spark is Schnorr-native; maybe raw, untweaked
   Each signature is checked against every key it could verify under: the
   account's own x-only key and, for P2TR, the output key in the address. */
const FORMATS = [
  { format: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR", path: "m/86'/1'/0'/0/0" },
  { format: "ADDRESS_FORMAT_SPARK_REGTEST", path: "m/8797555'/0'/0'/0'" },
];

const wallet = await tk.createWallet!({
  walletName: `warda-spike-${Date.now()}`,
  accounts: FORMATS.map((f) => ({
    curve: "CURVE_SECP256K1",
    pathFormat: "PATH_FORMAT_BIP32",
    path: f.path,
    addressFormat: f.format,
  })),
}).catch((e: Error) => {
  console.log(`createWallet with both formats refused (${e.message}); retrying with P2TR only`);
  return tk.createWallet!({
    walletName: `warda-spike-${Date.now()}`,
    accounts: [{ curve: "CURVE_SECP256K1", pathFormat: "PATH_FORMAT_BIP32", path: FORMATS[0]!.path, addressFormat: FORMATS[0]!.format }],
  });
});
console.log(`wallet       ${wallet.walletId}`);
await sleep(3000);
const { accounts } = await tk.getWalletAccounts!({ walletId: wallet.walletId });

for (const acct of accounts as { address: string; publicKey?: string; addressFormat: string }[]) {
  console.log(`\n${acct.addressFormat}`);
  console.log(`  address    ${acct.address}`);
  const keys: [string, Uint8Array][] = [];
  if (acct.publicKey) {
    const pk = Buffer.from(acct.publicKey, "hex");
    keys.push(["account key (untweaked)", pk.length === 33 ? pk.subarray(1) : pk]);
    console.log(`  public key ${acct.publicKey}`);
  }
  if (acct.address.startsWith("tb1p") || acct.address.startsWith("bc1p")) {
    const q = taprootOutputKey(acct.address);
    keys.push(["taproot output key", q]);
    console.log(`  output key ${hex(q)}`);
  }
  for (const signWith of [acct.address, acct.publicKey].filter(Boolean) as string[]) {
    const digest = new Uint8Array(randomBytes(32));
    let r: { r: string; s: string; v?: string } | null = null;
    for (let attempt = 1; attempt <= 5 && !r; attempt++) {
      try {
        r = await tk.signRawPayload!({
          signWith,
          payload: hex(digest),
          encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
          hashFunction: "HASH_FUNCTION_NO_OP",
        });
      } catch (e) {
        const m = (e as Error).message;
        if (/Could not find any resource/.test(m) && attempt < 5) { await sleep(2000); continue; }
        console.log(`  signWith ${signWith === acct.address ? "address" : "public key"}: refused — ${m}`);
        break;
      }
    }
    if (!r) continue;
    const sig = Buffer.from(String(r.r) + String(r.s), "hex");
    const hits = keys.filter(([, k]) => sig.length === 64 && k.length === 32 && schnorr.verify(sig, digest, k)).map(([n]) => n);
    console.log(
      `  signWith ${signWith === acct.address ? "address   " : "public key"}: ${sig.length} bytes, v=${r.v ?? "-"}  ` +
        (hits.length ? `PASS — BIP340 verifies against the ${hits.join(" and ")}` : "FAIL — not a BIP340 signature under any of these keys"),
    );
  }
}
