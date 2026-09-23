/**
 * How many searches this pass may buy, and which queries get them.
 *
 * ## The arithmetic that forced this to exist
 *
 * Twice daily is 14 runs a week. Eight queries a run at 0.05 KAS a search is
 * 5.6 KAS a week, against a grant of about 2. Cadence and budget were chosen
 * separately and they do not fit, which is not a mistake — it is the normal
 * case, because how often you want to look and how much you want to spend are
 * answers to different questions.
 *
 * Something has to give, and the choice is between coverage per run and
 * coverage per day. Rotating keeps the cadence: every run buys what it can
 * afford, and the queries take turns, so each topic is checked roughly daily
 * while the fast-moving ones are checked on every pass.
 *
 * ## The covenant is the backstop, not the mechanism
 *
 * The grant's epoch limit bounds this on chain, and it must — but a loop
 * designed to run until the chain refuses it is a loop whose coverage is
 * whatever the refusal happens to cut off. So the budget is kept in software,
 * where it can be spent deliberately, and the limit on chain exists for the
 * case where this file is wrong. That is what a safety limit is for, and it
 * is also the only arrangement in which the limit firing is INFORMATION
 * rather than routine.
 */
import type { Query } from "./listen.ts";

export interface Plan {
  /** The queries to run this pass, in order. */
  queries: Query[];
  /** Where the next pass should start, to be stored and handed back. */
  nextCursor: number;
  /** How many searches this pass intends to buy. */
  searches: number;
  /** Why it is that many — printed in the run log. */
  why: string;
}

export interface PlanInput {
  /** Every query, in a stable order. The cursor indexes into this. */
  queries: Query[];
  /** Where the last pass stopped. */
  cursor: number;
  /** What one search costs, in sompi. */
  priceSompi: number;
  /** What this grant may still spend THIS epoch, in sompi. */
  epochRemainingSompi: number;
  /** What this grant may still spend at all, in sompi. */
  budgetRemainingSompi?: number;
  /**
   * Queries that run on every pass regardless of the rotation. The topics
   * that move fastest are worth checking every twelve hours even when the
   * rest are on a daily turn.
   */
  always?: string[];
}

export function plan(input: PlanInput): Plan {
  const { queries, priceSompi } = input;
  if (queries.length === 0) return { queries: [], nextCursor: 0, searches: 0, why: "no queries" };
  if (priceSompi <= 0) return { queries: [], nextCursor: input.cursor, searches: 0, why: "price is not positive" };

  const room = Math.min(
    input.epochRemainingSompi,
    input.budgetRemainingSompi ?? Number.POSITIVE_INFINITY,
  );
  const affordable = Math.floor(room / priceSompi);
  if (affordable <= 0) {
    return {
      queries: [], nextCursor: input.cursor, searches: 0,
      why: `nothing affordable: ${room} sompi left, a search costs ${priceSompi}`,
    };
  }

  const always = new Set(input.always ?? []);
  const pinned = queries.filter((q) => always.has(q.label));
  const rest = queries.filter((q) => !always.has(q.label));

  /* The pinned ones first, and if there is not even room for those, take as
     many as there is room for — in their listed order, so which one gets
     dropped is a decision made when the list was written rather than by
     whatever the cursor happened to be. */
  const out: Query[] = pinned.slice(0, affordable);
  let cursor = input.cursor;

  if (rest.length > 0) {
    /* Modulo on the way in, so a cursor stored by an older version, or a
       shortened query list, cannot index off the end. */
    cursor = ((cursor % rest.length) + rest.length) % rest.length;
    while (out.length < affordable && out.length - pinned.length < rest.length) {
      out.push(rest[cursor]!);
      cursor = (cursor + 1) % rest.length;
    }
  }

  const why = affordable >= queries.length
    ? `every query: ${affordable} searches affordable, ${queries.length} queries`
    : `${out.length} of ${queries.length} queries: ${room} sompi left this epoch buys ${affordable} at ${priceSompi} each` +
      (pinned.length ? `, ${pinned.map((q) => q.label).join(" and ")} on every pass` : "");

  return { queries: out, nextCursor: cursor, searches: out.length, why };
}
