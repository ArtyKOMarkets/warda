/**
 * A month of one agent's spending, as the rows an accountant asks for: every
 * payment with its date, what it bought or whom it paid, the amount and the
 * transaction, then the runner's fees. Built from the run log, which records
 * each payment's txid at broadcast — so a payment that went out and was never
 * delivered is listed too, marked, because the money moved either way.
 */
import { formatKas } from "@warda_protocol/core";
import type { FeeLedger } from "./fees.ts";
import type { Store, RunRecord } from "./store.ts";

export interface StatementRow {
  date: string;
  job: string;
  kind: "payment" | "runner fee";
  what: string;
  kas: string;
  txid: string;
  status: string;
}

export interface Statement {
  agent: string;
  month: string;
  rows: StatementRow[];
  totals: { paymentsKas: string; payments: number; runnerFeesKas: string; charged: number; allKas: string };
  note: string;
}

export async function statement(o: {
  store: Store;
  agent: string;
  month: string;
  perRunSompi: bigint;
  ledger: FeeLedger | null;
}): Promise<Statement> {
  if (!/^\d{4}-\d{2}$/.test(o.month)) throw new Error("month is YYYY-MM");
  const runs = (await o.store.listRuns(o.agent, 1000)).filter((r) => new Date(r.startedAt).toISOString().slice(0, 7) === o.month);
  runs.sort((a, b) => a.startedAt - b.startedAt);
  const names = new Map<string, { name: string; actions: { url?: string; to?: string }[] } | null>();
  const wfOf = async (r: RunRecord) => {
    if (!names.has(r.workflowId)) {
      const wf = await o.store.getWorkflow(r.workflowId);
      names.set(r.workflowId, wf
        ? { name: wf.name, actions: wf.actions.map((a) => (a.type === "pay-x402" ? { url: a.url } : a.type === "send" ? { to: a.to } : {})) }
        : null);
    }
    return names.get(r.workflowId)!;
  };
  const rows: StatementRow[] = [];
  let paid = 0n, count = 0, charged = 0;
  for (const r of runs) {
    const wf = await wfOf(r);
    const job = wf?.name ?? (r.workflowId.startsWith("mcp-") ? "paid over MCP" : r.workflowId);
    r.steps.forEach((s, i) => {
      if (!s.txid || !s.sompi) return;
      const a = wf?.actions[i];
      const sompi = BigInt(s.sompi);
      paid += sompi; count++;
      rows.push({
        date: new Date(r.startedAt).toISOString().replace("T", " ").slice(0, 16) + " UTC",
        job, kind: "payment",
        what: s.to ?? a?.url ?? a?.to ?? s.detail ?? "",
        kas: formatKas(sompi), txid: s.txid,
        status: s.status === "submitted" ? "paid, not delivered" : "paid",
      });
    });
    if (r.charged) charged++;
  }
  const fees = o.perRunSompi * BigInt(charged);
  if (charged > 0) {
    rows.push({
      date: `${o.month}`, job: "", kind: "runner fee",
      what: `${charged} run${charged === 1 ? "" : "s"} × ${formatKas(o.perRunSompi)} KAS`,
      kas: formatKas(fees), txid: o.ledger?.lastSettlementTxid ?? "", status: "accrued; settled in batches from the grant",
    });
  }
  return {
    agent: o.agent, month: o.month, rows,
    totals: { paymentsKas: formatKas(paid), payments: count, runnerFeesKas: formatKas(fees), charged, allKas: formatKas(paid + fees) },
    note: "Amounts exclude Kaspa network fees, which the grant's coin pays and the budget does not count. Each txid can be checked on any Kaspa explorer.",
  };
}

const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function statementCsv(s: Statement): string {
  const head = ["date", "job", "kind", "what", "kas", "txid", "status"];
  const lines = [head.join(",")];
  for (const r of s.rows) lines.push([r.date, r.job, r.kind, r.what, r.kas, r.txid, r.status].map(cell).join(","));
  lines.push("", `total payments,${s.totals.payments},,,${s.totals.paymentsKas},,`, `runner fees,${s.totals.charged} runs,,,${s.totals.runnerFeesKas},,`,
    `total,,,,${s.totals.allKas},,`, "", cell(s.note));
  return lines.join("\n") + "\n";
}
