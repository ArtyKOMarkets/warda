import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  LayoutGrid, Bot, FileKey2, Activity, BarChart3, Plus, Wallet, Store, UserRound, BellRing, Menu, X, RefreshCw, Check, ChevronDown, Unplug, KeyRound, Search, Layers,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { href } from "@/lib/router";
import { useCounts, useData } from "@/lib/data";
import { useWallet } from "@/lib/connect";
import { ScopeSwitch } from "./scope";
import { short } from "@/lib/format";
import { ago } from "@/lib/format";

type Item = { id: string; label: string; icon: typeof Bot; to?: string; classic?: string };
const NAV: { title: string; items: Item[] }[] = [
  { title: "Workspace", items: [
    { id: "overview", label: "Overview", icon: LayoutGrid },
    { id: "agents", label: "Agents", icon: Bot },
    { id: "fleet", label: "Fleet", icon: Layers },
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
    { id: "alerts", label: "Alerts", icon: BellRing },
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
  const { runner } = useData();
  const counts = useCounts();
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
                    className={cn("group relative flex h-11 items-center gap-2.5 rounded-lg px-2.5 text-[14px] font-medium transition lg:h-8 lg:text-[13.5px]",
                      on ? "bg-raised text-fg" : "text-fg-2 hover:bg-raised/60 hover:text-fg")}>
                    {on && <span className="absolute -left-3 top-1.5 bottom-1.5 w-[2px] rounded-full bg-accent" />}
                    <it.icon className={cn("size-4", on ? "text-accent" : "text-fg-3 group-hover:text-fg-2")} strokeWidth={1.8} />
                    <span className="flex-1">{it.label}</span>
                    {/* A pill rather than bare digits: the number sits at the
                        end of a row of words and needs an edge to stop being
                        read as part of the label. `bg-line` rather than
                        `bg-raised` so it still separates from the row's own
                        hover and active backgrounds, which are raised.
                        Null means nothing was read — see useCounts. */}
                    {counts[it.id] !== null && counts[it.id] !== undefined && (
                      <span className={cn("num rounded-md px-1.5 py-px text-[11px] leading-[1.45] tabular-nums",
                        on ? "bg-accent/15 text-accent" : "bg-line text-fg-3 group-hover:text-fg-2")}>
                        {counts[it.id]}
                      </span>
                    )}
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

/* One network today. Mainnet is listed and not selectable: the covenant is
   the same, the audit is not done, and a console that quietly reads mainnet
   would be showing grants nobody should make yet. */
function NetworkPill() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}
        className="inline-flex h-7 items-center gap-2 rounded-full border border-line-strong bg-surface px-2.5 text-[12px] font-medium text-fg-2 transition hover:text-fg">
        <span className="relative flex size-2"><span className="absolute inset-0 animate-ping rounded-full bg-ok/60" /><span className="relative size-2 rounded-full bg-ok" /></span>
        Kaspa testnet-10
        <ChevronDown className={cn("size-3.5 text-fg-3 transition", open && "rotate-180")} />
      </button>
      {open && (
        <ul role="listbox" className="rise absolute right-0 z-40 mt-1.5 w-64 rounded-xl border border-line-strong bg-raised p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,.7)]">
          <li role="option" aria-selected className="flex items-center gap-2 rounded-lg bg-hover px-2.5 py-2 text-[13px]">
            <span className="size-2 rounded-full bg-ok" /><span className="flex-1">Kaspa testnet-10</span><Check className="size-4 text-accent" />
          </li>
          <li role="option" aria-selected={false} aria-disabled className="flex cursor-not-allowed items-start gap-2 rounded-lg px-2.5 py-2 text-[13px] text-fg-3">
            <span className="mt-1.5 size-2 rounded-full bg-line-strong" />
            <span><span className="block">Kaspa mainnet</span><span className="block text-[11.5px]">when the covenant is audited — real money will not be read from an unaudited console</span></span>
          </li>
        </ul>
      )}
    </div>
  );
}

/* What the chain was at when these readings were taken. A DAA score is the
   only clock the covenant has, so it is the one worth showing. */
function StatusBar() {
  const { agents, readAt } = useData();
  const daa = agents.map((a) => a.daaNow).filter((x): x is number => !!x).sort((a, b) => b - a)[0] ?? null;
  const net = agents[0]?.network ?? "testnet-10";
  return (
    <div className="mx-auto mb-10 w-full max-w-[1240px] px-4 text-[11.5px] text-fg-3 sm:px-6 lg:px-10">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-3">
        <span>Kaspa {net}</span>
        {daa && <span className="num">virtual DAA {daa.toLocaleString("en-US")}</span>}
        {readAt && <span>read {ago(readAt)}</span>}
        <span className="flex-1" />
        <span>This page holds no key and signs nothing.</span>
      </div>
    </div>
  );
}

function WalletFoot({ onPick }: { onPick?: () => void }) {
  const { wallet, forget } = useWallet();
  if (!wallet) return (
    <a href={href("account", "wallet")} onClick={onPick} className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] font-medium text-fg-2 transition hover:bg-raised hover:text-fg">
      <KeyRound className="size-4 text-fg-3" /> Connect a wallet
    </a>
  );
  return (
    <div className="rounded-lg px-2.5 py-2">
      <a href={href("account", "wallet")} onClick={onPick} className="flex items-center gap-2"><span className={cn("size-2 shrink-0 rounded-full", wallet.problem ? "bg-warn" : "bg-accent")} /><span className="num min-w-0 flex-1 truncate text-[12px] text-fg-2">{short(wallet.address, 10, 4)}</span></a>
      <button onClick={() => { forget(); onPick?.(); }} className="mt-1.5 flex items-center gap-1.5 text-[12px] text-fg-3 transition hover:text-fg"><Unplug className="size-3.5" /> Disconnect</button>
    </div>
  );
}

function WalletChip() {
  const { wallet } = useWallet();
  return wallet ? (
    <a href={href("account", "wallet")} aria-label="Your wallet" className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-line-strong bg-surface px-2.5 text-[12px] font-medium text-fg-2 transition hover:text-fg sm:h-7">
      <span className={cn("size-2 shrink-0 rounded-full", wallet.problem ? "bg-warn" : "bg-accent")} />
      <span className="num sm:hidden">{short(wallet.address, wallet.family === "evm" ? 6 : 6, 4)}</span>
      <span className="num hidden sm:inline">{short(wallet.address, wallet.family === "evm" ? 6 : 14, 4)}</span>
    </a>
  ) : (
    <a href={href("account", "wallet")} className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full border border-line-strong px-3 text-[12px] font-medium text-fg-2 transition hover:border-accent/50 hover:text-fg sm:h-7">Connect<span className="hidden sm:inline">&nbsp;wallet</span></a>
  );
}


/* On a phone the five places you actually go live at the thumb, not behind a
   hamburger. Everything else stays one tap away under More. */
const TABS: { id: string; label: string; icon: typeof Bot }[] = [
  { id: "overview", label: "Overview", icon: LayoutGrid },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "fleet", label: "Fleet", icon: Layers },
  { id: "activity", label: "Activity", icon: Activity },
];

function BottomBar({ active, onMore }: { active: string; onMore: () => void }) {
  const more = !TABS.some((t) => t.id === active);
  return (
    <nav aria-label="Main" className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
      <ul className="mx-auto flex max-w-lg">
        {TABS.map((t) => {
          const on = active === t.id;
          return (
            <li key={t.id} className="flex-1">
              <a href={href(t.id)} aria-current={on ? "page" : undefined}
                className={cn("flex h-[54px] flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition", on ? "text-accent" : "text-fg-3")}>
                <t.icon className="size-[18px]" strokeWidth={on ? 2.2 : 1.8} />
                {t.label}
              </a>
            </li>
          );
        })}
        <li className="flex-1">
          <button onClick={onMore} aria-label="More"
            className={cn("flex h-[54px] w-full flex-col items-center justify-center gap-1 text-[10.5px] font-medium transition", more ? "text-accent" : "text-fg-3")}>
            <Menu className="size-[18px]" strokeWidth={more ? 2.2 : 1.8} />
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}

export function Shell({ active, children }: { active: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [hunt, setHunt] = useState(false);
  const { reload, loading, readAt, missing, range, setRange, filter, setFilter } = useData();
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = document.activeElement;
      if (e.key === "/" && !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) { e.preventDefault(); box.current?.focus(); }
      if (e.key === "Escape" && document.activeElement === box.current) { setFilter(""); box.current?.blur(); }
    };
    addEventListener("keydown", on);
    return () => removeEventListener("keydown", on);
  }, [setFilter]);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => { document.body.style.overflow = open ? "hidden" : ""; }, [open]);

  return (
    <div className="min-h-full">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-line bg-[#0a0b0e] lg:flex">
        <div className="flex h-16 items-center px-4"><Logo /></div>
        <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2"><Nav active={active} /></div>
        <div className="border-t border-line p-4"><WalletFoot /></div>
      </aside>

      {/* Mobile drawer */}
      <div className={cn("fixed inset-0 z-40 lg:hidden", open ? "pointer-events-auto" : "pointer-events-none")}>
        <div className={cn("absolute inset-0 bg-black/60 backdrop-blur-sm transition-opacity", open ? "opacity-100" : "opacity-0")} onClick={() => setOpen(false)} />
        <aside className={cn("absolute inset-y-0 left-0 flex w-[280px] flex-col border-r border-line bg-[#0a0b0e] transition-transform duration-200", open ? "translate-x-0" : "-translate-x-full")}>
          <div className="flex h-14 items-center justify-between px-4"><Logo /><button className="grid size-9 place-items-center rounded-lg text-fg-2 hover:bg-raised" onClick={() => setOpen(false)} aria-label="Close menu"><X className="size-5" /></button></div>
          <div className="flex-1 overflow-y-auto px-4 pb-6 pt-2"><Nav active={active} onPick={() => setOpen(false)} /></div>
          <div className="border-t border-line p-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
            <div className="mb-2 flex items-center gap-2 px-2.5 text-[12px] text-fg-3"><span className="size-2 rounded-full bg-ok" /> Kaspa testnet-10</div>
            <WalletFoot onPick={() => setOpen(false)} />
          </div>
        </aside>
      </div>

      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/85 backdrop-blur-xl">
          <div className="flex h-14 items-center gap-3 px-4 sm:px-6 lg:h-16 lg:px-10">
            <div className="lg:hidden"><Logo /></div>
            <label className="relative ml-1 hidden min-w-0 flex-1 items-center sm:flex">
              <Search className="pointer-events-none absolute left-2.5 size-3.5 text-fg-3" />
              <input ref={box} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by agent, payee, address or endpoint  ( / )"
                className="h-8 w-full max-w-sm rounded-lg border border-line-strong bg-surface pl-8 pr-3 text-[12.5px] placeholder:text-fg-3 focus:border-accent/60 focus:outline-none" />
              {filter && <button onClick={() => setFilter("")} aria-label="Clear the filter" className="absolute right-2 text-fg-3 hover:text-fg"><X className="size-3.5" /></button>}
            </label>
            <div className="flex-1 sm:hidden" />
            <div className="hidden rounded-lg border border-line-strong bg-surface p-0.5 md:flex">
              {(["7", "30", "all"] as const).map((r) => (
                <button key={r} onClick={() => setRange(r)} className={cn("h-7 rounded-md px-2 text-[12px] font-medium transition", range === r ? "bg-raised text-fg" : "text-fg-3 hover:text-fg-2")}>
                  {r === "all" ? "All" : `${r}d`}
                </button>
              ))}
            </div>
            <span className={cn("hidden text-[12px] sm:inline", missing ? "text-bad" : "text-fg-3")} title={readAt ? `Chain read ${new Date(readAt).toLocaleString("en-US")}` : ""}>
              {missing ? `${missing} reading${missing === 1 ? "" : "s"} did not load` : readAt ? `Read ${ago(readAt)}` : ""}
            </span>
            <button onClick={reload} className="grid size-9 place-items-center rounded-lg text-fg-3 transition hover:bg-raised hover:text-fg sm:size-8" aria-label="Refresh" title="Refresh">
              <RefreshCw className={cn("size-4", loading && "animate-spin")} />
            </button>
            <ScopeSwitch className="hidden md:flex" />
            <div className="hidden sm:block"><NetworkPill /></div>
            <WalletChip />
          </div>

          {/* Phones get the same controls on their own line, where a thumb can
              reach them. The filter takes the whole line while it is in use. */}
          <div className="flex items-center gap-2 px-4 pb-2.5 md:hidden">
            {hunt || filter ? (
              <>
                <label className="relative flex min-w-0 flex-1 items-center">
                  <Search className="pointer-events-none absolute left-2.5 size-4 text-fg-3" />
                  <input autoFocus={hunt} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter agents, payees, endpoints"
                    className="h-9 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-3 text-[13px] placeholder:text-fg-3 focus:border-accent/60 focus:outline-none" />
                </label>
                <button onClick={() => { setFilter(""); setHunt(false); }} className="h-9 shrink-0 px-1 text-[13px] font-medium text-fg-2">Cancel</button>
              </>
            ) : (
              <>
                <div className="flex shrink-0 rounded-lg border border-line-strong bg-surface p-0.5">
                  {(["7", "30", "all"] as const).map((r) => (
                    <button key={r} onClick={() => setRange(r)} className={cn("h-8 rounded-md px-3 text-[12.5px] font-medium transition", range === r ? "bg-raised text-fg" : "text-fg-3")}>
                      {r === "all" ? "All" : `${r}d`}
                    </button>
                  ))}
                </div>
                <ScopeSwitch className="shrink-0" />
                <span className="flex-1" />
                <button onClick={() => setHunt(true)} aria-label="Filter"
                  className="grid size-9 shrink-0 place-items-center rounded-lg border border-line-strong bg-surface text-fg-3"><Search className="size-4" /></button>
              </>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1240px] px-4 pb-8 pt-6 sm:px-6 sm:pt-8 lg:px-10 lg:pt-10">{children}</main>
        <StatusBar />
        <div aria-hidden className="h-[54px] pb-[env(safe-area-inset-bottom)] lg:hidden" />
        <BottomBar active={active} onMore={() => setOpen(true)} />
      </div>
    </div>
  );
}
