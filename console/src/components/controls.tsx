import { useState } from "react";
import { Ban, Download, Receipt, RefreshCw, Search, Sparkle } from "lucide-react";
import { commandFor, SAY } from "@/lib/commands";
import { useWallet } from "@/lib/connect";
import type { AgentView } from "@/lib/model";
import { kas } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Card, CardHeader, Copy } from "./ui";

type K = "revoke" | "reclaim" | "topup" | "find";
const BTN: { k: K; label: string; sub: string; icon: typeof Ban; danger?: boolean }[] = [
  { k: "revoke", label: "Revoke now", sub: "the emergency stop · revocation key", icon: Ban, danger: true },
  { k: "reclaim", label: "Reclaim the remainder", sub: "after the term · principal key", icon: Download },
  { k: "topup", label: "Renew it", sub: "a successor grant, same limits · funder key", icon: RefreshCw },
  { k: "find", label: "Find it again", sub: "after it moved · no key", icon: Search },
];

/* This page signs nothing. A control is the command that does the thing, the
   key that must sign it, and whether the chain would allow it now. */
export function Controls({ a }: { a: AgentView }) {
  const { wallet } = useWallet();
  const [open, setOpen] = useState<K | null>(null);
  const ended = a.status === "ended";
  const why = (k: K) =>
    ended ? (k === "topup" ? "Issue a new grant instead." : "Already ended.")
    : k === "reclaim" && !a.expired ? `Only after the term ends${a.expiresIn ? ` — in ${a.expiresIn}` : ""}.` : "";
  const key = wallet?.family === "kaspa" ? wallet.key : null;
  const mine = key ? [a.ownerKey === key && "revoke it", a.principalKey === key && "reclaim it", a.principalKey === key && "renew it"].filter(Boolean) as string[] : [];
  const who = !key ? "Connect the Kaspa wallet that holds this grant's keys and this says which of these you can sign."
    : mine.length ? `Your connected key can ${mine.join(", ")}. Signing happens in the CLI on your machine; this page holds no key.`
    : "Your connected key is none of this grant's keys — whoever holds them runs these.";

  return (
    <Card>
      <CardHeader title="Controls" sub={who} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-2 p-5 sm:grid-cols-2">
        {BTN.map((b) => {
          const blocked = why(b.k);
          return (
            <button key={b.k} disabled={!!blocked} onClick={() => setOpen(open === b.k ? null : b.k)}
              className={cn("rounded-xl border p-3.5 text-left transition disabled:opacity-45",
                open === b.k ? "border-accent/50 bg-accent/[0.06]" : b.danger ? "border-bad/25 hover:bg-bad/[0.06]" : "border-line-strong hover:bg-raised/50")}>
              <div className={cn("flex items-center gap-2 text-[13.5px] font-medium", b.danger && !blocked && "text-bad")}><b.icon className="size-4" /> {b.label}</div>
              <div className="mt-1 text-[12px] text-fg-3">{blocked || b.sub}</div>
            </button>
          );
        })}
      </div>
      {open && (
        <div className="rise border-t border-line p-5">
          <div className="flex items-start rounded-lg border border-line-strong bg-bg">
            <pre className="num min-w-0 flex-1 overflow-x-auto whitespace-pre p-3 text-[12px] leading-relaxed text-fg-2">{commandFor(open, a.payees[0]?.address)}</pre>
            <Copy text={commandFor(open, a.payees[0]?.address)} className="m-1.5 shrink-0" label="Copy the command" />
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-fg-3">{SAY[open]} grant.json is this grant's manifest on your machine.</p>
        </div>
      )}
    </Card>
  );
}

/** What the covenant says was spent, against what the agent's own log names. */
export function Reconciliation({ a }: { a: AgentView }) {
  const r = a.reconciliation;
  if (!r || (r.spent === null && r.logged === null)) return null;
  const rows: [string, string, boolean?][] = [
    ["Spent, per the covenant", `${kas(r.spent)} KAS`],
    ["Named by its own log", `${kas(r.logged)} KAS`],
    ["Still visible at the payee", `${kas(r.atPayee)} KAS`],
    ...(r.chargedHome ? ([["Charged home by a helper", `${kas(r.chargedHome)} KAS`]] as [string, string][]) : []),
    ...(r.unrecorded && r.unrecorded > 0 ? ([["Unrecorded", `${kas(r.unrecorded)} KAS`, true]] as [string, string, boolean][]) : []),
    ...(r.overclaimed && r.overclaimed > 0 ? ([["Over-claimed by the log", `${kas(r.overclaimed)} KAS`, true]] as [string, string, boolean][]) : []),
  ];
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Receipt className="size-4 text-fg-3" /> Money against receipts</span>} sub="The only missing-money check there is" />
      <dl className="divide-y divide-line px-5 pb-2 pt-1">
        {rows.map(([k, v, bad]) => (
          <div key={k} className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className={cn("text-[13px]", bad ? "text-warn" : "text-fg-3")}>{k}</dt>
            <dd className={cn("num text-[13.5px]", bad ? "text-warn" : "text-fg")}>{v}</dd>
          </div>
        ))}
      </dl>
      {r.note && <p className="border-t border-line px-5 py-3 text-[12px] leading-relaxed text-fg-3">{r.note}</p>}
    </Card>
  );
}

/** Attempts that really happened and did not settle. Not rules — events. */
export function RealRefusals({ a }: { a: AgentView }) {
  if (!a.refused.length) return null;
  return (
    <Card>
      <CardHeader title="Attempts that did not settle" sub="Recorded by the agent at the moment it happened" />
      <ul className="mt-2 divide-y divide-line">
        {a.refused.map((d, i) => (
          <li key={i} className="px-5 py-4">
            <div className="flex items-center gap-2 text-[13.5px] font-medium"><Sparkle className="size-4 text-warn" /> {d.rule}<span className="font-normal text-fg-3">· {d.attempted}</span></div>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-3">{d.why}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
