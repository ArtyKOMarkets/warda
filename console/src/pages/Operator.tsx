import { useCallback, useEffect, useState } from "react";
import { CircleAlert, Coins, Eye, EyeOff, LayoutGrid, Loader2, RefreshCw, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import { loadRunner } from "@/lib/runner";
import { ago, kas, kasOf, short } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Badge, Button, Card, CardHeader, Copy, Empty, Kas, PageHeader, Skeleton, Stat, type Tone } from "@/components/ui";
import { Field, inputCls } from "@/components/form";

/* The operator's view, as the classic console had it at #/admin: the hosted
   runner from the inside, read from GET /v1/admin/stats with the runner's own
   admin secret. The secret is not the account key — it is RUNNER_ADMIN_SECRET
   from the runner's env, and it stays in this browser under the key the
   classic console used, so whoever entered it there is still in here. */
const AD_KEY = "warda.console.admin";

const readSecret = () => { try { return localStorage.getItem(AD_KEY) || ""; } catch { return ""; } };
const keepSecret = (s: string) => { try { localStorage.setItem(AD_KEY, s); } catch { /* private window */ } };
const dropSecret = () => { try { localStorage.removeItem(AD_KEY); } catch { /* private window */ } };

/* Every field below may be missing: the runner is read as it answers today,
   and an older one answers with less. */
interface Runs { ok?: number; failed?: number; refused?: number }
interface Problem { kind?: string; agent?: string; status?: string; detail?: string; at?: number }
interface AdAgent {
  agent?: string; account?: string; funding?: string; jobs?: number;
  grant?: { left?: string | number; budget?: string | number } | null;
  runs?: Runs; lastRunAt?: number | null;
  fees?: { settled?: string | number; owed?: string | number };
  lastProblem?: Problem | null;
}
interface AdAccount { account?: string; createdAt?: number | null; agents?: number; telegram?: boolean }
interface Day { day?: string; [status: string]: number | string | undefined }
interface Stats {
  at?: number; lastTickAt?: number | null;
  totals?: { accounts?: number; agents?: number; telegram?: number; runs24h?: number; problems24h?: number; feesSettled?: string | number; feesOwed?: string | number };
  days?: Day[]; agents?: AdAgent[]; problems?: Problem[]; accounts?: AdAccount[];
}

/** Amounts come as display strings; put them through the console's own formatting. */
const money = (v: unknown) => kas(kasOf(v));
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
const when = (ms: number | null | undefined) => (ms ? ago(ms) : "never");

/* How a day's runs are grouped, and in what colour, exactly as the classic
   page grouped them. Anything the runner adds later falls into "other". */
const GROUPS: { key: string; label: string; bar: string; text: string; statuses: string[] }[] = [
  { key: "ok", label: "ok", bar: "bg-ok", text: "text-ok", statuses: ["ok"] },
  { key: "refused", label: "refused", bar: "bg-warn", text: "text-warn", statuses: ["refused"] },
  { key: "failed", label: "failed or stuck", bar: "bg-bad", text: "text-bad", statuses: ["failed", "undelivered"] },
  { key: "other", label: "skipped, missed, undecided", bar: "bg-line-strong", text: "text-fg-3", statuses: ["skipped", "missed", "undecided", "running"] },
];

function dayTotal(d: Day) {
  return Object.keys(d).reduce((a, k) => a + (k === "day" ? 0 : num(d[k])), 0);
}
function groupOf(d: Day, statuses: string[]) {
  return statuses.reduce((a, k) => a + num(d[k]), 0);
}

function Tile({ label, value, hint, icon, tone = "muted" }: { label: string; value: React.ReactNode; hint: React.ReactNode; icon: React.ReactNode; tone?: Tone }) {
  const ring: Record<Tone, string> = {
    ok: "text-ok bg-ok/10", warn: "text-warn bg-warn/10", bad: "text-bad bg-bad/10",
    info: "text-info bg-info/10", accent: "text-accent bg-accent/10", muted: "text-fg-2 bg-raised",
  };
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <Stat label={label} hint={hint}>{value}</Stat>
        <span className={cn("grid size-8 shrink-0 place-items-center rounded-lg", ring[tone])}>{icon}</span>
      </div>
    </Card>
  );
}

function SecretForm({ url, err, busy, onSubmit }: { url: string; err: string | null; busy: boolean; onSubmit: (s: string) => void }) {
  const [v, setV] = useState("");
  const [show, setShow] = useState(false);
  return (
    <Card className="max-w-xl">
      <CardHeader title="The runner's admin secret" sub={`Read from ${url}`} />
      <form className="p-5 pt-4" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onSubmit(v.trim()); }}>
        <Field label="Admin secret" hint="RUNNER_ADMIN_SECRET from the runner's own environment — not your account key. It is kept in this browser and sent to the runner, nowhere else.">
          <span className="relative block">
            <input className={cn(inputCls, "num pr-10")} type={show ? "text" : "password"} value={v} onChange={(e) => setV(e.target.value)}
              placeholder="RUNNER_ADMIN_SECRET" autoComplete="off" autoCapitalize="off" spellCheck={false} />
            <button type="button" onClick={() => setShow(!show)} aria-label={show ? "Hide secret" : "Show secret"}
              className="absolute right-1 top-1 grid size-8 place-items-center rounded-md text-fg-3 transition hover:text-fg">
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </span>
        </Field>
        {err && <p className="mt-4 flex items-start gap-2 rounded-lg bg-bad/10 px-3 py-2.5 text-[13px] text-bad"><CircleAlert className="mt-0.5 size-4 shrink-0" />{err}</p>}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="primary" disabled={busy || !v.trim()}>{busy ? <><Loader2 className="size-4 animate-spin" /> Reading…</> : "Read the runner"}</Button>
        </div>
        <p className="mt-4 text-[12px] leading-relaxed text-fg-3">The runner URL comes from your runner sign-in on Account. This page reads the runner's own records — who uses it, how their runs go, what is failing, what it has earned. It never reads the chain, and it changes nothing.</p>
      </form>
    </Card>
  );
}

function Days({ days }: { days: Day[] }) {
  const max = Math.max(1, ...days.map(dayTotal));
  return (
    <>
      <div className="flex h-44 items-end gap-[3px] overflow-x-auto px-5 pt-4 [scrollbar-width:none]">
        {days.map((d, i) => {
          const parts = GROUPS.map((g) => ({ ...g, n: groupOf(d, g.statuses) }));
          const total = dayTotal(d);
          return (
            <div key={String(d.day ?? i)} className="flex h-full min-w-[10px] flex-1 flex-col justify-end gap-1"
              title={`${d.day ?? "—"}: ${parts.map((p) => `${p.n} ${p.label}`).join(", ")}`}>
              <div className="flex w-full flex-col-reverse justify-start" style={{ height: `${(total / max) * 100}%` }}>
                {parts.map((p) => (p.n ? <span key={p.key} className={cn("w-full first:rounded-b-[2px] last:rounded-t-[2px]", p.bar)} style={{ height: `${(p.n / Math.max(1, total)) * 100}%` }} /> : null))}
              </div>
              <b className="num block text-center text-[10px] font-normal text-fg-3">{String(d.day ?? "").slice(8)}</b>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 border-t border-line px-5 py-3 text-[12px] text-fg-3">
        {GROUPS.map((g) => <span key={g.key} className="flex items-center gap-1.5"><i className={cn("size-2 rounded-[2px]", g.bar)} />{g.label}</span>)}
      </div>
    </>
  );
}

function ProblemLine({ p }: { p: Problem }) {
  return (
    <li className="flex items-start gap-3 px-5 py-3">
      <Badge tone="bad" className="mt-0.5 shrink-0">{p.kind ?? "problem"}</Badge>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-medium">{p.agent ?? "—"}{p.status ? ` · ${p.status}` : ""}</div>
        <div className="break-words text-[12.5px] leading-relaxed text-fg-3">{p.detail || "No detail from the runner."}</div>
      </div>
      <span className="shrink-0 whitespace-nowrap text-[12px] text-fg-3">{when(p.at)}</span>
    </li>
  );
}

export function Operator() {
  const [url] = useState(() => loadRunner().url.trim().replace(/\/+$/, ""));
  const [secret, setSecret] = useState(readSecret);
  const [data, setData] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (s: string) => {
    setBusy(true); setErr(null);
    try {
      let r: Response;
      try {
        r = await fetch(`${url}/v1/admin/stats`, { headers: { Authorization: `Bearer ${s}` } });
      } catch { throw new Error(`The runner did not answer at ${url}.`); }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 401 ? "The runner refused that secret." : j.error || `The runner answered ${r.status}.`);
      keepSecret(s);
      setSecret(s);
      setData(j as Stats);
    } catch (e) {
      setErr((e as Error).message);
    } finally { setBusy(false); }
  }, [url]);

  useEffect(() => { const s = readSecret(); if (s) load(s); }, [load]);

  const forget = () => { dropSecret(); setSecret(""); setData(null); setErr(null); };

  const header = (
    <PageHeader title="Operator"
      sub="The hosted runner from the inside: who uses it, how their runs go, what is failing, and what it has earned. Read from the runner's own records, not the chain."
      actions={secret ? (
        <>
          <Button onClick={() => load(secret)} disabled={busy}>{busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />} Read again</Button>
          <Button variant="ghost" onClick={forget}>Forget it in this browser</Button>
        </>
      ) : undefined} />
  );

  if (!secret || (err && !data)) {
    return (
      <>
        {header}
        <SecretForm url={url} err={err} busy={busy} onSubmit={load} />
      </>
    );
  }

  if (!data) {
    return (
      <>
        {header}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0, 1, 2, 3].map((i) => <Card key={i} className="p-5"><Skeleton className="h-3 w-24" /><Skeleton className="mt-3 h-6 w-20" /><Skeleton className="mt-3 h-3 w-32" /></Card>)}</div>
        <Card className="mt-4 p-5"><Skeleton className="h-40 w-full" /></Card>
      </>
    );
  }

  const t = data.totals ?? {};
  const days = Array.isArray(data.days) ? data.days : [];
  const agents = Array.isArray(data.agents) ? data.agents : [];
  const problems = Array.isArray(data.problems) ? data.problems : [];
  const accounts = Array.isArray(data.accounts) ? data.accounts : [];
  const tickAge = data.lastTickAt ? (Date.now() - data.lastTickAt) / 60000 : null;
  const ticking = tickAge !== null && tickAge < 5;

  return (
    <>
      {header}

      {err && <p className="mb-4 flex items-start gap-2 rounded-lg bg-bad/10 px-3 py-2.5 text-[13px] text-bad"><CircleAlert className="mt-0.5 size-4 shrink-0" />{err}</p>}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Tile label="Last tick" tone={ticking ? "ok" : "warn"} icon={<ShieldCheck className="size-4" />}
          value={when(data.lastTickAt)}
          hint={ticking ? "the minute schedule is running" : "the schedule should tick every minute — check QStash"} />
        <Tile label="Accounts · agents" tone="info" icon={<LayoutGrid className="size-4" />}
          value={`${num(t.accounts)} · ${num(t.agents)}`}
          hint={`${num(t.telegram)} with Telegram connected`} />
        <Tile label="Runs, last 24 h" tone="accent" icon={<RefreshCw className="size-4" />}
          value={<span className="num">{num(t.runs24h)}</span>}
          hint={num(t.problems24h) ? `${num(t.problems24h)} the operator should look at` : "none needing you"} />
        <Tile label="Runner fees" tone="accent" icon={<Coins className="size-4" />}
          value={<Kas value={money(t.feesSettled)} />}
          hint={<>{money(t.feesOwed)} KAS owed, not yet settled</>} />
      </div>

      <Card className="mt-4 overflow-hidden">
        <CardHeader title="Runs per day" sub={days.length ? `${days.length} days, every run the runner recorded` : undefined} />
        {days.length ? <Days days={days} /> : <Empty title="No runs recorded">Nothing has run on this runner yet.</Empty>}
      </Card>

      <Card className="mt-4 overflow-hidden">
        <CardHeader title="Agents" sub={agents.length ? `${agents.length} hosted across every account` : undefined} />
        {!agents.length ? <Empty title="No agents yet">Nobody has created an agent on this runner.</Empty> : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[1020px] text-left text-[13.5px]">
              <thead className="border-b border-line text-[12px] text-fg-3">
                <tr>
                  {["Agent", "Account", "Funding", "Left of budget", "Jobs", "Runs ok / failed / refused", "Last run", "Fees settled · owed", "Last problem"].map((h) => (
                    <th key={h} className={cn("px-5 py-3 font-medium", ["Left of budget", "Jobs", "Runs ok / failed / refused", "Fees settled · owed"].includes(h) && "text-right")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {agents.map((a, i) => {
                  const r = a.runs ?? {};
                  return (
                    <tr key={a.agent ?? i} className="transition hover:bg-raised/50">
                      <td className="px-5 py-3.5 font-medium">{a.agent ?? "—"}</td>
                      <td className="px-5">
                        <span className="flex items-center gap-1">
                          <span className="num text-[12.5px] text-fg-2">{short(a.account, 10, 6)}</span>
                          {a.account && <Copy text={a.account} label="Copy account" />}
                        </span>
                      </td>
                      <td className="px-5 text-fg-2">{a.funding || "—"}</td>
                      <td className="num px-5 text-right text-fg-2">{a.grant ? <>{money(a.grant.left)} <span className="text-fg-3">of {money(a.grant.budget)}</span></> : "—"}</td>
                      <td className="num px-5 text-right text-fg-2">{num(a.jobs)}</td>
                      <td className="num px-5 text-right">
                        <span className="text-ok">{num(r.ok)}</span>
                        <span className="text-fg-3"> / </span>
                        <span className={num(r.failed) ? "text-bad" : "text-fg-3"}>{num(r.failed)}</span>
                        <span className="text-fg-3"> / </span>
                        <span className={num(r.refused) ? "text-warn" : "text-fg-3"}>{num(r.refused)}</span>
                      </td>
                      <td className="px-5 text-fg-3">{when(a.lastRunAt)}</td>
                      <td className="num px-5 text-right text-fg-2">{money(a.fees?.settled)} <span className="text-fg-3">· {money(a.fees?.owed)}</span></td>
                      <td className="px-5">
                        {a.lastProblem ? (
                          <span className="flex items-center gap-2">
                            <Badge tone="bad">{a.lastProblem.kind ?? "problem"}</Badge>
                            <span className="whitespace-nowrap text-[12px] text-fg-3">{when(a.lastProblem.at)}</span>
                          </span>
                        ) : <span className="text-fg-3">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden">
          <CardHeader title="Problems" sub={problems.length ? `${problems.length} in ${days.length} days` : undefined} />
          {!problems.length ? (
            <Empty icon={<TriangleAlert className="size-5" />} title="Nothing failed, nothing stuck">Every run in this window either paid or was refused on purpose.</Empty>
          ) : <ul className="mt-2 divide-y divide-line">{problems.map((p, i) => <ProblemLine key={`${p.agent}-${p.at}-${i}`} p={p} />)}</ul>}
        </Card>

        <Card className="overflow-hidden">
          <CardHeader title="Accounts" sub={accounts.length ? `${accounts.length} on this runner` : undefined} />
          {!accounts.length ? (
            <Empty icon={<Users className="size-5" />} title="No accounts yet">Nobody has redeemed an invite code.</Empty>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[420px] text-left text-[13.5px]">
                <thead className="border-b border-line text-[12px] text-fg-3">
                  <tr>{["Account", "Since", "Agents", "Telegram"].map((h) => <th key={h} className={cn("px-5 py-3 font-medium", h === "Agents" && "text-right")}>{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {accounts.map((a, i) => (
                    <tr key={a.account ?? i} className="transition hover:bg-raised/50">
                      <td className="px-5 py-3">
                        <span className="flex items-center gap-1">
                          <span className="num text-[12.5px] text-fg-2">{short(a.account, 10, 6)}</span>
                          {a.account && <Copy text={a.account} label="Copy account" />}
                        </span>
                      </td>
                      <td className="px-5 text-fg-3">{when(a.createdAt)}</td>
                      <td className="num px-5 text-right text-fg-2">{num(a.agents)}</td>
                      <td className="px-5">{a.telegram ? <Badge tone="ok" dot>connected</Badge> : <span className="text-fg-3">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <p className="mt-6 text-[12px] text-fg-3">
        Read {data.at ? new Date(data.at).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : "just now"} from {url}. The admin secret stays in this browser.
      </p>
    </>
  );
}
