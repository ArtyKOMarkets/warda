import { concat, toHex } from "./bytes.ts";
import { blake3Unkeyed } from "./hashers.ts";
import { ScriptBuilder } from "./script.ts";
import {
  payToPubkeyScript,
  payToScriptHashScript,
  SUBNETWORK_ID_NATIVE,
  sighash,
  type Transaction,
  type UtxoEntry,
} from "./tx.ts";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytecodeFor, type CovenantTemplate, type Grant, type GrantAuthority, type GrantState } from "./template.ts";

/**
 * Assembling an agent spend.
 *
 * A deliberate scoping note, because it is the whole safety argument for this
 * file existing:
 *
 *   Reimplementing the covenant's RULES in JavaScript would be dangerous. A
 *   divergence between two rule implementations fails by wrongly PERMITTING
 *   something — the SDK says yes, the chain says yes, and the grant is
 *   drained by a spend nobody authorised.
 *
 *   Reimplementing ASSEMBLY is safe. A divergence fails by producing a
 *   transaction the network REJECTS. The rules stay where they are enforced:
 *   in the covenant, on chain. This file only has to agree with the Rust tool
 *   on how bytes are laid out, and `golden-spend.json` is the proof that it
 *   does.
 */

/** The ABI signature of the spend entrypoint, as the compiler spells it. */
const SPEND_ENTRYPOINT = "__covenant_entrypoint_auth_spend";
const SPEND_ARG_TYPES = ["State", "int", "byte[32]", "byte[32][]", "bool[]", "int", "sig"];

/**
 * Dispatch tags are the first four bytes of an UNKEYED blake3 over
 * "name(type,type,...)". Renaming an argument type — even cosmetically —
 * changes the tag, and every spend built against the old one stops
 * dispatching. The golden vector pins this so a compiler upgrade that changes
 * a type's spelling fails a test here rather than on chain.
 */
export function dispatchTag(name: string, argTypes: string[]): Uint8Array {
  const signature = `${name}(${argTypes.join(",")})`;
  return blake3Unkeyed(new TextEncoder().encode(signature)).slice(0, 4);
}

/** The 13 State fields, in the order the covenant declares them. */
const STATE_FIELDS = [
  "agentKey",
  "budgetTotal",
  "maxPerSpend",
  "epochLimit",
  "epochLength",
  "recipientsRoot",
  "notBefore",
  "expiresAt",
  "delegationDepth",
  "spentTotal",
  "reserved",
  "epochIndex",
  "epochSpent",
] as const;

const STATE_BYTE_FIELDS = new Set<string>(["agentKey", "recipientsRoot"]);

function fromHexStrict(s: string, expect: number, label: string): Uint8Array {
  const c = s.startsWith("0x") ? s.slice(2) : s;
  const out = new Uint8Array(c.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(c.slice(i * 2, i * 2 + 2), 16);
  if (out.length !== expect) throw new Error(`${label}: expected ${expect} bytes, got ${out.length}`);
  return out;
}

/**
 * Pushes a struct as its fields, in declaration order, with no length prefix
 * and no marker of any kind — a struct argument is simply its fields flattened
 * onto the stack. Field ORDER is therefore load-bearing and invisible: swap
 * two same-typed fields and the script still runs, on the wrong values.
 */
function pushState(b: ScriptBuilder, state: GrantState): void {
  for (const name of STATE_FIELDS) {
    const value = (state as unknown as Record<string, unknown>)[name];
    if (value === undefined) throw new Error(`state is missing field ${name}`);
    if (STATE_BYTE_FIELDS.has(name)) {
      b.addData(fromHexStrict(value as string, 32, name));
    } else {
      b.addI64(value as bigint);
    }
  }
}

export interface MerkleProof {
  siblings: Uint8Array[];
  /** True when the sibling sits on the LEFT of the running hash at that level. */
  left: boolean[];
}

export interface SpendPlan {
  template: CovenantTemplate;
  /** Fixed for the life of the grant; the agent cannot move it. */
  authority: GrantAuthority;
  /** The grant's state as it stands now. The input address is derived from it. */
  state: GrantState;
  utxo: {
    outpointTransactionId: Uint8Array;
    outpointIndex: number;
    value: bigint;
    blockDaaScore: bigint;
    isCoinbase: boolean;
    covenantId: Uint8Array;
  };
  amount: bigint;
  /** x-only public key of the payee; must be a leaf of the recipients tree. */
  recipient: Uint8Array;
  proof: MerkleProof;
  claimedDaa: bigint;
  fee: bigint;
  computeBudget: number;
}

export interface UnsignedSpend {
  /** The transaction with a 65-byte placeholder signature in place. */
  tx: Transaction;
  entry: UtxoEntry;
  /** The digest to sign. Commits to the outputs' covenant bindings. */
  sighash: Uint8Array;
  /** The state the successor UTXO will carry, and therefore its address. */
  successorState: GrantState;
}

/**
 * The successor state. Not a permission check — the covenant decides whether
 * this transition is allowed. This only has to compute the same numbers the
 * covenant will, so that the successor lands at the address the covenant
 * expects. Get it wrong and the spend is refused, which is the safe direction.
 */
export function successorState(state: GrantState, amount: bigint, claimedDaa: bigint): GrantState {
  const epochIndex = (claimedDaa - state.notBefore) / state.epochLength;
  const carried = epochIndex === state.epochIndex ? state.epochSpent : 0n;
  return {
    ...state,
    spentTotal: state.spentTotal + amount,
    epochIndex,
    epochSpent: carried + amount,
  };
}

const PLACEHOLDER_SIGNATURE = new Uint8Array(65);

function scriptHash(bytecode: Uint8Array): Uint8Array {
  return blake2b.create({ dkLen: 32 }).update(bytecode).digest();
}

/**
 * Builds the signature script for a spend.
 *
 * Argument order matches the ABI exactly; the dispatch tag goes last among
 * the arguments, and the redeem script is pushed after it. The redeem script
 * is the CURRENT state's bytecode — it must hash to the address holding the
 * UTXO, which is why the state and the UTXO cannot be varied independently.
 */
export function spendSignatureScript(plan: SpendPlan, signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) {
    throw new Error(`a signature is 64 bytes plus a sighash type byte, got ${signature.length}`);
  }
  const next = successorState(plan.state, plan.amount, plan.claimedDaa);

  const b = new ScriptBuilder();
  pushState(b, next);
  b.addI64(plan.amount);
  b.addData(plan.recipient);
  b.addData(concat(...plan.proof.siblings));
  b.addData(Uint8Array.from(plan.proof.left, (x) => (x ? 1 : 0)));
  b.addI64(plan.claimedDaa);
  b.addData(signature);
  b.addData(dispatchTag(SPEND_ENTRYPOINT, SPEND_ARG_TYPES));
  b.addData(bytecodeFor(plan.template, { authority: plan.authority, state: plan.state }));
  return b.drain();
}

/**
 * Builds the transaction and the digest to sign.
 *
 * The continuation output goes to the SUCCESSOR's address, not back to the
 * input's. A grant's address encodes its state, so a spend necessarily moves
 * it; sending the remainder back to where it came from produces an output
 * that no longer matches its own state and is unspendable forever.
 */
export function buildUnsignedSpend(plan: SpendPlan): UnsignedSpend {
  if (plan.amount <= 0n) throw new Error("amount must be positive");
  const change = plan.utxo.value - plan.amount - plan.fee;
  if (change < 0n) throw new Error("amount plus fee exceeds the grant UTXO");

  const next = successorState(plan.state, plan.amount, plan.claimedDaa);
  // Authority carries over unchanged: a spend may move the state, never the
  // keys that govern it. Recomputing the successor from `plan.authority` is
  // what makes that structural rather than a rule the agent could bend.
  const grantSpk = payToScriptHashScript(
    scriptHash(bytecodeFor(plan.template, { authority: plan.authority, state: plan.state })),
  );
  const successorSpk = payToScriptHashScript(
    scriptHash(bytecodeFor(plan.template, { authority: plan.authority, state: next })),
  );

  const entry: UtxoEntry = {
    value: plan.utxo.value,
    scriptPublicKey: grantSpk,
    blockDaaScore: plan.utxo.blockDaaScore,
    isCoinbase: plan.utxo.isCoinbase,
    covenantId: plan.utxo.covenantId,
  };

  const tx: Transaction = {
    version: 1,
    inputs: [
      {
        previousOutpoint: {
          transactionId: plan.utxo.outpointTransactionId,
          index: plan.utxo.outpointIndex,
        },
        signatureScript: spendSignatureScript(plan, PLACEHOLDER_SIGNATURE),
        sequence: 0n,
        computeBudget: plan.computeBudget,
      },
    ],
    outputs: [
      {
        value: change,
        scriptPublicKey: successorSpk,
        covenant: { authorizingInput: 0, covenantId: plan.utxo.covenantId },
      },
      { value: plan.amount, scriptPublicKey: payToPubkeyScript(plan.recipient) },
    ],
    lockTime: plan.claimedDaa,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };

  return { tx, entry, sighash: sighash(tx, 0, entry), successorState: next };
}

/**
 * Splices a real signature into an unsigned spend.
 *
 * Safe because the signature push is fixed-width: 65 bytes both before and
 * after, so no offset downstream of it moves. That is also why the digest
 * taken over the placeholder form is the digest of the finished transaction —
 * signature scripts are excluded from both the txid preimage and the sighash.
 */
export function attachSignature(plan: SpendPlan, unsigned: UnsignedSpend, signature: Uint8Array): Transaction {
  return {
    ...unsigned.tx,
    inputs: [{ ...unsigned.tx.inputs[0]!, signatureScript: spendSignatureScript(plan, signature) }],
  };
}

export { toHex };
