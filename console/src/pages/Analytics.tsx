import { useData } from "@/lib/data";
import { kas } from "@/lib/format";
import { totals } from "@/lib/model";
import { BarChart, HBars } from "@/components/charts";
import { Card, CardHeader, Empty, Kas, PageHeader, Skeleton, Stat } from "@/components/ui";
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
      <PageHeader title="Analytics" sub="Where the money went, from the payments your agents logged." />
      <Card className="grid grid-cols-2 gap-y-6 p-5 sm:p-6 lg:grid-cols-4">
        <Stat label="Spent, all time"><Kas value={kas(t.spent)} loading={first} /></Stat>
        <Stat label="Payments" className="lg:border-l lg:border-line lg:pl-6">{first ? <Skeleton className="h-[1em] w-10" /> : <span className="num">{t.payments}</span>}</Stat>
        <Stat label="Average payment" className="lg:border-l lg:border-line lg:pl-6"><Kas value={kas(avg)} loading={first} /></Stat>
        <Stat label="Blocked" className="lg:border-l lg:border-line lg:pl-6">{first ? <Skeleton className="h-[1em] w-10" /> : <span className="num">{t.blocked}</span>}</Stat>
      </Card>

      <Card className="mt-4 p-5 sm:p-6">
        {first ? <Skeleton className="h-[250px] w-full" /> : <BarChart data={bars} />}
      </Card>

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
