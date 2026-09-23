import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Boxes, Radar, BookOpen, Send, KeyRound, KeySquare, ExternalLink, ShieldCheck } from "lucide-react";
import { useData } from "@/lib/data";
import { href } from "@/lib/router";
import { explorerTx } from "@/lib/kaspa";
import { cn } from "@/lib/cn";
import { Card, CardHeader } from "./ui";
import { Ring, SERIES } from "./charts";

/* Warda's own weekly loop, as it ran: an orchestrator that may pay only its
   scout, a scout that buys one record at a time, a researcher that sells
   facts, and outreach that holds no key at all. Shown with the examples. */
interface Growth { label: string; network?: string; schedule?: string; candidates?: number; bought?: number; spentKas?: string; drafts?: number; noDraft?: number; sent?: number; orchestrator?: string; scout?: string; researcher?: { url?: string; price?: string }; transactions?: { step: string; txid: string }[] }

interface Stage { key: string; name: string; id?: string; icon: typeof Boxes; rule: string; figure: ReactNode; keyed: boolean; url?: string; external?: boolean }

export function GrowthFleet() {
  const { scope, agents } = useData();
  const [g, setG] = useState<Growth | null>(null);
  useEffect(() => { fetch("/growth.json").then((r) => (r.ok ? r.json() : null)).then(setG).catch(() => {}); }, []);
  if (!g || scope !== "warda") return null;

  const tx = Object.fromEntries((g.transactions ?? []).map((t) => [t.step, t.txid]));
  const agentOf = (id?: string) => agents.find((a) => a.id === id);
  const found = g.candidates ?? 0, bought = g.bought ?? 0, drafts = g.drafts ?? 0, sent = g.sent ?? 0;
  const orch = agentOf(g.orchestrator ?? "009"), scout = agentOf(g.scout ?? "010");

  const stages: Stage[] = [
    { key: "orchestrator", name: "Orchestrator", id: g.orchestrator ?? "009", icon: Boxes, rule: "A batch grant that may pay one address: the scout.", figure: <>{found} project{found === 1 ? "" : "s"} found</>, keyed: true, url: orch ? href("agents", orch.key) : undefined },
    { key: "scout", name: "Scout", id: g.scout ?? "010", icon: Radar, rule: "One payee, one record's price per payment.", figure: <>{bought} record{bought === 1 ? "" : "s"} bought · {g.spentKas ?? "0"} KAS</>, keyed: true, url: scout ? href("agents", scout.key) : undefined },
    { key: "researcher", name: "Researcher", icon: BookOpen, rule: "Sells facts with sources, paid per record.", figure: <>{g.researcher?.price ?? "priced per record"}</>, keyed: false, url: g.researcher?.url, external: true },
    { key: "outreach", name: "Outreach", icon: Send, rule: "Holds no grant and no key. A person sends.", figure: <>{drafts} draft{drafts === 1 ? "" : "s"} to read · {sent} sent</>, keyed: false },
  ];

  const funnel = [
    { label: "Projects found", value: found, color: SERIES[2]! },
    { label: "Records bought", value: bought, color: SERIES[0]! },
    { label: "Drafts to read", value: drafts, color: SERIES[3]! },
    { label: "Messages sent", value: sent, color: SERIES[6]! },
  ];
  const top = Math.max(1, ...funnel.map((f) => f.value));
  const conv = found > 0 ? (bought / found) * 100 : 0;
  const drafted = bought > 0 ? (drafts / bought) * 100 : 0;

  return (
    <Card className="mt-4 overflow-hidden">
      <CardHeader
        title={<span className="flex items-center gap-2">Warda's own growth loop</span>}
        sub={`${g.label}${g.network ? ` · ${g.network}` : ""}`}
        action={<span className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-raised px-2.5 py-1 text-[11.5px] text-fg-2">
          <span className="relative flex size-1.5"><span className="absolute inline-flex size-full animate-ping rounded-full bg-accent opacity-60" /><span className="relative inline-flex size-1.5 rounded-full bg-accent" /></span>
          runs {g.schedule ?? "weekly"}
        </span>}
      />

      <div className="relative flex flex-col items-stretch gap-0 px-5 pb-1 pt-2 lg:flex-row lg:items-stretch">
        {stages.map((s, i) => (
          <div key={s.key} className="flex flex-1 flex-col items-stretch lg:contents">
            <StageCard s={s} i={i} />
            {i < stages.length - 1 && (
              <div className="flex shrink-0 items-center justify-center py-1 lg:px-1.5 lg:py-0">
                <span className="grid size-6 place-items-center rounded-full border border-line-strong bg-raised text-fg-3">
                  <ChevronRight className="size-3.5 rotate-90 lg:rotate-0" />
                </span>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 border-t border-line px-5 py-5 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div>
          <div className="text-[11.5px] uppercase tracking-[0.07em] text-fg-3">What one run produced</div>
          <ul className="mt-3 space-y-2.5">
            {funnel.map((f) => (
              <li key={f.label} className="grid grid-cols-[minmax(0,118px)_minmax(0,1fr)_auto] items-center gap-3" title={`${f.label}: ${f.value}`}>
                <span className="truncate text-[12.5px] text-fg-2">{f.label}</span>
                <span className="h-[9px] w-full overflow-hidden rounded-[4px] bg-raised">
                  <span className="block h-full rounded-[4px]" style={{ width: `${Math.max(f.value > 0 ? 2 : 0, (f.value / top) * 100)}%`, background: f.color, transition: "width .6s cubic-bezier(.3,.7,.3,1)" }} />
                </span>
                <span className="num text-[13px] text-fg">{f.value}</span>
              </li>
            ))}
          </ul>
          {g.noDraft ? <p className="mt-3 text-[12px] text-fg-3"><span className="num text-fg-2">{g.noDraft}</span> bought records led to no draft — the scout paid, the loop still said no.</p> : null}
        </div>
        <div className="flex items-center justify-center gap-6 lg:justify-end lg:border-l lg:border-line lg:pl-6 lg:pr-1">
          <div className="text-center">
            <Ring pct={conv} size={76} width={8} sub="bought" title={`${Math.round(conv)}% of the projects found were worth buying a record for`} />
            <div className="mt-2 text-[11.5px] text-fg-3">of found</div>
          </div>
          <div className="text-center">
            <Ring pct={drafted} size={76} width={8} sub="drafted" title={`${Math.round(drafted)}% of bought records became a draft`} />
            <div className="mt-2 text-[11.5px] text-fg-3">of bought</div>
          </div>
        </div>
      </div>

      <div className="border-t border-line px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11.5px] uppercase tracking-[0.07em] text-fg-3">On chain</span>
          {["genesis", "hire", "settle", "revoke"].map((k) => (
            tx[k]
              ? <a key={k} href={explorerTx(tx[k]!)} target="_blank" rel="noopener" className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-raised px-2.5 py-1 text-[12px] transition hover:border-accent/50 hover:text-accent">
                  {k} <span className="num text-fg-3">{tx[k]!.slice(0, 8)}…</span><ExternalLink className="size-3" />
                </a>
              : <span key={k} className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-line-strong px-2.5 py-1 text-[12px] text-fg-3">{k} —</span>
          ))}
        </div>
        <p className="mt-3 flex items-start gap-1.5 text-[12px] leading-relaxed text-fg-3">
          <ShieldCheck className="mt-px size-3.5 shrink-0 text-accent/80" />
          The authority is real and enforced by the covenant; the money is testnet, and both ends are Warda's.
        </p>
      </div>
    </Card>
  );
}

function StageCard({ s, i }: { s: Stage; i: number }) {
  const Icon = s.icon;
  const inner = (
    <>
      <div className="flex items-center gap-2">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-[9px]", s.keyed ? "bg-accent/12 text-accent" : "bg-raised text-fg-2")}><Icon className="size-3.5" /></span>
        <span className="truncate text-[13px] font-medium">{s.name}</span>
        {s.id && <span className="num text-[11px] text-fg-3">#{s.id}</span>}
        <span className="num ml-auto text-[11px] text-fg-3">{i + 1}</span>
      </div>
      <p className="mt-2.5 text-[11.5px] leading-snug text-fg-3">{s.rule}</p>
      <div className="num mt-2.5 text-[12.5px] text-fg-2">{s.figure}</div>
      <div className="mt-2.5 flex items-center gap-1.5 text-[11px] text-fg-3">
        {s.keyed ? <><KeyRound className="size-3 text-accent/70" /> holds a grant</> : <><KeySquare className="size-3" /> no key</>}
        {s.external && <ExternalLink className="ml-auto size-3" />}
      </div>
    </>
  );
  const klass = cn(
    "flex min-w-0 flex-1 flex-col rounded-[13px] p-3.5 transition",
    s.keyed ? "border border-line-strong bg-raised/40" : "border border-dashed border-line-strong",
    s.url && "hover:border-accent/40 hover:bg-raised/70",
  );
  return s.url
    ? <a href={s.url} {...(s.external ? { target: "_blank", rel: "noopener" } : {})} className={klass}>{inner}</a>
    : <div className={klass}>{inner}</div>;
}
