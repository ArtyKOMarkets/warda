import { useMemo } from "react";
import { Plus, ShieldCheck, Ban, ArrowRight, Bot, FileJson, ExternalLink } from "lucide-react";
import { useData, inRange, agentHit, paymentHit } from "@/lib/data";
import { useAccount, ownKey } from "@/lib/account";
import { totals, type AgentView } from "@/lib/model";
import { kas, ago, short } from "@/lib/format";
import { href } from "@/lib/router";
import { Lineage } from "@/components/lineage";
import { AgentCard, ActivityList, BlockedCard } from "@/components/agent";
import { Badge, Card, CardHeader, Empty, Kas, LinkButton, PageHeader, Skeleton, Stat } from "@/components/ui";
import { CumulativeChart, Donut, HBars } from "@/components/charts";
import { Notices, ScopeBanner } from "@/components/scope";
import { GrowthFleet } from "@/components/growth";
import { allPayments, agentName } from "./shared";

export function Overview() {
  const { agents, loading, scope, yours, range, filter } = useData();
  const t = totals(agents);
  const shownAgents = agents.filter((a) => agentHit(a, filter));
  const live = shownAgents.filter((a) => a.status !== "ended" && a.status !== "expired");
  const cards = (live.length ? live : shownAgents).slice(0, 6);
  const rows = allPayments(shownAgents).filter(({ p, a }) => inRange(p.at, range) && paymentHit(p, a, filter));
  const settled = rows.filter((r) => r.p.outcome === "paid" || r.p.outcome === "paid-not-served");
  const blocked = rows.filter((r) => r.p.outcome === "blocked");
  const first = loading && !agents.length;

  const onChain = shownAgents.reduce((s, a) => s + (a.onChain ?? 0), 0);
  const outside = shownAgents.reduce((s, a) => s + (a.activity.outside ?? 0), 0);
  const spentInRange = settled.reduce((s, r) => s + (r.p.amount ?? 0), 0);
  const perDay = useMemo(() => {
    if (settled.length < 2) return null;
    const ts = settled.map((r) => new Date(r.p.at).getTime()).sort();
    const days = (ts[ts.length - 1]! - ts[0]!) / 86_400_000;
    return days > 0.5 ? spentInRange / days : null;
  }, [settled, spentInRange]);

  const cumulative = useMemo(() => {
    let run = 0;
    return [...settled].sort((x, y) => +new Date(x.p.at) - +new Date(y.p.at)).map((r) => ({ at: +new Date(r.p.at), total: (run += r.p.amount ?? 0) }));
  }, [settled]);
  const byAgent = useMemo(() => {
    const m = new Map<string, { key: string; label: string; value: number }>();
    for (const { p, a } of settled) {
      const e = m.get(a.key) ?? { key: a.key, label: agentName(a), value: 0 };
      e.value += p.amount ?? 0; m.set(a.key, e);
    }
    return [...m.values()].filter((x) => x.value > 0).sort((x, y) => y.value - x.value);
  }, [settled]);
  const topPayees = useMemo(() => {
    const m = new Map<string, number>();
    for (const { p } of settled) if (p.payTo) m.set(p.payTo, (m.get(p.payTo) ?? 0) + (p.amount ?? 0));
    const names = new Map(shownAgents.flatMap((a) => a.payees.map((x) => [x.address, x.label] as const)));
    return [...m].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([addr, v]) => ({ key: addr, value: v, label: <span className="flex items-baseline gap-2"><span>{names.get(addr) ?? "Unlisted"}</span><span className="num text-[11.5px] text-fg-3">{short(addr, 8, 4)}</span></span> }));
  }, [settled, shownAgents]);
  const endpoints = useMemo(() => {
    const m = new Map<string, { n: number; kas: number }>();
    for (const { p } of settled) { const k = p.host ? p.host + (p.path ?? "") : "—"; const e = m.get(k) ?? { n: 0, kas: 0 }; e.n++; e.kas += p.amount ?? 0; m.set(k, e); }
    return [...m].sort((x, y) => y[1].kas - x[1].kas).slice(0, 6);
  }, [settled]);

  return (
    <>
      <ScopeBanner />
      <PageHeader
        title={scope === "warda" && !yours ? "Warda's own agents" : "Overview"}
        sub={scope === "warda" ? "Public examples, live on testnet-10. Connect your wallet to see your own." : "Your agents, what they may spend, and every payment — each limit enforced by the Kaspa network."}
        actions={<LinkButton variant="primary" href={href("new")}><Plus className="size-4" /> New agent</LinkButton>}
      />

      <Card className="grid grid-cols-[minmax(0,1fr)] grid-cols-2 items-start gap-x-6 gap-y-6 p-5 sm:p-6 lg:grid-cols-4">
        <Stat label="They can still pay" hint={first ? <Skeleton className="w-24" /> : `across ${live.length} live agent${live.length === 1 ? "" : "s"}`}>
          <Kas value={kas(t.remaining)} loading={first} />
        </Stat>
        <Stat label="Still authorised" hint={first ? <Skeleton className="w-24" /> : `${kas(onChain)} KAS of it actually on chain`} className="lg:border-l lg:border-line lg:pl-6">
          <Kas value={kas(t.budget)} loading={first} />
        </Stat>
        <Stat label={range === "all" ? "Spent, all time" : `Spent, last ${range} days`} hint={first ? <Skeleton className="w-24" /> : perDay ? `${kas(perDay, { max: 3 })} KAS a day` : "per the payments logged"} className="lg:border-l lg:border-line lg:pl-6">
          <Kas value={kas(spentInRange)} loading={first} />
        </Stat>
        <Stat label="Settled" hint={first ? <Skeleton className="w-24" /> : `${blocked.length} refused · ${rows.length - settled.length - blocked.length} did not settle`} className="lg:border-l lg:border-line lg:pl-6">
          {first ? <Skeleton className="h-[1em] w-10" /> : <span className="num">{settled.length} <span className="text-[14px] text-fg-3">of {rows.length}</span></span>}
        </Stat>
      </Card>

      {outside > 0 && (
        <Card className="mt-4 border-bad/30 bg-bad/[0.05] p-4 text-[13px] text-fg-2">
          <span className="num text-bad">{kas(outside)} KAS</span> was paid outside an allowlist. That should not be possible — read it before anything else.
        </Card>
      )}

      <Notices className="mt-6" />

      <section className="mt-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[17px] font-semibold tracking-[-0.015em]">Agents</h2>
          <a href={href("agents")} className="flex items-center gap-1 text-[13px] text-fg-3 transition hover:text-fg">All agents <ArrowRight className="size-3.5" /></a>
        </div>
        {first ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((i) => <Card key={i} className="h-[268px] p-5"><Skeleton className="size-9 rounded-[10px]" /><Skeleton className="mt-8 h-7 w-28" /><Skeleton className="mt-4 h-1.5 w-full" /></Card>)}</div>
        ) : cards.length ? (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-3">{cards.map((a, i) => <div key={a.key} className="rise" style={{ animationDelay: `${i * 40}ms` }}><AgentCard a={a} /></div>)}</div>
        ) : (
          <Card><Empty icon={<Bot className="size-5" />} title={filter ? "No agent matches" : "No agents yet"} action={!filter ? <LinkButton variant="primary" href={href("new")}><Plus className="size-4" /> New agent</LinkButton> : undefined}>
            {filter ? "Clear the filter to see them all." : "Give an agent a budget, a per-payment cap and a list of who it may pay. The network enforces all three."}
          </Empty></Card>
        )}
      </section>

      <Tracked />

      <section className="mt-10 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <Card className="p-5 sm:p-6">
          <div className="text-[15px] font-semibold">What it has spent</div>
          <div className="mt-3">{first ? <Skeleton className="h-40 w-full" /> : <CumulativeChart points={cumulative} />}</div>
        </Card>
        <Card className="p-5 sm:p-6">
          <div className="text-[15px] font-semibold">Where it went, by agent</div>
          <div className="mt-4">{first ? <Skeleton className="h-40 w-full" /> : <Donut rows={byAgent} />}</div>
        </Card>
      </section>

      <section className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader title="Top payees" sub="By what they have actually been paid" />
          <div className="p-5">{topPayees.length ? <HBars rows={topPayees} /> : <Empty title="No payments in this range" className="py-8" />}</div>
        </Card>
        <Card>
          <CardHeader title="Where they buy" sub="The endpoint each payment went to" />
          <div className="p-5">
            {endpoints.length ? (
              <ul className="divide-y divide-line">
                {endpoints.map(([k, v]) => (
                  <li key={k} className="flex items-center justify-between gap-3 py-2.5 text-[13px]">
                    <span className="num min-w-0 flex-1 truncate text-fg-2" title={k}>{k}</span>
                    <span className="text-[12px] text-fg-3">{v.n} call{v.n === 1 ? "" : "s"}</span>
                    <span className="num w-20 text-right">{kas(v.kas)} <span className="text-[11px] text-fg-3">KAS</span></span>
                  </li>
                ))}
              </ul>
            ) : <Empty title="No payments in this range" className="py-8" />}
          </div>
        </Card>
      </section>

      <section className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
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
            {first ? <Skeleton className="h-24 w-full" /> : blocked.length ? blocked.slice(0, 3).map((r, i) => <BlockedCard key={i} {...r} />) : (
              <Empty icon={<ShieldCheck className="size-5" />} title="Nothing blocked" className="py-8">Every attempt so far stayed inside its limits.</Empty>
            )}
            {!first && blocked.length > 0 && (
              <p className="flex items-start gap-2 pt-1 text-[12px] leading-relaxed text-fg-3"><Ban className="mt-0.5 size-3.5 shrink-0" /> The network rejects any transaction that breaks a grant's rules, whatever the agent's software tries.</p>
            )}
          </div>
        </Card>
      </section>

      <GrowthFleet />
      <Lineage className="mt-4" agents={shownAgents} />
      <Readings agents={shownAgents} />
    </>
  );
}

/** Who delegated to whom, and what replaced what. */

/** The readings themselves: what this page is drawn from. */
function Readings({ agents }: { agents: AgentView[] }) {
  const pub = agents.filter((a) => a.source === "published");
  if (!pub.length) return null;
  return (
    <Card className="mt-4">
      <CardHeader title="The readings themselves" sub="Every figure above comes from one of these files" />
      <ul className="mt-2 divide-y divide-line">
        {pub.map((a) => (
          <li key={a.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-2.5 text-[13px]">
            <span className="min-w-[7rem] font-medium">{agentName(a)}</span>
            <span className="text-[12px] text-fg-3">read {ago(a.checkedAt)}</span>
            <span className="flex-1" />
            <a className="flex items-center gap-1 text-[12.5px] text-fg-3 hover:text-accent" href={`/agent-${a.id}.json`} target="_blank" rel="noopener"><FileJson className="size-3.5" /> JSON</a>
            <a className="flex items-center gap-1 text-[12.5px] text-fg-3 hover:text-accent" href={`/agent-${a.id}.html`} target="_blank" rel="noopener"><ExternalLink className="size-3.5" /> Public page</a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Grants you track by their grant.json, read by the verifier. */
export function Tracked() {
  const { own, readings } = useAccount();
  if (!own.length) return null;
  return (
    <Card className="mt-10">
      <CardHeader title="Grants you track" sub="Read by the verifier, kept in this browser" action={<a href={href("account", "grants")} className="text-[13px] text-fg-3 hover:text-fg">Manage</a>} />
      <ul className="mt-2 divide-y divide-line">
        {own.map((x) => {
          const k = ownKey(x.m), rd = readings[k];
          const r = rd?.st === "read" && rd.r.found ? rd.r : null;
          const K = (s: any) => (s?.sompi != null ? kas(Number(s.sompi) / 1e8, { max: 2 }) : "—");
          return (
            <li key={k} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3 text-[13px]">
              <a href={href("account", "grants")} className="min-w-[9rem] font-medium hover:text-accent">Grant {x.m.covenant_id ? String(x.m.covenant_id).slice(0, 8) + "…" : short(x.m.principal)}</a>
              <Badge tone={!rd ? "muted" : rd.st === "read" ? (r ? "ok" : "warn") : rd.st === "reading" ? "muted" : "bad"}>
                {!rd || rd.st === "reading" ? "reading…" : rd.st !== "read" ? "no reading" : r ? (r.agrees ? "live" : "disagrees") : "not at this state"}
              </Badge>
              <span className="text-fg-3">next payment up to <span className="num text-fg-2">{K(r?.maxNextSpend)}</span> KAS</span>
              <span className="text-fg-3">this period <span className="num text-fg-2">{K(r?.epochRemaining)}</span> KAS</span>
              <span className="flex-1" />
              <span className="num">{K(r?.remaining)} <span className="text-[11.5px] text-fg-3">KAS left</span></span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
