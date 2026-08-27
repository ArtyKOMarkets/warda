import { fromHex } from "./bytes.ts";
import { RecipientSet } from "./recipients.ts";
import type { SpendPlan } from "./spend.ts";
import type { CovenantTemplate } from "./template.ts";

/**
 * A spend plan, as something with a node connection hands it over.
 *
 * This SDK cannot find a grant. A grant's address is derived from its state,
 * so it MOVES after every spend, and locating the current UTXO means asking a
 * node — which needs a client this package deliberately does not have yet.
 *
 * The split is not a workaround, it is the safe factoring. Network I/O sits
 * with whatever already speaks to a node (`warda-deploy plan` does it today);
 * byte layout sits here; and a transaction crossing between them gets checked
 * by the script engine before anything is broadcast.
 *
 * A plan is perishable. Regenerate it before every spend — a stale one points
 * at an address the grant has already left.
 */

export interface SpendPlanDocument {
  authority: { principalKey: string; revocationKey: string };
  state: {
    agentKey: string;
    budgetTotal: string | number;
    maxPerSpend: string | number;
    epochLimit: string | number;
    epochLength: string | number;
    recipientsRoot: string;
    notBefore: string | number;
    expiresAt: string | number;
    delegationDepth: string | number;
    spentTotal: string | number;
    reserved: string | number;
    epochIndex: string | number;
    epochSpent: string | number;
  };
  utxo: {
    outpointTransactionId: string;
    outpointIndex: number;
    value: string | number;
    blockDaaScore: string | number;
    isCoinbase: boolean;
    covenantId: string;
  };
  recipients: { members: string[]; target: string };
  spend: {
    amount: string | number;
    claimedDaa: string | number;
    fee: string | number;
    computeBudget: number;
  };
}

const big = (v: string | number): bigint => BigInt(v);

export function spendPlanFrom(doc: SpendPlanDocument, template: CovenantTemplate): SpendPlan {
  const set = new RecipientSet(doc.recipients.members);

  // Derived, not trusted. If the tree here disagreed with the one the grant
  // committed to, every proof would be for a different tree — and the only
  // symptom would be an on-chain rejection that reads like a covenant bug.
  if (set.rootHex !== doc.state.recipientsRoot.toLowerCase()) {
    throw new Error(
      `the member list hashes to ${set.rootHex}, but the grant commits to ${doc.state.recipientsRoot}`,
    );
  }

  return {
    template,
    authority: {
      principalKey: doc.authority.principalKey,
      revocationKey: doc.authority.revocationKey,
    },
    state: {
      agentKey: doc.state.agentKey,
      budgetTotal: big(doc.state.budgetTotal),
      maxPerSpend: big(doc.state.maxPerSpend),
      epochLimit: big(doc.state.epochLimit),
      epochLength: big(doc.state.epochLength),
      recipientsRoot: doc.state.recipientsRoot,
      notBefore: big(doc.state.notBefore),
      expiresAt: big(doc.state.expiresAt),
      delegationDepth: big(doc.state.delegationDepth),
      spentTotal: big(doc.state.spentTotal),
      reserved: big(doc.state.reserved),
      epochIndex: big(doc.state.epochIndex),
      epochSpent: big(doc.state.epochSpent),
    },
    utxo: {
      outpointTransactionId: fromHex(doc.utxo.outpointTransactionId),
      outpointIndex: doc.utxo.outpointIndex,
      value: big(doc.utxo.value),
      blockDaaScore: big(doc.utxo.blockDaaScore),
      isCoinbase: doc.utxo.isCoinbase,
      covenantId: fromHex(doc.utxo.covenantId),
    },
    amount: big(doc.spend.amount),
    recipient: fromHex(doc.recipients.target),
    proof: set.proof(doc.recipients.target),
    claimedDaa: big(doc.spend.claimedDaa),
    fee: big(doc.spend.fee),
    computeBudget: doc.spend.computeBudget,
  };
}
