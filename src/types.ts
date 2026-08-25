export type Hex = string;

export type GrantStatus = "ACTIVE" | "REVOKED" | "EXPIRED";

export interface MerkleSibling {
  hash: Hex;
  /** True when the sibling is the LEFT input to the parent hash.
   *  Carried per-sibling because odd nodes are promoted without a sibling,
   *  so level parity alone cannot reconstruct the order. */
  left: boolean;
}

export interface MerkleProof {
  index: number;
  siblings: MerkleSibling[];
}

/**
 * The immutable authority definition. Committed at issuance and never
 * changed — a covenant that lets any field here move is not a Warda grant.
 */
export interface Grant {
  version: number;
  grantId: Hex;
  parentId: Hex | null;
  principalKey: Hex;
  agentKey: Hex;
  revocationKey: Hex;
  assetId: string;
  budgetTotal: bigint;
  maxPerSpend: bigint;
  epochLimit: bigint;
  epochLength: bigint;
  recipientsRoot: Hex;
  recipientsDepth: number;
  notBefore: bigint;
  expiresAt: bigint;
  delegationDepth: number;
  nonce: Hex;
}

/**
 * The mutable state carried in the covenant UTXO. This is what the
 * successor output must contain, and the only thing a spend may change.
 */
export interface GrantState {
  grantId: Hex;
  spentTotal: bigint;
  /** Delegated to children and therefore no longer spendable by this agent. */
  reserved: bigint;
  epochIndex: bigint;
  epochSpent: bigint;
  status: GrantStatus;
}

export interface SpendRequest {
  grantId: Hex;
  amount: bigint;
  recipient: Hex;
  /** Inclusion proof of `recipient` against grant.recipientsRoot. */
  recipientProof: MerkleProof;
  daaScore: bigint;
  /** Successor state the spending transaction actually produces. */
  successor: GrantState;
}

/**
 * How a child grant proves its allowlist is no wider than its parent's.
 *
 * `inherit` — the child takes the parent's whole allowlist. Costs one root
 * equality check and nothing else. Use it whenever narrowing isn't needed.
 *
 * `subset` — the child names its members explicitly and proves each one is
 * in the parent's tree. Costs k inclusion proofs plus rebuilding the child
 * root from k leaves. This is the general case; `inherit` is its free path.
 */
export type RecipientWitness =
  | { mode: "inherit" }
  | { mode: "subset"; members: { recipient: Hex; proof: MerkleProof }[] };

export interface DelegationRequest {
  parentId: Hex;
  child: Grant;
  daaScore: bigint;
  /** Defaults to `{ mode: "inherit" }` when omitted. */
  recipientWitness?: RecipientWitness;
  /** Successor parent state the delegating transaction actually produces. */
  parentSuccessor: GrantState;
}

export type FailureCode =
  | "NOT_ACTIVE"
  | "REVOKED"
  | "NOT_YET_VALID"
  | "EXPIRED"
  | "AMOUNT_NOT_POSITIVE"
  | "EXCEEDS_MAX_PER_SPEND"
  | "EXCEEDS_AVAILABLE_BUDGET"
  | "EXCEEDS_EPOCH_LIMIT"
  | "RECIPIENT_NOT_AUTHORIZED"
  | "INVALID_SUCCESSOR"
  | "ASSET_MISMATCH"
  | "CHILD_BUDGET_EXCEEDS_PARENT"
  | "CHILD_MAX_PER_SPEND_EXCEEDS_PARENT"
  | "CHILD_EPOCH_LIMIT_EXCEEDS_PARENT"
  | "CHILD_STARTS_BEFORE_PARENT"
  | "CHILD_OUTLIVES_PARENT"
  | "DELEGATION_DEPTH_EXHAUSTED"
  | "CHILD_RECIPIENTS_NOT_SUBSET"
  | "CHILD_RECIPIENTS_NOT_CANONICAL"
  | "CHILD_RECIPIENTS_TOO_MANY"
  | "PARENT_ID_MISMATCH";

export interface Verdict {
  ok: boolean;
  failures: FailureCode[];
  /** The state a valid transaction must produce. Present even on failure,
   *  so a caller can see what it should have built. */
  expectedSuccessor?: GrantState;
}

export function fail(...codes: FailureCode[]): Verdict {
  return { ok: false, failures: codes };
}
