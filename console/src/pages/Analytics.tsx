import { useData } from "@/lib/data";
import { kas } from "@/lib/format";
import { totals, runway, spendable } from "@/lib/model";
import { ScopeBanner } from "@/components/scope";
import { BarChart, HBars } from "@/components/charts";
import { Badge, Card, CardHeader, Empty, Kas, PageHeader, Skeleton, Stat } from "@/components/ui";
import { href } from "@/lib/router";
import { allPayments, agentName } from "./shared";

export function Analytics() {
  const { agents, services, loading } = useData();
  const rows = allPayments(agents);
  const t = totals(agents);
  const spentRows = rows.filter((r) => r.p.outcome === "paid" || r.p.outcome === "paid-not-served");

  const days = [...Array(30)].map((_, i) => {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 29 + i);
    return d;
  });
  const bars = days.map((d) => {
    const k = d.toDateString();
    const on = rows.filter((r) => new Date(r.p.at).toDateString() === k);
    return {
      key: k, label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      value: on.filter((r) => r.p.outcome !== "blocked" && r.p.outcome !== "failed").reduce((s, r) => s + (r.p.amount ?? 0), 0),
      blocked: on.filter((r) => r.p.outcome === "blocked").length,
    };
  });

  const byAgent = agents.map((a) => ({ key: a.key, label: agentName(a), value: a.spent ?? 0 })).filter((r) => r.value > 0).sort((x, y) => y.value - x.value).slice(0, 8);
  const svcName = new Map(services.filter((s) => s.address).map((s) => [s.address!, s.name]));
  const bySvc = new Map<string, number>();
  for (const { p } of spentRows) {
    const k = (p.payTo && svcName.get(p.payTo)) || p.host || "Unlisted";
    bySvc.set(k, (bySvc.get(k) ?? 0) + (p.amount ?? 0));
  }
  const svcRows = [...bySvc].filter(([, v]) => v > 0).map(([label, value]) => ({ key: label, label, value })).sort((x, y) => y.value - x.value).slice(0, 8);
  const avg = spentRows.length ? spentRows.reduce((s, r) => s + (r.p.amount ?? 0), 0) / spentRows.length : null;
  const first = loading && !agents.length;

  return (
    <>
      <ScopeBanner />
      <PageHeader title="Analytics" sub="Where the money went, from the payments your agents logged." />
      <Card className="grid grid-cols-2 items-start gap-x-6 gap-y-6 p-5 sm:p-6 lg:grid-cols-4">
        <Stat label="Spent, all time"><Kas value={kas(t.spent)} loading={first} /></Stat>
        <Stat label="Payments" className="lg:border-l lg:border-line lg:pl-6">{first ? <Skeleton className="h-[1em] w-10" /> : <span className="num">{t.payments}</span>}</Stat>
        <Stat label="Average payment" className="lg:border-l lg:border-line lg:pl-6"><Kas value={kas(avg)} loading={first} /></Stat>
        <Stat label="Blocked" className="lg:border-l lg:border-line lg:pl-6">{first ? <Skeleton className="h-[1em] w-10" /> : <span className="num">{t.blocked}</span>}</Stat>
      </Card>

      <Card className="mt-4 p-5 sm:p-6">
        {first ? <Skeleton className="h-[250px] w-full" /> : <BarChart data={bars} />}
      </Card>

      <Runway agents={agents} />

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="By agent" sub="Spent per the covenant" />
          <div className="p-5">{byAgent.length ? <HBars rows={byAgent} /> : <Empty title="No spending yet" className="py-8" />}</div>
        </Card>
        <Card>
          <CardHeader title="By service" sub="Named from the Services registry" />
          <div className="p-5">{svcRows.length ? <HBars rows={svcRows} /> : <Empty title="No payments logged" className="py-8" />}</div>
        </Card>
      </div>
      <p className="mt-4 text-[12px] text-fg-3">Spent per the covenant can be higher than logged payments: some agents keep no purchase log.</p>
    </>
  );
}

/* Burn rate and runway: what it has spent since the grant opened, and how
   long what it can still pay lasts at that pace — against the term, which
   ends whatever is left. */
function Runway({ agents }: { agents: ReturnType<typeof useData>["agents"] }) {
  const rows = agents.map((a) => ({ a, r: runway(a) })).filter((x) => x.r) as { a: (typeof agents)[number]; r: NonNullable<ReturnType<typeof runway>> }[];
  if (!rows.length) return null;
  const rate = rows.reduce((s, x) => s + x.r.rate, 0);
  const left = rows.reduce((s, x) => s + (spendable(x.a) ?? 0), 0);
  return (
    <Card className="mt-4">
      <CardHeader title="Burn rate and runway" sub="From the covenant's own spend since each grant opened" />
      <div className="grid gap-y-5 border-b border-line p-5 sm:grid-cols-3">
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
      <p className="border-t border-line px-5 py-3 text-[12px] text-fg-3">An agent that has been open less than a day, or has spent nothing, is left out rather than guessed at.</p>
    </Card>
  );
}
