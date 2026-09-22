import { kasOf } from "./format";

/* One view of an agent, whichever way we learned about it: a reading this
   site publishes (/agent-NNN.json) or a hosted agent on the runner. Every
   figure here comes from the reading; nothing is estimated in the browser. */

export type Source = "published" | "hosted";
export type Status = "active" | "scheduled" | "waiting" | "paused" | "expired" | "ended" | "unknown";

export interface Payee { address: string; label: string | null }

export type Outcome = "paid" | "blocked" | "failed" | "paid-not-served";

export interface Payment {
  at: string;
  outcome: Outcome;
  amount: number | null;
  url: string | null;
  host: string | null;
  txid: string | null;
  payTo: string | null;
  /** The covenant rule that stopped it, in a word: timelock, allowlist, cap… */
  rule: string | null;
  /** The reading's own sentence for why. */
  why: string | null;
}

export interface DerivedLimit { rule: string; attempted: string; why: string }

export interface AgentView {
  key: string;            // stable key: "p:001" or "h:viking"
  id: string;             // "001" or "viking"
  label: string;          // "#001" or "viking"
  source: Source;
  network: string;
  mission: string | null;
  status: Status;
  statusNote: string | null;

  budget: number | null;
  spent: number | null;
  remaining: number | null;
  onChain: number | null;
  maxPerPayment: number | null;
  periodLimit: number | null;
  periodSeconds: number | null;  // epochLengthDaa / 10
  payees: Payee[];
  delegationDepth: number | null;
  parent: string | null;

  expiresIn: string | null;
  expired: boolean;
  opensIn: string | null;

  grantAddress: string | null;
  covenantId: string | null;
  agentKey: string | null;
  ownerKey: string | null;
  principalKey: string | null;

  payments: Payment[];
  derived: DerivedLimit[];
  checkedAt: string | null;
  lastActive: string | null;

  hosted?: { state: string; jobs: number; jobsOn: number; lastRunStatus: string | null };
}

const RULE_WORDS: Record<string, string> = {
  timelock: "Not open yet",
  "not_before": "Not open yet",
  expired: "Grant ended",
  allowlist: "Payee not allowed",
  recipients: "Payee not allowed",
  cap: "Over per-payment cap",
  "max_per_spend": "Over per-payment cap",
  epoch: "Over period limit",
  budget: "Over budget",
};

export function ruleWords(r: string | null | undefined): string {
  if (!r) return "Refused";
  const k = r.toLowerCase();
  for (const [needle, words] of Object.entries(RULE_WORDS)) if (k.includes(needle)) return words;
  if (k.includes("payee")) return "Payee not allowed";
  if (k.includes("per-payment")) return "Over per-payment cap";
  if (k.includes("period") || k.includes("rate")) return "Over period limit";
  if (k.includes("start")) return "Not open yet";
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function host(u: string | null | undefined): string | null {
  if (!u) return null;
  try { return new URL(u).host; } catch { return null; }
}

type Json = Record<string, any>;

function payment(p: Json): Payment {
  const o = String(p.outcome ?? "");
  const outcome: Outcome =
    o === "bought" || o === "served" ? "paid"
    : o === "refused" ? "blocked"
    : o === "paid-but-refused" || o === "paid-then-failed" ? "paid-not-served"
    : "failed";
  return {
    at: p.at,
    outcome,
    amount: kasOf(p.paid),
    url: p.url ?? null,
    host: host(p.url),
    txid: p.txid ?? null,
    payTo: p.payTo ?? null,
    rule: p.reason ?? null,
    why: p.refusal ?? p.sellerClaimed ?? null,
  };
}

function status(r: Json): { status: Status; note: string | null } {
  if (r.retired) {
    const how = r.retired.how as string | undefined;
    return { status: "ended", note: how === "settled" ? "Returned to its parent" : how === "revoked" ? "Revoked by its owner" : "Ended" };
  }
  const t = r.timelock ?? {};
  if (t.expired) return { status: "expired", note: t.expiredAgo ? `Ended ${t.expiredAgo} ago` : "Term is over" };
  if (t.open === false) return { status: "scheduled", note: t.lockedFor ? `Opens in ${t.lockedFor}` : "Not open yet" };
  return { status: "active", note: null };
}

/** A reading, published or hosted, into the one view the console draws. */
export function fromReading(r: Json, source: Source, id: string, labels: Map<string, string>): AgentView {
  const a = r.authority ?? {};
  const t = r.timelock ?? {};
  const s = status(r);
  const payments = ((r.purchases ?? []) as Json[]).map(payment).sort((x, y) => (y.at > x.at ? 1 : -1));
  const lastPay = payments[0]?.at ?? null;
  const epochDaa = typeof a.epochLengthDaa === "number" ? a.epochLengthDaa : Number(a.epochLengthDaa) || null;
  return {
    key: `${source === "hosted" ? "h" : "p"}:${id}`,
    id,
    label: source === "hosted" ? id : `#${id}`,
    source,
    network: r.network ?? "testnet-10",
    mission: r.mission ?? null,
    status: s.status,
    statusNote: s.note,
    budget: kasOf(a.budget),
    spent: kasOf(a.spent),
    remaining: kasOf(a.remaining),
    onChain: kasOf(a.onChain),
    maxPerPayment: kasOf(a.maxPerPayment),
    periodLimit: kasOf(a.epochLimit),
    periodSeconds: epochDaa ? epochDaa / 10 : null,
    payees: ((a.payees ?? []) as string[]).map((address) => ({ address, label: labels.get(address) ?? null })),
    delegationDepth: a.delegationDepth ?? null,
    parent: r.delegatedBy?.parent ? String(r.delegatedBy.parent).replace(/^WARDA-/, "#") : null,
    expiresIn: t.expiresIn ?? null,
    expired: !!t.expired,
    opensIn: t.open === false ? t.lockedFor ?? null : null,
    grantAddress: r.identity?.grantAddress ?? r.retired?.grantAddress ?? null,
    covenantId: r.identity?.covenantId ?? null,
    agentKey: r.identity?.agent ?? null,
    ownerKey: r.identity?.revocation ?? r.identity?.principal ?? null,
    principalKey: r.identity?.principal ?? null,
    payments,
    derived: ((r.refusals ?? []) as Json[]).map((x) => ({ rule: x.rule, attempted: x.attempted, why: x.refusal })),
    checkedAt: r.checkedAt ?? null,
    lastActive: [lastPay, r.lastRun?.at].filter(Boolean).sort().pop() ?? null,
  };
}

/** A hosted agent whose reading could not be fetched: the list row alone. */
export function fromHostedRow(row: Json): AgentView {
  const st = String(row.state ?? "unknown");
  const status: Status =
    st === "active" || st === "paying" ? "active"
    : st === "expired" ? "expired"
    : st === "settled" || st === "revoked" || st === "refunded" ? "ended"
    : st.includes("await") || st.includes("pending") || st === "planned" ? "waiting"
    : "unknown";
  const budget = kasOf(row.budgetKas);
  const spent = kasOf(row.spentKas);
  return {
    key: `h:${row.agent}`, id: row.agent, label: row.agent, source: "hosted", network: "testnet-10",
    mission: null, status, statusNote: status === "waiting" ? "Waiting for funding" : null,
    budget, spent, remaining: kasOf(row.spendableKas), onChain: null,
    maxPerPayment: null, periodLimit: null, periodSeconds: null, payees: [], delegationDepth: null,
    parent: row.parent ?? null,
    expiresIn: null, expired: status === "expired", opensIn: null,
    grantAddress: null, covenantId: null, agentKey: null, ownerKey: null, principalKey: null,
    payments: [], derived: [], checkedAt: null, lastActive: row.lastRun?.at ? new Date(row.lastRun.at).toISOString() : null,
    hosted: hostedMeta(row),
  };
}

export function hostedMeta(row: Json): AgentView["hosted"] {
  return { state: String(row.state ?? "unknown"), jobs: row.jobs ?? 0, jobsOn: row.jobsOn ?? 0, lastRunStatus: row.lastRun?.status ?? null };
}

export interface Totals { agents: number; active: number; budget: number; remaining: number; spent: number; payments: number; blocked: number }

export function totals(list: AgentView[]): Totals {
  const live = list.filter((a) => a.status !== "ended");
  const sum = (f: (a: AgentView) => number | null, l = live) => l.reduce((s, a) => s + (f(a) ?? 0), 0);
  return {
    agents: list.length,
    active: list.filter((a) => a.status === "active").length,
    budget: sum((a) => a.budget),
    remaining: sum((a) => a.remaining),
    spent: sum((a) => a.spent, list),
    payments: list.reduce((s, a) => s + a.payments.filter((p) => p.outcome === "paid" || p.outcome === "paid-not-served").length, 0),
    blocked: list.reduce((s, a) => s + a.payments.filter((p) => p.outcome === "blocked").length, 0),
  };
}
