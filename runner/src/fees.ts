/**
 * The runner's fee: flat, per run, out of the agent's own grant.
 *
 * Accrued, not paid per run. Every covenant spend carries its own network fee,
 * and paying a small runner fee as its own spend would cost more in network
 * fees than the fee itself. So runs accrue, and the total settles in one
 * payment when it reaches `settleAtSompi` — or sooner, when the grant is close
 * to its end and would otherwise leave the debt unpayable.
 *
 * Owed fees count as committed: a workflow cannot spend them. That is what
 * makes deferring settlement safe for the runner without making it a credit
 * line the agent can overdraw.
 */
export interface FeePolicy {
  /** The runner's payee address. New grants put it on their allowlist. */
  payee: string;
  /**
   * Earlier payee addresses. An allowlist is fixed when a grant is created, so
   * a grant made before the payee changed can only ever pay the one it named;
   * fees from it still go there. Never add an address here that the runner's
   * operator does not hold the key to.
   */
  previous?: string[];
  perRunSompi: bigint;
  settleAtSompi: bigint;
  /** Settle whatever is owed when fewer hours than this remain. */
  settleBeforeExpiryHours: number;
}

export interface FeeLedger {
  owed: bigint;
  runs: number;
  settled: bigint;
  lastSettlementTxid: string | null;
}

/**
 * Which of the runner's payee addresses this grant can pay: the current one if
 * its allowlist names it, else the newest earlier one it names, else null.
 */
export function feePayeeFor(p: FeePolicy, onAllowlist: (address: string) => boolean): string | null {
  for (const a of [p.payee, ...(p.previous ?? [])]) if (onAllowlist(a)) return a;
  return null;
}

export const emptyLedger = (): FeeLedger => ({ owed: 0n, runs: 0, settled: 0n, lastSettlementTxid: null });

export function accrue(l: FeeLedger, p: FeePolicy): FeeLedger {
  return { ...l, owed: l.owed + p.perRunSompi, runs: l.runs + 1 };
}

export function settlementDue(l: FeeLedger, p: FeePolicy, hoursLeft: number | null): boolean {
  if (l.owed <= 0n) return false;
  if (l.owed >= p.settleAtSompi) return true;
  return hoursLeft !== null && hoursLeft <= p.settleBeforeExpiryHours;
}

export function settled(l: FeeLedger, amount: bigint, txid: string): FeeLedger {
  return { ...l, owed: l.owed - amount, settled: l.settled + amount, lastSettlementTxid: txid };
}
