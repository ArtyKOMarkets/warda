import { useCallback, useEffect, useState } from "react";
import { Play, Pause, Sparkles, CircleCheck, CircleAlert, Ban, Clock, Hand, Loader2, Plus, Zap, ExternalLink } from "lucide-react";
import { api, type RunnerConfig } from "@/lib/runner";
import { useData } from "@/lib/data";
import { dateTime, ago } from "@/lib/format";
import { explorerTx } from "@/lib/kaspa";
import { cn } from "@/lib/cn";
import { Badge, Button, Card, CardHeader, Empty, type Tone } from "./ui";
import { Field, KasInput, Select, inputCls, kasOk } from "./form";

interface Workflow { id: string; name: string; enabled: boolean; trigger: { type: string; cron?: string; when?: string; percent?: number; hours?: number }; then?: { type: string }[] }
interface Step { action: string; status: string; detail?: string; txid?: string }
interface Run { id: string; startedAt: number; status: string; trigger: string; steps: Step[]; note?: string }
interface Approval { id: string; status: string; op: string; note?: string; createdAt: number }

export function triggerWords(t: Workflow["trigger"]): string {
  if (t.type === "schedule" && t.cron) {
    const [m, h, dom, , dow] = t.cron.split(" ");
    const at = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")} UTC`;
    if (dom === "*" && dow === "*" && /^\d+$/.test(h ?? "")) return `Every day at ${at}`;
    if (h === "*") return "Every hour";
    return `On a schedule (${t.cron})`;
  }
  if (t.type === "manual") return "When you run it";
  if (t.type === "webhook") return "When a webhook arrives";
  if (t.type === "grant") return t.when === "budget-below" ? `When budget drops below ${t.percent}%` : `When the grant has ${t.hours} h left`;
  if (t.type === "mcp") return "From an AI assistant";
  return t.type;
}

const RUN: Record<string, [Tone, string, typeof CircleCheck]> = {
  ok: ["ok", "Done", CircleCheck], running: ["info", "Running", Loader2], waiting: ["warn", "Waiting for you", Hand],
  refused: ["bad", "Refused", Ban], failed: ["bad", "Failed", CircleAlert], denied: ["muted", "Denied", Ban],
  expired: ["muted", "Expired", Clock], skipped: ["muted", "Skipped", Clock], missed: ["muted", "Missed", Clock],
  undelivered: ["warn", "Paid, not delivered", CircleAlert], undecided: ["warn", "Undecided", CircleAlert],
};

export function useHostedAgent(agent: string) {
  const { runner } = useData();
  const [wfs, setWfs] = useState<Workflow[] | null>(null);
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const load = useCallback(() => {
    const e = encodeURIComponent(agent);
    api<{ workflows?: Workflow[] }>(runner, "GET", `/v1/agents/${e}`).then((a) => setWfs(a.workflows ?? [])).catch(() => setWfs([]));
    api<{ runs: Run[] }>(runner, "GET", `/v1/agents/${e}/runs?limit=15`).then((r) => setRuns(r.runs)).catch(() => setRuns([]));
    api<{ approvals?: Approval[] }>(runner, "GET", `/v1/agents/${e}/approvals`).then((r) => setApprovals((r.approvals ?? []).filter((x) => x.status === "pending"))).catch(() => {});
  }, [agent, runner]);
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load]);
  return { runner, wfs, runs, approvals, reload: load };
}

export function ApprovalsBanner({ runner, approvals, onDone }: { runner: RunnerConfig; approvals: Approval[]; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!approvals.length) return null;
  const decide = async (id: string, decision: "approve" | "deny") => {
    setBusy(id + decision); setErr(null);
    try { await api(runner, "POST", `/v1/approvals/${encodeURIComponent(id)}`, { decision }); onDone(); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <Card className="mb-6 border-warn/30 bg-gradient-to-b from-warn/[0.07] to-transparent">
      <ul className="divide-y divide-line">
        {approvals.map((a) => {
          const left = Math.max(0, Math.round((a.createdAt + 86_400_000 - Date.now()) / 3_600_000));
          return (
            <li key={a.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
              <Hand className="hidden size-5 shrink-0 text-warn sm:block" />
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-medium">{a.note ?? (a.op === "continue" ? "A job is waiting for your OK" : `Asks you to ${a.op}`)}</div>
                <div className="mt-0.5 text-[12.5px] text-fg-3">{a.op === "continue" ? `Expires in ${left} h · also on Telegram` : "Sign it in your own wallet"}</div>
              </div>
              {a.op === "continue" && (
                <div className="flex gap-2">
                  <Button size="sm" variant="primary" disabled={!!busy} onClick={() => decide(a.id, "approve")}>{busy === a.id + "approve" ? "…" : "Approve"}</Button>
                  <Button size="sm" disabled={!!busy} onClick={() => decide(a.id, "deny")}>Deny</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {err && <p className="border-t border-line px-4 py-2.5 text-[12.5px] text-bad">{err}</p>}
    </Card>
  );
}

export function JobsTab({ agent, h }: { agent: string; h: ReturnType<typeof useHostedAgent> }) {
  const { runner, wfs, runs, reload } = h;
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setErr(null);
    try { await fn(); reload(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader title="Jobs" sub="What this agent does, and when" />
          {err && <p className="mx-5 mt-3 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{err}</p>}
          <div className="mt-3">
            {wfs === null ? <div className="p-5"><Loader2 className="size-4 animate-spin text-fg-3" /></div> : !wfs.length ? (
              <Empty icon={<Zap className="size-5" />} title="No jobs yet" className="py-10">Describe one in a sentence, or pick a quick job on the right.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {wfs.map((w) => (
                  <li key={w.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2"><span className="truncate text-[14px] font-medium">{w.name}</span>{!w.enabled && <Badge tone="warn">Paused</Badge>}</div>
                      <div className="mt-0.5 text-[12.5px] text-fg-3">{triggerWords(w.trigger)}</div>
                    </div>
                    <div className="flex gap-2">
                      <Button size="sm" disabled={!!busy} onClick={() => act("run" + w.id, () => api(runner, "POST", `/v1/workflows/${w.id}/run`, {}, { "Idempotency-Key": `next-${Date.now()}` }))}>
                        {busy === "run" + w.id ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Run now
                      </Button>
                      <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => act("tog" + w.id, () => api(runner, "PATCH", `/v1/workflows/${w.id}`, { enabled: !w.enabled }))}>
                        {w.enabled ? <><Pause className="size-3.5" /> Pause</> : <><Play className="size-3.5" /> Resume</>}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
        <Card>
          <CardHeader title="Recent runs" />
          <div className="mt-3">
            {runs === null ? <div className="p-5"><Loader2 className="size-4 animate-spin text-fg-3" /></div> : !runs.length ? (
              <Empty title="Nothing has run yet" className="py-10">Press Run now on a job, or wait for its schedule.</Empty>
            ) : (
              <ul className="divide-y divide-line">
                {runs.map((r) => {
                  const [tone, words, Icon] = RUN[r.status] ?? ["muted", r.status, Clock];
                  const tx = r.steps.find((s) => s.txid)?.txid;
                  const detail = r.note ?? r.steps.map((s) => s.detail).filter(Boolean).join(" · ");
                  return (
                    <li key={r.id} className="flex items-start gap-3 px-5 py-3.5">
                      <Icon className={cn("mt-0.5 size-[18px] shrink-0", { ok: "text-ok", bad: "text-bad", warn: "text-warn", info: "text-info animate-spin", muted: "text-fg-3", accent: "text-accent" }[tone])} strokeWidth={1.8} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[13.5px]"><span className="font-medium">{words}</span><span className="text-fg-3">· {r.trigger}</span></div>
                        {detail && <div className="mt-0.5 line-clamp-2 text-[12px] text-fg-3">{detail}</div>}
                      </div>
                      <div className="shrink-0 text-right">
                        <div className="text-[12px] text-fg-3" title={dateTime(r.startedAt)}>{ago(r.startedAt)}</div>
                        {tx && <a className="num text-[11.5px] text-fg-3 hover:text-accent" href={explorerTx(tx)} target="_blank" rel="noopener">{tx.slice(0, 8)}…</a>}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Card>
      </div>
      <div className="space-y-4">
        <DraftJob agent={agent} runner={runner} onAdded={reload} />
        <QuickJob agent={agent} runner={runner} onAdded={reload} />
      </div>
    </div>
  );
}

function DraftJob({ agent, runner, onAdded }: { agent: string; runner: RunnerConfig; onAdded: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<{ workflow: Workflow; summary?: string; notes?: string[] } | null>(null);
  const [msg, setMsg] = useState<{ bad?: boolean; text: string } | null>(null);
  const [secret, setSecret] = useState<string | null>(null);

  const make = async () => {
    if (text.trim().length < 8) { setMsg({ bad: true, text: "Say what it should do, in a sentence." }); return; }
    setBusy(true); setMsg(null); setDraft(null);
    try {
      const r = await api<{ ok: boolean; reason?: string; workflow: Workflow; summary?: string; notes?: string[] }>(runner, "POST", "/v1/workflows/draft", { agent, text: text.trim() });
      if (!r.ok) setMsg({ bad: true, text: `Not possible as asked: ${r.reason}` }); else setDraft(r);
    } catch (e) { setMsg({ bad: true, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const add = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const r = await api<{ workflow: Workflow; webhook?: { url: string; header: string; secret: string } }>(runner, "POST", "/v1/workflows", draft.workflow);
      if (r.webhook) setSecret(`POST ${r.webhook.url}\n${r.webhook.header}: ${r.webhook.secret}`);
      setMsg({ text: `Added: ${r.workflow.name}.` }); setDraft(null); setText(""); onAdded();
    } catch (e) { setMsg({ bad: true, text: (e as Error).message }); } finally { setBusy(false); }
  };

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-[15px] font-semibold"><Sparkles className="size-4 text-accent" /> Describe a job</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) make(); }}
        rows={3} placeholder="Buy the Kaspa digest every morning at 7, and ask me first"
        className={cn(inputCls, "mt-3 h-auto resize-none py-2.5 leading-relaxed")} />
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[12px] text-fg-3">It is checked against this agent's grant.</span>
        <Button size="sm" onClick={make} disabled={busy}>{busy && !draft ? <Loader2 className="size-3.5 animate-spin" /> : null} Draft</Button>
      </div>
      {draft && (
        <div className="rise mt-4 rounded-xl border border-line-strong bg-bg/60 p-4">
          <div className="text-[13.5px] font-medium">{draft.summary ?? draft.workflow.name}</div>
          <div className="mt-1 text-[12.5px] text-fg-3">{triggerWords(draft.workflow.trigger)}</div>
          <p className={cn("mt-2 text-[12.5px]", draft.notes?.length ? "text-warn" : "text-ok")}>{draft.notes?.length ? draft.notes.join(" · ") : "Inside this agent's grant."}</p>
          <div className="mt-3 flex gap-2"><Button size="sm" variant="primary" onClick={add} disabled={busy}><Plus className="size-3.5" /> Add job</Button><Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Discard</Button></div>
        </div>
      )}
      {msg && <p className={cn("mt-3 text-[12.5px]", msg.bad ? "text-bad" : "text-ok")}>{msg.text}</p>}
      {secret && <pre className="num mt-3 whitespace-pre-wrap break-all rounded-lg border border-line-strong bg-bg p-3 text-[11.5px] text-fg-2">{secret}{"\n\n"}The secret is shown once. Store it where the sender can read it.</pre>}
    </Card>
  );
}

function QuickJob({ agent, runner, onAdded }: { agent: string; runner: RunnerConfig; onAdded: () => void }) {
  const { services } = useData();
  const endpoints = services.filter((s) => s.endpoint);
  const [url, setUrl] = useState(endpoints[0]?.endpoint ?? "");
  const [when, setWhen] = useState<"daily" | "once">("daily");
  const [hour, setHour] = useState("7");
  const [max, setMax] = useState("0.1");
  const [ask, setAsk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ bad?: boolean; text: string } | null>(null);
  useEffect(() => { if (!url && endpoints[0]?.endpoint) setUrl(endpoints[0].endpoint); }, [endpoints, url]);

  const ok = /^https?:\/\/\S+$/.test(url) && kasOk(max);
  const add = async () => {
    const host = endpoints.find((s) => s.endpoint === url)?.name ?? url.replace(/^https?:\/\//, "").split("/")[0];
    const hr = Math.max(0, Math.min(23, parseInt(hour, 10) || 0));
    const wf: any = when === "daily"
      ? { agent, name: `Buy from ${host} daily`, trigger: { type: "schedule", cron: `0 ${hr} * * *` }, then: [{ type: "pay-x402", url, maxKas: max.trim() }] }
      : { agent, name: `Buy from ${host}`, trigger: { type: "manual" }, then: [{ type: "pay-x402", url, maxKas: max.trim() }] };
    if (ask) { wf.then.unshift({ type: "approval", op: "continue", note: `“${wf.name}” wants to buy from ${host} (up to ${max.trim()} KAS).` }); wf.name += " — asks first"; }
    setBusy(true); setMsg(null);
    try { const r = await api<{ workflow: Workflow }>(runner, "POST", "/v1/workflows", wf); setMsg({ text: `Added: ${r.workflow.name}.` }); onAdded(); }
    catch (e) { setMsg({ bad: true, text: (e as Error).message }); } finally { setBusy(false); }
  };

  return (
    <Card className="p-5">
      <div className="text-[15px] font-semibold">Quick job: buy from a service</div>
      <div className="mt-4 space-y-4">
        <Field label="Service">
          <Select value={endpoints.some((s) => s.endpoint === url) ? url : "__other"} onChange={(v) => setUrl(v === "__other" ? "" : v)}
            options={[...endpoints.map((s) => ({ value: s.endpoint!, label: s.name, hint: s.price ?? undefined })), { value: "__other", label: "Another URL…" }]} />
        </Field>
        {!endpoints.some((s) => s.endpoint === url) && <input className={cn(inputCls, "num text-[13px]")} placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} autoCapitalize="off" />}
        <div className="grid grid-cols-2 gap-3">
          <Field label="When">
            <Select value={when} onChange={setWhen} options={[{ value: "daily", label: "Every day" }, { value: "once", label: "When I run it" }]} />
          </Field>
          {when === "daily" ? (
            <Field label="Hour (UTC)"><input inputMode="numeric" className={cn(inputCls, "num")} value={hour} onChange={(e) => setHour(e.target.value.replace(/\D/g, "").slice(0, 2))} /></Field>
          ) : <span />}
        </div>
        <Field label="Pay at most" hint="Per purchase. The grant's own cap still applies."><KasInput value={max} onChange={(e) => setMax(e.target.value)} /></Field>
        <label className="flex cursor-pointer items-center gap-2.5 text-[13px] text-fg-2">
          <input type="checkbox" checked={ask} onChange={(e) => setAsk(e.target.checked)} className="size-4 accent-[var(--color-accent)]" /> Ask me first, each time
        </label>
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        {msg ? <span className={cn("text-[12.5px]", msg.bad ? "text-bad" : "text-ok")}>{msg.text}</span> : <a href="/app#/hagents" className="inline-flex items-center gap-1 text-[12.5px] text-fg-3 hover:text-fg">Templates &amp; alerts <ExternalLink className="size-3" /></a>}
        <Button size="sm" variant="primary" disabled={!ok || busy} onClick={add}><Plus className="size-3.5" /> Add job</Button>
      </div>
    </Card>
  );
}
