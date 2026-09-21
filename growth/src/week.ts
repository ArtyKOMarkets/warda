/**
 * One week of the growth fleet, as data: the plan, the steps, and what a
 * finished week says about itself. The runner (tools/week.ts) does the I/O;
 * everything that decides a number or a sentence is here, where a test can
 * reach it.
 *
 * ## The shape of a week
 *
 *   genesis   the principal issues a batch grant: Researcher is its one payee
 *   open      nothing on chain — the batch record starts
 *   scout     GitHub search, free: a shortlist with the search behind each entry
 *   hire      the orchestrator delegates Scout a child grant, sized to the list
 *   buy       Scout buys one record per candidate from Researcher, over x402
 *   settle    the child comes home: the parent is charged what Scout spent
 *   close     the batch record ends
 *   revoke    the principal ends the batch grant; the remainder goes home
 *   drafts    Outreach writes messages from the records — sends nothing
 *   report    what it cost, on chain, and what it found
 *
 * Every step records what it did before the next begins, so a week that
 * stops half way resumes where it stopped rather than paying twice.
 */
import type { Candidate } from "./scout.ts";
import type { Record as ProjectRecord } from "./verify-project.ts";
import type { Draft, Skipped } from "./outreach.ts";

export const STEPS = ["genesis", "open", "scout", "hire", "buy", "settle", "close", "revoke", "drafts", "report"] as const;
export type Step = (typeof STEPS)[number];

export interface StepDone {
  at: string;
  txid?: string;
  note?: string;
}

export interface WeekState {
  label: string;
  startedAt: string;
  done: Partial<Record<Step, StepDone>>;
  /** Set when a step refuses; cleared when a later run gets past it. */
  stoppedAt?: { step: Step; reason: string; at: string };
}

export const SOMPI_PER_KAS = 100_000_000n;

export interface Plan {
  records: number;
  priceSompi: bigint;
  /** What Scout's child grant may spend in total: every record, nothing more. */
  childBudget: bigint;
  /** The batch grant: the child's budget plus room for the covenant's fees. */
  parentBudget: bigint;
  maxPerSpendChild: bigint;
  maxPerSpendParent: bigint;
  /** A rate limit that is a rate limit: a quarter of the child's budget per epoch. */
  childEpochLimit: bigint;
  parentWindowDaa: bigint;
  childWindowDaa: bigint;
}

/** ~10 blocks a second on Kaspa. */
const DAA_PER_DAY = 864_000n;

export function plan(records: number, priceSompi = 5_000_000n): Plan {
  if (!Number.isInteger(records) || records < 1 || records > 50) {
    throw new Error(`records must be 1–50 a week, not ${records}: each one is a payment`);
  }
  const n = BigInt(records);
  const childBudget = n * priceSompi;
  const quarter = childBudget / 4n;
  return {
    records,
    priceSompi,
    childBudget,
    /* Fees are paid out of the coin, not the budget, but the coin must hold
       them: 0.3 KAS covers delegation, every spend and settlement at the
       ~0.02 KAS storage-mass floor with room to spare. */
    parentBudget: childBudget + 30_000_000n,
    maxPerSpendChild: priceSompi,
    maxPerSpendParent: priceSompi,
    childEpochLimit: quarter > priceSompi ? quarter : priceSompi,
    parentWindowDaa: 3n * DAA_PER_DAY,
    childWindowDaa: DAA_PER_DAY,
  };
}

/** ISO week label, e.g. 2026-W39. One batch per label. */
export function weekLabel(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function nextStep(state: WeekState): Step | null {
  return STEPS.find((s) => !state.done[s]) ?? null;
}

/** What buy.ts wrote, reduced to what a week needs. */
export interface Purchase {
  url: string;
  outcome: string;
  txid?: string;
  paidSompi?: bigint;
  record?: ProjectRecord;
}

export function readPurchase(raw: {
  url?: string; outcome?: string; txid?: string | null; paid?: string; paidSompi?: string; response?: unknown;
  proof?: { amountSompi?: string } | null; quoted?: { amountSompi?: string | null } | null;
}): Purchase | null {
  if (!raw.url || !raw.outcome) return null;
  const r = raw.response as ProjectRecord | undefined;
  const record = r && typeof r === "object" && Array.isArray(r.findings) ? r : undefined;
  let paidSompi: bigint | undefined;
  /* buy.ts writes the amount into the proof it presented; `quoted` is what
     was asked, which is the same number for a payment that went through. */
  if (raw.proof?.amountSompi) paidSompi = BigInt(raw.proof.amountSompi);
  else if (raw.paidSompi) paidSompi = BigInt(raw.paidSompi);
  else if (raw.txid && raw.quoted?.amountSompi) paidSompi = BigInt(raw.quoted.amountSompi);
  else if (raw.paid && /^[0-9.]+/.test(raw.paid)) paidSompi = BigInt(Math.round(parseFloat(raw.paid) * 1e8));
  return { url: raw.url, outcome: raw.outcome, txid: raw.txid ?? undefined, paidSompi, record };
}

/** The project a Researcher URL was asking about. */
export function projectOf(researcherUrl: string): string | null {
  try {
    return new URL(researcherUrl).searchParams.get("url");
  } catch {
    return null;
  }
}

/** Full names already bought in any week, so Scout never buys twice. */
export function seenFrom(purchases: Purchase[]): Set<string> {
  const seen = new Set<string>();
  for (const p of purchases) {
    if (p.outcome !== "bought" && p.outcome !== "served") continue;
    const project = projectOf(p.url);
    const m = project && /github\.com\/([^/]+\/[^/?#]+)/.exec(project);
    if (m) seen.add(m[1]!.replace(/\.git$/, "").toLowerCase());
  }
  return seen;
}

export interface Report {
  label: string;
  network: string;
  candidates: number;
  bought: number;
  failed: number;
  spentSompi: string;
  drafts: number;
  skipped: number;
  transactions: { step: Step; txid: string }[];
  searched: { label: string; status: number; found: number }[];
}

export function report(
  state: WeekState,
  network: string,
  candidates: Candidate[],
  purchases: Purchase[],
  results: (Draft | Skipped)[],
  searched: Report["searched"],
): Report {
  const ok = purchases.filter((p) => p.outcome === "bought" || p.outcome === "served");
  const spent = ok.reduce((s, p) => s + (p.paidSompi ?? 0n), 0n);
  return {
    label: state.label,
    network,
    candidates: candidates.length,
    bought: ok.length,
    failed: purchases.length - ok.length,
    spentSompi: spent.toString(),
    drafts: results.filter((r) => (r as Draft).body !== undefined).length,
    skipped: results.filter((r) => (r as Draft).body === undefined).length,
    transactions: STEPS.flatMap((s) => (state.done[s]?.txid ? [{ step: s, txid: state.done[s]!.txid! }] : [])),
    searched,
  };
}

export function kas(sompi: bigint | string): string {
  const v = typeof sompi === "string" ? BigInt(sompi) : sompi;
  const whole = v / SOMPI_PER_KAS;
  const frac = (v % SOMPI_PER_KAS).toString().padStart(8, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** The Telegram message, and the first lines of report.md. */
export function summary(r: Report): string {
  return [
    `Warda growth · ${r.label} · ${r.network}`,
    `${r.candidates} candidates from ${r.searched.length} searches; ${r.bought} records bought for ${kas(r.spentSompi)} KAS` +
      (r.failed ? `, ${r.failed} attempts did not complete` : ""),
    `${r.drafts} outreach drafts to read, ${r.skipped} projects with nothing to send`,
    r.transactions.length ? `on chain: ${r.transactions.map((t) => `${t.step} ${t.txid.slice(0, 8)}…`).join(", ")}` : "nothing on chain",
    "Nothing has been sent to anyone. The drafts are in growth/batches/" + r.label + "/drafts.md.",
  ].join("\n");
}
