import { useState } from "react";
import { Store, Plus, CircleCheck, CircleAlert, Terminal, Wallet } from "lucide-react";
import { api } from "@/lib/runner";
import { href } from "@/lib/router";
import { cn } from "@/lib/cn";
import type { Service, Unlisted } from "@/lib/data";
import { Button, LinkButton } from "@/components/ui";
import { KasInput, Select, inputCls } from "@/components/form";
import { useData } from "@/lib/data";
import { kas, short } from "@/lib/format";
import { Badge, Card, CardHeader, Copy, Empty, External, PageHeader, Skeleton } from "@/components/ui";
import { allPayments } from "./shared";

/** A payment's URL without its query, so one call and the next are the same endpoint. */
const bare = (url: string) => url.split(/[?#]/)[0]!.replace(/\/+$/, "");

/* What a grant for this one service would hold, sized to its price: a cap a
   little above one call, and a budget of two hundred of them. The create page
   reads them out of the hash. */
const trim = (n: number) => String(Math.round(n * 1e4) / 1e4);
function fundHref(s: Service): string | null {
  if (!s.address) return null;
  if (!s.priceKas) return href("create", s.address);
  const cap = Math.max(0.01, Math.ceil(s.priceKas * 1.2 * 100) / 100);
  const budget = Math.max(1, Math.ceil(s.priceKas * 200));
  return href("create", s.address, trim(budget), trim(cap));
}

const snippet = (endpoint: string) =>
  `# from the CLI, with a grant that may pay this service\nwarda pay ${endpoint}\n\n# or give an agent the MCP server, which pays within the same grant\nnpx @warda_protocol/mcp`;

export function Services() {
  const { services, unlisted, registry, agents, loading } = useData();
  const paid = allPayments(agents).filter((r) => r.p.outcome === "paid" || r.p.outcome === "paid-not-served");
  const nothing = !loading && !services.length && !registry;
  return (
    <>
      <PageHeader title="Services" sub="Paid APIs your agents can buy from. Each listing is its operator's own claim; what they've actually been paid is on-chain."
        actions={
          <div className="flex items-center gap-3">
            {registry && <Badge tone={registry.live ? "ok" : "warn"} dot>{registry.words}</Badge>}
            <External href="/network.html" className="text-[13px]">Full registry</External>
          </div>
        } />
      {loading && !services.length ? <div className="grid gap-4 md:grid-cols-2">{[0, 1].map((i) => <Card key={i} className="h-44 p-5"><Skeleton className="w-40" /></Card>)}</div> : nothing ? (
        <Card><Empty icon={<Store className="size-5" />} title="Neither the registry nor the published list answered">That is not "no services". It is one reading that did not load; try again in a moment.</Empty></Card>
      ) : !services.length ? (
        <Card><Empty icon={<Store className="size-5" />} title="The registry is empty" /></Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {services.map((s) => {
            /* Keyed by endpoint, and by payee only when the payment does not name
               a URL: one payee can serve several endpoints, and this figure is
               about this listing. */
            const mine = paid.filter((r) => (s.endpoint && r.p.url ? bare(r.p.url) === bare(s.endpoint) : !!s.address && r.p.payTo === s.address));
            const total = mine.reduce((x, r) => x + (r.p.amount ?? 0), 0);
            return <ServiceCard key={s.id} s={s} count={mine.length} total={total} />;
          })}
        </div>
      )}
      {unlisted.length > 0 && <KnownNotListed rows={unlisted} />}
    </>
  );
}

function ServiceCard({ s, count, total }: { s: Service; count: number; total: number }) {
  const [job, setJob] = useState(false);
  const [snip, setSnip] = useState(false);
  const fund = fundHref(s);
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[15px] font-semibold">{s.name}</div>
          <div className="mt-0.5 text-[12.5px] text-fg-3">by {s.operator ?? "unknown operator"}</div>
          {s.description && <p className="mt-2 text-[13px] leading-relaxed text-fg-2">{s.description}</p>}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {s.protocol && <Badge tone={s.warda ? "accent" : "muted"}>{s.protocol}{s.warda ? " · warda" : ""}</Badge>}
        </div>
      </div>

      {s.priceAmount && (
        <div className="mt-3 flex items-baseline gap-1.5">
          <span className="num text-[17px] font-semibold tracking-[-0.02em]">{s.priceAmount}</span>
          <span className="text-[12px] font-medium text-fg-3">{s.priceAsset ?? "KAS"}</span>
          <span className="text-[12.5px] text-fg-3">per {s.priceUnit ?? "call"}</span>
        </div>
      )}

      {s.capabilities.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {s.capabilities.map((c) => <span key={c} className="num rounded-md border border-line bg-raised px-1.5 py-0.5 text-[11.5px] text-fg-2">{c}</span>)}
        </div>
      )}

      {s.endpoint && <div className="num mt-4 truncate rounded-lg border border-line bg-bg/60 px-3 py-2 text-[12px] text-fg-2">{s.endpoint}</div>}
      {s.operatorNote && <p className="mt-2.5 text-[12.5px] leading-relaxed text-fg-3">{s.operatorNote}</p>}

      <div className="mt-auto flex items-center justify-between gap-3 pt-5 text-[12.5px]">
        <span className="text-fg-3">{count ? <>Paid <span className="num text-fg">{kas(total)} KAS</span> in {count} payment{count === 1 ? "" : "s"}</> : "No payments from these agents yet"}</span>
        {s.address && <span className="flex items-center text-fg-3"><span className="num hidden sm:inline">{short(s.address, 10, 4)}</span><Copy text={s.address} label="Copy payee address" /></span>}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {fund && <LinkButton size="sm" variant="primary" href={fund}><Wallet className="size-3.5" /> Fund an agent for this</LinkButton>}
        {s.endpoint && <Button size="sm" variant="ghost" onClick={() => setSnip(!snip)}><Terminal className="size-3.5" /> Use it</Button>}
        {s.endpoint && !job && <Button size="sm" onClick={() => setJob(true)}><Plus className="size-3.5" /> Add as a job</Button>}
      </div>

      {snip && s.endpoint && (
        <div className="rise mt-3 rounded-xl border border-line-strong bg-bg/60">
          <div className="flex items-start justify-between gap-2 p-3">
            <pre className="num min-w-0 flex-1 overflow-x-auto whitespace-pre text-[12px] leading-relaxed text-fg-2">{snippet(s.endpoint)}</pre>
            <Copy text={snippet(s.endpoint)} label="Copy both lines" className="shrink-0" />
          </div>
        </div>
      )}

      <ServiceJob s={s} open={job} onClose={() => setJob(false)} />
    </Card>
  );
}

function KnownNotListed({ rows }: { rows: Unlisted[] }) {
  return (
    <Card className="mt-4">
      <CardHeader title="Known, not listed" sub="Services agents here already pay that have never asked to be listed. Shown because a registry that shows only what it recruited hides the size of what it has not." />
      <div className="mt-4 divide-y divide-line border-t border-line">
        {rows.map((u) => (
          <div key={u.name} className="flex items-start justify-between gap-4 px-5 py-4">
            <div className="min-w-0">
              <div className="text-[13.5px] font-medium">{u.name}</div>
              {u.why && <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">{u.why}</p>}
              {u.endpoint && <div className="num mt-2 truncate text-[12px] text-fg-2">{u.endpoint}</div>}
            </div>
            {(u.address ?? u.payee) && <span className="flex shrink-0 items-center text-[12.5px] text-fg-3"><span className="num hidden sm:inline">{short(u.address ?? u.payee, 10, 4)}</span><Copy text={(u.address ?? u.payee)!} label="Copy payee address" /></span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

function ServiceJob({ s, open, onClose }: { s: Service; open: boolean; onClose: () => void }) {
  const { runner, agents, reload } = useData();
  const live = agents.filter((a) => a.source === "hosted" && a.status === "active");
  const [agent, setAgent] = useState<string>("");
  const pick = live.find((a) => a.id === agent) ?? live[0];
  const [when, setWhen] = useState<"daily" | "once">("daily");
  const [hour, setHour] = useState("9");
  const [max, setMax] = useState(s.priceKas ? String(Math.ceil(s.priceKas * 1.2 * 1e4) / 1e4) : "0.05");
  const [say, setSay] = useState<{ bad?: boolean; text: React.ReactNode } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!s.endpoint || !open) return null;
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
            <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button size="sm" variant="primary" disabled={busy || allowed === false} onClick={add}>Add the job</Button>
          </div>
          {say && <p className={cn("text-[12.5px]", say.bad ? "text-bad" : "text-fg-2")}>{say.text}</p>}
        </div>
      )}
    </div>
  );
}
