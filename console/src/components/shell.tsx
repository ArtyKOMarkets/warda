import { useEffect, useState, type ReactNode } from "react";
import {
  LayoutGrid, Bot, FileKey2, Activity, BarChart3, Plus, Wallet, Store, UserRound, BellRing, Menu, X, RefreshCw, ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { href } from "@/lib/router";
import { useData } from "@/lib/data";
import { ago } from "@/lib/format";

type Item = { id: string; label: string; icon: typeof Bot; to?: string; classic?: string };
const NAV: { title: string; items: Item[] }[] = [
  { title: "Workspace", items: [
    { id: "overview", label: "Overview", icon: LayoutGrid },
    { id: "agents", label: "Agents", icon: Bot },
    { id: "grants", label: "Grants", icon: FileKey2 },
    { id: "activity", label: "Activity", icon: Activity },
    { id: "analytics", label: "Analytics", icon: BarChart3 },
  ] },
  { title: "Build", items: [
    { id: "new", label: "New agent", icon: Plus },
    { id: "fund", label: "Fund", icon: Wallet },
  ] },
  { title: "Network", items: [{ id: "services", label: "Services", icon: Store }] },
  { title: "Settings", items: [
    { id: "account", label: "Account", icon: UserRound },
    { id: "alerts", label: "Alerts", icon: BellRing, classic: "alerts" },
  ] },
];

function Logo() {
  return (
    <a href={href("overview")} className="flex items-center gap-2.5 px-2">
      <img src="/assets/mark-200.png" alt="" className="size-7 rounded-lg" />
      <span className="text-[15px] font-semibold tracking-[-0.02em]">Warda</span>
      <span className="rounded-md border border-line-strong px-1.5 py-px text-[10.5px] font-medium text-fg-3">Console</span>
    </a>
  );
}

function Nav({ active, onPick }: { active: string; onPick?: () => void }) {
  const { agents, runner } = useData();
  const counts: Record<string, number> = { agents: agents.length };
  return (
    <nav className="flex flex-col gap-6">
      {NAV.map((g) => (
        <div key={g.title}>
          <div className="mb-1.5 px-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-fg-3/80">{g.title}</div>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((it) => {
              const on = active === it.id;
              const warn = it.id === "account" && !runner.key;
              return (
                <li key={it.id}>
                  <a href={href(it.id)} onClick={onPick}
                    className={cn("group relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[13.5px] font-medium transition",
                      on ? "bg-raised text-fg" : "text-fg-2 hover:bg-raised/60 hover:text-fg")}>
                    {on && <span className="absolute -left-3 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent" />}
                    <it.icon className={cn("size-4", on ? "text-accent" : "text-fg-3 group-hover:text-fg-2")} strokeWidth={1.8} />
                    <span className="flex-1">{it.label}</span>
                    {counts[it.id] ? <span className="num text-[11px] text-fg-3">{counts[it.id]}</span> : null}
                    {warn && <span className="size-1.5 rounded-full bg-warn" title="Not signed in to the runner" />}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function NetworkPill() {
  return (
    <span className="inline-flex h-7 items-center gap-2 rounded-full border border-line-strong bg-surface px-2.5 text-[12px] font-medium text-fg-2">
      <span className="relative flex size-2"><span className="absolute inset-0 animate-ping rounded-full bg-ok/60" /><span className="relative size-2 rounded-full bg-ok" /></span>
      Kaspa testnet-10
    </span>
  );
}

export function Shell({ active, children }: { active: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { reload, loading, updatedAt } = useData();
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; }, [open]);

  return (
    <div className="min-h-full">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-line bg-[#0a0b0e] lg:flex">
        <div className="flex h-16 items-center px-4"><Logo /></div>
        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2"><Nav active={active} /></div>
        <div className="border-t border-line p-4">
          <a href="/app" className="flex items-center justify-between rounded-lg px-2.5 py-2 text-[12.5px] text-fg-3 transition hover:bg-raised hover:text-fg-2">
            Classic console <ExternalLink className="size-3.5" />
          </a>
        </div>
      </aside>

      {/* Mobile drawer */}
      <div className={cn("fixed inset-0 z-40 lg:hidden", open ? "pointer-events-auto" : "pointer-events-none")}>
        <div className={cn("absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity", open ? "opacity-100" : "opacity-0")} onClick={() => setOpen(false)} />
        <aside className={cn("absolute inset-y-0 left-0 flex w-[280px] flex-col border-r border-line bg-[#0a0b0e] transition-transform duration-200", open ? "translate-x-0" : "-translate-x-full")}>
          <div className="flex h-14 items-center justify-between px-4"><Logo /><button className="grid size-9 place-items-center rounded-lg text-fg-2 hover:bg-raised" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button></div>
          <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2"><Nav active={active} onPick={() => setOpen(false)} /></div>
          <div className="border-t border-line p-4"><a href="/app" className="text-[12.5px] text-fg-3">Classic console</a></div>
        </aside>
      </div>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-bg/80 px-4 backdrop-blur-xl sm:px-6 lg:h-16 lg:px-10">
          <button className="-ml-1 grid size-9 place-items-center rounded-lg text-fg-2 hover:bg-raised lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu"><Menu className="size-5" /></button>
          <div className="lg:hidden"><Logo /></div>
          <div className="flex-1" />
          <span className="hidden text-[12px] text-fg-3 sm:inline">{updatedAt ? `Updated ${ago(updatedAt)}` : ""}</span>
          <button onClick={reload} className="grid size-8 place-items-center rounded-lg text-fg-3 transition hover:bg-raised hover:text-fg" aria-label="Refresh" title="Refresh">
            <RefreshCw className={cn("size-4", loading && "animate-spin")} />
          </button>
          <div className="hidden sm:block"><NetworkPill /></div>
        </header>
        <main className="mx-auto w-full max-w-[1240px] px-4 pb-24 pt-8 sm:px-6 lg:px-10 lg:pt-10">{children}</main>
      </div>
    </div>
  );
}
