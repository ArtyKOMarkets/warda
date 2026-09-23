import { useMemo } from "react";
import { Download, Printer } from "lucide-react";
import { useData, inRange, agentHit, paymentHit } from "@/lib/data";
import { useAccount, ownKey } from "@/lib/account";
import { kas, short } from "@/lib/format";
import { href } from "@/lib/router";
import { runway, spendable, totals, type AgentView } from "@/lib/model";
import { BarChart, HBars, StackedBars, Rings, FlowBars, hueOf } from "@/components/charts";
import { Badge, Button, Card, CardHeader, Empty, Kas, PageHeader, Skeleton, Stat } from "@/components/ui";
import { ScopeBanner } from "@/components/scope";
import { allPayments, agentName } from "./shared";

const DAY = 86_400_000;

export function Analytics() {
  const { agents, services, loading, range, filter } = useData();
  const list = agents.filter((a) => agentHit(a, filter));
  const rows = allPayments(list).filter(({ p, a }) => paymentHit(p, a, filter));
  const inR = rows.filter(({ p }) => inRange(p.at, range));
  const settled = inR.filter((r) => r.p.outcome === "paid" || r.p.outcome === "paid-not-served");
  const t = totals(list);
  const first = loading && !agents.length;
  const days = range === "all" ? 60 : Number(range);

  const dayKeys = useMemo(() => [...Array(days)].map((_, i) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (days - 1) + i); return d; }), [days]);
  const series = useMemo(() => {
    const by = new Map<string, number[]>();
    for (const { p, a } of settled) {
      const i = dayKeys.findIndex((d) => d.toDateString() === new Date(p.at).toDateString());
      if (i < 0) continue;
      const arr = by.get(a.key) ?? new Array(days).fill(0);
      arr[i] += p.amount ?? 0; by.set(a.key, arr);
    }
    return [...by].map(([key, values]) => ({ key, label: agentName(list.find((a) => a.key === key)!), values })).sort((x, y) => y.values.reduce((a, b) => a + b, 0) - x.values.reduce((a, b) => a + b, 0));
  }, [settled, dayKeys, days, list]);

  const week = (from: number, to: number) => rows.filter((r) => { const t2 = +new Date(r.p.at); return t2 >= from && t2 < to && (r.p.outcome === "paid" || r.p.outcome === "paid-not-served"); }).reduce((s, r) => s + (r.p.amount ?? 0), 0);
  const thisWeek = week(Date.now() - 7 * DAY, Date.now() + DAY), lastWeek = week(Date.now() - 14 * DAY, Date.now() - 7 * DAY);
  const wow = lastWeek > 0 ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) : null;

  const svcName = new Map(services.filter((s) => s.address).map((s) => [s.address!, s.name]));
  const bySvc = new Map<string, number>();
  for (const { p } of settled) { const k = (p.payTo && svcName.get(p.payTo)) || p.host || "Unlisted"; bySvc.set(k, (bySvc.get(k) ?? 0) + (p.amount ?? 0)); }

  /* Who paid whom. The services are the series, in one fixed order so a
     filter that drops a row never repaints the survivors; the agents are the
     rows, on one shared scale. The last segment of each row is the gap
     between the covenant's own figure and what that agent's log names — the
     same thing the "spending with no receipt" flag counts, shown as money
     rather than as a badge. */
  const flow = useMemo(() => {
    const names = [...bySvc].filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]).map(([k]) => k);
    const series = names.slice(0, 7).map((k) => ({ key: k, label: k }));
    const folded = names.length > 7;
    if (folded) series.push({ key: "__other", label: `Other (${names.length - 7})` });
    const idx = (k: string) => { const i = names.indexOf(k); return i < 0 ? -1 : i < 7 ? i : series.length - 1; };
    const byAgentSvc = new Map<string, number[]>();
    for (const { p, a } of settled) {
      const k = (p.payTo && svcName.get(p.payTo)) || p.host || "Unlisted";
      const i = idx(k);
      if (i < 0) continue;
      const arr = byAgentSvc.get(a.key) ?? new Array(series.length).fill(0);
      arr[i] += p.amount ?? 0;
      byAgentSvc.set(a.key, arr);
    }
    /* The covenant's figure is a grant's whole life; the log is filtered to
       the range. Subtracting one from the other while a range is on would
       render the payments the filter excluded as "money with no receipt",
       which is a filter narrowing half a row of figures and not the other
       half — two halves describing different populations. So the gap is
       shown only when the range is everything. */
    const whole = range === "all";
    const rows = list
      .map((a) => {
        const values = byAgentSvc.get(a.key) ?? new Array(series.length).fill(0);
        const logged = values.reduce((x: number, y: number) => x + y, 0);
        const covenant = a.spent ?? 0;
        const unlogged = whole ? Math.max(0, covenant - logged) : 0;
        return { key: a.key, label: agentName(a), values, unlogged, total: logged + unlogged };
      })
      .filter((r) => r.total > 0)
      .sort((x, y) => y.total - x.total);
    return { series, rows };
  }, [settled, list, services, range]);
  const avg = settled.length ? settled.reduce((s, r) => s + (r.p.amount ?? 0), 0) / settled.length : null;

  const endpoints = useMemo(() => {
    const m = new Map<string, { n: number; kas: number; last: string }>();
    for (const { p } of settled) {
      const k = p.host ? p.host + (p.path ?? "") : "—";
      const e = m.get(k) ?? { n: 0, kas: 0, last: p.at };
      e.n++; e.kas += p.amount ?? 0; if (p.at > e.last) e.last = p.at;
      m.set(k, e);
    }
    return [...m].sort((x, y) => y[1].kas - x[1].kas);
  }, [settled]);
  const endTotal = endpoints.reduce((s, [, v]) => s + v.kas, 0);

  const whyNot = useMemo(() => {
    const m = new Map<string, number>();
    for (const { p } of inR) if (p.outcome === "blocked" || p.outcome === "failed") {
      const k = (p.rule ?? p.why?.split(/[.,:]/)[0] ?? "unknown").toString().toLowerCase().slice(0, 48);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m].sort((x, y) => y[1] - x[1]);
  }, [inR]);

  const tasks = useMemo(() => {
    const m = new Map<string, { n: number; ok: number; kas: number; last: string }>();
    for (const { p } of inR) if (p.task) {
      const e = m.get(p.task) ?? { n: 0, ok: 0, kas: 0, last: p.at };
      e.n++; if (p.outcome === "paid") { e.ok++; e.kas += p.amount ?? 0; }
      if (p.at > e.last) e.last = p.at;
      m.set(p.task, e);
    }
    return [...m].sort((x, y) => y[1].kas - x[1].kas);
  }, [inR]);

  const near = useMemo(() => settled.map(({ p, a }) => ({ p, a, share: a.maxPerPayment ? ((p.amount ?? 0) / a.maxPerPayment) * 100 : null })).filter((x) => x.share !== null) as { p: any; a: AgentView; share: number }[], [settled]);
  const idle = list.filter((a) => a.status === "active").map((a) => ({ a, recent: a.payments.some((p) => inRange(p.at, "7") && p.outcome === "paid") }));
  const trees = useMemo(() => {
    const kids = new Map<string, AgentView[]>();
    for (const a of list) if (a.parent) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
    return list.filter((a) => !a.parent && (kids.has(a.label) || kids.has(a.id))).map((root) => {
      const family = [root, ...(kids.get(root.label) ?? kids.get(root.id) ?? [])];
      return { root, family, spent: family.reduce((s, x) => s + (x.spent ?? 0), 0) };
    });
  }, [list]);

  const csv = () => {
    const head = ["agent", "state", "budget_kas", "spent_kas", "left_kas", "on_chain_kas", "used_pct", "per_day_kas", "money_lasts_days", "term_days", "cap_kas"];
    const out = [head, ...list.map((a) => {
      const r = runway(a);
      return [agentName(a), a.status, a.budget ?? "", a.spent ?? "", a.remaining ?? "", a.onChain ?? "",
        a.budget && a.spent !== null ? Math.round((a.spent / a.budget) * 100) : "", r ? r.rate.toFixed(4) : "", r?.lasts != null ? Math.round(r.lasts) : "", r?.ends != null ? Math.round(r.ends) : "", a.maxPerPayment ?? ""];
    })];
    const text = out.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const el = document.createElement("a");
    el.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    el.download = `warda-summary-${new Date().toISOString().slice(0, 10)}.csv`; el.click();
  };

  return (
    <>
      <ScopeBanner />
      <PageHeader title="Analytics" sub={`Where the money went${range === "all" ? "" : `, over the last ${range} days`} — from the payments these agents logged, and what the covenant itself counted.`}
        actions={<><Button size="sm" onClick={csv}><Download className="size-3.5" /> Summary CSV</Button><Button size="sm" variant="ghost" onClick={() => print()}><Printer className="size-3.5" /> Print</Button></>} />

      <Card className="grid grid-cols-[minmax(0,1fr)] grid-cols-2 items-start gap-x-6 gap-y-6 p-5 sm:p-6 lg:grid-cols-5">
        <Stat label="Spent, per the covenant"><Kas value={kas(t.spent)} loading={first} /></Stat>
        <Stat label="Payments" hint={`${settled.length} settled in range`} className="lg:border-l lg:border-line lg:pl-6">{first ? <Skeleton className="h-[1em] w-10" /> : <span className="num">{t.payments}</span>}</Stat>
        <Stat label="Average payment" className="lg:border-l lg:border-line lg:pl-6"><Kas value={kas(avg)} loading={first} /></Stat>
        <Stat label="This week vs last" hint={`${kas(thisWeek)} against ${kas(lastWeek)} KAS`} className="lg:border-l lg:border-line lg:pl-6">
          {first ? <Skeleton className="h-[1em] w-10" /> : <span className={wow === null ? "" : wow > 0 ? "text-warn" : "text-ok"}>{wow === null ? "—" : `${wow > 0 ? "+" : ""}${wow}%`}</span>}
        </Stat>
        <Stat label="Blocked" hint="refused by a covenant rule" className="lg:border-l lg:border-line lg:pl-6">{first ? <Skeleton className="h-[1em] w-10" /> : <span className="num">{t.blocked}</span>}</Stat>
      </Card>

      <Card className="mt-4 p-5 sm:p-6">
        {first ? <Skeleton className="h-[250px] w-full" /> : series.length ? <StackedBars days={dayKeys.map((d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }))} series={series} />
          : <BarChart data={dayKeys.map((d) => ({ key: d.toDateString(), label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }), value: 0, blocked: 0 }))} />}
      </Card>

      <Runway agents={list} />

      <Card className="mt-4">
        <CardHeader title="Who spent it, and who they paid"
          sub={range === "all"
            ? "Every agent's spending, split by the service its log names"
            : `What each agent paid in the last ${range} days, by service`} />
        <div className="p-5">
          {flow.rows.length
            ? <FlowBars series={flow.series} rows={flow.rows} />
            : <Empty title="No spending yet" className="py-8" />}
        </div>
      </Card>

      <Card className="mt-4 p-5 sm:p-6">
        <div className="text-[15px] font-semibold">Budget used</div>
        <p className="mt-1 text-[13px] text-fg-3">How much of each grant is gone. Over 80% turns amber.</p>
        <div className="mt-5">{list.filter((a) => a.budget).length ? <Rings rows={list.filter((a) => a.budget).map((a) => ({ key: a.key, label: agentName(a), used: ((a.spent ?? 0) / a.budget!) * 100 }))} /> : <Empty title="No grants yet" className="py-6" />}</div>
      </Card>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="How close to the limit" sub="Each payment as a share of its grant's per-payment cap" />
          <div className="p-5">
            {near.length ? (
              <>
                <div className="relative h-24 rounded-lg border border-line-strong bg-bg">
                  <div className="absolute inset-y-0 right-0 w-[20%] rounded-r-lg bg-warn/10" />
                  <div className="absolute inset-y-0 right-0 w-px bg-warn/40" />
                  {near.map((x, i) => (
                    <span key={i} title={`${kas(x.p.amount)} KAS of a ${kas(x.a.maxPerPayment)} KAS cap`} className="absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                      style={{ left: `${Math.min(100, x.share)}%`, top: `${12 + ((i * 37) % 70)}%`, background: hueOf(list.findIndex((a) => a.key === x.a.key)) }} />
                  ))}
                </div>
                <div className="mt-2 flex justify-between text-[11.5px] text-fg-3"><span>0</span><span>within 20% of the cap</span><span>the cap</span></div>
              </>
            ) : <Empty title="No settled payments in range" className="py-8" />}
          </div>
        </Card>
        <Card>
          <CardHeader title="Why payments did not go through" sub="Grouped by what the attempt ran into" />
          <div className="p-5">
            {whyNot.length ? <HBars unit="attempts" rows={whyNot.map(([k, n]) => ({ key: k, label: k, value: n }))} /> : <Empty title="Everything went through" className="py-8" />}
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader title="Cost by endpoint" sub="What each URL has been paid, and how concentrated that is" />
        {endpoints.length ? (
          <ul className="mt-2 divide-y divide-line md:hidden">
            {endpoints.map(([k, v]) => (
              <li key={k} className="px-5 py-3">
                <div className="num truncate text-[12.5px] text-fg-2" title={k}>{k}</div>
                <div className="mt-2 flex items-center gap-3">
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><span className="block h-full rounded-full bg-accent" style={{ width: `${(v.kas / endTotal) * 100}%` }} /></span>
                  <span className="num text-[12px] text-fg-3">{Math.round((v.kas / endTotal) * 100)}%</span>
                </div>
                <div className="num mt-2 text-[12px] text-fg-3">
                  <span className="text-fg">{kas(v.kas)}</span> KAS · {v.n} payment{v.n === 1 ? "" : "s"} · {kas(v.kas / v.n, { max: 4 })} each · {new Date(v.last).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </div>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="hidden overflow-x-auto md:block">
          {endpoints.length ? (
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead className="border-b border-line text-[12px] text-fg-3"><tr>{["Endpoint", "Payments", "Total", "Average", "Share", "Last"].map((h) => <th key={h} className="px-5 py-2.5 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {endpoints.map(([k, v]) => (
                  <tr key={k}>
                    <td className="num max-w-[22rem] truncate px-5 py-2.5 text-fg-2" title={k}>{k}</td>
                    <td className="num px-5">{v.n}</td>
                    <td className="num px-5">{kas(v.kas)}</td>
                    <td className="num px-5 text-fg-2">{kas(v.kas / v.n, { max: 4 })}</td>
                    <td className="px-5"><span className="flex items-center gap-2"><span className="h-1.5 w-16 overflow-hidden rounded-full bg-raised"><span className="block h-full rounded-full bg-accent" style={{ width: `${(v.kas / endTotal) * 100}%` }} /></span><span className="num text-[12px] text-fg-3">{Math.round((v.kas / endTotal) * 100)}%</span></span></td>
                    <td className="px-5 text-[12px] text-fg-3">{new Date(v.last).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <Empty title="No payments in range" className="py-8" />}
        </div>
        {endpoints.length > 0 && (
          <p className="border-t border-line px-5 py-3 text-[12px] text-fg-3">
            The largest endpoint takes {Math.round((endpoints[0]![1].kas / endTotal) * 100)}% of the spend{(endpoints[0]![1].kas / endTotal) > 0.6 ? " — concentrated: one vendor going away would change what these agents do." : "."}
          </p>
        )}
      </Card>

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Active against idle" sub="Live grants that paid in the last 7 days" />
          <ul className="mt-2 divide-y divide-line">
            {idle.length ? idle.map(({ a, recent }) => (
              <li key={a.key} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
                <a href={href("agents", a.key)} className="min-w-0 flex-1 truncate font-medium hover:text-accent">{agentName(a)}</a>
                <span className="num text-fg-2">{kas(spendable(a))} KAS</span>
                <Badge tone={recent ? "ok" : "muted"}>{recent ? "active" : "idle"}</Badge>
              </li>
            )) : <li className="px-5 py-6 text-center text-[13px] text-fg-3">No live grants.</li>}
          </ul>
          <p className="border-t border-line px-5 py-3 text-[12px] text-fg-3">Idle authority is the first thing to reclaim: it is money committed to an agent that is not using it.</p>
        </Card>
        <Card>
          <CardHeader title="Cost by delegation tree" sub="A parent and everything under it" />
          <div className="p-5">
            {trees.length ? <HBars rows={trees.map((t2) => ({ key: t2.root.key, label: `${agentName(t2.root)} + ${t2.family.length - 1} helper${t2.family.length === 2 ? "" : "s"}`, value: t2.spent }))} /> : <Empty title="No helpers yet" className="py-8">A sub-agent's spending is counted with its parent here.</Empty>}
          </div>
        </Card>
      </div>

      {tasks.length > 0 && (
        <Card className="mt-4">
          <CardHeader title="Cost per task" sub="From what each agent said it was buying (warda pay --task)" />
          <ul className="mt-2 divide-y divide-line md:hidden">
            {tasks.map(([k, v]) => (
              <li key={k} className="px-5 py-3">
                <div className="truncate text-[13px]">{k}</div>
                <div className="num mt-1.5 text-[12px] text-fg-3">
                  <span className="text-fg">{kas(v.kas)}</span> KAS · {v.ok} of {v.n} settled · {v.ok ? `${kas(v.kas / v.ok, { max: 4 })} each` : "none settled"} · {new Date(v.last).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[620px] text-left text-[13px]">
              <thead className="border-b border-line text-[12px] text-fg-3"><tr>{["Task", "Attempts", "Settled", "Total", "Per settled payment", "Last"].map((h) => <th key={h} className="px-5 py-2.5 font-medium">{h}</th>)}</tr></thead>
              <tbody className="divide-y divide-line">
                {tasks.map(([k, v]) => (
                  <tr key={k}><td className="max-w-[20rem] truncate px-5 py-2.5">{k}</td><td className="num px-5">{v.n}</td><td className="num px-5">{v.ok}</td><td className="num px-5">{kas(v.kas)}</td><td className="num px-5 text-fg-2">{v.ok ? kas(v.kas / v.ok, { max: 4 }) : "—"}</td><td className="px-5 text-[12px] text-fg-3">{new Date(v.last).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <TrackedHistory />

      <p className="mt-4 text-[12px] text-fg-3">Spent per the covenant can be higher than logged payments: some agents keep no purchase log. The daily chart and the endpoint table come from the logs; "by agent" and the tiles come from the covenant.</p>
    </>
  );
}

/* Burn rate and runway: what it has spent since the grant opened, and how
   long what it can still pay lasts at that pace — against the term, which
   ends whatever is left. */
function Runway({ agents }: { agents: AgentView[] }) {
  const rows = agents.map((a) => ({ a, r: runway(a) })).filter((x) => x.r) as { a: AgentView; r: NonNullable<ReturnType<typeof runway>> }[];
  if (!rows.length) return null;
  const rate = rows.reduce((s, x) => s + x.r.rate, 0);
  const left = rows.reduce((s, x) => s + (spendable(x.a) ?? 0), 0);
  return (
    <Card className="mt-4">
      <CardHeader title="Burn rate and runway" sub="From the covenant's own spend since each grant opened" />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-y-5 border-b border-line p-5 sm:grid-cols-3">
        <Stat label="Fleet burn rate" hint="per day, across these agents"><Kas value={kas(rate, { max: 3 })} /></Stat>
        <Stat label="Fleet runway" hint="at that pace" className="sm:border-l sm:border-line sm:pl-6"><span className="num">{rate > 0 ? Math.round(left / rate) : "—"}<span className="ml-1.5 text-[12px] font-medium text-fg-3">days</span></span></Stat>
        <Stat label="Measured over" hint="since each grant opened" className="sm:border-l sm:border-line sm:pl-6"><span className="num">{Math.round(Math.max(...rows.map((x) => x.r.days)))}<span className="ml-1.5 text-[12px] font-medium text-fg-3">days</span></span></Stat>
      </div>
      <ul className="divide-y divide-line">
        {rows.sort((x, y) => (x.r.lasts ?? 1e9) - (y.r.lasts ?? 1e9)).map(({ a, r }) => {
          const moneyFirst = r.lasts != null && r.ends != null && r.lasts < r.ends;
          return (
            <li key={a.key} className="flex flex-wrap items-center gap-x-6 gap-y-1 px-5 py-3 text-[13px]">
              <a href={href("agents", a.key)} className="min-w-[8rem] flex-1 font-medium hover:text-accent">{agentName(a)}</a>
              <span className="num text-fg-2">{kas(r.rate, { max: 3 })} <span className="text-[11.5px] text-fg-3">KAS / day</span></span>
              <span className="num text-fg-2">{r.lasts != null ? Math.round(r.lasts) : "—"} <span className="text-[11.5px] text-fg-3">days of money</span></span>
              <span className="num text-fg-2">{r.ends != null ? Math.round(r.ends) : "—"} <span className="text-[11.5px] text-fg-3">days of term</span></span>
              <Badge tone={moneyFirst ? "warn" : "muted"}>{moneyFirst ? "money first" : "term first"}</Badge>
            </li>
          );
        })}
      </ul>
      <p className="border-t border-line px-5 py-3 text-[12px] text-fg-3">An agent open less than a day, or that has spent nothing, is left out rather than guessed at.</p>
    </Card>
  );
}

/** Authority left over time, hourly, for the grants your account keeps history for. */
function TrackedHistory() {
  const { own, history } = useAccount();
  const lines = own.map((x) => ({ key: ownKey(x.m), label: `Grant ${String(x.m.covenant_id ?? ownKey(x.m)).slice(0, 8)}…`, pts: history?.[ownKey(x.m)] ?? [] })).filter((l) => l.pts.length > 1);
  if (!lines.length) return null;
  const all = lines.flatMap((l) => l.pts);
  const t0 = Math.min(...all.map((p) => +new Date(p.at))), t1 = Math.max(...all.map((p) => +new Date(p.at)));
  const max = Math.max(...all.map((p) => Number(p.remainingSompi))) || 1;
  const W = 600, H = 160;
  return (
    <Card className="mt-4 p-5 sm:p-6">
      <div className="text-[15px] font-semibold">Tracked grants over time</div>
      <p className="mt-1 text-[13px] text-fg-3">Authority left, hourly, kept by your console account.</p>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-4 h-40 w-full" role="img" aria-label="Authority left over time">
        {lines.map((l, i) => (
          <path key={l.key} fill="none" stroke={hueOf(i)} strokeWidth="2" vectorEffect="non-scaling-stroke"
            d={l.pts.map((p, j) => `${j ? "L" : "M"}${(((+new Date(p.at) - t0) / Math.max(1, t1 - t0)) * (W - 4) + 2).toFixed(1)} ${(H - 4 - (Number(p.remainingSompi) / max) * (H - 12)).toFixed(1)}`).join(" ")} />
        ))}
      </svg>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-fg-3">
        {lines.map((l, i) => <li key={l.key} className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: hueOf(i) }} />{short(l.label, 18, 4)}</li>)}
      </ul>
    </Card>
  );
}
