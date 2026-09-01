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

  /**
   * The node covering a contiguous run of members, and the path from it to the
   * root — a witness that a SUBSET of this set is a subset of it.
   *
   * This is what lets a delegation narrow who a child may pay. The child
   * states `node` as its own recipientsRoot; the covenant folds `node` up
   * through `proof` and requires the result to be this root. The child's
   * members are then exactly the leaves beneath `node`, and no others: to pay
   * anyone it must produce a leaf that folds to `node`, and only its own
   * members do.
   *
   * The subset must be a SUBTREE, not an arbitrary selection. Members are
   * sorted canonically, so a subtree is a contiguous run whose position and
   * length align to a power of two — the same shape a Merkle proof has always
   * had, viewed from the other end. An arbitrary subset would need one
   * inclusion proof per member, which is a different and much more expensive
   * construction.
   *
   * Passing every member returns the root itself with an empty proof, which is
   * exactly the "inherit everything" case.
   */
  subtree(members: (Uint8Array | string)[]): { node: Uint8Array; proof: MerkleProof } {
    if (members.length === 0) throw new Error("a narrowed recipient set must not be empty");
    const keys = members.map((m) => (typeof m === "string" ? m.toLowerCase() : toHex(m)));
    const indices = keys.map((k) => {
      const i = this.members.findIndex((m) => toHex(m) === k);
      if (i < 0) {
        throw new Error(
          `${k} is not in this recipient set, so no subtree of it contains ${k}. ` +
            `A child can only narrow its parent's allowlist, never extend it.`,
        );
      }
      return i;
    }).sort((a, b) => a - b);

    const lo = indices[0]!;
    const hi = indices[indices.length - 1]!;
    for (let i = 0; i < indices.length; i++) {
      if (indices[i] !== lo + i) {
        throw new Error(
          `these members are not contiguous in the sorted set (indices ${indices.join(", ")}). ` +
            `A subset witness covers a SUBTREE, so the members must form an ` +
            `unbroken run. Order the parent's set so the ones you delegate ` +
            `together sit together, or give the child its own smaller grant.`,
        );
      }
    }

    // Climb until one node covers exactly [lo, hi] and nothing else.
    const span = hi - lo + 1;
    let level = 0;
    let idx = lo;
    let width = 1;
    while (width < span) {
      if (idx % 2 !== 0) {
        throw new Error(
          `this run starts at index ${lo} and spans ${span}, which no single node covers. ` +
            `A subtree's start must align to its size — 2 members starting at an even ` +
            `index, 4 at a multiple of 4, and so on.`,
        );
      }
      idx = Math.floor(idx / 2);
      width *= 2;
      level++;
    }
    if (width !== span) {
      throw new Error(
        `${span} members do not fill a subtree exactly; the nearest node covers ${width}. ` +
          `Narrow to a power-of-two run, or delegate a single member.`,
      );
    }

    const node = this.levels[level]![idx]!;

    // The remaining path, from this node to the root. Same walk as `proof`,
    // started partway up.
    const siblings: Uint8Array[] = [];
    const left: boolean[] = [];
    let i = idx;
    for (const lvl of this.levels.slice(level, -1)) {
      const pair = i % 2 === 0 ? i + 1 : i - 1;
      if (pair < lvl.length) {
        siblings.push(lvl[pair]!);
        left.push(pair < i);
      }
      i = Math.floor(i / 2);
    }
    return { node, proof: { siblings, left } };
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
