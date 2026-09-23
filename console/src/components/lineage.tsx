import type { ReactNode } from "react";
import { GitBranch, ArrowRight, ShieldCheck } from "lucide-react";
import type { AgentView } from "@/lib/model";
import { spendable } from "@/lib/model";
import { kas } from "@/lib/format";
import { href } from "@/lib/router";
import { cn } from "@/lib/cn";
import { Badge, Card, CardHeader, StatusBadge } from "./ui";
import { AgentMark, BudgetRing } from "./agent";

const name = (a: AgentView) => (a.source === "hosted" ? a.label : `Agent ${a.label}`);

function Chips({ a }: { a: AgentView }) {
  const chips: ReactNode[] = [];
  if (a.narrower) for (const [k, v] of Object.entries(a.narrower).slice(0, 3))
    chips.push(<Badge key={k} className="h-[19px] px-1.5 text-[11px] text-fg-2"><span className="text-fg-3">{k}</span>&nbsp;{v}</Badge>);
  if (a.delegationDepth !== null && a.delegationDepth > 0)
    chips.push(<Badge key="d" className="h-[19px] px-1.5 text-[11px] text-fg-2">can delegate {a.delegationDepth} deep</Badge>);
  if (!chips.length) return null;
  return <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{chips}</div>;
}

function Node({ a, kids, depth, last }: { a: AgentView; kids: (p: AgentView) => AgentView[]; depth: number; last: boolean }) {
  const children = kids(a);
  return (
    <li className={cn("relative", depth > 0 && "pl-[44px]")}>
      {depth > 0 && (
        <>
          <span aria-hidden className="absolute left-[25px] top-0 w-px bg-line-strong" style={{ height: last ? 25 : "100%" }} />
          <span aria-hidden className="absolute left-[25px] top-[25px] h-px w-[26px] bg-line-strong" />
        </>
      )}
      <a href={href("agents", a.key)} className="group flex items-start gap-3 rounded-[11px] px-2.5 py-2.5 transition hover:bg-raised">
        <AgentMark agent={a} size={30} className="rounded-[9px]" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[13.5px] font-medium transition group-hover:text-accent">{name(a)}</span>
            <StatusBadge status={a.status} />
            {depth === 0 && children.length > 0 && <span className="text-[12px] text-fg-3">{children.length} helper{children.length === 1 ? "" : "s"}</span>}
          </div>
          <Chips a={a} />
        </div>
        <div className="hidden shrink-0 text-right sm:block">
          <div className="num text-[13.5px] text-fg">{kas(spendable(a))}<span className="ml-1 text-[11px] text-fg-3">KAS</span></div>
          <div className="text-[11px] text-fg-3">can still pay</div>
        </div>
        <BudgetRing a={a} size={34} width={4.5} bare className="mt-0.5 shrink-0" />
      </a>
      {children.length > 0 && (
        <ul>{children.map((k, i) => <Node key={k.key} a={k} kids={kids} depth={depth + 1} last={i === children.length - 1} />)}</ul>
      )}
    </li>
  );
}

/** The delegation tree, drawn with connectors, plus successions underneath. */
export function Lineage({ agents, className, title = "Delegation and succession", sub = "A helper can only ever get less than its parent; a successor is a different grant with a different key" }:
  { agents: AgentView[]; className?: string; title?: string; sub?: string }) {
  const byParent = new Map<string, AgentView[]>();
  for (const a of agents) if (a.parent) byParent.set(a.parent, [...(byParent.get(a.parent) ?? []), a]);
  const kids = (p: AgentView) => byParent.get(p.label) ?? byParent.get(p.id) ?? [];
  const placed = new Set<string>();
  const roots = agents.filter((a) => !a.parent && kids(a).length);
  const walk = (a: AgentView) => { placed.add(a.key); kids(a).forEach(walk); };
  roots.forEach(walk);
  /** A helper whose parent is not in this scope still deserves a line. */
  const orphans = agents.filter((a) => a.parent && !placed.has(a.key));
  const succession = agents.filter((a) => a.replaced);
  if (!roots.length && !orphans.length && !succession.length) return null;

  const depth = Math.max(0, ...agents.filter((a) => a.parent).map(() => 1));
  return (
    <Card className={className}>
      <CardHeader
        title={<span className="flex items-center gap-2"><GitBranch className="size-4 text-accent" /> {title}</span>}
        sub={sub}
        action={roots.length ? <span className="num text-[12px] text-fg-3">{roots.length} parent{roots.length === 1 ? "" : "s"} · {agents.filter((a) => a.parent).length} helper{agents.filter((a) => a.parent).length === 1 ? "" : "s"}</span> : null}
      />
      {(roots.length > 0 || orphans.length > 0) && (
        <div className="px-3 pb-2 pr-4 pt-1">
          <ul>
            {roots.map((r, i) => <Node key={r.key} a={r} kids={kids} depth={0} last={i === roots.length - 1} />)}
            {orphans.map((o) => (
              <li key={o.key} className="relative pl-[44px]">
                <span aria-hidden className="absolute left-[25px] top-0 h-[25px] w-px bg-line-strong" />
                <span aria-hidden className="absolute left-[25px] top-[25px] h-px w-[26px] bg-line-strong" />
                <a href={href("agents", o.key)} className="group flex items-start gap-3 rounded-[11px] px-2.5 py-2.5 transition hover:bg-raised">
                  <AgentMark agent={o} size={30} className="rounded-[9px]" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-[13.5px] font-medium transition group-hover:text-accent">{name(o)}</span>
                      <StatusBadge status={o.status} />
                      <span className="text-[12px] text-fg-3">helper of <span className="text-fg-2">{o.parent}</span></span>
                    </div>
                    <Chips a={o} />
                  </div>
                  <BudgetRing a={o} size={34} width={4.5} bare className="mt-0.5 shrink-0" />
                </a>
              </li>
            ))}
          </ul>
          {depth > 0 && (
            <p className="flex items-center gap-1.5 px-2.5 pb-1 pt-2 text-[12px] text-fg-3">
              <ShieldCheck className="size-3.5 text-accent/80" /> Every line down is enforced by the covenant, not by the runner.
            </p>
          )}
        </div>
      )}
      {succession.length > 0 && (
        <div className="border-t border-line px-5 py-4">
          <div className="text-[12px] uppercase tracking-[0.06em] text-fg-3">Succession</div>
          <ul className="mt-2.5 space-y-2">
            {succession.map((a) => (
              <li key={a.key} className="flex flex-wrap items-center gap-2 text-[13px]">
                <span className="num rounded-md border border-line bg-raised px-2 py-1 text-fg-3 line-through decoration-fg-3/60">{a.replaced}</span>
                <ArrowRight className="size-3.5 text-fg-3" />
                <a href={href("agents", a.key)} className="num rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-fg transition hover:border-accent/60">{name(a)}</a>
                <span className="text-[12px] text-fg-3">new grant, new key — the old one stays refused</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
