import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useData } from "@/lib/data";
import { href } from "@/lib/router";
import { explorerTx } from "@/lib/kaspa";
import { Card, CardHeader } from "./ui";

/* Warda's own weekly loop, as it ran: an orchestrator that may pay only its
   scout, a scout that buys one record at a time, a researcher that sells
   facts, and outreach that holds no key at all. Shown with the examples. */
interface Growth { label: string; network?: string; schedule?: string; candidates?: number; bought?: number; spentKas?: string; drafts?: number; noDraft?: number; sent?: number; orchestrator?: string; scout?: string; researcher?: { url?: string; price?: string }; transactions?: { step: string; txid: string }[] }

export function GrowthFleet() {
  const { scope, agents } = useData();
  const [g, setG] = useState<Growth | null>(null);
  useEffect(() => { fetch("/growth.json").then((r) => (r.ok ? r.json() : null)).then(setG).catch(() => {}); }, []);
  if (!g || scope !== "warda") return null;
  const tx = Object.fromEntries((g.transactions ?? []).map((t) => [t.step, t.txid]));
  const has = (id?: string) => agents.find((a) => a.id === id);
  const step = (id: string | undefined, name: string, say: string) => {
    const a = has(id);
    const inner = <><span className="block text-[13px] font-medium">{name}{id ? ` · #${id}` : ""}</span><span className="block text-[11.5px] leading-snug text-fg-3">{say}</span></>;
    return a ? <a href={href("agents", a.key)} className="flex-1 rounded-xl border border-line-strong p-3 transition hover:bg-raised/60">{inner}</a>
      : <div className="flex-1 rounded-xl border border-dashed border-line-strong p-3">{inner}</div>;
  };
  const n = (label: string, v: unknown) => <div key={label}><div className="text-[11.5px] text-fg-3">{label}</div><div className="num mt-0.5 text-[15px]">{String(v ?? "—")}</div></div>;
  return (
    <Card className="mt-4">
      <CardHeader title="Warda's own growth loop" sub={`${g.label}${g.network ? ` · ${g.network}` : ""} · ${g.schedule ?? "weekly"}`} />
      <div className="flex flex-col items-stretch gap-2 p-5 pt-3 lg:flex-row lg:items-center">
        {step(g.orchestrator ?? "009", "Orchestrator", "batch grant; may pay the scout only")}
        <ArrowRight className="mx-auto size-4 shrink-0 rotate-90 text-fg-3 lg:rotate-0" />
        {step(g.scout ?? "010", "Scout", "one payee, one record's price at a time")}
        <ArrowRight className="mx-auto size-4 shrink-0 rotate-90 text-fg-3 lg:rotate-0" />
        <a href={g.researcher?.url ?? "#"} target="_blank" rel="noopener" className="flex-1 rounded-xl border border-line-strong p-3 transition hover:bg-raised/60">
          <span className="block text-[13px] font-medium">Researcher</span><span className="block text-[11.5px] text-fg-3">{g.researcher?.price ?? ""} · facts with sources</span>
        </a>
        <ArrowRight className="mx-auto size-4 shrink-0 rotate-90 text-fg-3 lg:rotate-0" />
        <div className="flex-1 rounded-xl border border-dashed border-line-strong p-3 opacity-70">
          <span className="block text-[13px] font-medium">Outreach</span><span className="block text-[11.5px] text-fg-3">no grant, no key; drafts for a person</span>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-y-4 border-t border-line px-5 py-4 sm:grid-cols-6">
        {[n("Projects found", g.candidates), n("Records bought", g.bought), n("Cost, on chain", `${g.spentKas ?? "0"} KAS`), n("Drafts to read", g.drafts), n("No draft", g.noDraft), n("Messages sent", g.sent ?? 0)]}
      </div>
      <p className="border-t border-line px-5 py-3 text-[12px] leading-relaxed text-fg-3">
        On chain: {["genesis", "hire", "settle", "revoke"].map((k, i) => (
          <span key={k}>{i ? " · " : ""}{k} {tx[k] ? <a className="num text-fg-2 hover:text-accent" href={explorerTx(tx[k]!)} target="_blank" rel="noopener">{tx[k]!.slice(0, 8)}…</a> : "—"}</span>
        ))}. The authority is real and enforced; the money is testnet, and both ends are Warda's.
      </p>
    </Card>
  );
}
