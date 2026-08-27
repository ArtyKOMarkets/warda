import { blake2b256 } from "./hashers.ts";
import { concat, fromHex, toHex } from "./bytes.ts";
import type { MerkleProof } from "./spend.ts";

/**
 * The recipients allowlist.
 *
 * A grant commits to a Merkle root, and a spend proves its payee is a leaf.
 * Three details here are load-bearing, and each has a specific failure the
 * comment exists to prevent:
 *
 *   Domain separators are 0x01 and 0x02, NOT 0x00 and 0x01. Kaspa script
 *   encodes zero as the EMPTY byte string, so a 0x00 separator compiles to
 *   nothing and the leaf and node domains collapse into one. That makes an
 *   internal node forgeable as a leaf. It cost a day to find, via opcode
 *   tracing, because the only symptom was one hash not matching another.
 *
 *   Odd nodes are PROMOTED, not duplicated. Duplicating the last node lets two
 *   different member sets produce the same root (CVE-2012-2459).
 *
 *   Because promotion can skip a level, the proof records which SIDE each
 *   sibling sits on rather than inferring it from an index's parity. Parity
 *   desynchronises the moment a level is skipped.
 */

const LEAF = Uint8Array.of(0x01);
const NODE = Uint8Array.of(0x02);

export class RecipientSet {
  /** Canonically sorted, so the same set always yields the same root. */
  readonly members: Uint8Array[];
  private readonly levels: Uint8Array[][];

  constructor(members: (Uint8Array | string)[]) {
    if (members.length === 0) throw new Error("a recipient set must not be empty");
    const bytes = members.map((m) => (typeof m === "string" ? fromHex(m) : m));
    for (const m of bytes) {
      if (m.length !== 32) throw new Error(`a recipient is a 32-byte x-only key, got ${m.length}`);
    }

    const seen = new Set<string>();
    for (const m of bytes) {
      const k = toHex(m);
      if (seen.has(k)) throw new Error(`duplicate recipient: ${k}`);
      seen.add(k);
    }

    this.members = [...bytes].sort((a, b) => toHex(a).localeCompare(toHex(b)));
    this.levels = [this.members.map((m) => blake2b256(concat(LEAF, m)))];
    while (this.levels[this.levels.length - 1]!.length > 1) {
      const prev = this.levels[this.levels.length - 1]!;
      const next: Uint8Array[] = [];
      for (let i = 0; i < prev.length; i += 2) {
        next.push(
          i + 1 < prev.length ? blake2b256(concat(NODE, prev[i]!, prev[i + 1]!)) : prev[i]!,
        );
      }
      this.levels.push(next);
    }
  }

  get root(): Uint8Array {
    return this.levels[this.levels.length - 1]![0]!;
  }

  get rootHex(): string {
    return toHex(this.root);
  }

  get depth(): number {
    return this.levels.length - 1;
  }

  has(member: Uint8Array | string): boolean {
    const k = typeof member === "string" ? member.toLowerCase() : toHex(member);
    return this.members.some((m) => toHex(m) === k);
  }

  proof(member: Uint8Array | string): MerkleProof {
    const k = typeof member === "string" ? member.toLowerCase() : toHex(member);
    let idx = this.members.findIndex((m) => toHex(m) === k);
    if (idx < 0) {
      // No proof exists, and inventing one would make the covenant's rejection
      // look like a bug in the tree rather than a payee that is not listed.
      throw new Error(`${k} is not in this recipient set, so no proof places it in the tree`);
    }

    const siblings: Uint8Array[] = [];
    const left: boolean[] = [];
    for (const level of this.levels.slice(0, -1)) {
      const pair = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (pair < level.length) {
        siblings.push(level[pair]!);
        left.push(pair < idx);
      }
      idx = Math.floor(idx / 2);
    }
    return { siblings, left };
  }
}
