/**
 * @warda_protocol/kaspa — build and sign agent spends against a Warda grant, from
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
  // The inverse of the splice: read a grant back out of the redeem script that
  // every spending transaction carries in the clear. This is what makes a grant
  // recoverable without the manifest describing it.
  decodeGrant,
  // The step before decoding: find the redeem script inside the signature
  // script that carried it. P2SH publishes it; this picks it out.
  redeemScriptFrom,
  grantFromSignatureScript,
  scriptHashFor,
  // A grant's claim about its own redeem-script shape, derived from the
  // template and the AUTHORITY together. Consumers building state need it, and
  // deriving it beats accepting it: a stated id belonging to another covenant
  // produces a plausible address with nothing at it.
  templateIdFor,
  templateFingerprint,
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
  claimedDaaFor,
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
  // The reserve stack's push. Exported because settlement needs to CHECK a
  // pop before attempting it — the chain re-derives this itself, so the value
  // is in the error message rather than in what gets accepted.
  pushChild,
  subsetWitness,
  parentSuccessorState,
  type ChildTerms,
  type DelegationPlan,
  type UnsignedDelegation,
} from "./delegate.ts";

export { pushState, pushStateArray, STATE_FIELDS } from "./state.ts";

export { RecipientSet } from "./recipients.ts";

export { spendPlanFrom, type SpendPlanDocument } from "./plan.ts";

export {
  fromWire,
  toWire,
  // A transaction whose inputs are spent under more than one covenant. A
  // settlement is the first: each input's digest commits to its OWN entry, so
  // a verifier given one entry can only judge input 0 and would report a pass.
  toWireMulti,
  type WireTransaction,
} from "./wire.ts";

export {
  agentPublicKey,
  signDigest,
  signSpend,
  verifyDigest,
  type SignedSpend,
} from "./sign.ts";

export { blake2b256, HashWriter } from "./hashers.ts";

export {
  candidateUrls,
  RpcConnection,
  RpcError,
  stringify,
  toBigInt,
  type RpcOptions,
  type RpcReply,
} from "./rpc.ts";

export {
  NodeClient,
  // Ask a node whether it can be believed before believing it. Every check
  // it makes fails by returning a plausible answer rather than an error.
  inspect,
  formatHealth,
  parseDagInfo,
  parseInfo,
  parseUtxos,
  scriptPublicKeyFromWire,
  scriptPublicKeyToWire,
  transactionToWire,
  type AddressUtxo,
  type DagInfo,
  type NodeCheck,
  type NodeHealth,
  type NodeInfo,
  type OpenOptions,
} from "./node.ts";

/**
 * Running a kaspad is a reasonable ask of an operator and an unreasonable one
 * of somebody trying this for ten minutes. A resolver answers one question —
 * which node should I talk to — and the wRPC conversation that follows is
 * byte for byte the same as with a local one.
 */
export {
  resolveNode,
  resolverFrom,
  resolverUrl,
  type NodeDescriptor,
  type ResolveOptions,
} from "./resolver.ts";

export {
  AddressVersion,
  decodeAddress,
  encodeAddress,
  pubkeyToAddress,
  scriptHashToAddress,
  type DecodedAddress,
  type NetworkPrefix,
} from "./address.ts";

export {
  describeGrant,
  verifyGrant,
  type Finding,
  type GrantExpectation,
  type GrantReport,
} from "./verify.ts";

export {
  attachExitSignature,
  buildUnsignedExit,
  exitSignatureScript,
  type ExitKind,
  type ExitPlan,
  type UnsignedExit,
} from "./exit.ts";

/**
 * Settlement: the other half of delegation. Until this existed a delegation
 * was one-way — a parent that subdivided itself shrank permanently, because
 * the reserve could only be released by the child expiring into the
 * PRINCIPAL's hands rather than back into the parent's.
 */
export {
  attachReabsorbSignatures,
  buildUnsignedReabsorb,
  reabsorbSignatureScript,
  reabsorbSuccessorState,
  settleSignatureScript,
  type GrantUtxo,
  type ReabsorbPlan,
  type UnsignedReabsorb,
} from "./reabsorb.ts";

/**
 * Watching a grant, which cannot be done by watching an address: the address
 * is a hash of the state, so the first spend moves it and every one after
 * leaves an empty address that looks exactly like a drain. A watcher has to
 * FOLLOW, and the mempool plus a deterministic successor is what lets it.
 */
export {
  GrantWatcher,
  type Alert,
  type ArmedRevocation,
  type PollResult,
  type Transition,
  type TransitionKind,
  type WatchOptions,
  type WatchRules,
} from "./watch.ts";

export {
  deriveSecret,
  derivePublic,
  resolveSigner,
  // The reserve stack of a grant that has never delegated. Not the zero hash:
  // Kaspa script encodes zero as the EMPTY byte string, so a zero literal
  // compiles to nothing and the field silently disappears.
  EMPTY_RESERVE,
  KEY_DOMAIN,
  type Derivation,
  type KeyDomain,
} from "./keys.ts";
