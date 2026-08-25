import { hash, toHex, fromHex } from "./hash.ts";
import type { Hex, MerkleProof, MerkleSibling } from "./types.ts";

/**
 * Recipient allowlist as a Merkle tree.
 *
 * Domain separation: leaves are prefixed 0x00, internal nodes 0x01. Without
 * this, an internal node can be presented as a leaf and an attacker forges
 * membership for a "recipient" that is really a concatenated node pair.
 *
 * Pairs are NOT sorted. Sorted-pair trees lose position information, which
 * makes distinct sets collide to the same root in edge cases. The proof
 * carries an explicit index instead.
 */
const LEAF = new Uint8Array([0x00]);
const NODE = new Uint8Array([0x01]);

export function leafHash(recipient: Hex): Uint8Array {
  return hash(LEAF, fromHex(recipient));
}

function level(nodes: Uint8Array[]): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < nodes.length; i += 2) {
    const l = nodes[i]!;
    // Odd node is promoted, not duplicated. Duplicating enables the
    // CVE-2012-2459 style ambiguity where two trees share a root.
    const r = i + 1 < nodes.length ? nodes[i + 1]! : undefined;
    out.push(r ? hash(NODE, l, r) : l);
  }
  return out;
}

export class RecipientSet {
  readonly recipients: Hex[];
  private readonly levels: Uint8Array[][];

  constructor(recipients: Hex[]) {
    if (recipients.length === 0) throw new Error("recipient set must not be empty");
    const seen = new Set<string>();
    for (const r of recipients) {
      const k = r.toLowerCase();
      if (seen.has(k)) throw new Error(`duplicate recipient: ${r}`);
      seen.add(k);
    }
    // Canonical ordering, so the same set always yields the same root.
    this.recipients = [...recipients].sort();
    this.levels = [this.recipients.map(leafHash)];
    while (this.levels[this.levels.length - 1]!.length > 1) {
      this.levels.push(level(this.levels[this.levels.length - 1]!));
    }
  }

  get root(): Hex {
    return toHex(this.levels[this.levels.length - 1]![0]!);
  }

  get depth(): number {
    return this.levels.length - 1;
  }

  get size(): number {
    return this.recipients.length;
  }

  has(recipient: Hex): boolean {
    return this.recipients.includes(recipient);
  }

  isSubsetOf(other: RecipientSet): boolean {
    return this.recipients.every((r) => other.has(r));
  }

  proof(recipient: Hex): MerkleProof {
    const index = this.recipients.indexOf(recipient);
    if (index < 0) throw new Error(`not in set: ${recipient}`);
    const siblings: MerkleSibling[] = [];
    let i = index;
    for (let l = 0; l < this.levels.length - 1; l++) {
      const nodes = this.levels[l]!;
      const pair = i % 2 === 0 ? i + 1 : i - 1;
      if (pair < nodes.length) {
        siblings.push({ hash: toHex(nodes[pair]!), left: pair < i });
      }
      i = Math.floor(i / 2);
    }
    return { index, siblings };
  }
}

export function verifyInclusion(
  recipient: Hex,
  proof: MerkleProof,
  root: Hex,
): boolean {
  let node = leafHash(recipient);
  for (const sib of proof.siblings) {
    const s = fromHex(sib.hash);
    node = sib.left ? hash(NODE, s, node) : hash(NODE, node, s);
  }
  return toHex(node) === root;
}

export type { MerkleProof, MerkleSibling };
