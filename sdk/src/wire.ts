import { fromHex, toHex } from "./bytes.ts";
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
  /** The one-input shorthand. Present only when the transaction has exactly
   *  one input, so every wire file written before settlement keeps its shape. */
  utxo?: WireUtxo;
  /** One per input, index-aligned. The general form; a settlement carries two. */
  utxos: WireUtxo[];
  /** What this SDK believes the id to be. The verifier recomputes it; a
   *  mismatch means the two disagree about serialization, which is worth
   *  knowing before anything is broadcast. */
  txid: string;
  builtBy: string;
}

export interface WireUtxo {
  value: string;
  scriptPublicKeyVersion: number;
  scriptPublicKeyHex: string;
  blockDaaScore: string;
  isCoinbase: boolean;
  covenantId: string | null;
}

function wireUtxo(entry: UtxoEntry): WireUtxo {
  return {
    value: entry.value.toString(),
    scriptPublicKeyVersion: entry.scriptPublicKey.version,
    scriptPublicKeyHex: toHex(entry.scriptPublicKey.script),
    blockDaaScore: entry.blockDaaScore.toString(),
    isCoinbase: entry.isCoinbase,
    covenantId: entry.covenantId ? toHex(entry.covenantId) : null,
  };
}

/**
 * A transaction whose inputs are spent under MORE THAN ONE covenant.
 *
 * Settlement is the first: the parent runs `reabsorb` and the child runs
 * `settle`, in one transaction, under two keys. Each input's signature digest
 * commits to its OWN entry's script and value, so a verifier needs all of
 * them — with one entry it can only judge input 0, which would silently leave
 * the revocation-key half of a settlement unchecked.
 */
export function toWireMulti(
  tx: Transaction,
  entries: UtxoEntry[],
  builtBy = "@warda_protocol/kaspa",
): WireTransaction {
  if (entries.length !== tx.inputs.length) {
    throw new Error(
      `this transaction has ${tx.inputs.length} inputs and ${entries.length} utxo entries; ` +
        `each input's digest commits to its own entry, so they must correspond`,
    );
  }
  const wire = toWire(tx, entries[0]!, builtBy);
  return {
    ...wire,
    // Dropped rather than left pointing at input 0's entry: a reader that
    // honours `utxo` and ignores `utxos` would validate one input of several
    // and report a pass. Absent, it fails instead.
    utxo: undefined,
    utxos: entries.map(wireUtxo),
  };
}

/** Integers go out as strings: a sompi value exceeds what JSON numbers hold exactly. */
/**
 * Wire form back to a transaction.
 *
 * The inverse of `toWire`, and it did not exist because nothing needed it:
 * every tool here builds a transaction, holds it, and converts outward once at
 * the end.
 *
 * An MCP client is the case that breaks that. `warda_build_spend` returns the
 * WIRE form — the server holds no key, so the transaction leaves it unsigned
 * and comes back later from somewhere else entirely. Whatever signs it has
 * only the wire form and still has to submit, and `submitTransaction` takes
 * the internal shape.
 *
 * Not a parser: it assumes the shape `toWire` produces and will throw on
 * anything else, which is the right failure for a file that claims to be one.
 */
export function fromWire(w: WireTransaction): Transaction {
  return {
    version: w.version,
    lockTime: BigInt(w.lockTime),
    subnetworkId: fromHex(w.subnetworkId),
    gas: BigInt(w.gas),
    payload: fromHex(w.payloadHex),
    inputs: w.inputs.map((i) => ({
      previousOutpoint: {
        transactionId: fromHex(i.previousOutpointTransactionId),
        index: i.previousOutpointIndex,
      },
      signatureScript: fromHex(i.signatureScriptHex),
      sequence: BigInt(i.sequence),
      computeBudget: i.computeBudget,
    })),
    outputs: w.outputs.map((o) => ({
      value: BigInt(o.value),
      scriptPublicKey: { version: o.scriptPublicKeyVersion, script: fromHex(o.scriptPublicKeyHex) },
      covenant: o.covenant
        ? {
            authorizingInput: o.covenant.authorizingInput,
            covenantId: fromHex(o.covenant.covenantId),
          }
        : undefined,
    })),
  };
}

export function toWire(tx: Transaction, entry: UtxoEntry, builtBy = "@warda_protocol/kaspa"): WireTransaction {
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
    utxo: wireUtxo(entry),
    utxos: [wireUtxo(entry)],
    txid: toHex(transactionId(tx)),
    builtBy,
  };
}
