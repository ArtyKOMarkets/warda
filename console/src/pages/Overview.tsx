import { Plus, ShieldCheck, Ban, ArrowRight, Bot } from "lucide-react";
import { useData } from "@/lib/data";
import { totals } from "@/lib/model";
import { kas } from "@/lib/format";
import { href } from "@/lib/router";
import { AgentCard, ActivityList, BlockedCard } from "@/components/agent";
import { Card, CardHeader, Empty, Kas, LinkButton, PageHeader, Skeleton, Stat } from "@/components/ui";
import { allPayments } from "./shared";

export function Overview() {
  const { agents, loading } = useData();
  const t = totals(agents);
  const live = agents.filter((a) => a.status !== "ended" && a.status !== "expired");
  const shown = (live.length ? live : agents).slice(0, 6);
  const rows = allPayments(agents);
  const blocked = rows.filter((r) => r.p.outcome === "blocked").slice(0, 3);
  const first = loading && !agents.length;

  return (
    <>
      <PageHeader
        title="Overview"
        sub="Your agents, what they may spend, and every payment — each limit enforced by the Kaspa network."
        actions={<LinkButton variant="primary" href={href("new")}><Plus className="size-4" /> New agent</LinkButton>}
      />

      <Card className="grid grid-cols-2 gap-y-6 p-5 sm:p-6 lg:grid-cols-4">
        <Stat label="Spendable now" hint={first ? <Skeleton className="w-24" /> : `across ${live.length} live agent${live.length === 1 ? "" : "s"}`}>
          <Kas value={kas(t.remaining)} loading={first} />
        </Stat>
        <Stat label="Total budget" hint={first ? <Skeleton className="w-24" /> : "granted to live agents"} className="lg:border-l lg:border-line lg:pl-6">
          <Kas value={kas(t.budget)} loading={first} />
        </Stat>
        <Stat label="Spent" hint="all time, per the covenant" className="lg:border-l lg:border-line lg:pl-6">
          <Kas value={kas(t.spent)} loading={first} />
        </Stat>
        <Stat label="Blocked attempts" hint="refused by the network" className="lg:border-l lg:border-line lg:pl-6">
          {first ? <Skeleton className="h-[1em] w-10" /> : <span className="num">{t.blocked}</span>}
        </Stat>
      </Card>

      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold tracking-[-0.015em]">Agents</h2>
          <a href={href("agents")} className="flex items-center gap-1 text-[13px] text-fg-3 transition hover:text-fg">All agents <ArrowRight className="size-3.5" /></a>
        </div>
        {first ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Card key={i} className="h-[268px] p-5"><Skeleton className="size-9 rounded-[10px]" /><Skeleton className="mt-8 h-7 w-28" /><Skeleton className="mt-4 h-1.5 w-full" /></Card>)}</div>
        ) : shown.length ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{shown.map((a, i) => <div key={a.key} className="rise" style={{ animationDelay: `${i * 40}ms` }}><AgentCard a={a} /></div>)}</div>
        ) : (
          <Card><Empty icon={<Bot className="size-5" />} title="No agents yet" action={<LinkButton variant="primary" href={href("new")}><Plus className="size-4" /> New agent</LinkButton>}>
            Give an agent a budget, a per-payment cap and a list of who it may pay. The network enforces all three.
          </Empty></Card>
        )}
      </section>

      <section className="mt-10 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card>
          <CardHeader title="Recent activity" sub="Payments and refusals, newest first" action={<a href={href("activity")} className="text-[13px] text-fg-3 hover:text-fg">View all</a>} />
          <div className="mt-3">
            {first ? <div className="space-y-3 px-5 pb-5">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div> :
              <ActivityList rows={rows.slice(0, 7)} showAgent empty={<Empty title="No payments yet">When an agent pays for something, it shows up here with its transaction.</Empty>} />}
          </div>
        </Card>
        <Card>
          <CardHeader title="Blocked by the network" sub="Real attempts outside a grant's rules" action={<a href={href("activity", "blocked")} className="text-[13px] text-fg-3 hover:text-fg">View all</a>} />
          <div className="space-y-3 p-5">
            {first ? <Skeleton className="h-24 w-full" /> : blocked.length ? blocked.map((r, i) => <BlockedCard key={i} {...r} />) : (
              <Empty icon={<ShieldCheck className="size-5" />} title="Nothing blocked" className="py-8">Every attempt so far stayed inside its limits.</Empty>
            )}
            {!first && blocked.length > 0 && (
              <p className="flex items-start gap-2 pt-1 text-[12px] leading-relaxed text-fg-3"><Ban className="mt-0.5 size-3.5 shrink-0" /> The network rejects any transaction that breaks a grant's rules, whatever the agent's software tries.</p>
            )}
          </div>
        </Card>
      </section>
    </>
  );
}
