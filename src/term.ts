/**
 * A grant's term, as a reading reports it.
 *
 * ## Why this is here and not in a dashboard
 *
 * There are two dashboard tools in this repository — `agent/tools/dashboard.ts`
 * writes agent #001's reading and `agents/tools/dashboard.ts` writes everybody
 * else's — and they are copies that have diverged by three hundred lines. When
 * `expiresAt` was added to the second one, five agents got a term on their page
 * and the sixth did not, silently, because nothing compares the two.
 *
 * That is the ninth time extracted-then-copied has cost something here, and the
 * answer has been the same every time: generate it, or have exactly one. This
 * is the "exactly one" for the term. It is not a formatter both call — it is
 * the whole block both emit, so the two readings cannot disagree about its
 * shape, its field names, or what `null` means in it.
 *
 * ## Null is not a number
 *
 * `expiresIn` is null once the term is over rather than a negative duration,
 * and `expiredAgo` is null while it is still running. A consumer that reads one
 * field and formats it cannot accidentally render "expires in -6 days", and a
 * consumer that reads `expired` gets a boolean rather than the sign of a
 * subtraction.
 */

/** Human-readable wall-clock from a DAA delta. Kaspa is ten blocks a second. */
export function daaDuration(daa: bigint): string {
  const s = Number(daa) / 10;
  if (s < 90) return `${Math.round(s)} second${Math.round(s) === 1 ? "" : "s"}`;
  const mins = Math.round(s / 60);
  if (mins < 90) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(s / 3600);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(s / 86400);
  return `${days} day${days === 1 ? "" : "s"}`;
}

export interface TermReading {
  notBefore: string;
  virtualDaaScore: string;
  /** Whether the start time has passed. */
  open: boolean;
  lockedFor: string;
  /** Null while still closed — there is no "ago" for something that has not happened. */
  openedAgo: string | null;
  expiresAt: string;
  expired: boolean;
  /** Null once expired. */
  expiresInDaa: string | null;
  expiresIn: string | null;
  /** Null until expired. */
  expiredAgo: string | null;
  enforcedBy: string;
  termEnforcedBy: string;
}

export interface TermInput {
  notBefore: bigint;
  expiresAt: bigint;
  /** The node's virtual DAA score at the moment of reading. */
  now: bigint;
  /** When the grant was created, if the manifest records it. Defaults to notBefore. */
  createdAtDaa?: bigint;
}

export function termReading(input: TermInput): TermReading {
  const { notBefore, expiresAt, now } = input;
  const open = now >= notBefore;
  const expired = now >= expiresAt;
  return {
    notBefore: notBefore.toString(),
    virtualDaaScore: now.toString(),
    open,
    lockedFor: daaDuration(notBefore - (input.createdAtDaa ?? notBefore)),
    openedAgo: open ? daaDuration(now - notBefore) : null,
    expiresAt: expiresAt.toString(),
    expired,
    expiresInDaa: expired ? null : (expiresAt - now).toString(),
    expiresIn: expired ? null : daaDuration(expiresAt - now),
    expiredAgo: expired ? daaDuration(now - expiresAt) : null,
    enforcedBy:
      "the covenant, on every spend: claimedDaa >= notBefore. Not a scheduler, not this " +
      "process, and not revocable by whoever issued the grant.",
    termEnforcedBy:
      "the covenant, on every spend: claimedDaa < expiresAt. After it, the grant refuses " +
      "everything whatever its budget says, and the balance is the principal's to reclaim.",
  };
}
