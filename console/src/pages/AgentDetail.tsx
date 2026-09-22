import { useState } from "react";
import { ArrowLeft, Ban, ExternalLink, FileJson, ShieldCheck, Settings2, Wallet } from "lucide-react";
import { useData } from "@/lib/data";
import { ago, kas, short } from "@/lib/format";
import { explorerAddress, explorerTx } from "@/lib/kaspa";
import { cn } from "@/lib/cn";
import { href } from "@/lib/router";
import { ruleWords, type AgentView } from "@/lib/model";
import { AgentMark, ActivityList, AuthorityBlock, BlockedCard } from "@/components/agent";
import { Badge, Card, CardHeader, Copy, Empty, External, LinkButton, Row, Skeleton, StatusBadge, Tabs } from "@/components/ui";
import { agentName } from "./shared";
import { ApprovalsBanner, JobsTab, useHostedAgent } from "@/components/jobs";
import { ManageTab } from "@/components/manage";
import { Controls, Reconciliation, RealRefusals } from "@/components/controls";

type T = "overview" | "jobs" | "manage" | "payments" | "blocked" | "proof";

export function AgentDetail({ id, tab }: { id: string; tab?: string }) {
  const { agents, loading } = useData();
  const a = agents.find((x) => x.key === id) ?? agents.find((x) => x.id === id);
  const [t, setT] = useState<T>((["overview", "jobs", "manage", "payments", "blocked", "proof"].includes(tab ?? "") ? tab : "overview") as T);

  if (!a) {
    return loading ? (
      <div><Skeleton className="h-8 w-48" /><Skeleton className="mt-8 h-64 w-full rounded-[14px]" /></div>
    ) : (
      <Card><Empty title="Agent not found" action={<LinkButton href={href("agents")}>Back to agents</LinkButton>}>
        It may belong to a runner account you are not signed in to.
      </Empty></Card>
    );
  }

  const paid = a.payments.filter((p) => p.outcome !== "blocked");
  const blocked = a.payments.filter((p) => p.outcome === "blocked");
  const parent = a.parent ? agents.find((x) => x.id === a.parent || x.label === a.parent) : null;

  return (
    <>
      <a href={href("agents")} className="mb-6 inline-flex items-center gap-1.5 text-[13px] text-fg-3 transition hover:text-fg"><ArrowLeft className="size-4" /> Agents</a>

      <div className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-4">
          <AgentMark agent={a} size={52} className="rounded-[14px]" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em]">{agentName(a)}</h1>
              <StatusBadge status={a.status} />
              <Badge>{a.source === "hosted" ? "Hosted" : "Published"}</Badge>
            </div>
            {a.mission && <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-fg-2">{a.mission}</p>}
            {parent && <p className="mt-1.5 text-[13px] text-fg-3">Sub-agent of <a className="text-fg-2 hover:text-accent" href={href("agents", parent.key)}>{agentName(parent)}</a></p>}
            {a.parent && !parent && <p className="mt-1.5 text-[13px] text-fg-3">Sub-agent of {a.parent}</p>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {a.source === "hosted" ? (
            <>
              <LinkButton href={href("agents", a.key, "jobs")} onClick={() => setT("jobs")}><Settings2 className="size-4" /> Jobs</LinkButton>
              {a.status !== "ended" && <LinkButton variant="primary" href={href("fund", a.id)}><Wallet className="size-4" /> Top up</LinkButton>}
            </>
          ) : (
            <LinkButton href={`/agent-${a.id}.html`}>Public page <ExternalLink className="size-4" /></LinkButton>
          )}
        </div>
      </div>

      {a.source === "hosted" ? <Hosted agent={a.id} t={t} setT={setT} /> : null}
      <AuthorityBlock a={a} />

      <Tabs className="mt-8" value={t} onChange={setT} items={[
        { value: "overview", label: "Overview" },
        ...(a.source === "hosted" ? [{ value: "jobs" as T, label: "Jobs" }, { value: "manage" as T, label: "Manage" }] : []),
        { value: "payments", label: "Payments", count: paid.length },
        { value: "blocked", label: "Blocked", count: blocked.length },
        { value: "proof", label: "Proof" },
      ]} />

      <div className="mt-6">
        {t === "overview" && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
            <Card>
              <CardHeader title="Recent payments" action={paid.length > 6 ? <button className="text-[13px] text-fg-3 hover:text-fg" onClick={() => setT("payments")}>View all</button> : null} />
              <div className="mt-3"><ActivityList rows={a.payments.slice(0, 6).map((p) => ({ p, a }))} empty={<Empty title="No payments yet" className="py-10">This agent has not paid for anything.</Empty>} /></div>
            </Card>
            <div className="space-y-4">
              <Counters a={a} />
              <Payees a={a} />
              <Reconciliation a={a} />
              <Card>
                <CardHeader title="Blocked" sub={blocked.length ? `${blocked.length} real attempt${blocked.length === 1 ? "" : "s"} refused` : "Nothing refused so far"} />
                <div className="space-y-3 p-5">
                  {blocked.slice(0, 2).map((p, i) => <BlockedCard key={i} p={p} a={a} />)}
                  {!blocked.length && <p className="text-[13px] leading-relaxed text-fg-3">Every attempt stayed within the grant. See <button className="text-fg-2 underline-offset-4 hover:underline" onClick={() => setT("blocked")}>what it would refuse</button>.</p>}
                </div>
              </Card>
            </div>
          </div>
        )}

        {t === "payments" && (
          <Card><ActivityList rows={paid.map((p) => ({ p, a }))} empty={<Empty title="No payments yet">When this agent pays for something, each payment appears here with its transaction.</Empty>} /></Card>
        )}

        {t === "blocked" && <Blocked a={a} />}
        {t === "jobs" && a.source === "hosted" && <HostedJobs agent={a.id} />}
        {t === "manage" && a.source === "hosted" && <HostedManage agent={a.id} />}
        {t === "proof" && <Proof a={a} />}
      </div>
    </>
  );
}

/** Coins this grant has paid, still sitting where they landed. */
function Coins({ a }: { a: AgentView }) {
  if (!a.activity.coins.length) return null;
  return (
    <Card>
      <CardHeader title="Coins it has paid" sub="Still visible at the payee, by transaction" />
      <ul className="mt-2 divide-y divide-line">
        {a.activity.coins.map((c) => (
          <li key={c.txid} className="flex items-center gap-3 px-5 py-2.5 text-[13px]">
            <span className="num flex-1">{kas(c.amount)} <span className="text-[11.5px] text-fg-3">KAS</span></span>
            {c.daa && <span className="num text-[12px] text-fg-3">DAA {c.daa}</span>}
            <a className="num text-[12px] text-fg-3 hover:text-accent" href={explorerTx(c.txid, a.network)} target="_blank" rel="noopener">{c.txid.slice(0, 10)}…</a>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Payees({ a }: { a: AgentView }) {
  return (
    <Card>
      <CardHeader title="Who it may pay" sub="Fixed when the grant was made" />
      <ul className="mt-3 divide-y divide-line">
        {a.payees.length ? a.payees.map((p) => (
          <li key={p.address} className="flex items-center gap-3 px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-[13.5px] font-medium">{p.label ?? <span className="text-fg-2">Unlisted</span>}{p.ours !== undefined && <Badge tone={p.ours ? "info" : "muted"}>{p.ours ? "ours" : "not ours"}</Badge>}</div>
              <div className="num truncate text-[11.5px] text-fg-3">{short(p.address, 16, 8)}</div>
            </div>
            <Copy text={p.address} label="Copy address" />
          </li>
        )) : <li className="px-5 pb-5 text-[13px] text-fg-3">{a.source === "hosted" && !a.grantAddress ? "Shown once the grant is funded." : "No payees in this reading."}</li>}
      </ul>
      {a.payees.some((p) => !p.label) && <p className="border-t border-line px-5 py-3 text-[12px] text-fg-3">Names come from the Services registry. Unlisted means the address isn't in it.</p>}
    </Card>
  );
}

function Blocked({ a }: { a: AgentView }) {
  const blocked = a.payments.filter((p) => p.outcome === "blocked");
  return (
    <div className="space-y-6">
      <RealRefusals a={a} />
      <Card>
        <CardHeader title="Refused attempts" sub="Payments this agent really tried that fell outside its grant" />
        <div className="grid gap-3 p-5 md:grid-cols-2">
          {blocked.length ? blocked.map((p, i) => <BlockedCard key={i} p={p} a={a} />) : (
            <div className="md:col-span-2"><Empty icon={<ShieldCheck className="size-5" />} title="Nothing refused" className="py-8">Every payment this agent attempted was within its limits.</Empty></div>
          )}
        </div>
      </Card>
      {a.derived.length > 0 && (
        <Card>
          <CardHeader title="What it would refuse" sub="Worked out from the grant's rules — examples, not events" />
          <ul className="mt-3 divide-y divide-line">
            {a.derived.map((d, i) => (
              <li key={i} className="px-5 py-4">
                <div className="flex items-center gap-2 text-[13.5px] font-medium"><Ban className="size-4 text-fg-3" /> {ruleWords(d.rule)}<span className="font-normal text-fg-3">· {d.attempted}</span></div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-3">{d.why}</p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function Proof({ a }: { a: AgentView }) {
  const same = !!a.principalKey && a.principalKey === a.ownerKey;
  const rows: [string, string | null, string?][] = [
    ["Grant address", a.grantAddress, a.grantAddress ? explorerAddress(a.grantAddress, a.network) : undefined],
    ["Covenant", a.covenantId],
    ["Template", a.template],
    ["Agent key", a.agentKey],
    ["Principal — funded it, and it returns there", a.principalKey],
    ["Revocation — can stop it, and receives nothing", a.ownerKey],
  ];
  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="space-y-4">
      <Card>
        <CardHeader title="On-chain identity" sub="Everything here can be checked on the Kaspa explorer" />
        <dl className="mt-2 divide-y divide-line px-5 pb-2">
          {rows.map(([k, v, link]) => (
            <div key={k} className="flex flex-col gap-1 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
              <dt className="shrink-0 text-[13px] text-fg-3">{k}</dt>
              <dd className="flex min-w-0 items-center gap-1">
                <span className="num truncate text-[12.5px] text-fg-2" title={v ?? ""}>{v ? short(v, 18, 10) : "—"}</span>
                {v && <Copy text={v} />}
                {link && <a href={link} target="_blank" rel="noopener" className="grid size-7 place-items-center rounded-md text-fg-3 hover:bg-raised hover:text-fg" aria-label="Open in explorer"><ExternalLink className="size-3.5" /></a>}
              </dd>
            </div>
          ))}
        </dl>
        <p className={cn("border-t border-line px-5 py-3 text-[12px] leading-relaxed", same ? "text-warn" : "text-fg-3")}>
          {same ? "The revocation key is the same key as the principal: one thing to keep and one thing to lose. A separate stop key can end a grant and cannot take a sompi of it."
            : "The stop key is separate from the funding key: whoever holds it can end this grant and cannot take a sompi of it."}
        </p>
      </Card>
      <Coins a={a} />
      <Controls a={a} />
      </div>
      <Card className="p-5">
        <div className="flex items-center gap-2 text-[15px] font-semibold"><ShieldCheck className="size-4 text-accent" /> Why you can trust this</div>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-2">
          The rules above are part of the grant's script on Kaspa. The network checks them on every payment, so neither the agent nor Warda can spend outside them.
        </p>
        <div className="mt-4 space-y-2 text-[13px]">
          {a.source === "published" && <div><External href={`/agent-${a.id}.json`}><FileJson className="size-3.5" /> Raw reading</External></div>}
          <div><External href="/proof.html">How the proof works</External></div>
        </div>
        {a.checkedAt && <p className="mt-4 border-t border-line pt-3 text-[12px] text-fg-3">Read from the chain {ago(a.checkedAt)} · {kas(a.onChain)} KAS at the grant address</p>}
      </Card>
    </div>
  );
}

function Hosted({ agent }: { agent: string; t: T; setT: (t: T) => void }) {
  const h = useHostedAgent(agent);
  return <ApprovalsBanner runner={h.runner} approvals={h.approvals} onDone={h.reload} />;
}

function HostedJobs({ agent }: { agent: string }) {
  const h = useHostedAgent(agent);
  return <JobsTab agent={agent} h={h} />;
}

function HostedManage({ agent }: { agent: string }) {
  const h = useHostedAgent(agent);
  return <ManageTab agent={agent} runner={h.runner} detail={h.detail} reload={h.reload} />;
}

/** What the reading's own counters say, beside what its log holds. */
function Counters({ a }: { a: AgentView }) {
  if (a.activity.payments === null && a.activity.paid === null) return null;
  const logged = a.payments.filter((p) => p.outcome === "paid" || p.outcome === "paid-not-served").length;
  return (
    <Card>
      <CardHeader title="What it has paid" sub="The covenant's count, beside its own log" />
      <dl className="divide-y divide-line px-5 pb-2 pt-1">
        <Row label="Payments">{a.activity.payments ?? "—"}{a.activity.payments !== null && a.activity.payments !== logged && <span className="text-fg-3"> · {logged} in its own log</span>}</Row>
        <Row label="Paid"><span className="num">{kas(a.activity.paid)} KAS</span></Row>
        <Row label="Outside the allowlist"><span className={cn("num", (a.activity.outside ?? 0) > 0 && "text-bad")}>{kas(a.activity.outside)} KAS</span></Row>
      </dl>
    </Card>
  );
}
