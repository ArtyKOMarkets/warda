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

// ---- the Kaspa SDK's "safe JSON" ----------------------------------------

/**
 * A transaction in `kaspa-sdk-safe-json-v2.0.0`, the encoding kaspa-x402 v2
 * carries an exact payment in.
 *
 * ## Why this is not `toWire`
 *
 * `toWire` is OUR shape: it exists so a built transaction can be handed to
 * `warda-deploy verify` and run through the real script engine, and it carries
 * things only this repository cares about — the compute budget per input, the
 * covenant binding per output, who built it.
 *
 * This is the Kaspa WASM SDK's shape, produced by `Transaction.serializeToSafeJSON`
 * and consumed by `Transaction.deserializeFromSafeJSON`. It is not ours to
 * design, and three of its details are exactly the kind that a plausible
 * reimplementation gets wrong:
 *
 *   - every u64 is a STRING, not a number — hence "safe";
 *   - `scriptPublicKey` is the SERIALIZED form: a little-endian u16 version
 *     followed by the script, so an ordinary v0 script starts `0000`. Not the
 *     bare script, which is what every other part of this SDK passes around;
 *   - the input carries `transactionId` and `index` FLATTENED, not a nested
 *     `previousOutpoint` as the constructor takes.
 *
 * `mass` is emitted as "0". The SDK emits whatever mass the transaction object
 * is carrying, and a transaction this SDK built has never been through a mass
 * calculator — so "0" is the true statement, and any other value here would be
 * a number we made up about a transaction we are asking someone else to accept.
 *
 * Verified against the real SDK rather than against this comment: see
 * `test/safe-json.test.ts`, which hands this output to
 * `Transaction.deserializeFromSafeJSON` and requires the id it derives to match
 * the one this SDK computes independently.
 */
export interface SafeJsonTransaction {
  id: string;
  version: number;
  inputs: {
    transactionId: string;
    index: number;
    sequence: string;
    sigOpCount: number;
    signatureScript: string;
    utxo: {
      address: string | null;
      amount: string;
      scriptPublicKey: string;
      blockDaaScore: string;
      isCoinbase: boolean;
    };
  }[];
  outputs: { value: string; scriptPublicKey: string }[];
  subnetworkId: string;
  lockTime: string;
  gas: string;
  mass: string;
  payload: string;
}

/**
 * The serialized script public key: a little-endian u16 version, then the
 * script. This is the form the SDK's safe JSON uses and the form kaspa-x402's
 * schema pins with its `^0000…` pattern; the two agree because they are the
 * same encoding.
 */
export function serializedScriptPublicKey(spk: { version: number; script: Uint8Array }): string {
  const version = new Uint8Array(2);
  version[0] = spk.version & 0xff;
  version[1] = (spk.version >> 8) & 0xff;
  return toHex(version) + toHex(spk.script);
}

/**
 * `sigOpCount` is 1 per input here.
 *
 * Every input this SDK builds is spent by exactly one signature — a covenant
 * spend authorized by the agent key, or a P2PK exit. There is no path in this
 * repository that produces a multisig input, so a count derived from the script
 * would be a computation with one possible answer, dressed up as a general one.
 * If that ever stops being true this must stop being a constant, and the test
 * that pins it against the real SDK is what will say so.
 */
export function toSafeJson(tx: Transaction, entries: UtxoEntry[]): SafeJsonTransaction {
  if (entries.length !== tx.inputs.length) {
    throw new Error(
      `this transaction has ${tx.inputs.length} inputs and ${entries.length} utxo entries; ` +
        `the safe-JSON form carries each input's entry inline, so they must correspond`,
    );
  }
  return {
    id: toHex(transactionId(tx)),
    version: tx.version,
    inputs: tx.inputs.map((input, i) => {
      const entry = entries[i]!;
      return {
        transactionId: toHex(input.previousOutpoint.transactionId),
        index: input.previousOutpoint.index,
        sequence: input.sequence.toString(),
        sigOpCount: 1,
        signatureScript: toHex(input.signatureScript),
        utxo: {
          // The SDK writes null when the entry carries no address, and an
          // entry built here never does: an address is a rendering of the
          // script, and the script is already right there.
          address: null,
          amount: entry.value.toString(),
          scriptPublicKey: serializedScriptPublicKey(entry.scriptPublicKey),
          blockDaaScore: entry.blockDaaScore.toString(),
          isCoinbase: entry.isCoinbase,
        },
      };
    }),
    outputs: tx.outputs.map((o) => ({
      value: o.value.toString(),
      scriptPublicKey: serializedScriptPublicKey(o.scriptPublicKey),
    })),
    subnetworkId: toHex(tx.subnetworkId),
    lockTime: tx.lockTime.toString(),
    gas: tx.gas.toString(),
    mass: "0",
    payload: toHex(tx.payload),
  };
}
