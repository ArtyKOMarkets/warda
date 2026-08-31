import { blake2b } from "@noble/hashes/blake2.js";

import { fromHex } from "./bytes.ts";
import { ScriptBuilder } from "./script.ts";
import { dispatchTag } from "./spend.ts";
import { bytecodeFor, type CovenantTemplate, type GrantAuthority, type GrantState } from "./template.ts";
import {
  payToPubkeyScript,
  payToScriptHashScript,
  SUBNETWORK_ID_NATIVE,
  sighash,
  type Transaction,
  type UtxoEntry,
} from "./tx.ts";

/**
 * The two ways a grant ends: the principal takes the coin back.
 *
 * Everything else in this package serves the agent. These two serve the
 * person who funded it, and they are the reason the rest is safe to use. The
 * pitch — "the principal signs once and is never online again" — is only
 * acceptable if the money is definitely retrievable. Until an exit path has
 * actually moved coin on chain, that is a claim, not a property.
 *
 * They differ in exactly one condition and it matters:
 *
 *   revoke   available at ANY time, signed by the revocation key. The
 *            emergency stop: an agent has been compromised, or is behaving in
 *            a way the rules permit and the principal does not like.
 *
 *   reclaim  available only once the chain has passed `expiresAt`, signed by
 *            the principal key. The scheduled end: the grant has served its
 *            term and the remainder comes home.
 *
 * Neither races an in-flight agent spend. Both make the remaining balance
 * unreachable from the next block on; a spend already in the mempool may
 * still land first. That is a property of a UTXO covenant, not a gap in this
 * code — there is no way to express "and cancel anything outstanding".
 *
 * ## What expiry does and does not do
 *
 * `expiresAt` opens the reclaim right. It does NOT close the spend path: the
 * covenant's spend entrypoint contains no expiry check, because a UTXO
 * covenant cannot express "must be spent before X" — CLTV only expresses "not
 * before". After expiry an agent keeps spending until a principal actually
 * reclaims. A grant left past its term is not dormant, it is unattended.
 */

/**
 * `entry` declarations dispatch under their BARE name — `reclaim(sig)`, not
 * `__covenant_entrypoint_reclaim(sig)`. That prefix belongs to `function`
 * entrypoints like `auth_spend` and `auth_delegate`. Getting this wrong
 * produces a four-byte tag that matches no branch, and the failure is an
 * unhelpful script error rather than "no such entrypoint".
 */
const RECLAIM_ENTRYPOINT = "reclaim";
const REVOKE_ENTRYPOINT = "revoke";
const EXIT_ARG_TYPES = ["sig"];

const PLACEHOLDER_SIGNATURE = new Uint8Array(65);

function scriptHash(bytecode: Uint8Array): Uint8Array {
  return blake2b.create({ dkLen: 32 }).update(bytecode).digest();
}

export type ExitKind = "reclaim" | "revoke";

export interface ExitPlan {
  kind: ExitKind;
  template: CovenantTemplate;
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
  fee: bigint;
  computeBudget: number;
  /**
   * The transaction's lock time. Reclaim compiles `tx.daa >= expiresAt` to a
   * CLTV, so this must be at least `expiresAt` — AND still in the past, since
   * a lock time at or above the current DAA score is not yet final. Both can
   * be satisfied only once the chain has moved past expiry, which is the
   * whole point of the reclaim right. Revoke has no such requirement and
   * takes 0.
   */
  lockTime: bigint;
}

export interface UnsignedExit {
  tx: Transaction;
  entry: UtxoEntry;
  sighash: Uint8Array;
  /** Where the coin lands: P2PK of the principal, always. */
  destination: Uint8Array;
  /** Which key must sign. Reclaim and revoke do not use the same one. */
  signingKey: "principalKey" | "revocationKey";
}

/**
 * The signature script for an exit: one signature, the dispatch tag, and the
 * redeem script. No state, no proof, no successor — an exit ends the covenant
 * rather than continuing it, and there is nothing to carry forward.
 */
export function exitSignatureScript(plan: ExitPlan, signature: Uint8Array): Uint8Array {
  if (signature.length !== 65) {
    throw new Error(`a signature is 64 bytes plus a sighash type byte, got ${signature.length}`);
  }
  const name = plan.kind === "reclaim" ? RECLAIM_ENTRYPOINT : REVOKE_ENTRYPOINT;
  const b = new ScriptBuilder();
  b.addData(signature);
  b.addData(dispatchTag(name, EXIT_ARG_TYPES));
  b.addData(bytecodeFor(plan.template, { authority: plan.authority, state: plan.state }));
  return b.drain();
}

/**
 * Builds an exit transaction and the digest to sign.
 *
 * One input, one output. The covenant checks only that `outputs[0]` is
 * `P2PK(principalKey)` — it does not constrain the value, so the fee is
 * whatever is left over, and it does not constrain further outputs. This
 * builds exactly one so that nothing is left to interpretation.
 *
 * Note the destination is the PRINCIPAL key in both cases. Revoke is signed
 * by the revocation key but does not pay it: the right to stop a grant and
 * the right to receive its balance are deliberately separate, so a revocation
 * key can be delegated to a monitor without handing over the money.
 */
export function buildUnsignedExit(plan: ExitPlan): UnsignedExit {
  if (plan.fee <= 0n) throw new Error("fee must be positive");
  const value = plan.utxo.value - plan.fee;
  if (value <= 0n) throw new Error(`fee ${plan.fee} exceeds the grant's ${plan.utxo.value} sompi`);

  if (plan.kind === "reclaim" && plan.lockTime < plan.state.expiresAt) {
    throw new Error(
      `reclaim needs a lock time of at least expiresAt (${plan.state.expiresAt}), got ${plan.lockTime}. ` +
        `The covenant checks tx.daa >= expiresAt with a CLTV; a lower lock time fails the script.`,
    );
  }

  const principal = fromHex(plan.authority.principalKey);

  const grantSpk = payToScriptHashScript(
    scriptHash(bytecodeFor(plan.template, { authority: plan.authority, state: plan.state })),
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
        signatureScript: exitSignatureScript(plan, PLACEHOLDER_SIGNATURE),
        sequence: 0n,
        computeBudget: plan.computeBudget,
      },
    ],
    // No covenant binding. Nothing in consensus requires a covenant-bound
    // input to produce bound outputs — `CovenantsContext::from_tx` only reads
    // the bindings that are there — so the coin simply leaves the covenant.
    outputs: [{ value, scriptPublicKey: payToPubkeyScript(principal) }],
    lockTime: plan.lockTime,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };

  return {
    tx,
    entry,
    sighash: sighash(tx, 0, entry),
    destination: principal,
    signingKey: plan.kind === "reclaim" ? "principalKey" : "revocationKey",
  };
}

export function attachExitSignature(
  plan: ExitPlan,
  unsigned: UnsignedExit,
  signature: Uint8Array,
): Transaction {
  return {
    ...unsigned.tx,
    inputs: [{ ...unsigned.tx.inputs[0]!, signatureScript: exitSignatureScript(plan, signature) }],
  };
}
