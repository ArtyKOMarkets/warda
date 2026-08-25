import { createHash } from "node:crypto";

/**
 * PLACEHOLDER HASH.
 *
 * Kaspa uses blake2b-256 with domain separation. Node's crypto exposes
 * blake2b512; truncating it is NOT equivalent to blake2b-256, because the
 * two are parameterised differently in the IV.
 *
 * This is deliberately pluggable. Before ANY on-chain work, swap this for
 * the exact hash Kaspa's script engine uses, then regenerate the test
 * vectors. Every grant_id and merkle root in this repo changes when you do.
 */
export type Hasher = (data: Uint8Array) => Uint8Array;

export const placeholderBlake2b256: Hasher = (data) => {
  const h = createHash("blake2b512");
  h.update(data);
  return new Uint8Array(h.digest()).slice(0, 32);
};

let active: Hasher = placeholderBlake2b256;

/** Swap the hash function used protocol-wide. Regenerate vectors after. */
export function setHasher(h: Hasher): void {
  active = h;
}

export function hash(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  return active(buf);
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(s: string): Uint8Array {
  const clean = s.startsWith("0x") ? s.slice(2) : s;
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${s}`);
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Canonical big-endian u64 encoding. Every amount and DAA score uses this. */
export function u64(n: bigint): Uint8Array {
  if (n < 0n) throw new Error(`u64 cannot encode negative: ${n}`);
  if (n > 0xffff_ffff_ffff_ffffn) throw new Error(`u64 overflow: ${n}`);
  const out = new Uint8Array(8);
  let v = n;
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffff_ffff) {
    throw new Error(`u32 out of range: ${n}`);
  }
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}
