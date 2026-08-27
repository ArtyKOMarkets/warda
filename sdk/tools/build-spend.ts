/**
 * Builds a spend in JavaScript and writes it out for the Rust verifier.
 *
 * Two modes, because they answer different questions:
 *
 *   --golden   rebuild the reference spend from golden-spend.json. Needs no
 *              node and no key of yours. Hand the result to
 *              `warda-deploy verify` and the consensus engine says whether it
 *              accepts a transaction JavaScript assembled — which is a
 *              stronger claim than "it matches a file we also wrote".
 *
 *   --live     build the NEXT spend against the real grant recorded in
 *              covenant/deploy/grant.json, signed with WARDA_SK. Hand the
 *              result to `warda-deploy submit` to put it on testnet-10.
 *
 * Usage:
 *   node --experimental-strip-types tools/build-spend.ts --golden > js-spend.json
 *   WARDA_SK=... node --experimental-strip-types tools/build-spend.ts --live > js-spend.json
 */

import { readFileSync } from "node:fs";

import { fromHex, toHex } from "../src/bytes.ts";
import { blake2b256 } from "../src/hashers.ts";
import { agentPublicKey, signSpend } from "../src/sign.ts";
import { buildUnsignedSpend, type MerkleProof, type SpendPlan } from "../src/spend.ts";
import type { CovenantTemplate, GrantState } from "../src/template.ts";
import { toWire } from "../src/wire.ts";

const here = (p: string) => new URL(p, import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(here(p), "utf8"));

const template: CovenantTemplate = readJson("../covenant-template.json");
const golden = readJson("../golden-spend.json");

// ---- the recipients tree, rebuilt ---------------------------------------
//
// Domain separators are 0x01 and 0x02, NOT 0x00 and 0x01. Kaspa script
// encodes zero as the empty byte string, so a 0x00 separator compiles to
// nothing and the leaf and node domains collapse into one. That cost a day
// once; it is written down here so it costs nobody another.

const LEAF = Uint8Array.of(0x01);
const NODE = Uint8Array.of(0x02);

function h(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const buf = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    buf.set(p, at);
    at += p.length;
  }
  return blake2b256(buf);
}

/**
 * Odd nodes are PROMOTED, not duplicated. Duplicating the last node lets two
 * different member sets produce the same root (CVE-2012-2459); promotion does
 * not. It does mean a level can be skipped, so the proof records which SIDE
 * each sibling sits on rather than inferring it from an index's parity.
 */
function merkleProof(members: Uint8Array[], target: Uint8Array): MerkleProof {
  const sorted = [...members].sort((a, b) => toHex(a).localeCompare(toHex(b)));
  const levels: Uint8Array[][] = [sorted.map((m) => h(LEAF, m))];
  while (levels[levels.length - 1]!.length > 1) {
    const prev = levels[levels.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < prev.length; i += 2) {
      next.push(i + 1 < prev.length ? h(NODE, prev[i]!, prev[i + 1]!) : prev[i]!);
    }
    levels.push(next);
  }

  let idx = sorted.findIndex((m) => toHex(m) === toHex(target));
  if (idx < 0) throw new Error("target is not in the member set");

  const siblings: Uint8Array[] = [];
  const left: boolean[] = [];
  for (const level of levels.slice(0, -1)) {
    const pair = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (pair < level.length) {
      siblings.push(level[pair]!);
      left.push(pair < idx);
    }
    idx = Math.floor(idx / 2);
  }
  return { siblings, left };
}

// ---- modes ---------------------------------------------------------------

function goldenPlan(): { plan: SpendPlan; secret: Uint8Array } {
  const p = golden.params;
  const state: GrantState = {
    agentKey: p.agentKey,
    budgetTotal: BigInt(p.budgetTotal),
    maxPerSpend: BigInt(p.maxPerSpend),
    epochLimit: BigInt(p.epochLimit),
    epochLength: BigInt(p.epochLength),
    recipientsRoot: p.recipientsRoot,
    notBefore: BigInt(p.notBefore),
    expiresAt: BigInt(p.expiresAt),
    delegationDepth: BigInt(p.delegationDepth),
    spentTotal: BigInt(p.prevState.spentTotal),
    reserved: BigInt(p.prevState.reserved),
    epochIndex: BigInt(p.prevState.epochIndex),
    epochSpent: BigInt(p.prevState.epochSpent),
  };

  const members = golden.recipients.members.map((m: string) => fromHex(m));
  const target = fromHex(golden.recipients.target);
  const proof = merkleProof(members, target);

  // Rebuilt, not copied. If this SDK's tree disagreed with the Rust one, a
  // copied proof would hide it and the failure would land on chain instead.
  const recomputedRoot = (() => {
    const sorted = [...members].sort((a: Uint8Array, b: Uint8Array) => toHex(a).localeCompare(toHex(b)));
    let level = sorted.map((m: Uint8Array) => h(LEAF, m));
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(i + 1 < level.length ? h(NODE, level[i]!, level[i + 1]!) : level[i]!);
      }
      level = next;
    }
    return toHex(level[0]!);
  })();
  if (recomputedRoot !== p.recipientsRoot) {
    throw new Error(`recomputed root ${recomputedRoot} != ${p.recipientsRoot}`);
  }

  return {
    secret: fromHex(golden.key.secretHex),
    plan: {
      template,
      authority: { principalKey: p.principalKey, revocationKey: p.revocationKey },
      state,
      utxo: {
        outpointTransactionId: fromHex(golden.utxo.outpointTransactionId),
        outpointIndex: golden.utxo.outpointIndex,
        value: BigInt(golden.utxo.value),
        blockDaaScore: BigInt(golden.utxo.blockDaaScore),
        isCoinbase: golden.utxo.isCoinbase,
        covenantId: fromHex(golden.utxo.covenantId),
      },
      amount: BigInt(golden.spend.amount),
      recipient: target,
      proof,
      claimedDaa: BigInt(golden.spend.claimedDaa),
      fee: BigInt(golden.spend.fee),
      computeBudget: golden.spend.computeBudget,
    },
  };
}

function main(): void {
  const mode = process.argv[2] ?? "--golden";
  if (mode !== "--golden") {
    // --live needs the grant's current UTXO, which needs a node. Until this
    // SDK speaks wRPC, `warda-deploy` is the thing that can look it up.
    console.error("only --golden is implemented here; use `warda-deploy spend` for a live grant");
    process.exit(2);
  }

  const { plan, secret } = goldenPlan();

  const derived = toHex(agentPublicKey(secret));
  if (derived !== plan.state.agentKey) {
    throw new Error(`key mismatch: derived ${derived}, state names ${plan.state.agentKey}`);
  }

  const unsigned = buildUnsignedSpend(plan);
  const signed = signSpend(plan, secret);

  process.stdout.write(JSON.stringify(toWire(signed.tx, unsigned.entry), null, 2) + "\n");
  console.error(`built ${signed.tx.inputs[0]!.signatureScript.length}-byte sigscript, txid ${toWire(signed.tx, unsigned.entry).txid}`);
}

main();
