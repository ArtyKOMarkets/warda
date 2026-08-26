import { blake2b } from "@noble/hashes/blake2.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { u16le, u32le, u64le, u8 } from "./bytes.ts";

/**
 * Kaspa's domain-separated hashers.
 *
 * Every hash in the protocol is keyed with a literal string, and the two
 * families differ in how that key is applied:
 *
 *   blake2b-256 uses the string DIRECTLY as a BLAKE2 key (padded internally
 *   to the block size by the BLAKE2 spec).
 *
 *   blake3 has a fixed 32-byte key, so the string is copied into a 32-byte
 *   ZERO-FILLED buffer. Not derive_key, not a hash of the string — a literal
 *   zero-padded copy. Getting this wrong produces a hash that is stable,
 *   plausible, and wrong everywhere.
 */

function blake3Key(domain: string): Uint8Array {
  const key = new Uint8Array(32);
  const bytes = new TextEncoder().encode(domain);
  if (bytes.length > 32) throw new Error(`blake3 domain separator too long: ${domain}`);
  key.set(bytes, 0);
  return key;
}

export interface Digest {
  update(data: Uint8Array): Digest;
  digest(): Uint8Array;
}

/**
 * A hasher plus Kaspa's `HasherExtensions` writers. Every integer is written
 * little-endian, and `writeVarBytes` prefixes a u64 length — NOT a compact
 * varint, which is what a Bitcoin-shaped implementation would reach for.
 */
interface Sponge {
  update(d: Uint8Array): unknown;
  digest(): Uint8Array;
}

export class HashWriter {
  private readonly h: Sponge;

  constructor(h: Sponge) {
    this.h = h;
  }

  static blake2b(domain: string): HashWriter {
    return new HashWriter(
      blake2b.create({ dkLen: 32, key: new TextEncoder().encode(domain) }) as never,
    );
  }

  static blake3(domain: string): HashWriter {
    return new HashWriter(blake3.create({ key: blake3Key(domain) }) as never);
  }

  update(data: Uint8Array): this {
    this.h.update(data);
    return this;
  }

  writeU8(v: number): this {
    return this.update(u8(v));
  }
  writeU16(v: number): this {
    return this.update(u16le(v));
  }
  writeU32(v: number): this {
    return this.update(u32le(v));
  }
  writeU64(v: bigint | number): this {
    return this.update(u64le(v));
  }
  writeBool(v: boolean): this {
    return this.update(Uint8Array.of(v ? 1 : 0));
  }
  /** u64 little-endian length, then the bytes. */
  writeVarBytes(data: Uint8Array): this {
    return this.writeU64(BigInt(data.length)).update(data);
  }
  writeLen(n: number): this {
    return this.writeU64(BigInt(n));
  }

  digest(): Uint8Array {
    return this.h.digest();
  }
}

/** blake2b-256 with no key at all — what OpBlake2b computes inside a script. */
export function blake2b256(data: Uint8Array): Uint8Array {
  return blake2b.create({ dkLen: 32 }).update(data).digest();
}

export const ZERO_HASH = new Uint8Array(32);

export function blake3Unkeyed(data: Uint8Array): Uint8Array {
  return blake3(data);
}
