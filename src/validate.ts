import type {
  Grant, GrantState, SpendRequest, DelegationRequest, Verdict, FailureCode,
  RecipientWitness,
} from "./types.ts";
import { available, statesEqual } from "./grant.ts";
import { epochIndexAt, epochSpentAt } from "./epoch.ts";
import { verifyInclusion, RecipientSet } from "./merkle.ts";

/**
 * Maximum recipients a child may name in `subset` mode.
 *
 * SETTLED by measurement. Covenant bytecode costs ~71 bytes per Merkle proof
 * level on a ~852-byte base, and KOMarkets already runs a 2,184-byte covenant
 * on-chain — so a depth-16 tree (65,536 recipients, 1,988 bytes) is affordable.
 * The allowlist was never the binding constraint. 8 members is comfortable.
 */
export const MAX_SUBSET_MEMBERS = 8;

/**
 * Every check a Toccata covenant must perform on a spend.
 *
 * Failures are COLLECTED here so the attack demo can show precisely which
 * rules bit; a single code hides that. The COVENANT must behave differently.
 *
 * GUARD ORDER IS NORMATIVE ON-CHAIN. Silverscript integer overflow is
 * undefined behaviour, and its spec is explicit that UB "is not guaranteed to
 * make execution fail" — the contract may simply succeed. So the covenant must
 * bound every attacker-supplied integer BEFORE that value reaches any
 * arithmetic, and reject immediately. A range check performed after the
 * addition is not a check at all. See PHASE0.md finding 1.
 *
 * That is why the range guards below appear before the successor is computed,
 * and why they are written as `amount <= limit - already` rather than
 * `already + amount <= limit`: the covenant mirrors this ordering, and the
 * two implementations should be readable against each other line by line.
 */
export function validateSpend(
  grant: Grant,
  state: GrantState,
  req: SpendRequest,
): Verdict {
  const failures: FailureCode[] = [];

  if (req.grantId !== grant.grantId || state.grantId !== grant.grantId) {
    return { ok: false, failures: ["PARENT_ID_MISMATCH"] };
  }

  if (state.status === "REVOKED") failures.push("REVOKED");
  else if (state.status !== "ACTIVE") failures.push("NOT_ACTIVE");

  const notYetValid = req.daaScore < grant.notBefore;
  if (notYetValid) failures.push("NOT_YET_VALID");
  if (req.daaScore >= grant.expiresAt) failures.push("EXPIRED");

  if (req.amount <= 0n) failures.push("AMOUNT_NOT_POSITIVE");
  if (req.amount > grant.maxPerSpend) failures.push("EXCEEDS_MAX_PER_SPEND");
  if (req.amount > available(grant, state)) failures.push("EXCEEDS_AVAILABLE_BUDGET");

  // Epoch arithmetic is undefined before the grant opens; the NOT_YET_VALID
  // failure above already covers that case.
  let expectedSuccessor: GrantState | undefined;
  if (!notYetValid) {
    const currentEpoch = epochIndexAt(grant, req.daaScore);
    const spentThisEpoch = epochSpentAt(grant, state, req.daaScore);
    if (spentThisEpoch + req.amount > grant.epochLimit) {
      failures.push("EXCEEDS_EPOCH_LIMIT");
    }
    expectedSuccessor = {
      grantId: grant.grantId,
      spentTotal: state.spentTotal + req.amount,
      reserved: state.reserved,
      epochIndex: currentEpoch,
      epochSpent: spentThisEpoch + req.amount,
      status: state.status,
    };
  }

  if (!verifyInclusion(req.recipient, req.recipientProof, grant.recipientsRoot)) {
    failures.push("RECIPIENT_NOT_AUTHORIZED");
  }

  // The check that makes every other check real. Without it an agent
  // rewrites its own remaining budget and the limits are decorative.
  if (!expectedSuccessor || !statesEqual(req.successor, expectedSuccessor)) {
    failures.push("INVALID_SUCCESSOR");
  }

  return { ok: failures.length === 0, failures, expectedSuccessor };
}

/**
 * RESOLVED — the recipient-subset question.
 *
 * `child.recipients ⊆ parent.recipients` is not decidable from a Merkle root,
 * so the child must WITNESS the relation rather than assert it:
 *
 *   inherit — child.recipientsRoot == parent.recipientsRoot. One equality.
 *   subset  — the child names its k members in canonical order; each is proved
 *             present in the parent tree, and the child root is recomputed
 *             from those k leaves and compared. k inclusion proofs.
 *
 * Canonical ordering is REQUIRED rather than sorted for: verifying that a list
 * is ascending costs k-1 comparisons, while sorting it inside a script costs
 * far more. It also forces one encoding per set, so the child root is unique.
 *
 * Rejected alternatives:
 *   - singleton-only children: a special case of subset with k=1, and needlessly
 *     restrictive once the general path exists.
 *   - "child root must be an internal node of the parent tree": one proof
 *     instead of k, but it only permits contiguous runs of the canonical
 *     ordering, so which subsets are expressible depends on how addresses
 *     happen to sort. Unusable in practice.
 */
export function validateDelegation(
  parent: Grant,
  parentState: GrantState,
  req: DelegationRequest,
): Verdict {
  const failures: FailureCode[] = [];
  const child = req.child;

  if (req.parentId !== parent.grantId || child.parentId !== parent.grantId) {
    return { ok: false, failures: ["PARENT_ID_MISMATCH"] };
  }

  if (parentState.status !== "ACTIVE") failures.push("NOT_ACTIVE");
  if (req.daaScore >= parent.expiresAt) failures.push("EXPIRED");

  if (child.assetId !== parent.assetId) failures.push("ASSET_MISMATCH");

  // Conservation: the child's budget comes out of what the parent still has,
  // not out of thin air. Total authority in the tree must not grow.
  if (child.budgetTotal > available(parent, parentState)) {
    failures.push("CHILD_BUDGET_EXCEEDS_PARENT");
  }
  if (child.maxPerSpend > parent.maxPerSpend) failures.push("CHILD_MAX_PER_SPEND_EXCEEDS_PARENT");
  if (child.epochLimit > parent.epochLimit) failures.push("CHILD_EPOCH_LIMIT_EXCEEDS_PARENT");
  if (child.notBefore < parent.notBefore) failures.push("CHILD_STARTS_BEFORE_PARENT");
  if (child.expiresAt > parent.expiresAt) failures.push("CHILD_OUTLIVES_PARENT");
  if (child.delegationDepth >= parent.delegationDepth) failures.push("DELEGATION_DEPTH_EXHAUSTED");

  failures.push(...checkRecipients(parent, child, req.recipientWitness ?? { mode: "inherit" }));

  const expectedSuccessor: GrantState = {
    grantId: parent.grantId,
    spentTotal: parentState.spentTotal,
    reserved: parentState.reserved + child.budgetTotal,
    epochIndex: parentState.epochIndex,
    epochSpent: parentState.epochSpent,
    status: parentState.status,
  };

  if (!statesEqual(req.parentSuccessor, expectedSuccessor)) {
    failures.push("INVALID_SUCCESSOR");
  }

  return { ok: failures.length === 0, failures, expectedSuccessor };
}

function checkRecipients(
  parent: Grant,
  child: Grant,
  witness: RecipientWitness,
): FailureCode[] {
  if (witness.mode === "inherit") {
    return child.recipientsRoot === parent.recipientsRoot ? [] : ["CHILD_RECIPIENTS_NOT_SUBSET"];
  }

  const members = witness.members;
  if (members.length === 0) return ["CHILD_RECIPIENTS_NOT_SUBSET"];
  if (members.length > MAX_SUBSET_MEMBERS) return ["CHILD_RECIPIENTS_TOO_MANY"];

  const out: FailureCode[] = [];

  // Ascending order, strictly — equal neighbours mean a duplicate, which would
  // let a child claim k members while really holding fewer.
  for (let i = 1; i < members.length; i++) {
    if (members[i - 1]!.recipient >= members[i]!.recipient) {
      out.push("CHILD_RECIPIENTS_NOT_CANONICAL");
      break;
    }
  }

  for (const m of members) {
    if (!verifyInclusion(m.recipient, m.proof, parent.recipientsRoot)) {
      out.push("CHILD_RECIPIENTS_NOT_SUBSET");
      break;
    }
  }

  // The child's committed root must be exactly the tree over its witnessed
  // members — otherwise it proves a narrow set and commits to a wide one.
  try {
    const rebuilt = new RecipientSet(members.map((m) => m.recipient));
    if (rebuilt.root !== child.recipientsRoot) out.push("CHILD_RECIPIENTS_NOT_SUBSET");
  } catch {
    out.push("CHILD_RECIPIENTS_NOT_CANONICAL");
  }

  return out;
}

export function revoke(state: GrantState): GrantState {
  return { ...state, status: "REVOKED" };
}
