import { blake2b } from "@noble/hashes/blake2.js";

import { childId, pushChild } from "./delegate.ts";
import { ScriptBuilder } from "./script.ts";
import { dispatchTag } from "./spend.ts";
import { pushStateArray } from "./state.ts";
import { bytecodeFor, type CovenantTemplate, type GrantAuthority, type GrantState } from "./template.ts";
import {
  payToScriptHashScript,
  SUBNETWORK_ID_NATIVE,
  sighash,
  type Transaction,
  type UtxoEntry,
} from "./tx.ts";
import { toHex } from "./bytes.ts";

/**
 * Settlement: a parent taking a child back in.
 *
 * This is the other half of `delegate`, and until it exists a delegation is
 * one-way. A parent that has delegated has `reserved` sompi it cannot spend
 * and cannot release; the coin sits in the child until the child expires and
 * the PRINCIPAL reclaims it, which returns it to the principal rather than to
 * the parent. So a grant that subdivides itself is a grant that shrinks
 * permanently. Settlement is what makes delegation a loan instead of a gift.
 *
 * ## One transaction, two covenants, two signatures
 *
 * Both grants are spent in the SAME transaction, and each runs a different
 * entrypoint:
 *
 *   input 0  the parent, running `reabsorb`, signed by the parent's AGENT key
 *   input 1  the child,  running `settle`,   signed by the REVOCATION key
 *   output 0 the parent's successor, holding both inputs' coin
 *
 * The child's half is signed by the revocation key rather than the child's
 * agent, and that asymmetry is deliberate: if settlement needed the child's
 * cooperation, an unresponsive or hostile child could lock its parent's
 * budget forever — which is the exact failure settlement exists to remove.
 * The revocation key can already end a child outright via `revoke`, so this
 * grants it no new power over the child; it only changes where the coin goes,
 * back to the parent rather than out to the principal.
 *
 * ## LIFO
 *
 * `reserveRoot` is a hash chain, not a set: each delegation hashes the new
 * child onto the front. Popping requires naming the value the chain had
 * BEFORE that push, and a hash cannot be inverted, so only the most recently
 * delegated child can be settled. Settling out of order is not a thing this
 * builder can be persuaded to do — `prevRoot` simply will not verify — and
 * the check below says so in a sentence rather than letting the engine say it
 * in a script error.
 *
 * That is a real constraint on operations, not just on this code: with
 * children A then B outstanding, B must be settled before A. It is the price
 * of a chain over a Merkle set, which is one hash instead of a second fold
 * and no proof to carry.
 */

/** `function` entrypoints carry the prefix AND an `auth_` before the name. */
const REABSORB_ENTRYPOINT = "__covenant_entrypoint_auth_reabsorb";
/** `prevState` is implicit — the covenant reads it from the input's own state
 *  region — so it is absent here, exactly as in the spend and delegate ABIs. */
const REABSORB_ARG_TYPES = ["State[]", "int", "byte[32]", "sig"];

/** `entry` declarations dispatch on the BARE name. */
const SETTLE_ENTRYPOINT = "settle";
const SETTLE_ARG_TYPES = ["sig"];

const PLACEHOLDER_SIGNATURE = new Uint8Array(65);

/** The covenant hardcodes `tx.inputs[0]` and `tx.inputs[1]` in `settle`, so
 *  these two indices are consensus, not convention. */
const PARENT_INPUT = 0;
const CHILD_INPUT = 1;

export interface ReabsorbPlan {
  template: CovenantTemplate;
  /** Shared by both grants: a child inherits its parent's authority. */
  authority: GrantAuthority;
  /** The parent as it stands now, with the child still on its reserve stack. */
  parentState: GrantState;
  /**
   * The child as it stands NOW, not as it was born. `reabsorb` charges the
   * parent `child.spentTotal`, so a stale child state under-reports what the
   * child spent and the covenant refuses the arithmetic.
   */
  childState: GrantState;
  /**
   * What `reserveRoot` was before this child was pushed onto it. Not
   * derivable — popping a hash chain means supplying the preimage — so a
   * parent must track its own stack. `build-delegation` records it.
   */
  prevRoot: string;
  parentUtxo: GrantUtxo;
  childUtxo: GrantUtxo;
  fee: bigint;
  computeBudget: number;
}

export interface GrantUtxo {
  outpointTransactionId: Uint8Array;
  outpointIndex: number;
  value: bigint;
  blockDaaScore: bigint;
  isCoinbase: boolean;
  covenantId: Uint8Array;
}

export interface UnsignedReabsorb {
  tx: Transaction;
  /** Index-aligned with `tx.inputs`. */
  entries: [UtxoEntry, UtxoEntry];
  /** The digest for input 0, signed by the parent's agent key. */
  parentSighash: Uint8Array;
  /** The digest for input 1, signed by the revocation key. */
  childSighash: Uint8Array;
  successorState: GrantState;
  successorScriptPublicKey: ReturnType<typeof payToScriptHashScript>;
  /** What lands in the parent: both inputs' coin, less the fee. */
  recovered: bigint;
}

function scriptHash(bytecode: Uint8Array): Uint8Array {
  return blake2b.create({ dkLen: 32 }).update(bytecode).digest();
}

/**
 * Where the parent lands: reserve released, the child's spending inherited.
 *
 * The two moves are a pair and neither is optional. Releasing the reserve
 * without charging what the child actually spent would let the same authority
 * be issued twice — delegate 4 KAS, child spends 4 KAS, settle, and the
 * parent's budget is untouched while 4 KAS has left the tree.
 */
export function reabsorbSuccessorState(parent: GrantState, child: GrantState, prevRoot: string): GrantState {
  return {
    ...parent,
    spentTotal: parent.spentTotal + child.spentTotal,
    reserved: parent.reserved - child.budgetTotal,
    reserveRoot: prevRoot,
  };
}

/**
 * Everything the covenant will check, checked here first.
 *
 * None of this is a permission decision — the chain decides that, and it
 * re-derives every one of these itself. The point is that a caller who has
 * the wrong child, or the wrong stack position, gets a sentence naming the
 * problem instead of a script failure that says only that a require() failed
 * somewhere in 5690 bytes.
 */
function check(plan: ReabsorbPlan): void {
  const { parentState: p, childState: c } = plan;

  if (c.budgetTotal <= 0n) throw new Error("a child grant carries a positive budget; this one does not");
  if (c.spentTotal < 0n) throw new Error(`the child reports spentTotal ${c.spentTotal}`);
  if (p.reserved < c.budgetTotal) {
    throw new Error(
      `the parent has ${p.reserved} reserved and this child's budget is ${c.budgetTotal}. ` +
        `Releasing more than is reserved would drive the parent's accounting negative.`,
    );
  }

  // The pop, verified before it is attempted. This is the check that catches
  // both "wrong child" and "right child, wrong order", and the two need
  // different advice, so the message names both.
  const expect = pushChild(plan.prevRoot, c);
  if (expect !== p.reserveRoot) {
    throw new Error(
      `this child is not the one at the top of the parent's reserve stack.\n` +
        `  the parent's reserveRoot : ${p.reserveRoot}\n` +
        `  prevRoot + this child    : ${expect}\n` +
        `  this child's id          : ${toHex(childId(c))}\n` +
        `Two things reach this line. Either the child or prevRoot is wrong for ` +
        `this parent, or the stack is being popped OUT OF ORDER — reserveRoot ` +
        `is a hash chain, so the most recently delegated child must be settled ` +
        `first. Settle the later children before this one.`,
    );
  }

  // The child's own children. Releasing the parent's reserve in full while
  // the child still has coin committed to grandchildren would leave that coin
  // outside anybody's accounting: the child is gone, so nothing can ever
  // reabsorb them, and the parent has already taken credit for the whole
  // budget. Settle the child's own children first.
  if (c.reserved > 0n) {
    throw new Error(
      `this child has ${c.reserved} sompi still reserved for children of its own. ` +
        `Settling it now would release the parent's reserve in full while that ` +
        `coin sits in grandchildren that nothing can reabsorb once their parent ` +
        `is gone. Settle the child's own children first.`,
    );
  }

  const next = reabsorbSuccessorState(p, c, plan.prevRoot);
  if (next.spentTotal + next.reserved > p.budgetTotal) {
    throw new Error(
      `settling this child would put the parent over its budget: spent ` +
        `${next.spentTotal} plus reserved ${next.reserved} exceeds ${p.budgetTotal}`,
    );
  }
  if (plan.fee < 0n) throw new Error("a negative fee is not a fee");
  if (plan.parentUtxo.value + plan.childUtxo.value < plan.fee) {
    throw new Error("the two inputs together do not cover the fee");
  }
}

export function reabsorbSignatureScript(plan: ReabsorbPlan, signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) {
    throw new Error(`a signature is 64 bytes plus a sighash type byte, got ${signature.length}`);
  }
  const next = reabsorbSuccessorState(plan.parentState, plan.childState, plan.prevRoot);

  const b = new ScriptBuilder();
  // Declaration order, prevState excluded: State[] newStates, int childIdx,
  // byte[32] prevRoot, sig. A fanout(to = 1) still takes an ARRAY, so the
  // single successor is wrapped rather than pushed as a scalar State — the
  // two encodings differ and the wrong one dispatches to nothing.
  pushStateArray(b, [next]);
  b.addI64(BigInt(CHILD_INPUT));
  b.addData(fromHex32(plan.prevRoot));
  b.addData(signature);
  b.addData(dispatchTag(REABSORB_ENTRYPOINT, REABSORB_ARG_TYPES));
  b.addData(bytecodeFor(plan.template, { authority: plan.authority, state: plan.parentState }));
  return b.drain();
}

export function settleSignatureScript(plan: ReabsorbPlan, signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) {
    throw new Error(`a signature is 64 bytes plus a sighash type byte, got ${signature.length}`);
  }
  const b = new ScriptBuilder();
  b.addData(signature);
  b.addData(dispatchTag(SETTLE_ENTRYPOINT, SETTLE_ARG_TYPES));
  b.addData(bytecodeFor(plan.template, { authority: plan.authority, state: plan.childState }));
  return b.drain();
}

function fromHex32(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length !== 64) throw new Error(`expected 32 hex-encoded bytes, got ${clean.length / 2}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function buildUnsignedReabsorb(plan: ReabsorbPlan): UnsignedReabsorb {
  check(plan);

  const next = reabsorbSuccessorState(plan.parentState, plan.childState, plan.prevRoot);
  const bytecodeOf = (state: GrantState) =>
    bytecodeFor(plan.template, { authority: plan.authority, state });

  const parentSpk = payToScriptHashScript(scriptHash(bytecodeOf(plan.parentState)));
  const childSpk = payToScriptHashScript(scriptHash(bytecodeOf(plan.childState)));
  const successorSpk = payToScriptHashScript(scriptHash(bytecodeOf(next)));

  const entries: [UtxoEntry, UtxoEntry] = [
    {
      value: plan.parentUtxo.value,
      scriptPublicKey: parentSpk,
      blockDaaScore: plan.parentUtxo.blockDaaScore,
      isCoinbase: plan.parentUtxo.isCoinbase,
      covenantId: plan.parentUtxo.covenantId,
    },
    {
      value: plan.childUtxo.value,
      scriptPublicKey: childSpk,
      blockDaaScore: plan.childUtxo.blockDaaScore,
      isCoinbase: plan.childUtxo.isCoinbase,
      covenantId: plan.childUtxo.covenantId,
    },
  ];

  const recovered = plan.parentUtxo.value + plan.childUtxo.value - plan.fee;

  const tx: Transaction = {
    version: 1,
    inputs: [
      {
        previousOutpoint: {
          transactionId: plan.parentUtxo.outpointTransactionId,
          index: plan.parentUtxo.outpointIndex,
        },
        signatureScript: reabsorbSignatureScript(plan, PLACEHOLDER_SIGNATURE),
        sequence: 0n,
        computeBudget: plan.computeBudget,
      },
      {
        previousOutpoint: {
          transactionId: plan.childUtxo.outpointTransactionId,
          index: plan.childUtxo.outpointIndex,
        },
        signatureScript: settleSignatureScript(plan, PLACEHOLDER_SIGNATURE),
        sequence: 0n,
        computeBudget: plan.computeBudget,
      },
    ],
    outputs: [
      {
        value: recovered,
        // Bound to the PARENT's input. `reabsorb` requires the parent to have
        // exactly one authorized output and for it to be output 0; the child
        // authorizes nothing, which is how a covenant terminates.
        scriptPublicKey: successorSpk,
        covenant: { authorizingInput: PARENT_INPUT, covenantId: plan.parentUtxo.covenantId },
      },
    ],
    // Settlement makes no claim about the chain's height. Only a spend does,
    // because only a spend consumes an epoch allowance.
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };

  return {
    tx,
    entries,
    parentSighash: sighash(tx, PARENT_INPUT, entries[PARENT_INPUT]),
    childSighash: sighash(tx, CHILD_INPUT, entries[CHILD_INPUT]),
    successorState: next,
    successorScriptPublicKey: successorSpk,
    recovered,
  };
}

/**
 * Splices both signatures in.
 *
 * Two keys, and they are not interchangeable: the parent's input needs the
 * parent's AGENT key, the child's needs the REVOCATION key. Passing them the
 * wrong way round produces two signatures that each verify against the wrong
 * pubkey, and the engine reports only that a check failed.
 */
export function attachReabsorbSignatures(
  plan: ReabsorbPlan,
  unsigned: UnsignedReabsorb,
  agentSignature: Uint8Array,
  revocationSignature: Uint8Array,
): Transaction {
  return {
    ...unsigned.tx,
    inputs: [
      { ...unsigned.tx.inputs[PARENT_INPUT]!, signatureScript: reabsorbSignatureScript(plan, agentSignature) },
      { ...unsigned.tx.inputs[CHILD_INPUT]!, signatureScript: settleSignatureScript(plan, revocationSignature) },
    ],
  };
}
