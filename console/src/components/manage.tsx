import { useEffect, useMemo, useState } from "react";
import { Bot, Download, FileText, Globe, Link2, Loader2, Plug, Printer, ShieldOff, Users } from "lucide-react";
import { api, type RunnerConfig } from "@/lib/runner";
import { href } from "@/lib/router";
import { cn } from "@/lib/cn";
import { Button, Card, CardHeader, Copy, LinkButton, Tabs } from "./ui";
import { Field, KasInput, Select, inputCls, kasOk } from "./form";

function download(name: string, data: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function Cmd({ children }: { children: string }) {
  return (
    <div className="mt-3 flex items-start rounded-lg border border-line-strong bg-bg">
      <pre className="num min-w-0 flex-1 overflow-x-auto whitespace-pre p-3 text-[12px] leading-relaxed text-fg-2">{children}</pre>
      <Copy text={children} className="m-1.5 shrink-0" label="Copy command" />
    </div>
  );
}

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

export function ManageTab({ agent, runner, detail, reload }: { agent: string; runner: RunnerConfig; detail: any; reload: () => void }) {
  if (!detail) return <Card className="p-6"><Loader2 className="size-4 animate-spin text-fg-3" /></Card>;
  return (
    <div className="grid items-start gap-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Helpers agent={agent} runner={runner} a={detail} reload={reload} />
        <Statement agent={agent} runner={runner} />
      </div>
      <div className="space-y-4">
        <Assistant agent={agent} runner={runner} />
        <Receipts agent={agent} runner={runner} a={detail} />
        <Stop a={detail} />
      </div>
    </div>
  );
}

function Helpers({ agent, runner, a, reload }: { agent: string; runner: RunnerConfig; a: any; reload: () => void }) {
  const kids: { agent: string; budgetKas: string }[] = a.subAgents ?? [];
  const [name, setName] = useState(""); const [budget, setBudget] = useState(""); const [cap, setCap] = useState(""); const [days, setDays] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ bad?: boolean; text: string } | null>(null);
  const [ret, setRet] = useState<string | null>(null);
  const f = a.funding; const topping = f && f.round > 1 && (f.status === "awaiting-deposit" || f.status === "submitting");

  const create = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ note: string }>(runner, "POST", `/v1/agents/${encodeURIComponent(agent)}/subagents`, { id: name.trim(), budgetKas: budget.trim(), maxPerPaymentKas: cap.trim() || budget.trim(), days: days.trim() });
      setMsg({ text: r.note }); setName(""); setBudget(""); setCap(""); setDays(""); reload();
    } catch (e) { setMsg({ bad: true, text: (e as Error).message }); } finally { setBusy(false); }
  };
  const giveBack = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await api<{ document: { says: string } }>(runner, "POST", `/v1/agents/${encodeURIComponent(agent)}/return`, {});
      download("return.json", JSON.stringify(r, null, 2) + "\n", "application/json");
      setRet(r.document?.says ?? "");
    } catch (e) { setMsg({ bad: true, text: (e as Error).message }); } finally { setBusy(false); }
  };

  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Users className="size-4 text-fg-3" /> Helpers</span>} sub="Sub-agents that spend part of this agent's budget, never more" />
      <div className="p-5 pt-4">
        {a.parent ? (
          <>
            <p className="text-[13px] leading-relaxed text-fg-2">This is a helper of <a className="text-fg hover:text-accent" href={href("agents", `h:${a.parent}`)}>{a.parent}</a>. Helpers can't make helpers of their own.</p>
            <div className="mt-4 rounded-xl border border-line-strong p-4">
              <div className="text-[13.5px] font-medium">Done with it?</div>
              <p className="mt-1 text-[12.5px] leading-relaxed text-fg-3">Give its unused budget back to {a.parent}. The runner signs {a.parent}'s half; the other half needs your revocation key, which the runner never holds — so you finish it with one command on your own machine. The helper's grant then ends and its jobs stop.</p>
              <Button size="sm" className="mt-3" disabled={busy} onClick={giveBack}><Download className="size-3.5" /> Return unused budget</Button>
              {ret !== null && (
                <div className="rise mt-3 text-[12.5px] text-fg-2">
                  {ret && <p>{ret}</p>}
                  <p className="mt-2">return.json is in your downloads. Where your revocation key is, run:</p>
                  <Cmd>{"npx @warda_protocol/cli return return.json --key <file with your revocation key>"}</Cmd>
                  <p className="mt-2 text-[12px] text-fg-3">The published CLI (0.4.2) doesn't have <span className="num">return</span> yet. Until it does, from the Warda repo:</p>
                  <Cmd>{"node --experimental-strip-types cli/warda.ts return return.json --key <file with your revocation key>"}</Cmd>
                  <p className="mt-2 text-[12px] text-fg-3">It rebuilds the transaction on your machine, shows what it does, and sends back only a signature. Valid for 30 minutes.</p>
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {kids.length > 0 && (
              <ul className="mb-4 divide-y divide-line rounded-xl border border-line-strong">
                {kids.map((k) => (
                  <li key={k.agent}><a href={href("agents", `h:${k.agent}`)} className="flex items-center gap-3 px-3.5 py-2.5 transition hover:bg-raised/50">
                    <Bot className="size-4 text-fg-3" /><span className="flex-1 text-[13.5px] font-medium">{k.agent}</span><span className="num text-[12px] text-fg-3">{k.budgetKas} KAS</span>
                  </a></li>
                ))}
              </ul>
            )}
            {a.canDelegate ? (
              <div className="grid grid-cols-2 gap-3">
                <Field label="Name" className="col-span-2"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder={`${agent}-helper`} autoCapitalize="off" spellCheck={false} /></Field>
                <Field label="Budget"><KasInput value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
                <Field label="Max per payment" hint="Defaults to the budget"><KasInput value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
                <Field label="Days" hint="Blank: same as the parent"><input inputMode="numeric" className={cn(inputCls, "num")} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} /></Field>
                <div className="flex items-end justify-end"><Button variant="primary" disabled={busy || !name.trim() || !kasOk(budget)} onClick={create}>{busy ? "Signing…" : "Create helper"}</Button></div>
              </div>
            ) : topping ? (
              <p className="text-[13px] leading-relaxed text-fg-2">Your top-up is {f.status === "submitting" ? "becoming the new grant right now" : "waiting for its deposit"}. Once the new grant is live, you can create helpers here.</p>
            ) : (
              <div>
                <p className="text-[13px] leading-relaxed text-fg-2">This agent's grant was made before helpers existed, so it has no room for them. A top-up gives it a new grant that does — same agent, same jobs, same payees.</p>
                <LinkButton size="sm" className="mt-3" href={href("fund", agent)}>Top up to allow helpers</LinkButton>
              </div>
            )}
          </>
        )}
        {msg && <p className={cn("mt-3 text-[12.5px]", msg.bad ? "text-bad" : "text-ok")}>{msg.text}</p>}
      </div>
    </Card>
  );
}

type Client = "code" | "desktop" | "cursor" | "raw";
function Assistant({ agent, runner }: { agent: string; runner: RunnerConfig }) {
  const [mcp, setMcp] = useState<{ url: string; token: string } | null>(null);
  const [c, setC] = useState<Client>("code");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ mcp: { url: string; token: string } }>(runner, "POST", `/v1/agents/${encodeURIComponent(agent)}/token`, {}); setMcp(r.mcp); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const text = useMemo(() => {
    if (!mcp) return "";
    const name = `warda-${agent}`, auth = `Bearer ${mcp.token}`;
    const cfg = JSON.stringify({ mcpServers: { [name]: { url: mcp.url, headers: { Authorization: auth } } } }, null, 2);
    return {
      code: `claude mcp add --transport http ${name} ${mcp.url} \\\n  --header "Authorization: ${auth}"`,
      desktop: `// Settings → Connectors → Add custom connector, or claude_desktop_config.json:\n${cfg}`,
      cursor: `// ~/.cursor/mcp.json\n${cfg}`,
      raw: `URL     ${mcp.url}\nHeader  Authorization: ${auth}\nTools   get_authority, pay, list_workflows, run_workflow, create_job, pause_job, list_runs`,
    }[c];
  }, [mcp, c, agent]);
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Plug className="size-4 text-fg-3" /> Use it from an AI assistant</span>} sub="Claude or Cursor can check what it may spend, pay, and give itself jobs" />
      <div className="p-5 pt-4">
        {!mcp ? (
          <>
            <p className="text-[13px] leading-relaxed text-fg-2">Makes a token that acts as this one agent — inside its grant, like everything else.</p>
            <Button className="mt-3" size="sm" disabled={busy} onClick={make}>{busy ? <Loader2 className="size-3.5 animate-spin" /> : null} Make a token</Button>
          </>
        ) : (
          <div className="rise">
            <Tabs value={c} onChange={setC} items={[{ value: "code", label: "Claude Code" }, { value: "desktop", label: "Claude app" }, { value: "cursor", label: "Cursor" }, { value: "raw", label: "Other" }]} />
            <Cmd>{text}</Cmd>
            <p className="mt-2 text-[12px] text-fg-3">Shown once. Then ask: "What can you spend?" A new token replaces this one.</p>
            <Button size="sm" variant="ghost" className="mt-2" onClick={make}>Make a new token</Button>
          </div>
        )}
        {err && <p className="mt-3 text-[12.5px] text-bad">{err}</p>}
      </div>
    </Card>
  );
}

function Receipts({ agent, runner, a }: { agent: string; runner: RunnerConfig; a: any }) {
  const [on, setOn] = useState<boolean>(!!a.public);
  const [url, setUrl] = useState<string | null>(a.publicUrl ?? null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const flip = async () => {
    setBusy(true); setErr(null);
    try { const r = await api<{ public: boolean; url?: string }>(runner, "POST", `/v1/agents/${encodeURIComponent(agent)}/public`, { on: !on }); setOn(r.public); if (r.url) setUrl(r.url); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[15px] font-semibold"><Globe className="size-4 text-fg-3" /> Public receipts</div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg-2">A read-only link to this agent's limits and payments, for anyone you send it to.</p>
        </div>
        <button role="switch" aria-checked={on} aria-label="Share receipts" disabled={busy} onClick={flip} className={cn("relative mt-1 h-6 w-10 shrink-0 rounded-full transition disabled:opacity-60", on ? "bg-accent" : "bg-line-strong")}>
          <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
        </button>
      </div>
      {on && url && (
        <div className="rise mt-4 flex items-center gap-2 rounded-lg border border-line-strong bg-bg px-3 py-2">
          <Link2 className="size-4 shrink-0 text-fg-3" /><span className="num min-w-0 flex-1 truncate text-[12px] text-fg-2">{url}</span><Copy text={url} label="Copy link" />
        </div>
      )}
      {err && <p className="mt-3 text-[12.5px] text-bad">{err}</p>}
    </Card>
  );
}

function Statement({ agent, runner }: { agent: string; runner: RunnerConfig }) {
  const months = useMemo(() => {
    const d = new Date();
    return [...Array(12)].map((_, i) => {
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
      return { value: m.toISOString().slice(0, 7), label: m.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) };
    });
  }, []);
  const [month, setMonth] = useState(months[0]!.value);
  const [sum, setSum] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const get = async (format?: "csv") => {
    const base = runner.url.replace(/\/+$/, "");
    const r = await fetch(`${base}/v1/agents/${encodeURIComponent(agent)}/statement?month=${month}${format ? `&format=${format}` : ""}`, { headers: { Authorization: `Bearer ${runner.key}` } });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `The runner answered ${r.status}.`); }
    return format === "csv" ? r.text() : r.json();
  };
  useEffect(() => {
    setSum(null); setErr(null);
    get().then((s: any) => setSum(s.totals.payments ? `${s.totals.payments} payment${s.totals.payments === 1 ? "" : "s"} · ${s.totals.paymentsKas} KAS, plus ${s.totals.runnerFeesKas} KAS of runner fees (${s.totals.charged} runs)` : "No payments that month."))
      .catch((e) => setErr((e as Error).message));
  }, [month]); // eslint-disable-line react-hooks/exhaustive-deps

  const csv = () => get("csv").then((t) => download(`warda-${agent}-${month}.csv`, t as string, "text/csv")).catch((e) => setErr((e as Error).message));
  const print = () => {
    const w = window.open("", "_blank");
    get().then((s: any) => {
      if (!w) { setErr("Allow pop-ups for this site to print."); return; }
      const rows = s.rows.map((r: any) => `<tr><td>${esc(r.date)}</td><td>${esc(r.job)}</td><td>${esc(r.kind)}</td><td class=w>${esc(r.what)}</td><td class=n>${esc(r.kas)}</td><td class=t>${esc(r.txid)}</td><td>${esc(r.status)}</td></tr>`).join("");
      w.document.open();
      w.document.write(`<!doctype html><meta charset=utf-8><title>Warda statement · ${esc(s.agent)} · ${esc(s.month)}</title><style>body{font:13px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0}p{color:#444}table{border-collapse:collapse;width:100%;margin-top:18px}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#666}.n{text-align:right;white-space:nowrap}.t{font:11px monospace;word-break:break-all}.w{word-break:break-all}.tot td{font-weight:600;border-top:2px solid #111}</style>` +
        `<h1>Statement — agent ${esc(s.agent)}</h1><p>${esc(s.month)} · generated ${esc(new Date().toISOString().slice(0, 16).replace("T", " "))} UTC · Warda runner</p>` +
        `<table><thead><tr><th>Date</th><th>Job</th><th>Kind</th><th>What</th><th class=n>KAS</th><th>Transaction</th><th>Status</th></tr></thead><tbody>${rows || "<tr><td colspan=7>No payments this month.</td></tr>"}` +
        `<tr class=tot><td colspan=4>Payments (${s.totals.payments})</td><td class=n>${esc(s.totals.paymentsKas)}</td><td colspan=2></td></tr><tr class=tot><td colspan=4>Runner fees (${s.totals.charged} runs)</td><td class=n>${esc(s.totals.runnerFeesKas)}</td><td colspan=2></td></tr><tr class=tot><td colspan=4>Total</td><td class=n>${esc(s.totals.allKas)}</td><td colspan=2></td></tr></tbody></table><p>${esc(s.note)}</p>`);
      w.document.close();
      setTimeout(() => { try { w.focus(); w.print(); } catch { /* */ } }, 300);
    }).catch((e) => { w?.close(); setErr((e as Error).message); });
  };

  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><FileText className="size-4 text-fg-3" /> Monthly statement</span>} sub="Every payment and runner fee, for your records" />
      <div className="p-5 pt-4">
        <Select value={month} onChange={setMonth} options={months} />
        <p className="mt-3 min-h-5 text-[13px] text-fg-2">{err ? <span className="text-bad">{err}</span> : sum ?? <Loader2 className="size-4 animate-spin text-fg-3" />}</p>
        <div className="mt-3 flex gap-2"><Button size="sm" onClick={csv}><Download className="size-3.5" /> CSV</Button><Button size="sm" variant="ghost" onClick={print}><Printer className="size-3.5" /> Print or PDF</Button></div>
      </div>
    </Card>
  );
}

function Stop({ a }: { a: any }) {
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-[15px] font-semibold"><ShieldOff className="size-4 text-fg-3" /> Stop this grant</div>
      {!a.manifest ? <p className="mt-2 text-[13px] text-fg-3">This agent has no grant yet, so there is nothing to stop.</p> : (
        <>
          <p className="mt-1.5 text-[13px] leading-relaxed text-fg-2">Ends the grant and takes back what's left. Only your revocation key can do it — the runner can't, and neither can Warda.</p>
          <Button size="sm" className="mt-3" onClick={() => download("grant.json", JSON.stringify(a.manifest, null, 2) + "\n", "application/json")}><Download className="size-3.5" /> Download grant.json</Button>
          <p className="mt-3 text-[12.5px] text-fg-3">Then, where your revocation key is:</p>
          <Cmd>{"npx @warda_protocol/cli revoke grant.json --key <file with your revocation key>"}</Cmd>
          <p className="mt-2 text-[12px] text-fg-3">Download it just before you run it: the grant moves after every payment.</p>
        </>
      )}
    </Card>
  );
}
