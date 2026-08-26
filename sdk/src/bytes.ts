/**
 * Byte plumbing. Deliberately boring, and deliberately strict: every
 * conversion here sits underneath a signature, so a silent truncation would
 * surface as "the network rejected your transaction" three layers away.
 */

export function fromHex(s: string): Uint8Array {
  const c = s.startsWith("0x") ? s.slice(2) : s;
  if (c.length % 2 !== 0) throw new Error(`hex string has odd length: ${c.length}`);
  const o = new Uint8Array(c.length / 2);
  for (let i = 0; i < o.length; i++) {
    const b = Number.parseInt(c.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new Error(`not hex: ${c.slice(i * 2, i * 2 + 2)}`);
    o[i] = b;
  }
  return o;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function le(value: bigint, width: number, label: string): Uint8Array {
  if (value < 0n) throw new Error(`${label} must not be negative, got ${value}`);
  const limit = 1n << BigInt(width * 8);
  if (value >= limit) throw new Error(`${label} does not fit in ${width} bytes: ${value}`);
  const out = new Uint8Array(width);
  let x = value;
  for (let i = 0; i < width; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

export const u8 = (v: number | bigint): Uint8Array => le(BigInt(v), 1, "u8");
export const u16le = (v: number | bigint): Uint8Array => le(BigInt(v), 2, "u16");
export const u32le = (v: number | bigint): Uint8Array => le(BigInt(v), 4, "u32");
export const u64le = (v: number | bigint): Uint8Array => le(BigInt(v), 8, "u64");

/** A hash written as 32 bytes; rejects anything else rather than padding it. */
export function hash32(hex: string): Uint8Array {
  const b = fromHex(hex);
  if (b.length !== 32) throw new Error(`expected a 32-byte hash, got ${b.length} bytes`);
  return b;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
