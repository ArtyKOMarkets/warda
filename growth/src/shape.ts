/**
 * The Listener's numbers, once.
 *
 * They were spread across two tools' flag defaults, a table in the runbook
 * and — once it exists — a grant on chain. Four copies of an arithmetic that
 * has to agree with itself, and the failure when it stops agreeing is not a
 * crash: the buyer asks for more results than the seller serves, or the
 * software budget outruns the epoch limit, and what you see is a covenant
 * refusal at eight in the morning with nothing saying why.
 *
 * So: one definition, the derivations computed rather than restated, and a
 * guard (`ops/check-listener.mjs`) that fails if the runbook's table or a
 * grant disagrees with this file.
 *
 * ## Where the numbers come from
 *
 * X bills $0.005 per post read, pay-per-use. A search reads up to 10 posts,
 * so it costs $0.05, and the KAS price covers that. Twice daily is 14 passes
 * a week; three searches a pass is 42 searches, $2.10 of real money.
 *
 * The epoch is 12 hours because that is the cadence. Shorter makes the limit
 * unreachable; longer lets one broken pass spend the next pass's allowance
 * too. Matched, the allowance refills exactly when the next pass needs it.
 */

/** Kaspa's DAA score advances about this fast. */
export const DAA_PER_SECOND = 10;

/** What X charges per post read, in USD. */
export const USD_PER_READ = 0.005;

export const LISTENER = {
  /** One search. */
  priceSompi: 5_000_000,
  /** Posts a search reads. The buyer asks for this; the seller caps at it. */
  maxResults: 10,
  /** How often a pass runs, and the epoch length that matches it. */
  epochHours: 12,
  /** Three searches an epoch. */
  epochLimitSompi: 15_000_000,
  /** How long the grant lives. */
  termDays: 7,
  /** Fourteen epochs at the epoch limit. */
  budgetSompi: 210_000_000,
} as const;

/** Everything else is computed from those, so it cannot disagree with them. */
export const derived = {
  searchesPerEpoch: LISTENER.epochLimitSompi / LISTENER.priceSompi,
  epochsPerTerm: (LISTENER.termDays * 24) / LISTENER.epochHours,
  epochLengthDaa: LISTENER.epochHours * 3600 * DAA_PER_SECOND,
  termDaa: LISTENER.termDays * 86_400 * DAA_PER_SECOND,
  get searchesPerTerm() { return this.searchesPerEpoch * this.epochsPerTerm; },
  get readsPerTerm() { return this.searchesPerTerm * LISTENER.maxResults; },
  get usdPerTerm() { return Number((this.readsPerTerm * USD_PER_READ).toFixed(2)); },
  get budgetFromEpochs() { return this.epochsPerTerm * LISTENER.epochLimitSompi; },
} as const;

export const kas = (sompi: number) => sompi / 1e8;
