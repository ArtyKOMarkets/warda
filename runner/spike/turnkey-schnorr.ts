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

const wallet = await tk.createWallet!({
  walletName: `warda-spike-${Date.now()}`,
  accounts: [{
    curve: "CURVE_SECP256K1",
    pathFormat: "PATH_FORMAT_BIP32",
    path: "m/86'/1'/0'/0/0",
    addressFormat: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR",
  }],
});
const address: string = wallet.addresses[0];
const outputKey = taprootOutputKey(address);
console.log(`account      ${address}`);
console.log(`output key   ${hex(outputKey)}   <- what a grant would bake in as its agent key`);

for (const hashFunction of ["HASH_FUNCTION_NO_OP", "HASH_FUNCTION_NOT_APPLICABLE"]) {
  const digest = new Uint8Array(randomBytes(32));
  try {
    const r = await tk.signRawPayload!({
      signWith: address,
      payload: hex(digest),
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction,
    });
    const sig = Buffer.from(String(r.r) + String(r.s), "hex");
    const ok = sig.length === 64 && schnorr.verify(sig, digest, outputKey);
    console.log(`${hashFunction.padEnd(30)} ${sig.length} bytes  ${ok ? "PASS — BIP340 against the output key" : "FAIL"}`);
  } catch (e) {
    console.log(`${hashFunction.padEnd(30)} refused: ${(e as Error).message}`);
  }
}
