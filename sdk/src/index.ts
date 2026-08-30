/**
 * @warda/kaspa — build and sign agent spends against a Warda grant, from
 * JavaScript, with no Silverscript compiler and no Rust toolchain.
 *
 * What this package does NOT do, deliberately:
 *
 *   It does not decide whether a spend is allowed. The covenant does that, on
 *   chain, and it is the only thing that can. A second implementation of the
 *   rules would fail by wrongly PERMITTING — an SDK that says yes to a spend
 *   the grant forbids is how a budget gets drained. This package only lays out
 *   bytes, where a mistake fails by producing a transaction the network
 *   rejects.
 *
 *   It does not broadcast. Bring your own node connection; a spend is an
 *   ordinary transaction once it is built.
 *
 * Everything here is checked against `golden-spend.json`, a reference
 * transaction produced by the same Rust construction path that put a spend on
 * testnet-10. Matching it means matching something the network has validated.
 */

export { fromHex, toHex, concat, equal } from "./bytes.ts";

export {
  bytecodeFor,
  scriptHashFor,
  type CovenantTemplate,
  type FieldSlot,
  type Grant,
  type GrantAuthority,
  type GrantState,
} from "./template.ts";

export { ScriptBuilder, serializeI64 } from "./script.ts";

export {
  payToPubkeyScript,
  payToScriptHashScript,
  sighash,
  transactionId,
  SIG_HASH_ALL,
  SUBNETWORK_ID_NATIVE,
  type CovenantBinding,
  type ScriptPublicKey,
  type Transaction,
  type TransactionInput,
  type TransactionOutpoint,
  type TransactionOutput,
  type UtxoEntry,
} from "./tx.ts";

export {
  attachSignature,
  buildUnsignedSpend,
  dispatchTag,
  spendSignatureScript,
  successorState,
  type MerkleProof,
  type SpendPlan,
  type UnsignedSpend,
} from "./spend.ts";

export {
  attachGenesisSignature,
  buildGenesis,
  covenantId,
  type FundingUtxo,
  type GenesisPlan,
  type UnsignedGenesis,
} from "./genesis.ts";

export {
  attachDelegationSignature,
  buildUnsignedDelegation,
  childStateFrom,
  delegateSignatureScript,
  parentSuccessorState,
  type ChildTerms,
  type DelegationPlan,
  type UnsignedDelegation,
} from "./delegate.ts";

export { pushState, pushStateArray, STATE_FIELDS } from "./state.ts";

export { RecipientSet } from "./recipients.ts";

export { spendPlanFrom, type SpendPlanDocument } from "./plan.ts";

export { toWire, type WireTransaction } from "./wire.ts";

export {
  agentPublicKey,
  signDigest,
  signSpend,
  verifyDigest,
  type SignedSpend,
} from "./sign.ts";

export { blake2b256, HashWriter } from "./hashers.ts";
