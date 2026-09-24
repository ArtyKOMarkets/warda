/**
 * Where an epoch boundary sits.
 *
 * This was inline in `tools/listen.ts`, which is why it was wrong for three
 * weeks. The rule there was "if twelve hours have passed, start a new epoch
 * NOW" -- which reads as obviously correct and quietly is not, because the
 * anchor then lands on a pass time. The passes are twelve hours apart. So the
 * next pass arrives at the boundary to the second, and whether it rolls is
 * decided by the jitter between two cron firings. Simulated over eight days
 * of 08:13/20:13 passes it lost one in four, and a pass that does not roll
 * buys nothing and reports nothing -- which from a phone is exactly what a
 * quiet day looks like. That is the whole bug: not a crash, a coin flip whose
 * losing side is indistinguishable from success.
 *
 * Rescheduling does not fix it. An 11-hour gap never reaches the boundary at
 * all, so 08:13/21:13 against the old rule is worse: seven dead passes in
 * sixteen rather than four.
 *
 * The fix is to put the boundary on a fixed grid from the first epoch's
 * start, so it never moves to meet the observer. It lives here, exported and
 * pure, because a rule this easy to get wrong has to be a thing a test can
 * hold.
 *
 * None of this is the limit. The covenant counts DAA, not seconds, and will
 * refuse a spend the software thought was fine; that refusal costs no coin
 * and is recorded. This only decides when it is worth ASKING.
 */

/** Five minutes: comfortably more than cron jitter, far less than the drift
 *  between wall-clock hours and a DAA count, so it can never be the thing
 *  that lets a real over-spend through. */
export const ROLL_SLACK_MS = 5 * 60_000;

/**
 * The epoch anchor in force at `now`, given the one currently recorded.
 *
 * Returns `startedAt` unchanged when the epoch has not ended -- the caller
 * uses that identity to decide whether to reset the spend counter, so the
 * string is passed through rather than re-serialised.
 *
 * `periods` rather than a single step: a laptop that slept through two days
 * comes back to the same grid instead of re-anchoring to whenever it woke.
 */
export function epochStart(
  startedAt: string,
  now: number,
  epochHours: number,
  slack: number = ROLL_SLACK_MS,
): string {
  const len = epochHours * 3_600_000;
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return new Date(now).toISOString();
  const elapsed = now - start;
  if (elapsed < len - slack) return startedAt;
  const periods = Math.max(1, Math.floor(elapsed / len));
  return new Date(start + periods * len).toISOString();
}
