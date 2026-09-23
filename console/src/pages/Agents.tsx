import { useMemo, useState } from "react";
import { Plus, Search, Bot, LayoutGrid, List } from "lucide-react";
import { useData } from "@/lib/data";
import { kas, ago } from "@/lib/format";
import { href, go } from "@/lib/router";
import { AgentCard, AgentMark } from "@/components/agent";
import { Card, Empty, Kas, LinkButton, Meter, PageHeader, Skeleton, StatusBadge, Tabs, Badge } from "@/components/ui";
import { cn } from "@/lib/cn";
import { agentName } from "./shared";
import { ScopeSwitch, ScopeBanner } from "@/components/scope";
import { spendable, shortOfCoin } from "@/lib/model";

type F = "live" | "hosted" | "published" | "ended" | "all";

export function Agents() {
  const { agents, loading } = useData();
  const [f, setF] = useState<F>("live");
  const [q, setQ] = useState("");
  const [grid, setGrid] = useState(() => { try { return localStorage.getItem("warda.next.grid") !== "0"; } catch { return true; } });
  const setView = (g: boolean) => { setGrid(g); try { localStorage.setItem("warda.next.grid", g ? "1" : "0"); } catch { /* */ } };

  const isLive = (s: string) => s !== "ended" && s !== "expired";
  const counts = {
    live: agents.filter((a) => isLive(a.status)).length,
    hosted: agents.filter((a) => a.source === "hosted").length,
    published: agents.filter((a) => a.source === "published").length,
    ended: agents.filter((a) => !isLive(a.status)).length,
    all: agents.length,
  };
  const list = useMemo(() => agents.filter((a) =>
    (f === "all" || (f === "live" && isLive(a.status)) || (f === "ended" && !isLive(a.status)) || a.source === f) &&
    (!q || `${a.label} ${a.mission ?? ""}`.toLowerCase().includes(q.toLowerCase()))), [agents, f, q]);

  // Parents first, each followed by its helpers.
  const ordered = useMemo(() => {
    const kids = new Map<string, typeof list>();
    for (const a of list) if (a.parent) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
    const out: { a: (typeof list)[number]; child: boolean }[] = [];
    for (const a of list) {
      if (a.parent && list.some((p) => p.label === a.parent || p.id === a.parent)) continue;
      out.push({ a, child: false });
      for (const k of kids.get(a.label) ?? kids.get(a.id) ?? []) out.push({ a: k, child: true });
    }
    return out;
  }, [list]);

  return (
    <>
      <ScopeBanner />
      <PageHeader title="Agents" sub="Each agent holds a grant: a budget it can spend, under rules the network checks on every payment."
        actions={<><ScopeSwitch /><LinkButton variant="primary" href={href("new")}><Plus className="size-4" /> New agent</LinkButton></>} />

      <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <Tabs value={f} onChange={setF} className="flex-1 border-b-0" items={[
          { value: "live", label: "Live", count: counts.live },
          { value: "hosted", label: "Hosted", count: counts.hosted },
          { value: "published", label: "Published", count: counts.published },
          { value: "ended", label: "Ended", count: counts.ended },
        ]} />
        <div className="flex items-center gap-2">
          <label className="relative flex-1 sm:w-60 sm:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search agents"
              className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm placeholder:text-fg-3 focus:border-accent/60 focus:outline-none" />
          </label>
          <div className="flex rounded-lg border border-line-strong bg-surface p-0.5">
            {[{ g: true, I: LayoutGrid, l: "Cards" }, { g: false, I: List, l: "Table" }].map(({ g, I, l }) => (
              <button key={l} aria-label={l} onClick={() => setView(g)} className={cn("grid size-8 place-items-center rounded-md transition", grid === g ? "bg-raised text-fg" : "text-fg-3 hover:text-fg-2")}><I className="size-4" /></button>
            ))}
          </div>
        </div>
      </div>

      {loading && !agents.length ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2, 3, 4, 5].map((i) => <Card key={i} className="h-[268px] p-5"><Skeleton className="size-9" /><Skeleton className="mt-8 h-7 w-28" /></Card>)}</div>
      ) : !list.length ? (
        <Card><Empty icon={<Bot className="size-5" />} title={q ? "No agents match" : "Nothing here"}>{q ? "Try another name." : "Agents in this group will show up here."}</Empty></Card>
      ) : grid ? (
        // Helpers sit under the parent they were delegated from, not beside it.
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {ordered.map(({ a, child }, i) => (
            <div key={a.key} className={cn("rise", child && "sm:col-span-1")} style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
              {child && <div className="mb-1 flex items-center gap-1.5 pl-1 text-[11.5px] text-fg-3">↳ helper of {a.parent}</div>}
              <AgentCard a={a} />
            </div>
          ))}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[13.5px]">
              <thead className="border-b border-line text-[12px] text-fg-3">
                <tr>{["Agent", "Status", "Can still pay", "Budget used", "Per payment", "Ends in", "Last active"].map((h) => <th key={h} className="px-5 py-3 font-medium">{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-line">
                {list.map((a) => (
                  <tr key={a.key} onClick={() => go("agents", a.key)} className="cursor-pointer transition hover:bg-raised/50">
                    <td className="px-5 py-3.5">
                      <a href={href("agents", a.key)} className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
                        <AgentMark agent={a} size={30} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-medium">{agentName(a)}{a.parent && <Badge className="h-5 px-1.5 text-[11px]">sub-agent</Badge>}</div>
                          <div className="max-w-[260px] truncate text-[12px] text-fg-3">{a.mission ?? (a.source === "hosted" ? "Hosted agent" : "Published agent")}</div>
                        </div>
                      </a>
                    </td>
                    <td className="px-5"><StatusBadge status={a.status} /></td>
                    <td className="px-5"><Kas value={kas(spendable(a))} className={shortOfCoin(a) ? "text-warn" : ""} /></td>
                    <td className="w-40 px-5"><Meter spent={a.spent} budget={a.budget} /><div className="num mt-1.5 text-[11.5px] text-fg-3">{kas(a.spent)} / {kas(a.budget)}</div></td>
                    <td className="num px-5 text-fg-2">{kas(a.maxPerPayment)}</td>
                    <td className="px-5 text-fg-2">{a.status === "active" ? a.expiresIn ?? "—" : "—"}</td>
                    <td className="px-5 text-fg-3">{ago(a.lastActive)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
