import type { Grant, GrantState } from "./types.ts";

/**
 * Fixed epochs, not a sliding window.
 *
 * Consequence, which belongs in the docs rather than in a bug report: an
 * agent can spend its full epoch limit at the end of one epoch and again at
 * the start of the next, so the true worst case over a short window is 2x
 * the epoch limit. This is accepted for v0.1.
 */
export function epochIndexAt(grant: Grant, daaScore: bigint): bigint {
  if (daaScore < grant.notBefore) {
    throw new RangeError("daaScore precedes grant.notBefore");
  }
  return (daaScore - grant.notBefore) / grant.epochLength;
}

/** Spend already recorded in the epoch containing `daaScore`. Zero if the
 *  state's recorded epoch is stale — a new epoch starts from nothing. */
export function epochSpentAt(grant: Grant, state: GrantState, daaScore: bigint): bigint {
  const current = epochIndexAt(grant, daaScore);
  return current === state.epochIndex ? state.epochSpent : 0n;
}
