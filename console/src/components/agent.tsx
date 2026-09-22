import { ArrowUpRight, Ban, CircleCheck, CircleAlert, Clock, Layers, ShieldCheck, Users, Gauge, Timer } from "lucide-react";
import type { AgentView, Payment } from "@/lib/model";
import { ruleWords } from "@/lib/model";
import { ago, kas, periodWords, short, dateTime } from "@/lib/format";
import { explorerTx } from "@/lib/kaspa";
import { href } from "@/lib/router";
import { cn } from "@/lib/cn";
import { Badge, Card, Kas, Meter, StatusBadge } from "./ui";

const HUES = [172, 200, 228, 262, 292, 330, 18, 42, 140];
function hash(s: string) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }

export function AgentMark({ agent, size = 36, className }: { agent: Pick<AgentView, "id" | "label" | "status">; size?: number; className?: string }) {
  const hue = HUES[hash(agent.id) % HUES.length]!;
  const ended = agent.status === "ended" || agent.status === "expired";
  const text = agent.label.replace(/^#/, "").slice(0, /^\d+$/.test(agent.id) ? 3 : 2).toUpperCase();
  return (
    <div
      className={cn("relative grid shrink-0 place-items-center rounded-[10px] font-semibold tracking-[-0.02em] text-white/95", ended && "opacity-45 grayscale", className)}
      style={{
        width: size, height: size, fontSize: size * (text.length > 2 ? 0.3 : 0.36),
        background: `linear-gradient(140deg, hsl(${hue} 70% 46%), hsl(${(hue + 40) % 360} 65% 28%))`,
        boxShadow: `inset 0 1px 0 rgba(255,255,255,.18), 0 0 0 1px hsl(${hue} 60% 40% / .5)`,
      }}
      aria-hidden
    >
      {text}
    </div>
  );
}

export function AgentCard({ a }: { a: AgentView }) {
  const blocked = a.payments.filter((p) => p.outcome === "blocked").length;
  return (
    <a href={href("agents", a.key)} className="group block focus-visible:outline-none">
      <Card interactive className="flex h-full flex-col p-5 group-focus-visible:border-accent">
        <div className="flex items-start gap-3">
          <AgentMark agent={a} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[15px] font-semibold">{a.source === "hosted" ? a.label : `Agent ${a.label}`}</span>
              {a.parent && <Badge className="h-5 px-1.5 text-[11px]">sub-agent</Badge>}
            </div>
            <div className="mt-0.5 line-clamp-1 text-[13px] text-fg-3">{a.mission ?? (a.source === "hosted" ? "Hosted agent" : "Published agent")}</div>
          </div>
          <StatusBadge status={a.status} />
        </div>

        <div className="mt-6 flex items-end justify-between gap-3">
          <div>
            <div className="text-[12px] text-fg-3">Spendable now</div>
            {a.remaining === null && a.status === "waiting" ? <span className="mt-1 block text-[20px] font-semibold leading-[26px] tracking-[-0.02em] text-fg-2">Not funded yet</span> : <Kas value={kas(a.status === "ended" ? 0 : a.remaining)} className="mt-1 block text-[26px] font-semibold leading-none tracking-[-0.03em]" />}
          </div>
          <div className="text-right text-[12px] text-fg-3">
            of <span className="num text-fg-2">{kas(a.budget)}</span> KAS
          </div>
        </div>
        <Meter className="mt-3" spent={a.spent} budget={a.budget} muted={a.status === "ended" || a.status === "expired" || a.remaining === null} />

        <div className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4 text-[12px]">
          <Mini label="Per payment" value={a.maxPerPayment === null ? "—" : `${kas(a.maxPerPayment)}`} />
          <Mini label="Payees" value={a.payees.length ? String(a.payees.length) : "—"} />
          <Mini label={a.status === "active" ? "Ends in" : "Last active"} value={a.status === "active" ? a.expiresIn ?? "—" : ago(a.lastActive)} />
        </div>

        <div className="mt-4 flex items-center justify-between text-[12px] text-fg-3">
          <span className="flex items-center gap-1.5">
            {blocked > 0 ? <><Ban className="size-3.5 text-bad/80" /> {blocked} blocked</> : <><ShieldCheck className="size-3.5 text-accent/80" /> Enforced on-chain</>}
          </span>
          <span className="flex items-center gap-1 transition group-hover:text-fg-2">Open <ArrowUpRight className="size-3.5" /></span>
        </div>
      </Card>
    </a>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-fg-3">{label}</div>
      <div className="num mt-1 truncate text-[13px] text-fg">{value}</div>
    </div>
  );
}

/** The one block that says what this agent may do. Every line is a rule the covenant checks. */
export function AuthorityBlock({ a }: { a: AgentView }) {
  const ended = a.status === "ended";
  const rules = [
    { icon: Gauge, label: "Max per payment", value: a.maxPerPayment === null ? "—" : `${kas(a.maxPerPayment)} KAS`, note: "Any single payment above this is refused." },
    { icon: Timer, label: "Limit per period", value: a.periodLimit === null ? "—" : `${kas(a.periodLimit)} KAS / ${periodWords(a.periodSeconds)}`, note: a.periodSeconds ? `The period is ${Math.round(a.periodSeconds * 10).toLocaleString("en-US")} DAA of network time (about ${periodWords(a.periodSeconds)}).` : "Resets with network time." },
    { icon: Users, label: "Allowed payees", value: a.payees.length ? `${a.payees.length} address${a.payees.length === 1 ? "" : "es"}` : "—", note: "Fixed when the grant was made. Nobody else can be paid." },
    { icon: Layers, label: "Sub-agents", value: a.delegationDepth === null ? "—" : a.delegationDepth === 0 ? "Not allowed" : `Up to ${a.delegationDepth} level${a.delegationDepth === 1 ? "" : "s"}`, note: "A sub-agent can only get less than its parent." },
    ended || a.expired
      ? { icon: Clock, label: "Term", value: ended ? "Ended early" : "Term is over", note: a.statusNote ?? "The grant refuses every spend now." }
      : { icon: Clock, label: a.opensIn ? "Opens in" : "Ends in", value: a.opensIn ?? a.expiresIn ?? "—", note: "After this, the grant refuses every spend." },
  ];
  return (
    <Card className="overflow-hidden">
      <div className="relative p-6">
        <div aria-hidden className="pointer-events-none absolute -top-24 right-0 h-48 w-72 rounded-full bg-accent/10 blur-3xl" />
        <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-[13px] text-fg-3"><ShieldCheck className="size-4 text-accent" /> Spending authority</div>
            <div className="mt-3 flex items-baseline gap-3">
              <Kas value={kas(ended ? 0 : a.remaining)} className="text-[44px] font-semibold leading-none tracking-[-0.04em]" />
            </div>
            <div className="mt-2 text-[13px] text-fg-3">
              {ended ? a.statusNote ?? "This grant has ended." : <>spendable now, of a <span className="num text-fg-2">{kas(a.budget)} KAS</span> budget</>}
            </div>
          </div>
          <div className="grid grid-cols-3 gap-6 text-[13px] lg:min-w-[380px]">
            <Legend color="bg-fg-3/60" label="Spent" value={kas(a.spent)} />
            <Legend color="bg-accent" label="Left" value={kas(ended ? 0 : a.remaining)} />
            <Legend color="bg-line-strong" label="On-chain" value={kas(a.onChain)} />
          </div>
        </div>
        <Meter className="relative mt-6" height={8} spent={a.spent} budget={a.budget} muted={ended || a.expired} />
      </div>
      <div className="grid border-t border-line sm:grid-cols-2 lg:grid-cols-5">
        {rules.map((r, i) => (
          <div key={r.label} className={cn("p-5", i > 0 && "border-t border-line sm:border-t-0", i % 2 === 1 && "sm:border-l", i >= 2 && "sm:border-t lg:border-t-0", i > 0 && "lg:border-l")}>
            <div className="flex items-center gap-2 text-[12px] text-fg-3"><r.icon className="size-3.5" /> {r.label}</div>
            <div className="num mt-2 text-[15px] font-medium text-fg">{r.value}</div>
            <div className="mt-1.5 text-[12px] leading-snug text-fg-3">{r.note}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-fg-3"><span className={cn("size-2 rounded-full", color)} /> {label}</div>
      <div className="num mt-1.5 text-[15px] text-fg">{value}<span className="ml-1 text-[11px] text-fg-3">KAS</span></div>
    </div>
  );
}

const OUT: Record<Payment["outcome"], { icon: typeof CircleCheck; tone: string; words: string }> = {
  paid: { icon: CircleCheck, tone: "text-ok", words: "Paid" },
  blocked: { icon: Ban, tone: "text-bad", words: "Blocked" },
  failed: { icon: CircleAlert, tone: "text-warn", words: "Not sent" },
  "paid-not-served": { icon: CircleAlert, tone: "text-warn", words: "Paid, not served" },
};

export function ActivityList({ rows, showAgent, empty }: { rows: { p: Payment; a: AgentView }[]; showAgent?: boolean; empty?: React.ReactNode }) {
  if (!rows.length) return <>{empty}</>;
  return (
    <ul className="divide-y divide-line">
      {rows.map(({ p, a }, i) => {
        const o = OUT[p.outcome];
        return (
          <li key={`${a.key}-${p.at}-${i}`} className="flex items-center gap-3 px-5 py-3.5 transition hover:bg-raised/40">
            <o.icon className={cn("size-[18px] shrink-0", o.tone)} strokeWidth={1.8} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px]">
                <span className="font-medium">{p.outcome === "blocked" ? ruleWords(p.rule) : o.words}</span>
                {showAgent && <a href={href("agents", a.key)} className="truncate text-fg-3 hover:text-fg-2">{a.source === "hosted" ? a.label : `Agent ${a.label}`}</a>}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-fg-3">{p.host ?? (p.payTo ? short(p.payTo, 14, 6) : "—")} · {dateTime(p.at)}</div>
            </div>
            <div className="text-right">
              {p.amount !== null && <div className={cn("num text-[13.5px]", p.outcome === "blocked" ? "text-fg-3 line-through" : "text-fg")}>−{kas(p.amount)} <span className="text-[11px] text-fg-3">KAS</span></div>}
              {p.txid ? (
                <a href={explorerTx(p.txid, a.network)} target="_blank" rel="noopener" className="num text-[11.5px] text-fg-3 hover:text-accent">{p.txid.slice(0, 8)}…</a>
              ) : <div className="text-[11.5px] text-fg-3">{p.outcome === "blocked" ? "never broadcast" : ""}</div>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A real attempt the network refused: the proof that the limits hold. */
export function BlockedCard({ p, a }: { p: Payment; a: AgentView }) {
  return (
    <div className="rounded-xl border border-bad/20 bg-gradient-to-b from-bad/[0.06] to-transparent p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[13.5px] font-medium"><Ban className="size-4 text-bad" /> {ruleWords(p.rule)}</div>
        <span className="text-[12px] text-fg-3">{ago(p.at)}</span>
      </div>
      <div className="mt-1 text-[12px] text-fg-3">{a.source === "hosted" ? a.label : `Agent ${a.label}`}{p.host ? ` · ${p.host}` : ""}</div>
      {p.why && <p className="mt-3 line-clamp-3 text-[12.5px] leading-relaxed text-fg-2">{p.why}</p>}
    </div>
  );
}
