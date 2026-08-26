import { concat, u16le, u32le } from "./bytes.ts";

/**
 * Kaspa's script builder, reimplemented.
 *
 * This is a port of `ScriptBuilder` in rusty-kaspa's txscript crate, and it
 * has to be exact: the sigscript these bytes form is committed to by the
 * script hash of nothing, but the *arguments* it pushes are read positionally
 * by the covenant, and the redeem script push at the end is what the P2SH
 * address commits to. One byte off and the engine either dispatches to the
 * wrong entrypoint or refuses the script outright.
 *
 * The subtle part is canonicalisation. `addData` does NOT simply emit a
 * length prefix: a one-byte payload in 1..=16 becomes OP_1..OP_16, and the
 * single byte 0x81 becomes OP_1NEGATE. Skipping that is the classic way to
 * produce a script that is valid-looking and non-canonical, and the engine
 * rejects non-canonical pushes.
 */

const OP_0 = 0x00;
const OP_PUSHDATA1 = 0x4c;
const OP_PUSHDATA2 = 0x4d;
const OP_PUSHDATA4 = 0x4e;
const OP_1NEGATE = 0x4f;
const OP_1 = 0x51;

const OP_DATA_MIN = 0x01; // OpData1
const OP_DATA_MAX_LEN = 75; // OpData75
const OP_SMALL_INT_MIN = 1;
const OP_SMALL_INT_MAX = 16;
const OP_1_NEGATE_VAL = 0x81;

/** Covenants raise the element ceiling; without them it is far lower. */
const MAX_SCRIPT_ELEMENT_SIZE_COVENANTS = 16_384;

export class ScriptBuilder {
  private parts: Uint8Array[] = [];
  private length = 0;

  addOp(op: number): this {
    this.parts.push(Uint8Array.of(op));
    this.length += 1;
    return this;
  }

  /** Canonical push, matching `ScriptBuilder::add_data`. */
  addData(data: Uint8Array): this {
    if (data.length > MAX_SCRIPT_ELEMENT_SIZE_COVENANTS) {
      throw new Error(`push of ${data.length} bytes exceeds the maximum script element size`);
    }
    if (data.length === 1 && data[0] === OP_1_NEGATE_VAL) return this.addOp(OP_1NEGATE);
    if (data.length === 1 && data[0] >= OP_SMALL_INT_MIN && data[0] <= OP_SMALL_INT_MAX) {
      return this.addOp(OP_1 - 1 + data[0]);
    }
    return this.addDataWithPushOpcode(data);
  }

  /** Length-prefixed push with no small-integer folding. */
  addDataWithPushOpcode(data: Uint8Array): this {
    const n = data.length;
    if (n === 0) return this.addOp(OP_0);

    let prefix: Uint8Array;
    if (n <= OP_DATA_MAX_LEN) prefix = Uint8Array.of(OP_DATA_MIN - 1 + n);
    else if (n <= 0xff) prefix = Uint8Array.of(OP_PUSHDATA1, n);
    else if (n <= 0xffff) prefix = concat(Uint8Array.of(OP_PUSHDATA2), u16le(n));
    else prefix = concat(Uint8Array.of(OP_PUSHDATA4), u32le(n));

    this.parts.push(prefix, data);
    this.length += prefix.length + n;
    return this;
  }

  /** Matches `ScriptBuilder::add_i64`. */
  addI64(value: bigint): this {
    if (value === 0n) return this.addOp(OP_0);
    if (value === -1n || (value >= 1n && value <= 16n)) {
      return this.addOp(Number(BigInt(OP_1) - 1n + value));
    }
    return this.addData(serializeI64(value));
  }

  drain(): Uint8Array {
    const out = concat(...this.parts);
    this.parts = [];
    this.length = 0;
    return out;
  }

  get size(): number {
    return this.length;
  }
}

/**
 * Script number encoding — a port of `serialize_i64`.
 *
 * Little-endian magnitude with the sign carried in the top bit of the last
 * byte, and a trailing 0x00 appended when the magnitude's own top byte would
 * otherwise be read as a sign bit. Zero encodes as the EMPTY string, not as a
 * zero byte; that asymmetry has bitten this codebase before, in the covenant's
 * domain separators.
 */
export function serializeI64(value: bigint): Uint8Array {
  const negative = value < 0n;
  let magnitude = negative ? -value : value;
  if (magnitude >= 1n << 64n) throw new Error(`value does not fit in i64: ${value}`);

  const out: number[] = [];
  let lastSaturated = false;
  while (magnitude !== 0n) {
    const byte = Number(magnitude & 0xffn);
    lastSaturated = (byte & 0x80) !== 0;
    out.push(byte);
    magnitude >>= 8n;
  }
  if (lastSaturated) out.push(0);
  if (negative && out.length > 0) out[out.length - 1] |= 0x80;

  return Uint8Array.from(out);
}
