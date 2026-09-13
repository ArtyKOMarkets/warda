/**
 * Hiring a sub-agent: what a parent may hand over, and what it may not.
 *
 * This is the rulebook the orchestrator consults BEFORE it builds anything.
 * Every refusal here is one the covenant would also make — but it would make
 * it in a script error, on chain, after a fee, and usually with a message
 * about a hash. The value of this module is that the same no arrives in
 * English, in milliseconds, before money moves.
 *
 * Nothing here re-implements a rule. Conservation, attenuation and the subtree
 * witness all live in `@warda_protocol/kaspa`; this checks the SAME conditions
 * against the SAME code and explains them. Where a check could drift from the
 * covenant, it calls the SDK rather than restating the arithmetic.
 *
 * ## The two findings that shape a delegation tree
 *
 * **Only a single-payee child is reliably expressible.** A child may narrow its
 * parent's allowlist, but the witness covers a SUBTREE: the members must be a
 * contiguous, power-of-two-aligned run of the parent's set. And that set is
 * sorted by the HEX OF THE KEY, discarding insertion order — so a caller
 * cannot arrange which payees sit together. A one-member run aligns at any
 * index; two is a coin flip; four is worse. So the reliable shape is one child
 * per service, which is the right security shape anyway: "may pay the search
 * API and nothing else" belongs in an address, not a config file.
 *
 * **Settlement is LIFO.** `reserveRoot` is a hash chain, not a set — each
 * delegation hashes the new child onto the front, and popping requires naming
 * the value the chain had before that push. With children A then B
 * outstanding, B must settle before A, and no builder can be persuaded
 * otherwise. That is an operational constraint on how a tree is run, not a
 * detail of how it is coded, so it is checked here where the plan is made.
 */

import {
  RecipientSet,
  fromHex,
  toHex,
  type GrantState,
} from "@warda_protocol/kaspa";

/** What the orchestrator wants: one agent, one job, one thing it may pay. */
export interface JobSpec {
  /** A label for humans and logs. Not on chain. */
  name: string;
  /** The sub-agent's x-only public key. It generated this; we never hold its secret. */
  agentKey: string;
  /** The ONE payee this agent may pay, as an x-only key. See the header. */
  payee: string;
  /** Total the sub-agent may spend across the job. */
  budgetSompi: bigint;
  /** Most it may spend in one payment. */
  maxPerSpendSompi: bigint;
  /** Most it may spend inside one epoch. Omit to inherit the parent's. */
  epochLimitSompi?: bigint;
  /** How long the child may live, in DAA from now. Omit to inherit the parent's term. */
  windowDaa?: bigint;
}

export interface HireTerms {
  agentKey: string;
  budgetTotal: bigint;
  maxPerSpend: bigint;
  epochLimit: bigint;
  delegationDepth: bigint;
  expiresAt?: bigint;
  recipients: string[];
}

export interface Refusal {
  /** Short, stable, for tests and logs. */
  code:
    | "no-depth-left"
    | "not-in-allowlist"
    | "unaligned-subset"
    | "over-uncommitted"
    | "cap-over-parent"
    | "epoch-over-parent"
    | "window-outside-parent"
    | "budget-not-positive"
    | "cap-over-budget";
  /** What a person should do about it. */
  detail: string;
}

/** The uncommitted balance: what the parent could still hand to a child. */
export function uncommitted(parent: GrantState): bigint {
  return parent.budgetTotal - parent.spentTotal - parent.reserved;
}

/**
 * Can this parent hire this agent on these terms?
 *
 * Returns every reason it cannot, not the first. An orchestrator that fixes
 * one refusal per round trip against a chain is an orchestrator that takes
 * five blocks to learn what one function knew.
 */
export function checkHire(
  parent: GrantState,
  members: RecipientSet,
  job: JobSpec,
  now: bigint,
): Refusal[] {
  const out: Refusal[] = [];

  if (job.budgetSompi <= 0n) {
    out.push({ code: "budget-not-positive", detail: "a child with no budget can pay nobody" });
  }

  /* Depth must STRICTLY decrease, or the tree could not terminate. A parent at
     depth 0 is a leaf: it may spend, and it may not hire. */
  if (parent.delegationDepth <= 0n) {
    out.push({
      code: "no-depth-left",
      detail:
        "this grant is at delegation depth 0, so it may spend but not hire. " +
        "Depth is fixed at genesis and a child's must be strictly less than its parent's — " +
        "issue the parent deeper if the tree needs another level.",
    });
  }

  const free = uncommitted(parent);
  if (job.budgetSompi > free) {
    out.push({
      code: "over-uncommitted",
      detail:
        `this grant can commit ${free} sompi and the job asks for ${job.budgetSompi}. ` +
        `Authority is subdivided, never created: budget ${parent.budgetTotal} less ` +
        `${parent.spentTotal} spent and ${parent.reserved} already reserved in outstanding children. ` +
        `Settle a child first, or hire smaller.`,
    });
  }

  if (job.maxPerSpendSompi > parent.maxPerSpend) {
    out.push({
      code: "cap-over-parent",
      detail:
        `a child's per-spend cap may only shrink: the parent's is ${parent.maxPerSpend}, ` +
        `the job asks for ${job.maxPerSpendSompi}.`,
    });
  }
  if (job.maxPerSpendSompi > job.budgetSompi) {
    out.push({
      code: "cap-over-budget",
      detail: "a per-spend cap above the child's whole budget is not a cap",
    });
  }

  const epochLimit = job.epochLimitSompi ?? parent.epochLimit;
  if (epochLimit > parent.epochLimit) {
    out.push({
      code: "epoch-over-parent",
      detail: `a child's epoch limit may only shrink: the parent's is ${parent.epochLimit}.`,
    });
  }

  if (job.windowDaa !== undefined) {
    const expiresAt = now + job.windowDaa;
    if (expiresAt > parent.expiresAt) {
      out.push({
        code: "window-outside-parent",
        detail:
          `the child would end at ${expiresAt} and its parent ends at ${parent.expiresAt}. ` +
          `A child may end no later than its parent — a shorter window is the only ` +
          `attenuation that closes with nobody online.`,
      });
    }
  }

  /* The allowlist. Asked of the SDK rather than restated: the alignment rules
     are the Merkle tree's, and a second implementation of them here would be a
     second thing that can disagree with the witness the covenant checks. */
  const payee = job.payee.toLowerCase();
  const known = members.members.some((m) => toHex(m) === payee);
  if (!known) {
    out.push({
      code: "not-in-allowlist",
      detail:
        `${payee.slice(0, 16)}… is not on this grant's allowlist, and a child can only ` +
        `narrow its parent's, never extend it. The list was fixed at genesis.`,
    });
  } else {
    try {
      members.subtree([fromHex(payee)]);
    } catch (e) {
      // The SDK's message is the useful one; only its first line belongs in a list.
      out.push({ code: "unaligned-subset", detail: (e as Error).message.split("\n")[0] ?? "unaligned" });
    }
  }

  return out;
}

/** The child terms, once `checkHire` has returned nothing. */
export function hireTerms(parent: GrantState, job: JobSpec, now: bigint): HireTerms {
  return {
    agentKey: job.agentKey,
    budgetTotal: job.budgetSompi,
    maxPerSpend: job.maxPerSpendSompi,
    epochLimit: job.epochLimitSompi ?? parent.epochLimit,
    // One less than the parent, which is the deepest a child may be.
    delegationDepth: parent.delegationDepth - 1n,
    expiresAt: job.windowDaa === undefined ? undefined : now + job.windowDaa,
    recipients: [job.payee.toLowerCase()],
  };
}

// ---- the stack -------------------------------------------------------------

/**
 * Outstanding children, newest last. Settlement pops from the end.
 *
 * The orchestrator has to keep this because the chain will not tell it: the
 * reserve is a hash chain, so the parent's state proves how MUCH is reserved
 * and not by whom or in what order. Losing this list does not lose the money —
 * each child still expires to the principal — but it does lose the ability to
 * settle, which is the difference between a loan and a gift.
 */
export interface Outstanding {
  name: string;
  agentKey: string;
  manifest: string;
  reservedSompi: string;
  hiredAt: string;
}

export interface SettleCheck {
  ok: boolean;
  detail: string;
}

/** May this child be settled right now? */
export function checkSettle(stack: Outstanding[], agentKey: string): SettleCheck {
  if (stack.length === 0) {
    return { ok: false, detail: "nothing is outstanding; this grant has no children to settle" };
  }
  const top = stack[stack.length - 1]!;
  if (top.agentKey.toLowerCase() === agentKey.toLowerCase()) {
    return { ok: true, detail: `${top.name} is the most recent child` };
  }
  const at = stack.findIndex((c) => c.agentKey.toLowerCase() === agentKey.toLowerCase());
  if (at < 0) {
    return {
      ok: false,
      detail:
        `no outstanding child has that agent key. It may already have been settled, ` +
        `or expired into the principal's hands.`,
    };
  }
  const after = stack.slice(at + 1).map((c) => c.name);
  return {
    ok: false,
    detail:
      `settlement is LIFO and ${stack[at]!.name} is not the most recent child. ` +
      `The reserve is a hash chain — popping requires naming the value it had before the push, ` +
      `and a hash cannot be inverted. Settle ${after.join(", then ")} first, ` +
      `or let this one expire.`,
  };
}
