import { useEffect, useState } from "react";
import { ArrowRight, Coins, ExternalLink, LogIn, Wallet } from "lucide-react";
import { useData } from "@/lib/data";
import { api, RunnerError } from "@/lib/runner";
import { kas } from "@/lib/format";
import { href, go } from "@/lib/router";
import { cn } from "@/lib/cn";
import { AgentMark } from "@/components/agent";
import { Button, Card, CardHeader, Empty, LinkButton, PageHeader, Row, Skeleton } from "@/components/ui";
import { Field, KasInput, inputCls, kasOk } from "@/components/form";
import { DepositPanel, type Funding } from "@/components/deposit";
import { agentName } from "./shared";

export function Fund({ agent }: { agent?: string }) {
  const { runner, agents, loading, reload } = useData();
  const hosted = agents.filter((a) => a.source === "hosted" && a.status !== "ended");
  const a = hosted.find((x) => x.id === agent) ?? null;

  if (!runner.key) {
    return (
      <>
        <PageHeader title="Fund" sub="Add money to a hosted agent. It moves to a new grant with the limits you choose." />
        <Card><Empty icon={<LogIn className="size-5" />} title="Sign in to the runner" action={<LinkButton variant="primary" href={href("account")}>Sign in</LinkButton>}>Top-ups are for hosted agents on your runner account.</Empty></Card>
      </>
    );
  }

  return (
    <>
      <PageHeader title="Fund" sub="Add money to a hosted agent. It moves to a new grant with the limits you choose — same agent, same jobs, same payees." />
      <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
        <Card className="h-fit overflow-hidden">
          <div className="px-5 pb-2 pt-4 text-[12px] font-medium text-fg-3">Choose an agent</div>
          {loading && !agents.length ? <div className="space-y-2 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div> : hosted.length ? (
            <ul className="pb-2">
              {hosted.map((x) => (
                <li key={x.key}>
                  <button onClick={() => go("fund", x.id)} className={cn("flex w-full items-center gap-3 px-4 py-2.5 text-left transition", x.id === agent ? "bg-raised" : "hover:bg-raised/50")}>
                    <AgentMark agent={x} size={30} />
                    <span className="min-w-0 flex-1"><span className="block truncate text-[13.5px] font-medium">{agentName(x)}</span>
                      <span className="num block text-[12px] text-fg-3">{x.remaining === null ? "not funded" : `${kas(x.remaining)} of ${kas(x.budget)} KAS`}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          ) : <p className="px-5 pb-5 text-[13px] text-fg-3">No hosted agents yet. <a className="text-fg-2 hover:text-accent" href={href("new")}>Create one</a>.</p>}
        </Card>

        <div className="space-y-4">
          {a ? <TopUp key={a.id} agent={a.id} current={{ budget: a.budget, cap: a.maxPerPayment, remaining: a.remaining, expiresIn: a.expiresIn }} onDone={reload} />
            : <Card><Empty icon={<Wallet className="size-5" />} title="Pick an agent to top up">Its current grant keeps working until the new one exists.</Empty></Card>}
          <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-line-strong bg-raised"><Coins className="size-5 text-fg-2" /></div>
              <div><div className="text-[14px] font-semibold">Pay with USDC or USDT</div><p className="mt-0.5 text-[13px] text-fg-3">Swapped to KAS from Base, Ethereum, Arbitrum and more. Mainnet only.</p></div>
            </div>
            <LinkButton className="shrink-0" href="/app-classic#/fund">Stablecoin funding <ExternalLink className="size-4" /></LinkButton>
          </Card>
        </div>
      </div>
    </>
  );
}

function TopUp({ agent, current, onDone }: { agent: string; current: { budget: number | null; cap: number | null; remaining: number | null; expiresIn: string | null }; onDone: () => void }) {
  const { runner } = useData();
  const [budget, setBudget] = useState(current.budget ? String(current.budget) : "1");
  const [cap, setCap] = useState(current.cap ? String(current.cap) : "0.1");
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<Funding | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api<{ funding: (Funding & { round?: number }) | null; previousGrant?: string }>(runner, "GET", `/v1/agents/${encodeURIComponent(agent)}`)
      .then((r) => { if (r.funding && (r.funding.round ?? 1) > 1 && !["funded", "refunded"].includes(r.funding.status)) setPending(r.funding); })
      .catch(() => {}).finally(() => setChecked(true));
  }, [agent, runner]);

  const b = Number(budget), c = Number(cap), d = Number(days);
  const problem = !kasOk(budget) ? "Set a budget in KAS." : !kasOk(cap) || c > b ? "Max per payment must be positive and at most the budget." : !(d >= 1 && d <= 365) ? "1 to 365 days." : null;

  const go_ = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ deposit: Funding }>(runner, "POST", `/v1/agents/${encodeURIComponent(agent)}/topup`, { budgetKas: budget.trim(), maxPerPaymentKas: cap.trim(), days: d });
      setPending(r.deposit);
    } catch (e) { setErr(e instanceof RunnerError ? e.message : "Could not start the top-up."); }
    finally { setBusy(false); }
  };

  if (!checked) return <Card className="p-6"><Skeleton className="h-40 w-full" /></Card>;
  if (pending) return <DepositPanel runner={runner} agent={agent} initial={pending} kind="topup" onFunded={onDone} />;

  return (
    <Card>
      <CardHeader title={`Top up ${agent}`} sub={`Now ${kas(current.remaining)} KAS left${current.expiresIn ? ` · ends in ${current.expiresIn}` : ""}`} />
      <div className="grid gap-5 p-5 sm:grid-cols-3">
        <Field label="New budget" hint="For the new grant."><KasInput value={budget} onChange={(e) => setBudget(e.target.value)} /></Field>
        <Field label="Max per payment"><KasInput value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
        <Field label="Lasts">
          <span className="relative block"><input inputMode="numeric" className={cn(inputCls, "num pr-14")} value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-medium text-fg-3">days</span></span>
        </Field>
      </div>
      <dl className="mx-5 divide-y divide-line border-t border-line">
        <Row label="Per period"><span className="num">{kasOk(cap) ? `${+(c * 5).toFixed(8)} KAS / 100 s` : "—"}</span></Row>
        <Row label="What's left in the current grant">Stays under your key. Only you can take it back.</Row>
      </dl>
      {err && <p className="mx-5 mt-4 rounded-lg bg-bad/10 px-3 py-2.5 text-[13px] text-bad">{err}</p>}
      <div className="flex items-center justify-end gap-3 p-5">
        {problem && <span className="text-[12.5px] text-fg-3">{problem}</span>}
        <Button variant="primary" disabled={!!problem || busy} onClick={go_}>{busy ? "Preparing…" : "Get deposit address"} <ArrowRight className="size-4" /></Button>
      </div>
    </Card>
  );
}
