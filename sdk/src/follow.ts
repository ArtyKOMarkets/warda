/**
 * Where did a grant go?
 *
 * A grant's address is the hash of its state, so every spend moves it. A tool
 * holding a manifest that is even one payment stale is pointing at an empty
 * address, and Kaspa's node RPC answers "what is unspent here", never "what
 * spent this". So finding the grant means guessing states and asking.
 *
 * ## Why the obvious algorithm cannot work
 *
 * The first version of this walked forward one payment at a time and accepted
 * a step only when the resulting address held a UTXO. That check is exactly
 * right for the step it verifies and it makes the whole walk impossible:
 * intermediate states DO NOT hold UTXOs. If a grant paid twice, the first
 * successor was spent to make the second, and its address is as empty as the
 * one we started from. So a grant that moved twice between polls could never
 * be followed at all — not "followed partway", not at all, because the very
 * first step fails.
 *
 * That is fine for a grant only its owner spends and polls after. It is
 * useless for a PUBLIC grant, where two strangers inside one polling window is
 * the intended behaviour rather than an edge case.
 *
 * ## What makes the real algorithm cheap
 *
 * `successorState` changes exactly three fields: `spentTotal`, `epochIndex`
 * and `epochSpent`. Nothing else in a grant's state moves when it spends. So
 * where a grant LANDS after any number of payments depends on only three
 * numbers, and not at all on the order they happened in or on which epochs the
 * intermediate steps claimed:
 *
 *   - how much was spent in total,
 *   - which epoch was claimed last,
 *   - how much of the spending fell in that last epoch.
 *
 * That collapses a combinatorial walk into an enumeration of ENDPOINTS, and an
 * endpoint is the one thing that is actually observable — it is where the coin
 * is now. So this enumerates candidate endpoints, and the caller derives each
 * address and asks the node.
 *
 * ## What bounds the enumeration
 *
 * Every coin the grant released is at the vendor, one UTXO per payment, each
 * carrying the DAA score of the block that accepted it. From that:
 *
 *   - the payments belonging to this grant are a SUFFIX of that list in DAA
 *     order. Anything mined before the grant opened belongs to an earlier
 *     grant — vendor addresses outlive the grants that pay them — and anything
 *     already counted in the manifest's `spentTotal` is a prefix.
 *   - the last epoch claimed is at least the manifest's (the covenant ratchets
 *     and refuses to move backwards) and at most the epoch of the block that
 *     mined the earliest payment assigned to it, because a spend cannot claim
 *     a DAA score the network had not reached.
 *   - a candidate exceeding the per-epoch allowance or the lifetime budget is
 *     one the covenant would have refused, so it is not a candidate.
 *
 * Each candidate is built by folding `successorState` rather than by setting
 * the three fields directly. The transition rule then has exactly one
 * implementation, and a candidate this produces is a state the covenant agrees
 * is reachable.
 */
import { successorState } from "./spend.ts";
import type { GrantState } from "./template.ts";

/** One coin at the vendor: an amount, and when the network accepted it. */
export interface Payment {
  value: bigint;
  blockDaaScore: bigint;
  /** Anything that identifies it to the caller. Carried through untouched. */
  id?: string;
}

export interface Candidate {
  state: GrantState;
  /** The payments folded in, in order. */
  applied: Payment[];
  /** The epoch the last of them claimed. */
  finalEpoch: bigint;
}

export interface EnumerateOptions {
  /**
   * Stop after this many distinct candidates. A safety rail, not a tuning
   * knob: the enumeration is bounded by the payment count and the epoch span,
   * and a run that hits this has found a grant whose vendor has thousands of
   * coins — at which point asking the node about each is the wrong approach
   * and the caller should be told rather than left waiting.
   */
  limit?: number;
}

const DEFAULT_LIMIT = 2_000;

/**
 * How far a spend's claimed DAA may sit behind the block that mined it.
 *
 * A payer backs off from the tip so the lock time stays final, and the network
 * then takes some time to accept the transaction. So a payment mined in epoch
 * 7 may well have claimed epoch 6. Two epochs of slack covers the default
 * backoff at any sane epoch length; it only affects the ORDER candidates are
 * offered in, never which ones exist.
 */
const CLAIM_SLACK_EPOCHS = 2n;

/** The key that decides an address: everything else in the state is fixed. */
function key(s: GrantState): string {
  return `${s.spentTotal}:${s.epochIndex}:${s.epochSpent}`;
}

/**
 * Payments that could not be this grant's, and why.
 *
 * Split out rather than filtered silently because "the vendor holds twelve
 * coins and nine of them predate this grant" is the single most useful thing
 * to print when a follow fails.
 */
export function partitionPayments(
  state: GrantState,
  payments: Payment[],
): { usable: Payment[]; tooEarly: Payment[] } {
  const ordered = [...payments].sort((a, b) =>
    a.blockDaaScore === b.blockDaaScore ? 0 : a.blockDaaScore < b.blockDaaScore ? -1 : 1,
  );
  return {
    usable: ordered.filter((p) => p.blockDaaScore >= state.notBefore),
    tooEarly: ordered.filter((p) => p.blockDaaScore < state.notBefore),
  };
}

/**
 * Every state this grant could be in, given what is at the vendor.
 *
 * Ordered fewest-payments-first, because a manifest is usually stale by one or
 * two spends and the caller stops at the first candidate the chain confirms.
 * Correctness does not depend on the order — every candidate is tested — but
 * the number of round trips does.
 */
export function candidateStates(
  state: GrantState,
  payments: Payment[],
  options: EnumerateOptions = {},
): Candidate[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const { usable } = partitionPayments(state, payments);
  const n = usable.length;

  const out: Candidate[] = [];
  const seen = new Set<string>();

  const epochOf = (daa: bigint) => (daa - state.notBefore) / state.epochLength;
  const daaOf = (epoch: bigint) => state.notBefore + epoch * state.epochLength;

  /** Fold a set of payments in, with a chosen final epoch. */
  const build = (applied: Payment[], finalFrom: number, finalEpoch: bigint): Candidate | null => {
    let s = state;
    try {
      for (let i = 0; i < applied.length; i++) {
        // Everything before the final group is folded in at the manifest's own
        // epoch. Which epoch those actually claimed cannot be recovered and
        // does not matter: only the final epoch's total survives into the
        // address, and this assignment produces exactly that total.
        const epoch = i < finalFrom ? state.epochIndex : finalEpoch;
        s = successorState(s, applied[i]!.value, daaOf(epoch));
      }
    } catch {
      return null; // a transition the covenant refuses; not a candidate
    }
    if (s.spentTotal > state.budgetTotal) return null;
    if (s.epochSpent > state.epochLimit) return null;
    return { state: s, applied, finalEpoch };
  };

  const offer = (c: Candidate | null): void => {
    if (!c || out.length >= limit) return;
    const k2 = key(c.state);
    if (seen.has(k2)) return;
    seen.add(k2);
    out.push(c);
  };

  /**
   * The likely answers first.
   *
   * Every candidate below is eventually enumerated anyway, but a vendor with
   * twenty coins produces thousands of them and each one costs a round trip.
   * What actually happened is almost always the plain reading: these payments
   * were made in the epochs their own DAA scores imply. So that reading is
   * offered first, for each suffix, with a little slack for a payer that
   * backed off from the tip — and in practice the search ends on one of these
   * rather than grinding through the rest.
   */
  for (let k = n - 1; k >= 0; k--) {
    const applied = usable.slice(k);
    const last = applied[applied.length - 1]!;
    for (let slack = 0n; slack <= CLAIM_SLACK_EPOCHS; slack++) {
      const e = epochOf(last.blockDaaScore) - slack;
      if (e < state.epochIndex) continue;
      // The final group is whichever trailing payments the natural reading
      // puts in that epoch.
      let f = applied.length - 1;
      while (f > 0 && epochOf(applied[f - 1]!.blockDaaScore) - slack >= e) f--;
      offer(build(applied, f, e));
    }
  }

  // Then everything else. Fewest applied payments first: k is where the
  // applied suffix starts.
  for (let k = n - 1; k >= 0 && out.length < limit; k--) {
    const applied = usable.slice(k);
    const lastEpoch = epochOf(applied[applied.length - 1]!.blockDaaScore);

    for (let e = state.epochIndex; e <= lastEpoch && out.length < limit; e++) {
      // Which payments fall in the final epoch. They are a suffix of `applied`,
      // because payments are in DAA order and epochs only move forward.
      for (let f = 0; f < applied.length && out.length < limit; f++) {
        // A payment cannot claim an epoch whose DAA the network had not
        // reached when the payment was mined; the earliest in the group binds.
        if (e > epochOf(applied[f]!.blockDaaScore)) continue;
        // The manifest's own epoch cannot be "re-entered" partway: if nothing
        // rolled over, every applied payment is in it.
        if (e === state.epochIndex && f !== 0) continue;

        offer(build(applied, f, e));
      }
    }
  }

  return out;
}
