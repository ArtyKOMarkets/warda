import { blake2b } from "@noble/hashes/blake2.js";
import { concat, fromHex, toHex } from "./bytes.ts";
import { ScriptBuilder } from "./script.ts";
import { EMPTY_RESERVE } from "./keys.ts";
import { RecipientSet } from "./recipients.ts";
import type { MerkleProof } from "./spend.ts";
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
const DELEGATE_ARG_TYPES = ["State[]", "byte[32][]", "bool[]", "sig"];

/** How a child narrows its parent. Every term here may only ever shrink. */
/**
 * What a child may differ in.
 *
 * The covenant permits attenuation along six axes and equality on the rest.
 * All six are here. Two of them — the validity window — were missing for a
 * while, which meant a sub-agent could only ever be given the parent's full
 * term. That is the wrong default for a short-lived task: a lane opened for
 * one job should close on its own rather than waiting for someone to revoke
 * it, and a window is the only attenuation that expires without anybody
 * being online.
 */
export interface ChildTerms {
  /** The sub-agent's x-only key. The one field that is genuinely new. */
  agentKey: string;
  budgetTotal: bigint;
  maxPerSpend: bigint;
  epochLimit: bigint;
  /** Must be strictly less than the parent's, or the tree could not terminate. */
  delegationDepth: bigint;
  /** Opens no EARLIER than the parent's. Omit to inherit. */
  notBefore?: bigint;
  /** Ends no LATER than the parent's. Omit to inherit. */
  expiresAt?: bigint;
  /**
   * Who this child may pay. Omit to inherit the parent's whole allowlist.
   *
   * Delegation could not narrow this until v4 — the covenant required exact
   * equality, so every child could pay everyone its parent could, and a
   * sub-agent hired to pay one vendor held the authority to pay all of them.
   *
   * Give a subset and the child is bound to it: it states the covering
   * subtree's node as its own recipientsRoot, and the delegation carries the
   * path from that node to the parent's root. The subset must be a contiguous,
   * power-of-two-aligned run of the parent's canonically sorted members — see
   * `RecipientSet.subtree`, which computes both and explains the alignment
   * rules when they are not met.
   */
  recipients?: (Uint8Array | string)[];
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
  /**
   * The parent's recipient set, needed only when `child.recipients` narrows
   * it: the witness is a path through this tree, and a root alone cannot
   * produce one. Omit when the child inherits everything.
   */
  recipients?: RecipientSet;
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
 * A child's IDENTITY: only the fields that can never change once it exists.
 *
 * spentTotal, reserved, epochIndex and epochSpent are excluded because they
 * move as the child spends, and an identity that changed with use could not be
 * matched at settlement — which is the whole reason it exists.
 *
 * Integers are widened to a FIXED eight bytes. Script's native integer form is
 * minimal-width, so 1 and 256 occupy different numbers of bytes and two
 * different children could collide by shifting a field boundary.
 */
export function childId(child: GrantState): Uint8Array {
  const n = (v: bigint) => {
    const out = new Uint8Array(8);
    let x = v < 0n ? -v : v;
    for (let i = 0; i < 8; i++) {
      out[i] = Number(x & 0xffn);
      x >>= 8n;
    }
    if (v < 0n) out[7] |= 0x80;
    return out;
  };
  const preimage = concat(
    fromHex(child.agentKey),
    n(child.budgetTotal),
    n(child.maxPerSpend),
    n(child.epochLimit),
    n(child.epochLength),
    fromHex(child.recipientsRoot),
    n(child.notBefore),
    n(child.expiresAt),
    n(child.delegationDepth),
  );
  return blake2b.create({ dkLen: 32, key: new TextEncoder().encode("WardaChildId") }).update(preimage).digest();
}

/**
 * Push a child onto the parent's LIFO stack of outstanding delegations.
 *
 * A hash chain rather than a Merkle set: one hash instead of a second fold and
 * no proof, at the price of settling children MOST RECENT FIRST. The parent
 * must commit to WHICH children are outstanding — reading a child's state
 * proves it is a real grant of this covenant, not that it is a grant THIS
 * parent delegated, and releasing reserve for somebody else's child would let
 * a parent over-delegate.
 */
export function pushChild(reserveRoot: string, child: GrantState): string {
  const preimage = concat(fromHex(reserveRoot), childId(child));
  return toHex(
    blake2b.create({ dkLen: 32, key: new TextEncoder().encode("WardaReserve") }).update(preimage).digest(),
  );
}

/**
 * The parent after delegating: reserve grows, and the child is pushed.
 *
 * Not a permission check — the covenant decides whether this transition is
 * allowed, and it verifies every other field for equality. This only has to
 * compute the same numbers so the successor lands where the covenant expects.
 */
export function parentSuccessorState(state: GrantState, child: GrantState): GrantState {
  // reserveRoot is part of the ADDRESS, so pushing a child MOVES the parent.
  // Computing the successor address from the old stack while the state says
  // pushed produces an output the covenant refuses — and the failure reads as
  // a logic error rather than an address one, which cost four rounds of
  // bisection to find on the Rust side.
  return {
    ...state,
    reserved: state.reserved + child.budgetTotal,
    reserveRoot: pushChild(state.reserveRoot, child),
  };
}

/**
 * The child's state. Every field not narrowed is INHERITED, which is the safe
 * default: a field forgotten here is one the child shares with its parent
 * rather than one it invents for itself.
 */
/**
 * The child's allowlist root, and the witness that places it inside the
 * parent's.
 *
 * Inheriting everything is the empty-witness case, and the covenant needs no
 * special branch for it: folding a node through zero siblings returns the node
 * itself, which it then requires to equal the parent's root.
 */
export function subsetWitness(
  state: GrantState,
  child: ChildTerms,
  recipients?: RecipientSet,
): { root: string; proof: MerkleProof } {
  if (!child.recipients) {
    return { root: state.recipientsRoot, proof: { siblings: [], left: [] } };
  }
  if (!recipients) {
    throw new Error(
      "narrowing a child's recipients needs the parent's RecipientSet: the witness " +
        "is a path through that tree, and a root on its own cannot produce one. " +
        "Pass `recipients` on the delegation plan.",
    );
  }
  if (recipients.rootHex !== state.recipientsRoot.toLowerCase()) {
    throw new Error(
      `the recipient set given hashes to ${recipients.rootHex}, and this grant commits ` +
        `to ${state.recipientsRoot}. A witness through the wrong tree proves nothing.`,
    );
  }
  const { node, proof } = recipients.subtree(child.recipients);
  return { root: toHex(node), proof };
}

export function childStateFrom(
  state: GrantState,
  child: ChildTerms,
  recipients?: RecipientSet,
): GrantState {
  return {
    agentKey: child.agentKey,
    budgetTotal: child.budgetTotal,
    maxPerSpend: child.maxPerSpend,
    epochLimit: child.epochLimit,
    epochLength: state.epochLength,
    recipientsRoot: subsetWitness(state, child, recipients).root,
    // Inherited unless narrowed. `??` and not `||`: a notBefore of 0n is a
    // legitimate value, and `||` would silently replace it with the parent's.
    // Same covenant, so the same template id — that is what will let the
    // parent read this child's state at settlement.
    templateId: state.templateId,
    notBefore: child.notBefore ?? state.notBefore,
    expiresAt: child.expiresAt ?? state.expiresAt,
    delegationDepth: child.delegationDepth,
    // A child starts spent-out-of-nothing. Without this it could be born
    // mid-epoch with its allowance already used, or worse, negative.
    spentTotal: 0n,
    reserved: 0n,
    epochIndex: 0n,
    epochSpent: 0n,
    // A newborn child has delegated to nobody.
    reserveRoot: EMPTY_RESERVE,
  };
}

export function delegateSignatureScript(plan: DelegationPlan, signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) {
    throw new Error(`a signature is 64 bytes plus a sighash type byte, got ${signature.length}`);
  }
  const child = childStateFrom(plan.state, plan.child, plan.recipients);
  const parentNext = parentSuccessorState(plan.state, child);

  const witness = subsetWitness(plan.state, plan.child, plan.recipients).proof;

  const b = new ScriptBuilder();
  // Order matters twice over: parent first, child second — that is what binds
  // each state to its output index.
  pushStateArray(b, [parentNext, child]);
  b.addData(concat(...witness.siblings));
  b.addData(Uint8Array.from(witness.left, (x) => (x ? 1 : 0)));
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
  // The window may only shrink, and it shrinks from BOTH ends — the covenant
  // asks for `notBefore >= parent's` and `expiresAt <= parent's`. A child
  // cannot start earlier or outlive its parent, which is what stops a
  // delegation from being a way to extend a grant past its own term.
  if (child.notBefore !== undefined && child.notBefore < plan.state.notBefore) {
    throw new Error(
      `a child cannot open before its parent (${child.notBefore} < ${plan.state.notBefore})`,
    );
  }
  if (child.expiresAt !== undefined && child.expiresAt > plan.state.expiresAt) {
    throw new Error(
      `a child cannot outlive its parent (${child.expiresAt} > ${plan.state.expiresAt})`,
    );
  }
  const childOpens = child.notBefore ?? plan.state.notBefore;
  const childEnds = child.expiresAt ?? plan.state.expiresAt;
  if (childOpens >= childEnds) {
    // The covenant permits this — both bounds are satisfied — and it produces
    // a grant that can never be spent from and can only be reclaimed. Cheaper
    // to refuse here than to fund one.
    throw new Error(`a child whose window opens at ${childOpens} and ends at ${childEnds} can never spend`);
  }

  const parentChange = plan.utxo.value - child.budgetTotal - plan.fee;
  if (parentChange < 0n) {
    throw new Error(
      `the parent UTXO holds ${plan.utxo.value}, not enough for a child of ${child.budgetTotal} plus fee ${plan.fee}`,
    );
  }

  const childState = childStateFrom(plan.state, child, plan.recipients);
  const parentNext = parentSuccessorState(plan.state, childState);

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
