import { toHex } from "./bytes.ts";
import { transactionId, type Transaction, type UtxoEntry } from "./tx.ts";

/**
 * A built transaction, in a form something else can check.
 *
 * Passing the golden test proves this SDK agrees with a recorded reference.
 * It does not prove the consensus engine agrees with either of them — a shared
 * misreading of the spec would satisfy both. So a built transaction can be
 * written out here and handed to `warda-deploy verify`, which runs it through
 * the same `TxScriptEngine` a node runs, and to `warda-deploy submit`, which
 * puts it on the network.
 *
 * The UTXO travels with the transaction because a covenant spend cannot be
 * validated without it: the entry carries the covenant id, and the digest
 * commits to the entry's script and value.
 */

export interface WireTransaction {
  version: number;
  lockTime: string;
  subnetworkId: string;
  gas: string;
  payloadHex: string;
  inputs: {
    previousOutpointTransactionId: string;
    previousOutpointIndex: number;
    signatureScriptHex: string;
    sequence: string;
    computeBudget: number;
  }[];
  outputs: {
    value: string;
    scriptPublicKeyVersion: number;
    scriptPublicKeyHex: string;
    covenant: { authorizingInput: number; covenantId: string } | null;
  }[];
  utxo: {
    value: string;
    scriptPublicKeyVersion: number;
    scriptPublicKeyHex: string;
    blockDaaScore: string;
    isCoinbase: boolean;
    covenantId: string | null;
  };
  /** What this SDK believes the id to be. The verifier recomputes it; a
   *  mismatch means the two disagree about serialization, which is worth
   *  knowing before anything is broadcast. */
  txid: string;
  builtBy: string;
}

/** Integers go out as strings: a sompi value exceeds what JSON numbers hold exactly. */
export function toWire(tx: Transaction, entry: UtxoEntry, builtBy = "@warda/kaspa"): WireTransaction {
  return {
    version: tx.version,
    lockTime: tx.lockTime.toString(),
    subnetworkId: toHex(tx.subnetworkId),
    gas: tx.gas.toString(),
    payloadHex: toHex(tx.payload),
    inputs: tx.inputs.map((i) => ({
      previousOutpointTransactionId: toHex(i.previousOutpoint.transactionId),
      previousOutpointIndex: i.previousOutpoint.index,
      signatureScriptHex: toHex(i.signatureScript),
      sequence: i.sequence.toString(),
      computeBudget: i.computeBudget,
    })),
    outputs: tx.outputs.map((o) => ({
      value: o.value.toString(),
      scriptPublicKeyVersion: o.scriptPublicKey.version,
      scriptPublicKeyHex: toHex(o.scriptPublicKey.script),
      covenant: o.covenant
        ? { authorizingInput: o.covenant.authorizingInput, covenantId: toHex(o.covenant.covenantId) }
        : null,
    })),
    utxo: {
      value: entry.value.toString(),
      scriptPublicKeyVersion: entry.scriptPublicKey.version,
      scriptPublicKeyHex: toHex(entry.scriptPublicKey.script),
      blockDaaScore: entry.blockDaaScore.toString(),
      isCoinbase: entry.isCoinbase,
      covenantId: entry.covenantId ? toHex(entry.covenantId) : null,
    },
    txid: toHex(transactionId(tx)),
    builtBy,
  };
}
