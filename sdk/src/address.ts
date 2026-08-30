/**
 * Kaspa addresses: the last thing standing between a state and a query.
 *
 * A grant's address is derived from its state, and until now this package
 * could produce the script hash but not the address string a node wants — so
 * watching a grant still needed something else. This closes that.
 *
 * It is bech32 in shape and not in detail. Three differences:
 *
 *   - the checksum is 8 characters, not 6, and its polymod uses BCH generator
 *     constants (0x98f2bc8e61 and friends) over a 40-bit register;
 *   - the prefix is folded in as `c & 0x1f` per character with a single zero
 *     separator, not the bech32 high/low split;
 *   - the version byte is part of the payload rather than a separate field:
 *     0 for P2PK, 1 for ECDSA, and 8 for P2SH — which is where a grant lives.
 *
 * Encoding is the operation this package needs; decoding exists so that an
 * address handed in from elsewhere can be checked against a derived script
 * hash rather than trusted.
 */

import { fromHex, toHex } from "./bytes.ts";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

export type NetworkPrefix = "kaspa" | "kaspatest" | "kaspasim" | "kaspadev";

/** A const object rather than an enum: node's --experimental-strip-types
 *  erases types without rewriting syntax, and an enum emits code. */
export const AddressVersion = {
  PubKey: 0,
  PubKeyECDSA: 1,
  ScriptHash: 8,
} as const;

export type AddressVersion = (typeof AddressVersion)[keyof typeof AddressVersion];

const GENERATORS = [
  0x98f2bc8e61n,
  0x79b76d99e2n,
  0xf33e5fb3c4n,
  0xae2eabe2a8n,
  0x1e4f43e470n,
];

function polymod(values: Iterable<number>): bigint {
  let c = 1n;
  for (const d of values) {
    const c0 = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    for (let i = 0; i < 5; i++) {
      if ((c0 >> BigInt(i)) & 1n) c ^= GENERATORS[i]!;
    }
  }
  return c ^ 1n;
}

function prefixToFive(prefix: string): number[] {
  return Array.from(prefix, (ch) => ch.charCodeAt(0) & 0x1f);
}

function checksum(payloadFive: number[], prefix: string): bigint {
  return polymod([...prefixToFive(prefix), 0, ...payloadFive, 0, 0, 0, 0, 0, 0, 0, 0]);
}

/** 8-bit to 5-bit, right-padded. */
function conv8to5(bytes: Uint8Array | number[]): number[] {
  const src = Array.from(bytes);
  const out: number[] = [];
  let buff = 0;
  let bits = 0;
  for (const c of src) {
    buff = (buff << 8) | c;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((buff >> bits) & 0x1f);
      buff &= (1 << bits) - 1;
    }
  }
  if (bits > 0) out.push((buff << (5 - bits)) & 0x1f);
  return out;
}

/** 5-bit to 8-bit, discarding right-hand padding. */
function conv5to8(five: number[]): Uint8Array {
  const out = new Uint8Array(Math.floor((five.length * 5) / 8));
  let at = 0;
  let buff = 0;
  let bits = 0;
  for (const c of five) {
    buff = (buff << 5) | c;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out[at++] = (buff >> bits) & 0xff;
      buff &= (1 << bits) - 1;
    }
  }
  return out;
}

export function encodeAddress(
  prefix: NetworkPrefix,
  version: AddressVersion,
  payload: Uint8Array,
): string {
  const five = conv8to5([version, ...payload]);
  const sum = checksum(five, prefix);
  // The checksum contributes its low 5 bytes: `to_be_bytes()[3..]`.
  const sumBytes = new Uint8Array(5);
  for (let i = 0; i < 5; i++) sumBytes[4 - i] = Number((sum >> BigInt(i * 8)) & 0xffn);
  const body = [...five, ...conv8to5(sumBytes)].map((c) => CHARSET[c]!).join("");
  return `${prefix}:${body}`;
}

export interface DecodedAddress {
  prefix: NetworkPrefix;
  version: AddressVersion;
  payload: Uint8Array;
}

export function decodeAddress(address: string): DecodedAddress {
  const colon = address.indexOf(":");
  if (colon < 0) throw new Error(`address has no network prefix: ${address}`);
  const prefix = address.slice(0, colon) as NetworkPrefix;
  const body = address.slice(colon + 1);
  if (body.length < 9) throw new Error(`address payload too short: ${address}`);

  const five: number[] = [];
  for (const ch of body) {
    const i = CHARSET.indexOf(ch);
    if (i < 0) throw new Error(`not a valid address character: '${ch}'`);
    five.push(i);
  }

  const payloadFive = five.slice(0, -8);
  const checkFive = five.slice(-8);
  const expected = BigInt("0x" + toHex(conv5to8(checkFive)));
  if (checksum(payloadFive, prefix) !== expected) {
    throw new Error(`address checksum does not verify: ${address}`);
  }

  const bytes = conv5to8(payloadFive);
  return { prefix, version: bytes[0] as AddressVersion, payload: bytes.slice(1) };
}

/**
 * The address a grant lives at, from the hash of its compiled covenant.
 *
 * `scriptHashFor(template, grant)` gives the hash; this turns it into
 * something a node will answer questions about. The pair is the whole reason
 * an application can watch a grant without a Silverscript compiler.
 */
export function scriptHashToAddress(
  scriptHash: Uint8Array | string,
  prefix: NetworkPrefix,
): string {
  // `scriptHashFor` returns hex; accepting both saves a conversion at every
  // call site and removes the one mistake that would otherwise be silent.
  const bytes = typeof scriptHash === "string" ? fromHex(scriptHash) : scriptHash;
  if (bytes.length !== 32) throw new Error(`a script hash is 32 bytes, got ${bytes.length}`);
  return encodeAddress(prefix, AddressVersion.ScriptHash, bytes);
}

/** The x-only key form, for recipients and for the principal's own wallet. */
export function pubkeyToAddress(xonly: Uint8Array, prefix: NetworkPrefix): string {
  if (xonly.length !== 32) throw new Error(`an x-only public key is 32 bytes, got ${xonly.length}`);
  return encodeAddress(prefix, AddressVersion.PubKey, xonly);
}
