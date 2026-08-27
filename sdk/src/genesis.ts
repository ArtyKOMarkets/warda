import { toHex, u16le, u32le, u64le } from "./bytes.ts";
import { HashWriter } from "./hashers.ts";
import { ScriptBuilder } from "./script.ts";
import {
  payToScriptHashScript,
  SIG_HASH_ALL,
  SUBNETWORK_ID_NATIVE,
  sighash,
  type ScriptPublicKey,
  type Transaction,
  type TransactionOutput,
  type UtxoEntry,
} from "./tx.ts";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytecodeFor, type CovenantTemplate, type Grant } from "./template.ts";

/**
 * Creating a grant.
 *
 * Spending is only half the protocol. Until this existed, a principal needed
 * the Rust tool to issue a grant, so "give your agent a budget" was not
 * something an application could actually do — only something it could read
 * about.
 *
 * Genesis is an ordinary P2PK spend that happens to pay into a covenant. The
 * one thing about it that is not ordinary is the chicken-and-egg in the
 * covenant id, which is worth stating plainly because getting it wrong
 * produces a valid-looking transaction with an id that means nothing:
 *
 *   The grant output carries a covenant BINDING containing a covenant ID.
 *   That id is derived from the funding outpoint and the authorized outputs —
 *   each hashed WITHOUT its binding, to avoid self-reference. So the output is
 *   built unbound, the id is computed over it, and only then is the binding
 *   written in.
 */

/**
 * blake2b-256 keyed with "CovenantID" over the funding outpoint and every
 * authorized output. Any change to an output's index, value or script yields a
 * different covenant — which is what makes the id a commitment to the rules
 * rather than a name for them.
 */
export function covenantId(
  outpoint: { transactionId: Uint8Array; index: number },
  authorizedOutputs: { index: number; output: TransactionOutput }[],
): Uint8Array {
  const w = HashWriter.blake2b("CovenantID");
  w.update(outpoint.transactionId).writeU32(outpoint.index).writeLen(authorizedOutputs.length);
  for (const { index, output } of authorizedOutputs) {
    w.writeU32(index)
      .writeU64(output.value)
      .writeU16(output.scriptPublicKey.version)
      .writeVarBytes(output.scriptPublicKey.script);
  }
  return w.digest();
}

export interface FundingUtxo {
  outpointTransactionId: Uint8Array;
  outpointIndex: number;
  value: bigint;
  /** The wallet script the funding UTXO sits behind; change returns here. */
  scriptPublicKey: ScriptPublicKey;
  blockDaaScore: bigint;
  isCoinbase: boolean;
}

export interface GenesisPlan {
  template: CovenantTemplate;
  /** The grant to create: its authority and its INITIAL state. */
  grant: Grant;
  funding: FundingUtxo;
  /** How much of the funding to lock into the grant. */
  grantValue: bigint;
  fee: bigint;
  computeBudget: number;
  /** Where the remainder goes. Defaults to the funding script. */
  changeScriptPublicKey?: ScriptPublicKey;
}

export interface UnsignedGenesis {
  tx: Transaction;
  entry: UtxoEntry;
  sighash: Uint8Array;
  covenantId: Uint8Array;
  grantScriptPublicKey: ScriptPublicKey;
  grantScriptHash: Uint8Array;
  changeValue: bigint;
}

function scriptHash(bytecode: Uint8Array): Uint8Array {
  return blake2b.create({ dkLen: 32 }).update(bytecode).digest();
}

export function buildGenesis(plan: GenesisPlan): UnsignedGenesis {
  const { state } = plan.grant;
  if (state.spentTotal !== 0n || state.reserved !== 0n || state.epochSpent !== 0n) {
    // A grant that starts mid-history is not impossible, but it is almost
    // always a caller reusing a live state by mistake — and the resulting
    // address would not be the one they expect to fund.
    throw new Error("a grant is created at zero state: spentTotal, reserved and epochSpent must be 0");
  }
  if (plan.grantValue <= 0n) throw new Error("grantValue must be positive");

  const change = plan.funding.value - plan.grantValue - plan.fee;
  if (change < 0n) {
    throw new Error(
      `funding ${plan.funding.value} is less than grant ${plan.grantValue} plus fee ${plan.fee}`,
    );
  }

  const bytecode = bytecodeFor(plan.template, plan.grant);
  const grantScriptHash = scriptHash(bytecode);
  const grantScriptPublicKey = payToScriptHashScript(grantScriptHash);
  const changeSpk = plan.changeScriptPublicKey ?? plan.funding.scriptPublicKey;

  // Unbound first — the id is computed over this, so it cannot contain it.
  const unbound: TransactionOutput = {
    value: plan.grantValue,
    scriptPublicKey: grantScriptPublicKey,
  };
  const id = covenantId(
    { transactionId: plan.funding.outpointTransactionId, index: plan.funding.outpointIndex },
    [{ index: 0, output: unbound }],
  );

  const tx: Transaction = {
    version: 1, // covenant bindings only enter the sighash at v1
    inputs: [
      {
        previousOutpoint: {
          transactionId: plan.funding.outpointTransactionId,
          index: plan.funding.outpointIndex,
        },
        signatureScript: new Uint8Array(0),
        sequence: 0n,
        computeBudget: plan.computeBudget,
      },
    ],
    outputs: [
      {
        value: plan.grantValue,
        scriptPublicKey: grantScriptPublicKey,
        covenant: { authorizingInput: 0, covenantId: id },
      },
      { value: change, scriptPublicKey: changeSpk },
    ],
    lockTime: 0n,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };

  const entry: UtxoEntry = {
    value: plan.funding.value,
    scriptPublicKey: plan.funding.scriptPublicKey,
    blockDaaScore: plan.funding.blockDaaScore,
    isCoinbase: plan.funding.isCoinbase,
    // The FUNDING utxo carries no covenant. It is an ordinary wallet output;
    // the covenant begins with the output this transaction creates.
  };

  return {
    tx,
    entry,
    sighash: sighash(tx, 0, entry),
    covenantId: id,
    grantScriptPublicKey,
    grantScriptHash,
    changeValue: change,
  };
}

/**
 * Attaches a P2PK signature.
 *
 * Unlike a covenant spend, genesis's signature script is a single data push
 * and is EMPTY before signing — so this changes the script's length. That is
 * fine: signature scripts are excluded from both the sighash and the txid
 * preimage, so neither moves.
 */
export function attachGenesisSignature(unsigned: UnsignedGenesis, signature: Uint8Array): Transaction {
  if (signature.length !== 65) {
    throw new Error(`a signature is 64 bytes plus a sighash type byte, got ${signature.length}`);
  }
  return {
    ...unsigned.tx,
    inputs: [
      {
        ...unsigned.tx.inputs[0]!,
        signatureScript: new ScriptBuilder().addData(signature).drain(),
      },
    ],
  };
}

export { SIG_HASH_ALL, toHex, u16le, u32le, u64le };
