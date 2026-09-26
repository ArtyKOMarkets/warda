/**
 * The operator's view: who is using the runner, how it is going, and what is
 * going wrong — for the first outside users, before they have to say so.
 *
 * Read from the registry and the run log — plus ONE question per agent to the
 * chain, which is new and is the point of the `grants` argument. Grant figures
 * are still the registered manifest's, as of the agent's last payment; what the
 * chain adds is whether the coin is at the address that manifest derives.
 *
 * That question was missing, and its absence is why the hosted fleet had no
 * equivalent of ops/check-located.ts. On 25 September a covenant freeze made
 * every agent in this repository derive a v5 address for a v4 grant — valid,
 * well-formed, empty — and this page would have shown all of them with a healthy
 * budget and a healthy spend, because a manifest cannot tell you whether the
 * money is where it says.
 *
 * `GrantReader.read` already answered it and nothing asked: its own comment says
 * null means "the node is down, behind, or the address the runner has on file
 * holds nothing. It is never empty." So `located` is three-valued and the third
 * value is not a failure — an unreachable node and a lost grant must not be the
 * same answer.
 *
 * Account ids are shortened and no key, token, chat id or deposit secret is
 * included.
 */
import type { Store, RunRecord } from "./store.ts";
import type { Registry } from "./registry.ts";
import type { GrantReader } from "./grant.ts";
import { formatKas } from "@warda_protocol/core";
import { classify } from "./ops.ts";

const DAY = 86_400_000;
const k = (s: bigint) => formatKas(s);
const big = (v: unknown) => { try { return BigInt(String(v ?? 0)); } catch { return 0n; } };
const short = (id: string) => (id.length > 14 ? id.slice(0, 9) + "…" + id.slice(-4) : id);

export async function adminStats(o: {
  store: Store;
  registry: Registry;
  now: number;
  lastTickAt: number | null;
  days?: number;
  /** Optional: without it `located` is null everywhere and says why. */
  grants?: GrantReader;
}) {
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
    const [grant, ledger, plan, wfs, view] = await Promise.all([
      o.registry.getGrant(a.agent), o.store.getLedger(a.agent), o.registry.getPlan(a.agent), o.store.listWorkflows(a.agent),
      /* Never throws by contract; null is "cannot tell", not "empty". */
      o.grants ? o.grants.read(a.agent).catch(() => null) : Promise.resolve(null),
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
      /**
       * Is the coin where this agent's manifest says it is?
       *
       * true   the chain holds it at the derived address
       * false  the record names a grant and the chain has nothing there
       * null   nobody asked, or the node could not answer
       *
       * `false` is the one that matters and the only one worth waking somebody
       * for. It has the usual three causes — the grant moved and the record did
       * not follow, it was revoked or reclaimed, or the address is being derived
       * under the wrong covenant — and the runner cannot tell them apart from
       * here. What it can do is stop reporting a healthy budget for a grant
       * whose money it cannot find.
       */
      located: grant ? (view ? true : o.grants ? false : null) : null,
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
      /* Counted at the top so a probe does not have to walk `agents`, and
         separated from `unknown` so that "the node was asleep" can never be
         read as "seven grants are missing". */
      unlocated: agents.filter((x) => x.located === false).length,
      locationUnknown: agents.filter((x) => x.located === null && x.grant !== null).length,
      chainAsked: !!o.grants,
    },
    days: Object.entries(byDay).map(([day, s]) => ({ day, ...s })),
    accounts: perAccount,
    agents,
    problems,
  };
}
