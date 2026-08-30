import { blake2b } from "@noble/hashes/blake2.js";
import { fromHex } from "./bytes.ts";
import { ScriptBuilder } from "./script.ts";
import { pushStateArray } from "./state.ts";
import { dispatchTag } from "./spend.ts";
import {
  payToScriptHashScript,
  SUBNETWORK_ID_NATIVE,
  sighash,
  type ScriptPublicKey,
  type Transaction,
  type UtxoEntry,
} from "./tx.ts";
import { bytecodeFor, type CovenantTemplate, type GrantAuthority, type GrantState } from "./template.ts";

/**
 * Delegation: giving a sub-agent part of your budget.
 *
 * This is the thing that distinguishes a Warda grant from a spending cap. An
 * agent can hand a narrower grant to a sub-agent without asking the principal,
 * without custody, and without being able to hand over more than it holds.
 *
 * A 1:2 fanout. One input, two authorized outputs: the parent continues at
 * output 0, the child is created at output 1.
 *
 * CONSERVATION is the whole point. Authority is subdivided, never created:
 * the parent RESERVES exactly what the child receives, and real coins move
 * with it. A child holding authority but no coins could pay nobody; a child
 * holding coins but no reserve against its parent would double the tree's
 * total authority — the same KAS spendable twice, from two addresses, both
 * legitimately.
 *
 * The child inherits the parent's COVENANT ID. Both outputs carry the same
 * binding, which is what makes a delegation tree one covenant's lineage
 * rather than a family of lookalikes.
 */

const DELEGATE_ENTRYPOINT = "__covenant_entrypoint_auth_delegate";
const DELEGATE_ARG_TYPES = ["State[]", "sig"];

/** How a child narrows its parent. Every term here may only ever shrink. */
export interface ChildTerms {
  /** The sub-agent's x-only key. The one field that is genuinely new. */
  agentKey: string;
  budgetTotal: bigint;
  maxPerSpend: bigint;
  epochLimit: bigint;
  /** Must be strictly less than the parent's, or the tree could not terminate. */
  delegationDepth: bigint;
}

export interface DelegationPlan {
  template: CovenantTemplate;
  authority: GrantAuthority;
  /** The parent's state as it stands now. Its address derives from this. */
  state: GrantState;
  utxo: {
    outpointTransactionId: Uint8Array;
    outpointIndex: number;
    value: bigint;
    blockDaaScore: bigint;
    isCoinbase: boolean;
    covenantId: Uint8Array;
  };
  child: ChildTerms;
  fee: bigint;
  computeBudget: number;
}

export interface UnsignedDelegation {
  tx: Transaction;
  entry: UtxoEntry;
  sighash: Uint8Array;
  /** Where the parent continues. Its reserve has grown by the child's budget. */
  parentSuccessorState: GrantState;
  parentSuccessorScriptPublicKey: ScriptPublicKey;
  /** The child grant, at zero state. Watch this address to see it spend. */
  childState: GrantState;
  childScriptPublicKey: ScriptPublicKey;
  parentChange: bigint;
}

function scriptHash(bytecode: Uint8Array): Uint8Array {
  return blake2b.create({ dkLen: 32 }).update(bytecode).digest();
}

/**
 * The parent after delegating: reserve grows, nothing else moves.
 *
 * Not a permission check — the covenant decides whether this transition is
 * allowed, and it verifies every other field for equality. This only has to
 * compute the same numbers so the successor lands where the covenant expects.
 */
export function parentSuccessorState(state: GrantState, childBudget: bigint): GrantState {
  return { ...state, reserved: state.reserved + childBudget };
}

/**
 * The child's state. Every field not narrowed is INHERITED, which is the safe
 * default: a field forgotten here is one the child shares with its parent
 * rather than one it invents for itself.
 */
export function childStateFrom(state: GrantState, child: ChildTerms): GrantState {
  return {
    agentKey: child.agentKey,
    budgetTotal: child.budgetTotal,
    maxPerSpend: child.maxPerSpend,
    epochLimit: child.epochLimit,
    epochLength: state.epochLength,
    recipientsRoot: state.recipientsRoot,
    notBefore: state.notBefore,
    expiresAt: state.expiresAt,
    delegationDepth: child.delegationDepth,
    // A child starts spent-out-of-nothing. Without this it could be born
    // mid-epoch with its allowance already used, or worse, negative.
    spentTotal: 0n,
    reserved: 0n,
    epochIndex: 0n,
    epochSpent: 0n,
  };
}

export function delegateSignatureScript(plan: DelegationPlan, signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) {
    throw new Error(`a signature is 64 bytes plus a sighash type byte, got ${signature.length}`);
  }
  const parentNext = parentSuccessorState(plan.state, plan.child.budgetTotal);
  const child = childStateFrom(plan.state, plan.child);

  const b = new ScriptBuilder();
  // Order matters twice over: parent first, child second — that is what binds
  // each state to its output index.
  pushStateArray(b, [parentNext, child]);
  b.addData(signature);
  b.addData(dispatchTag(DELEGATE_ENTRYPOINT, DELEGATE_ARG_TYPES));
  b.addData(bytecodeFor(plan.template, { authority: plan.authority, state: plan.state }));
  return b.drain();
}

const PLACEHOLDER_SIGNATURE = new Uint8Array(65);

export function buildUnsignedDelegation(plan: DelegationPlan): UnsignedDelegation {
  const { child } = plan;
  if (child.budgetTotal <= 0n) throw new Error("a child grant must carry a positive budget");

  // Checked here so the caller gets a sentence instead of a script failure.
  // The covenant enforces all of these itself; duplicating them can only make
  // this refuse something the chain would too, never permit something it
  // would not.
  const committed = plan.state.spentTotal + plan.state.reserved;
  const uncommitted = plan.state.budgetTotal - committed;
  if (child.budgetTotal > uncommitted) {
    throw new Error(
      `child budget ${child.budgetTotal} exceeds the parent's uncommitted ${uncommitted} ` +
        `(budget ${plan.state.budgetTotal} less spent ${plan.state.spentTotal} and reserved ${plan.state.reserved})`,
    );
  }
  if (child.maxPerSpend > plan.state.maxPerSpend) throw new Error("a child cannot raise the per-spend cap");
  if (child.epochLimit > plan.state.epochLimit) throw new Error("a child cannot raise the epoch limit");
  if (child.delegationDepth >= plan.state.delegationDepth) {
    throw new Error("a child's delegation depth must be strictly less than its parent's");
  }

  const parentChange = plan.utxo.value - child.budgetTotal - plan.fee;
  if (parentChange < 0n) {
    throw new Error(
      `the parent UTXO holds ${plan.utxo.value}, not enough for a child of ${child.budgetTotal} plus fee ${plan.fee}`,
    );
  }

  const parentNext = parentSuccessorState(plan.state, child.budgetTotal);
  const childState = childStateFrom(plan.state, child);

  const grantSpk = payToScriptHashScript(
    scriptHash(bytecodeFor(plan.template, { authority: plan.authority, state: plan.state })),
  );
  const parentNextSpk = payToScriptHashScript(
    scriptHash(bytecodeFor(plan.template, { authority: plan.authority, state: parentNext })),
  );
  // The child shares the parent's AUTHORITY — same principal, same revocation
  // key. Delegation subdivides an agent's budget; it does not hand over the
  // right to revoke or reclaim.
  const childSpk = payToScriptHashScript(
    scriptHash(bytecodeFor(plan.template, { authority: plan.authority, state: childState })),
  );

  const entry: UtxoEntry = {
    value: plan.utxo.value,
    scriptPublicKey: grantSpk,
    blockDaaScore: plan.utxo.blockDaaScore,
    isCoinbase: plan.utxo.isCoinbase,
    covenantId: plan.utxo.covenantId,
  };

  const binding = { authorizingInput: 0, covenantId: plan.utxo.covenantId };
  const tx: Transaction = {
    version: 1,
    inputs: [
      {
        previousOutpoint: {
          transactionId: plan.utxo.outpointTransactionId,
          index: plan.utxo.outpointIndex,
        },
        signatureScript: delegateSignatureScript(plan, PLACEHOLDER_SIGNATURE),
        sequence: 0n,
        computeBudget: plan.computeBudget,
      },
    ],
    outputs: [
      { value: parentChange, scriptPublicKey: parentNextSpk, covenant: binding },
      // Exactly the child's budget, not a sompi more or less: the covenant
      // requires value to follow authority precisely.
      { value: child.budgetTotal, scriptPublicKey: childSpk, covenant: binding },
    ],
    // No lock time. A delegation makes no claim about the chain's height —
    // only a spend needs to, because only a spend consumes an epoch allowance.
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };

  return {
    tx,
    entry,
    sighash: sighash(tx, 0, entry),
    parentSuccessorState: parentNext,
    parentSuccessorScriptPublicKey: parentNextSpk,
    childState,
    childScriptPublicKey: childSpk,
    parentChange,
  };
}

export function attachDelegationSignature(
  plan: DelegationPlan,
  unsigned: UnsignedDelegation,
  signature: Uint8Array,
): Transaction {
  return {
    ...unsigned.tx,
    inputs: [{ ...unsigned.tx.inputs[0]!, signatureScript: delegateSignatureScript(plan, signature) }],
  };
}

export { fromHex };
