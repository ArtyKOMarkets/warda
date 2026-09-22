/**
 * The operator's view: who is using the runner, how it is going, and what is
 * going wrong — for the first outside users, before they have to say so.
 *
 * Read from the registry and the run log only; the chain is not asked, so the
 * page is fast and costs nothing. Grant figures are the registered manifest's,
 * which is as of the agent's last payment. Account ids are shortened and no
 * key, token, chat id or deposit secret is included.
 */
import type { Store, RunRecord } from "./store.ts";
import type { Registry } from "./registry.ts";
import { formatKas } from "@warda_protocol/core";
import { classify } from "./ops.ts";

const DAY = 86_400_000;
const k = (s: bigint) => formatKas(s);
const big = (v: unknown) => { try { return BigInt(String(v ?? 0)); } catch { return 0n; } };
const short = (id: string) => (id.length > 14 ? id.slice(0, 9) + "…" + id.slice(-4) : id);

export async function adminStats(o: { store: Store; registry: Registry; now: number; lastTickAt: number | null; days?: number }) {
  const days = o.days ?? 14;
  const since = o.now - days * DAY;
  const runs = await o.store.runsSince(since, 5000);
  const accounts = await o.registry.listAccounts();
  const agentRows = await o.registry.listAgents();

  const byDay: Record<string, Record<string, number>> = {};
  for (let d = days - 1; d >= 0; d--) byDay[new Date(o.now - d * DAY).toISOString().slice(0, 10)] = {};
  for (const r of runs) {
    const day = new Date(r.startedAt).toISOString().slice(0, 10);
    const row = (byDay[day] ??= {});
    row[r.status] = (row[r.status] ?? 0) + 1;
  }

  let feesSettled = 0n, feesOwed = 0n;
  const agents = [];
  for (const a of agentRows) {
    const [grant, ledger, plan, wfs] = await Promise.all([
      o.registry.getGrant(a.agent), o.store.getLedger(a.agent), o.registry.getPlan(a.agent), o.store.listWorkflows(a.agent),
    ]);
    const mine = runs.filter((r) => r.agent === a.agent);
    const count = (s: RunRecord["status"]) => mine.filter((r) => r.status === s).length;
    feesSettled += ledger?.settled ?? 0n;
    feesOwed += ledger?.owed ?? 0n;
    const m = grant?.manifest as Record<string, unknown> | undefined;
    const budget = big(m?.budget), spent = big(m?.spent_total);
    const problem = mine.map((r) => ({ r, c: classify(r) })).find((x) => x.c);
    agents.push({
      agent: a.agent,
      account: short(a.account),
      createdAt: a.createdAt,
      funding: plan?.status ?? (grant ? "registered" : "no grant"),
      grant: grant ? { budget: k(budget), spent: k(spent), left: k(budget - spent) } : null,
      jobs: wfs.filter((w) => w.enabled).length,
      runs: { total: mine.length, ok: count("ok"), failed: count("failed"), refused: count("refused"), other: mine.length - count("ok") - count("failed") - count("refused") },
      lastRunAt: mine[0]?.startedAt ?? null,
      fees: { settled: k(ledger?.settled ?? 0n), owed: k(ledger?.owed ?? 0n) },
      lastProblem: problem ? { at: problem.r.startedAt, kind: problem.c!.kind, detail: problem.c!.detail } : null,
    });
  }

  const tg = await Promise.all(accounts.map((a) => o.registry.telegramOf(a.id)));
  const perAccount = accounts.map((a, i) => ({
    account: short(a.id),
    createdAt: a.createdAt,
    agents: agentRows.filter((x) => x.account === a.id).length,
    telegram: !!tg[i],
  }));

  const problems = runs
    .map((r) => ({ r, c: classify(r) }))
    .filter((x) => x.c)
    .slice(0, 30)
    .map(({ r, c }) => ({ at: r.startedAt, agent: r.agent, status: r.status, kind: c!.kind, detail: c!.detail }));

  const dayAgo = o.now - DAY;
  return {
    at: new Date(o.now).toISOString(),
    lastTickAt: o.lastTickAt,
    totals: {
      accounts: accounts.length,
      agents: agentRows.length,
      telegram: tg.filter(Boolean).length,
      runs24h: runs.filter((r) => r.startedAt >= dayAgo).length,
      problems24h: problems.filter((p) => p.at >= dayAgo).length,
      feesSettled: k(feesSettled),
      feesOwed: k(feesOwed),
    },
    days: Object.entries(byDay).map(([day, s]) => ({ day, ...s })),
    accounts: perAccount,
    agents,
    problems,
  };
}
