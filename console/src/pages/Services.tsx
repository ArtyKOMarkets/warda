import { useState } from "react";
import { Store, Plus, CircleCheck, CircleAlert } from "lucide-react";
import { api } from "@/lib/runner";
import { href } from "@/lib/router";
import { cn } from "@/lib/cn";
import type { Service } from "@/lib/data";
import { Button, LinkButton } from "@/components/ui";
import { KasInput, Select, inputCls } from "@/components/form";
import { useData } from "@/lib/data";
import { kas, short } from "@/lib/format";
import { Badge, Card, Copy, Empty, External, PageHeader, Skeleton } from "@/components/ui";
import { allPayments } from "./shared";

export function Services() {
  const { services, agents, loading } = useData();
  const paid = allPayments(agents).filter((r) => r.p.outcome === "paid" || r.p.outcome === "paid-not-served");
  return (
    <>
      <PageHeader title="Services" sub="Paid APIs your agents can buy from. Each listing is its operator's own claim; what they've actually been paid is on-chain."
        actions={<External href="/network.html" className="text-[13px]">Full registry</External>} />
      {loading && !services.length ? <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <Card key={i} className="h-44 p-5"><Skeleton className="w-40" /></Card>)}</div> : !services.length ? (
        <Card><Empty icon={<Store className="size-5" />} title="The registry is empty" /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {services.map((s) => {
            const mine = paid.filter((r) => r.p.payTo && r.p.payTo === s.address);
            const total = mine.reduce((x, r) => x + (r.p.amount ?? 0), 0);
            return (
              <Card key={s.id} className="flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[15px] font-semibold">{s.name}</div>
                    <div className="mt-0.5 text-[12.5px] text-fg-3">by {s.operator ?? "unknown operator"}</div>
                    {s.description && <p className="mt-2 text-[13px] leading-relaxed text-fg-2">{s.description}</p>}
                  </div>
                  {s.price && <Badge tone="accent">{s.price}</Badge>}
                </div>
                {s.endpoint && <div className="num mt-4 truncate rounded-lg border border-line bg-bg/60 px-3 py-2 text-[12px] text-fg-2">{s.endpoint}</div>}
                <div className="mt-auto flex items-center justify-between gap-3 pt-5 text-[12.5px]">
                  <span className="text-fg-3">{mine.length ? <>Paid <span className="num text-fg">{kas(total)} KAS</span> in {mine.length} payment{mine.length === 1 ? "" : "s"}</> : "No payments from these agents yet"}</span>
                  {s.address && <span className="flex items-center text-fg-3"><span className="num hidden sm:inline">{short(s.address, 10, 4)}</span><Copy text={s.address} label="Copy payee address" /></span>}
                </div>
                <ServiceJob s={s} />
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}

function ServiceJob({ s }: { s: Service }) {
  const { runner, agents, reload } = useData();
  const [open, setOpen] = useState(false);
  const live = agents.filter((a) => a.source === "hosted" && a.status === "active");
  const [agent, setAgent] = useState<string>("");
  const pick = live.find((a) => a.id === agent) ?? live[0];
  const [when, setWhen] = useState<"daily" | "once">("daily");
  const [hour, setHour] = useState("9");
  const [max, setMax] = useState(s.priceKas ? String(Math.ceil(s.priceKas * 1.2 * 1e4) / 1e4) : "0.05");
  const [say, setSay] = useState<{ bad?: boolean; text: React.ReactNode } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!s.endpoint) return null;
  const allowed = pick && s.address ? pick.payees.some((p) => p.address === s.address) : null;

  const add = async () => {
    if (!pick) return;
    setBusy(true); setSay({ text: "Adding…" });
    const once = when === "once", hr = Math.max(0, Math.min(23, parseInt(hour, 10) || 0));
    const wf = { agent: pick.id, name: (once ? "Buy " : "Daily: ") + s.name, trigger: once ? { type: "manual" } : { type: "schedule", cron: `0 ${hr} * * *` }, then: [{ type: "pay-x402", url: s.endpoint, maxKas: max.trim() }] };
    try {
      const r = await api<{ workflow: { id: string } }>(runner, "POST", "/v1/workflows", wf);
      if (once) await api(runner, "POST", `/v1/workflows/${r.workflow.id}/run`, {}, { "Idempotency-Key": `svc-${Date.now()}` });
      setSay({ text: <>{once ? "Added and run." : `Added: ${pick.id} buys this every day at ${hr}:00 UTC.`} <a className="text-accent hover:underline" href={href("agents", pick.key, "jobs")}>See its jobs</a></> });
      reload();
    } catch (e) { setSay({ bad: true, text: (e as Error).message }); } finally { setBusy(false); }
  };

  if (!open) return <Button size="sm" className="mt-4 self-start" onClick={() => setOpen(true)}><Plus className="size-3.5" /> Add as a job</Button>;
  return (
    <div className="rise mt-4 rounded-xl border border-line-strong p-4">
      {!runner.key ? (
        <div className="text-[13px] text-fg-2">Jobs run on agents the Warda runner hosts for you. <div className="mt-3 flex gap-2"><LinkButton size="sm" href={href("account", "runner")}>Sign in</LinkButton><LinkButton size="sm" variant="primary" href={href("new")}>New agent</LinkButton></div></div>
      ) : !live.length ? (
        <div className="text-[13px] text-fg-2">None of your agents has a live grant yet. <LinkButton size="sm" variant="primary" className="mt-3" href={href("new")}>New agent</LinkButton></div>
      ) : (
        <div className="space-y-3">
          <Select value={pick!.id} onChange={setAgent} options={live.map((a) => ({ value: a.id, label: a.label, hint: `${a.remaining ?? "?"} KAS left` }))} />
          <div className="grid grid-cols-2 gap-2">
            <Select value={when} onChange={setWhen} options={[{ value: "daily", label: "Every day" }, { value: "once", label: "Once, now" }]} />
            {when === "daily" ? <span className="relative block"><input inputMode="numeric" aria-label="Hour (UTC)" className={cn(inputCls, "num pr-14")} value={hour} onChange={(e) => setHour(e.target.value.replace(/\D/g, "").slice(0, 2))} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-fg-3">:00 UTC</span></span> : <span />}
          </div>
          <div className="flex items-center gap-2"><span className="shrink-0 text-[12.5px] text-fg-3">Never more than</span><KasInput value={max} onChange={(e) => setMax(e.target.value)} aria-label="Most per call" /><span className="shrink-0 text-[12.5px] text-fg-3">a call</span></div>
          {allowed === false && <p className="flex items-start gap-2 text-[12.5px] text-warn"><CircleAlert className="mt-0.5 size-3.5 shrink-0" />{pick!.id}'s grant doesn't list this service's payee, so the network would refuse its payments. Pick another agent, or make a new one with it as a payee.</p>}
          {allowed && <p className="flex items-center gap-2 text-[12.5px] text-ok"><CircleCheck className="size-3.5" />{pick!.id} may pay this service.</p>}
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={busy || allowed === false} onClick={add}>Add the job</Button>
          </div>
          {say && <p className={cn("text-[12.5px]", say.bad ? "text-bad" : "text-fg-2")}>{say.text}</p>}
        </div>
      )}
    </div>
  );
}
