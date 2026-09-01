/**
 * Turning a grant an agent understands into a transaction the chain accepts.
 *
 * This is the bridge between two vocabularies. The MCP layer speaks in KAS
 * strings and named recipients, because that is what an agent framework finds
 * natural. The covenant speaks in sompi, little-endian state slices and a
 * Merkle proof. Nothing in between is a rule — every value here either passes
 * through or is arithmetic the covenant will redo itself.
 *
 * THIS FILE NEVER SEES A KEY. It returns an unsigned transaction and the
 * digest to sign; whoever holds the agent key signs it wherever that key
 * lives. An MCP server that signed would be a custodian, and the whole point
 * of Warda is that nobody has to be.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { buildUnsignedSpend, type MerkleProof, type SpendPlan } from "../../sdk/src/spend.ts";
import { toWire, type WireTransaction } from "../../sdk/src/wire.ts";
import { fromHex, toHex } from "../../sdk/src/bytes.ts";
import { scriptHashFor, templateIdFor, type CovenantTemplate } from "../../sdk/src/template.ts";
import type { Materialised } from "./grant.ts";
import type { MerkleProof as CoreProof } from "../../src/types.ts";

/**
 * The template is loaded from disk, never accepted from the caller.
 *
 * A caller-supplied template would be the softest attack surface in the
 * protocol: swap it and every address the server derives is wrong, so a grant
 * pays into a script nobody can ever spend. It is not a parameter for the same
 * reason a wallet does not take the curve as a parameter.
 */
let cached: CovenantTemplate | undefined;

export function loadTemplate(): CovenantTemplate {
  if (cached) return cached;
  const path =
    process.env.WARDA_TEMPLATE ??
    fileURLToPath(new URL("../../sdk/covenant-template.json", import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(
      `cannot read the covenant template at ${path}. ` +
        `Regenerate it with \`warda-deploy template\`, or set WARDA_TEMPLATE. ` +
        `(${(e as Error).message})`,
    );
  }
  cached = JSON.parse(raw) as CovenantTemplate;
  return cached;
}

/** The core's proof shape carries a per-sibling side flag; the SDK wants two arrays. */
function toSdkProof(proof: CoreProof): MerkleProof {
  return {
    siblings: proof.siblings.map((s) => fromHex(s.hash)),
    left: proof.siblings.map((s) => s.left),
  };
}

export interface UtxoDescriptor {
  transactionId: string;
  index: number;
  /** Sompi, as a string. The grant's whole balance lives in this one number. */
  valueSompi: string;
  blockDaaScore: string;
  isCoinbase: boolean;
  covenantId: string;
}

export interface BuildOptions {
  amount: bigint;
  recipient: string;
  daaScore: bigint;
  utxo: UtxoDescriptor;
  feeSompi: bigint;
  computeBudget: number;
  /**
   * How far behind the tip to claim. The claimed DAA becomes the
   * transaction's LOCK TIME, and a transaction whose lock time equals the
   * current DAA score is not yet final — the node refuses it with a message
   * about finalization that says nothing about lock time. Backing off avoids
   * a race with the tip advancing between building and broadcasting.
   */
  daaBackoff: bigint;
}

export interface BuiltSpend {
  transaction: WireTransaction;
  sighashHex: string;
  claimedDaa: string;
  successorScriptHash: string;
  changeSompi: string;
}

export function buildSpend(m: Materialised, set: Materialised["set"], o: BuildOptions): BuiltSpend {
  const template = loadTemplate();
  const { grant, state } = m;

  const claimedDaa = o.daaScore > o.daaBackoff ? o.daaScore - o.daaBackoff : o.daaScore;

  // An unlisted payee has no proof. Rather than inventing one, refuse here:
  // the covenant would reject it anyway, and a fabricated proof would make the
  // rejection look like a bug in the tree rather than a payee that is not
  // on the list.
  if (!set.has(o.recipient)) {
    throw new Error(
      `${o.recipient} is not on this grant's allowlist, so no proof places it in the tree. ` +
        `No valid transaction exists for this payee.`,
    );
  }

  const authority = { principalKey: grant.principalKey, revocationKey: grant.revocationKey };

  const plan: SpendPlan = {
    template,
    authority,
    state: {
      agentKey: grant.agentKey,
      budgetTotal: grant.budgetTotal,
      maxPerSpend: grant.maxPerSpend,
      epochLimit: grant.epochLimit,
      epochLength: grant.epochLength,
      recipientsRoot: grant.recipientsRoot,
      notBefore: grant.notBefore,
      expiresAt: grant.expiresAt,
      delegationDepth: BigInt(grant.delegationDepth),
      // Derived, never supplied: the id is a property of the template and the
      // authority together, so a descriptor cannot get it wrong by stating it.
      templateId: templateIdFor(template, authority),
      spentTotal: state.spentTotal,
      reserved: state.reserved,
      epochIndex: state.epochIndex,
      epochSpent: state.epochSpent,
      reserveRoot: m.reserveRoot,
    },
    utxo: {
      outpointTransactionId: fromHex(o.utxo.transactionId),
      outpointIndex: o.utxo.index,
      value: BigInt(o.utxo.valueSompi),
      blockDaaScore: BigInt(o.utxo.blockDaaScore),
      isCoinbase: o.utxo.isCoinbase,
      covenantId: fromHex(o.utxo.covenantId),
    },
    amount: o.amount,
    recipient: fromHex(o.recipient),
    proof: toSdkProof(set.proof(o.recipient)),
    claimedDaa,
    fee: o.feeSompi,
    computeBudget: o.computeBudget,
  };

  // The address the grant will occupy AFTER this spend. Worth returning: a
  // caller that watches the wrong address concludes its spend vanished.
  const successorScriptHash = scriptHashFor(template, {
    authority: plan.authority,
    state: buildUnsignedSpend(plan).successorState,
  });

  const built = buildUnsignedSpend(plan);
  return {
    transaction: toWire(built.tx, built.entry, "@warda/mcp (unsigned)"),
    sighashHex: toHex(built.sighash),
    claimedDaa: claimedDaa.toString(),
    successorScriptHash,
    changeSompi: built.tx.outputs[0]!.value.toString(),
  };
}
