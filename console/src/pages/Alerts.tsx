import { useCallback, useEffect, useState } from "react";
import { BellRing, CircleCheck, Loader2, LogIn, Send } from "lucide-react";
import { useData } from "@/lib/data";
import { api } from "@/lib/runner";
import { href } from "@/lib/router";
import { cn } from "@/lib/cn";
import { AgentMark } from "@/components/agent";
import { Button, Card, CardHeader, Empty, LinkButton, PageHeader, Tabs } from "@/components/ui";
import { go } from "@/lib/router";
import { AlertRules } from "./AlertRules";
import { agentName } from "./shared";

interface Wf { id: string; name: string; enabled: boolean; trigger: { type: string; when?: string; percent?: number; hours?: number } }
type Kind = "low" | "end";

const RULES: Record<Kind, { label: string; hint: string; wf: (agent: string, to: string) => object; match: (w: Wf) => boolean }> = {
  low: {
    label: "Running low", hint: "Under 20% of its budget left",
    match: (w) => w.trigger.type === "grant" && w.trigger.when === "budget-below",
    wf: (agent, to) => ({ agent, name: "Budget low", trigger: { type: "grant", when: "budget-below", percent: 20 },
      then: [{ type: "notify", channel: "telegram", to, text: "{{agent}} has {{grant.availableKas}} KAS left." }] }),
  },
  end: {
    label: "Nearly over", hint: "Its grant ends within 24 hours",
    match: (w) => w.trigger.type === "grant" && w.trigger.when === "expiring-within",
    wf: (agent, to) => ({ agent, name: "Grant ending", trigger: { type: "grant", when: "expiring-within", hours: 24 },
      then: [{ type: "notify", channel: "telegram", to, text: "{{agent}}'s grant ends in {{grant.hoursToExpiry}} hours, with {{grant.availableKas}} KAS left. After that it can pay no one, and what is left is yours to take back." }] }),
  },
};

function Toggle({ on, busy, onClick, label }: { on: boolean; busy?: boolean; onClick: () => void; label: string }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={busy} onClick={onClick}
      className={cn("relative h-6 w-10 shrink-0 rounded-full transition disabled:opacity-60", on ? "bg-accent" : "bg-line-strong")}>
      <span className={cn("absolute top-0.5 size-5 rounded-full bg-white shadow transition-all", on ? "left-[18px]" : "left-0.5")} />
    </button>
  );
}

function HostedAlerts() {
  const { runner, agents } = useData();
  const hosted = agents.filter((a) => a.source === "hosted" && a.status !== "ended" && a.status !== "expired");
  const [tg, setTg] = useState<{ available: boolean; connected: boolean } | null>(null);
  const [wfs, setWfs] = useState<Record<string, Wf[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [chat, setChat] = useState("");

  const loadTg = useCallback(() => api<{ available: boolean; connected: boolean }>(runner, "GET", "/v1/telegram").then((r) => { setTg(r); return r.connected; }).catch(() => false), [runner]);
  const ids = hosted.map((a) => a.id).join(",");
  const loadWfs = useCallback(() => {
    for (const id of ids.split(",").filter(Boolean))
      api<{ workflows?: Wf[] }>(runner, "GET", `/v1/agents/${encodeURIComponent(id)}`).then((a) => setWfs((m) => ({ ...m, [id]: a.workflows ?? [] }))).catch(() => {});
  }, [ids, runner]);
  useEffect(() => { if (runner.key) { loadTg(); loadWfs(); } }, [runner.key, loadTg, loadWfs]);

  const connect = async () => {
    const w = window.open("about:blank", "_blank");
    setErr(null);
    try {
      const r = await api<{ url: string }>(runner, "POST", "/v1/telegram/link", {});
      if (w) w.location.href = r.url; else location.href = r.url;
      setLinking(true);
      let n = 0;
      const t = setInterval(async () => { if (++n > 60 || (await loadTg())) { clearInterval(t); setLinking(false); } }, 3000);
    } catch (e) { w?.close(); setErr((e as Error).message); }
  };

  const toggle = async (agent: string, kind: Kind) => {
    const found = (wfs[agent] ?? []).find(RULES[kind].match);
    setBusy(agent + kind); setErr(null);
    try {
      if (!found) await api(runner, "POST", "/v1/workflows", RULES[kind].wf(agent, chat.trim()));
      else await api(runner, "PATCH", `/v1/workflows/${found.id}`, { enabled: !found.enabled });
      const a = await api<{ workflows?: Wf[] }>(runner, "GET", `/v1/agents/${encodeURIComponent(agent)}`);
      setWfs((m) => ({ ...m, [agent]: a.workflows ?? [] }));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };

  if (!runner.key) {
    return (
      <>
        <Card><Empty icon={<LogIn className="size-5" />} title="Sign in to the runner" action={<LinkButton variant="primary" href={href("account")}>Sign in</LinkButton>}>Alerts run on the runner, for your hosted agents.</Empty></Card>
      </>
    );
  }

  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader title="Per agent" sub="Checked by the runner every minute" />
          {err && <p className="mx-5 mt-3 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{err}</p>}
          <div className="mt-3">
            {!hosted.length ? <Empty icon={<BellRing className="size-5" />} title="No live hosted agents">Alerts are for agents the runner hosts.</Empty> : (
              <ul className="divide-y divide-line">
                {hosted.map((a) => {
                  const list = wfs[a.id];
                  return (
                    <li key={a.key} className="flex flex-col gap-4 px-5 py-4 md:flex-row md:items-center">
                      <a href={href("agents", a.key)} className="flex min-w-0 flex-1 items-center gap-3"><AgentMark agent={a} size={30} /><span className="truncate text-[14px] font-medium">{agentName(a)}</span></a>
                      <div className="flex flex-col gap-3 sm:flex-row sm:gap-6">
                        {(Object.keys(RULES) as Kind[]).map((k) => {
                          const w = list?.find(RULES[k].match);
                          return (
                            <div key={k} className="flex items-center justify-between gap-3 sm:justify-start">
                              <span><span className="block text-[13px]">{RULES[k].label}</span><span className="block text-[11.5px] text-fg-3">{RULES[k].hint}</span></span>
                              {list === undefined ? <Loader2 className="size-4 animate-spin text-fg-3" /> : <Toggle label={`${RULES[k].label} for ${a.id}`} on={!!w?.enabled} busy={busy === a.id + k} onClick={() => toggle(a.id, k)} />}
                            </div>
                          );
                        })}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
          <div className="border-t border-line px-5 py-3">
            <p className="text-[12px] text-fg-3">Jobs that ask you first always message you on Telegram, whatever is set here.</p>
            <label className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-fg-3">
              Send new alerts to another Telegram chat instead
              <input value={chat} onChange={(e) => setChat(e.target.value.replace(/[^\d-]/g, ""))} placeholder="chat id — blank: yours"
                className="num h-7 w-40 rounded-md border border-line-strong bg-bg px-2 text-[12px] text-fg placeholder:text-fg-3 focus:border-accent/60 focus:outline-none" />
            </label>
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <div className="flex items-center gap-2 text-[15px] font-semibold"><Send className="size-4 text-accent" /> Telegram</div>
            {tg === null ? <Loader2 className="mt-4 size-4 animate-spin text-fg-3" /> : tg.connected ? (
              <p className="mt-3 flex items-center gap-2 text-[13.5px] text-ok"><CircleCheck className="size-4" /> Connected — alerts come to your phone.</p>
            ) : !tg.available ? (
              <p className="mt-3 text-[13px] text-fg-3">This runner has no Telegram bot yet.</p>
            ) : (
              <>
                <p className="mt-2 text-[13px] leading-relaxed text-fg-2">One tap in Telegram links it to your account. Nothing is posted anywhere else.</p>
                <Button variant="primary" className="mt-4" onClick={connect} disabled={linking}>{linking ? <><Loader2 className="size-4 animate-spin" /> Waiting for Start…</> : "Connect Telegram"}</Button>
              </>
            )}
            {tg && !tg.connected && tg.available && <p className="mt-3 text-[12px] text-fg-3">Alerts you turn on now start arriving once it's connected.</p>}
          </Card>
          <Card className="p-5">
            <div className="text-[14px] font-semibold">Watch an address or any grant</div>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-2">Money arrived, running out, nearly over and spending spikes, for any address or tracked grant — run by your console account.</p>
            <LinkButton className="mt-4" href={href("alerts", "rules")}>Build a rule</LinkButton>
          </Card>
        </div>
      </div>
    </>
  );
}

export function Alerts({ tab, arg }: { tab?: string; arg?: string }) {
  const t = tab === "rules" || tab === "watch" ? "rules" : "agents";
  return (
    <>
      <PageHeader title="Alerts" sub="A Telegram message when something needs you. Alerts only tell you — they never move money." />
      <Tabs className="mb-6" value={t} onChange={(v) => go("alerts", v)} items={[{ value: "agents", label: "Hosted agents" }, { value: "rules", label: "Addresses & grants" }]} />
      {t === "agents" ? <HostedAlerts /> : <AlertRules watch={tab === "watch" ? arg : undefined} />}
    </>
  );
}
