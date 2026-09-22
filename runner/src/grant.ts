/**
 * What the runner knows about a grant at one moment, and the checks a
 * payment must pass before anything is signed.
 *
 * The checks are a PREFLIGHT, not the guarantee. The covenant refuses every
 * one of these on chain whatever this file says. They exist so a refusal is a
 * sentence in the run log rather than a broadcast, a spent fee, and a
 * script-verification failure nobody can read.
 */
import { formatKas } from "@warda_protocol/core";
import { decodeAddress, toHex } from "@warda_protocol/kaspa";

/** A payee as an allowlist stores it: 32-byte x-only hex, from an address or hex. */
export function memberKey(m: string): string {
  const t = m.replace(/#.*$/, "").trim();
  return t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase();
}

function onAllowlist(payees: string[], payee: string): boolean {
  try {
    const k = memberKey(payee);
    return payees.some((p) => { try { return memberKey(p) === k; } catch { return false; } });
  } catch {
    return false;
  }
}

export interface GrantView {
  /** Where the grant's coin is right now. It moves after every spend. */
  address: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  budgetTotal: bigint;
  spentTotal: bigint;
  reserved: bigint;
  maxPerSpend: bigint;
  /** Left in the current epoch, or null if the grant has no epoch limit. */
  epochRemaining: bigint | null;
  /** What the coin holds. Budget and coin diverge by fees over a grant's life. */
  coin: bigint;
  /** Allowlisted payees, as Kaspa addresses or x-only hex; compared by key. */
  payees: string[];
  /** Wall-clock estimate of the covenant's expiry, or null if unknown. */
  expiresAtMs: number | null;
}

/**
 * Reads a grant. `null` means UNDECIDED: the node is down, behind, or the
 * address the runner has on file holds nothing. It is never "empty".
 */
export interface GrantReader {
  read(agentId: string): Promise<GrantView | null>;
}

/** Uncommitted budget, less fees the runner is owed and has not settled. */
export function spendable(g: GrantView, feesOwed: bigint): bigint {
  const uncommitted = g.budgetTotal - g.spentTotal - g.reserved - feesOwed;
  return uncommitted > 0n ? uncommitted : 0n;
}

export function spentPercent(g: GrantView): number {
  if (g.budgetTotal === 0n) return 100;
  return Number(((g.spentTotal + g.reserved) * 10_000n) / g.budgetTotal) / 100;
}

export function hoursToExpiry(g: GrantView, now: number): number | null {
  return g.expiresAtMs === null ? null : (g.expiresAtMs - now) / 3_600_000;
}

/** Why a payment of `sompi` cannot be made now, or null. */
export function refusal(
  g: GrantView,
  sompi: bigint,
  opts: { now: number; feesOwed: bigint; payee?: string; networkFee: bigint },
): string | null {
  if (g.status !== "ACTIVE") return `the grant is ${g.status.toLowerCase()}; nothing can be spent from it`;
  if (g.expiresAtMs !== null && g.expiresAtMs <= opts.now) return "the grant's term has ended";
  if (opts.payee !== undefined && !onAllowlist(g.payees, opts.payee)) {
    return `${opts.payee} is not on this grant's allowlist, and an allowlist is fixed when the grant is created`;
  }
  if (sompi > g.maxPerSpend) {
    return `${formatKas(sompi)} KAS is over the grant's per-payment cap of ${formatKas(g.maxPerSpend)} KAS`;
  }
  if (g.epochRemaining !== null && sompi > g.epochRemaining) {
    return `${formatKas(sompi)} KAS is over what is left in this epoch (${formatKas(g.epochRemaining)} KAS)`;
  }
  const left = spendable(g, opts.feesOwed);
  if (sompi > left) {
    const owed = opts.feesOwed > 0n ? `, after ${formatKas(opts.feesOwed)} KAS of runner fees owed` : "";
    return `${formatKas(sompi)} KAS is more than the ${formatKas(left)} KAS the grant has uncommitted${owed}`;
  }
  if (sompi + opts.networkFee > g.coin) {
    return `the grant's coin holds ${formatKas(g.coin)} KAS, which will not cover ${formatKas(sompi)} plus the network fee`;
  }
  return null;
}
