import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, KeyRound, Plus, ShieldCheck, Store, Trash2, Wallet, LogIn , CircleCheck } from "lucide-react";
import { useData } from "@/lib/data";
import { api, RunnerError } from "@/lib/runner";
import { isAddress, ownerKey } from "@/lib/kaspa";
import { hasKasware, kaswareOwner } from "@/lib/wallet";
import { href, go } from "@/lib/router";
import { short } from "@/lib/format";
import { cn } from "@/lib/cn";
import { Button, Card, LinkButton, PageHeader, Row } from "@/components/ui";
import { Field, KasInput, inputCls, kasOk } from "@/components/form";
import { DepositPanel, type Funding } from "@/components/deposit";
import { DraftJob } from "@/components/jobs";

const STEPS = ["Limits", "Payees & owner", "Fund", "Give it a job"];
const DRAFT = "warda.next.draft";

interface Draft { name: string; budget: string; cap: string; days: string; picked: string[]; custom: string[]; owner: string }
const EMPTY: Draft = { name: "", budget: "1", cap: "0.1", days: "30", picked: [], custom: [], owner: "" };

export function NewAgent() {
  const { runner, setRunner, services, reload } = useData();
  const [step, setStep] = useState(0);
  const [d, setD] = useState<Draft>(() => { try { return { ...EMPTY, ...JSON.parse(sessionStorage.getItem(DRAFT) || "{}") }; } catch { return EMPTY; } });
  const [add, setAdd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [funding, setFunding] = useState<{ agent: string; f: Funding } | null>(null);
  const [ownerNote, setOwnerNote] = useState<string | null>(null);
  const set = (p: Partial<Draft>) => setD((x) => ({ ...x, ...p }));

  useEffect(() => { try { sessionStorage.setItem(DRAFT, JSON.stringify(d)); } catch { /* */ } }, [d]);

  // An agent created earlier and not funded yet: pick up where it was left.
  useEffect(() => {
    if (!runner.key || !runner.agent || funding) return;
    api<{ agent: string; funding: Funding | null }>(runner, "GET", `/v1/agents/${encodeURIComponent(runner.agent)}`)
      .then((a) => { if (a.funding && !["funded", "refunded"].includes(a.funding.status)) { setFunding({ agent: a.agent, f: a.funding }); setStep(2); } })
      .catch(() => {});
  }, [runner.key]); // eslint-disable-line react-hooks/exhaustive-deps

  const prefix = runner.url.includes("mainnet") ? "kaspa" : "kaspatest";
  const svc = services.filter((s) => s.address && s.address.startsWith(prefix + ":"));
  const payees = useMemo(() => [...new Set([...d.picked, ...d.custom])], [d.picked, d.custom]);
  const owner = ownerKey(d.owner);
  const b = Number(d.budget), c = Number(d.cap), days = Number(d.days);

  const problem = (s: number): string | null => {
    if (s === 0) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,39}$/.test(d.name.trim())) return "Name it: 3–40 letters, digits, - or _.";
      if (!kasOk(d.budget)) return "Set a budget in KAS.";
      if (!kasOk(d.cap) || c > b) return "A single payment must be positive and no more than the budget.";
      if (!(days >= 1 && days <= 365)) return "A grant lasts 1 to 365 days.";
    }
    if (s === 1) {
      if (!payees.length) return "Choose at least one service or address it may pay.";
      if (!owner) return d.owner.trim() ? "That isn't a Kaspa address or public key." : "Add your Kaspa address — it is the key that can stop the grant.";
    }
    return null;
  };

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api<{ agent: string; deposit: Funding }>(runner, "POST", "/v1/agents", {
        id: d.name.trim(),
        funding: { principal: owner, payees, limits: { budgetKas: d.budget.trim(), maxPerPaymentKas: d.cap.trim(), days } },
      });
      setRunner({ ...runner, agent: r.agent });
      setFunding({ agent: r.agent, f: r.deposit });
      setStep(2);
      try { sessionStorage.removeItem(DRAFT); } catch { /* */ }
    } catch (e) {
      setErr(e instanceof RunnerError ? e.message : "Could not create the agent.");
    } finally { setBusy(false); }
  };

  const useKasware = async () => {
    setOwnerNote(null);
    try { const o = await kaswareOwner(); set({ owner: o.address }); setOwnerNote("From KasWare. Only its public key is sent."); }
    catch (e) { setOwnerNote((e as Error).message); }
  };

  if (!runner.key) {
    return (
      <>
        <PageHeader title="New agent" sub="Every agent gets its own grant: money it can spend, and rules the network enforces on every payment." />
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2">
          <Card className="p-6">
            <div className="grid size-11 place-items-center rounded-xl border border-line-strong bg-raised"><LogIn className="size-5 text-accent" /></div>
            <h2 className="mt-5 text-[18px] font-semibold">Sign in to the runner</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-fg-2">Hosted agents run on Warda's runner. Sign in with your account key, then come back here.</p>
            <LinkButton variant="primary" className="mt-5" href={href("account")}>Sign in</LinkButton>
          </Card>
          <Card className="p-6">
            <div className="grid size-11 place-items-center rounded-xl border border-line-strong bg-raised"><KeyRound className="size-5 text-fg-2" /></div>
            <h2 className="mt-5 text-[18px] font-semibold">Or make your own grant</h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-fg-2">Your software holds the agent key and you plug the grant into the SDK, CLI or MCP.</p>
            <LinkButton className="mt-5" href="#/create">Create a grant</LinkButton>
          </Card>
        </div>
      </>
    );
  }

  const blocker = problem(step);
  return (
    <>
      <PageHeader title="New agent" sub="Set what it may spend and who it may pay. The network enforces both, on every payment."
        actions={<LinkButton variant="ghost" href="#/create">Own grant instead</LinkButton>} />

      <ol className="mb-8 flex items-center gap-2 sm:gap-3">
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2 sm:gap-3">
            <span className={cn("grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold ring-1 transition",
              i < step ? "bg-accent text-accent-ink ring-accent" : i === step ? "bg-accent/15 text-accent ring-accent/50" : "bg-raised text-fg-3 ring-line-strong")}>
              {i < step ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn("hidden text-[13px] font-medium sm:inline", i === step ? "text-fg" : "text-fg-3")}>{s}</span>
            {i < STEPS.length - 1 && <span className={cn("h-px flex-1", i < step ? "bg-accent/50" : "bg-line-strong")} />}
          </li>
        ))}
      </ol>

      {step >= 3 && funding ? (
        /* The last step of the classic console, and the one that makes the
           two minutes worth anything: an agent with a grant and no job is a
           funded thing that does nothing. */
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="p-6">
            <h2 className="text-[18px] font-semibold tracking-[-0.01em]">Give it a job</h2>
            <p className="mt-1.5 max-w-xl text-[13.5px] leading-relaxed text-fg-2">
              {funding.agent} is funded and its grant is live. Tell it what to do in a sentence — the runner drafts the job,
              you see exactly what it will fire on and what it will pay before anything is added.
            </p>
            <div className="mt-5"><DraftJob agent={funding.agent} runner={runner} onAdded={reload} standalone={false} /></div>
          </Card>
          <Card className="h-fit p-5">
            <div className="flex items-center gap-2 text-[15px] font-semibold"><CircleCheck className="size-4 text-ok" /> {funding.agent}</div>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-2">Funded, with you as its owner. It can only pay the payees you listed, and only within the limits you set.</p>
            <div className="mt-5 flex flex-col gap-2">
              <Button variant="primary" onClick={() => go("agents", `h:${funding.agent}`)}>Open agent</Button>
              <LinkButton variant="ghost" href={href("agents", `h:${funding.agent}`, "jobs")}>All its jobs</LinkButton>
            </div>
            <p className="mt-4 text-[12px] leading-relaxed text-fg-3">A job is optional — you can add one any time, and an agent with none simply never spends.</p>
          </Card>
        </div>
      ) : step >= 2 && funding ? (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <DepositPanel runner={runner} agent={funding.agent} initial={funding.f} onFunded={() => { setStep(3); setRunner({ ...runner, agent: undefined }); reload(); }} />
          <Card className="h-fit p-5">
            <div className="text-[15px] font-semibold">{funding.agent}</div>
            <p className="mt-2 text-[13px] leading-relaxed text-fg-2">The runner made the agent's key. When your payment arrives it creates the grant in one transaction, with you as its owner.</p>
            <div className="mt-5 flex flex-col gap-2">
              <Button onClick={() => go("agents", `h:${funding.agent}`)}>Open agent</Button>
              <LinkButton variant="ghost" href={href("agents", `h:${funding.agent}`, "jobs")}>Add a job</LinkButton>
            </div>
          </Card>
        </div>
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
          <Card className="p-6">
            {step === 0 && (
              <div className="grid grid-cols-[minmax(0,1fr)] gap-5 sm:grid-cols-2">
                <Field label="Name" hint="3–40 letters, digits, - or _. It can't be changed." className="sm:col-span-2">
                  <input className={inputCls} value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="research-bot" autoCapitalize="off" spellCheck={false} autoFocus />
                </Field>
                <Field label="Budget" hint="The most it can ever spend from this grant."><KasInput value={d.budget} onChange={(e) => set({ budget: e.target.value })} /></Field>
                <Field label="Max per payment" hint="Anything above this is refused."><KasInput value={d.cap} onChange={(e) => set({ cap: e.target.value })} /></Field>
                <Field label="Lasts" hint="After this, the grant refuses every spend.">
                  <span className="relative block"><input inputMode="numeric" className={cn(inputCls, "num pr-14")} value={d.days} onChange={(e) => set({ days: e.target.value.replace(/\D/g, "") })} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-medium text-fg-3">days</span></span>
                </Field>
                <Field label="Limit per period" hint="Five payments' worth per ~100 s of network time. Set by the runner.">
                  <div className={cn(inputCls, "num flex items-center text-fg-2")}>{kasOk(d.cap) ? `${+(c * 5).toFixed(8)} KAS / 100 s` : "—"}</div>
                </Field>
              </div>
            )}
            {step === 1 && (
              <div className="space-y-7">
                <div>
                  <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold"><Store className="size-4 text-fg-3" /> Who it may pay</div>
                  <div className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2">
                    {svc.map((s) => {
                      const on = d.picked.includes(s.address!);
                      return (
                        <button key={s.id} type="button" onClick={() => set({ picked: on ? d.picked.filter((x) => x !== s.address) : [...d.picked, s.address!] })}
                          className={cn("flex items-start gap-3 rounded-xl border p-3.5 text-left transition", on ? "border-accent/50 bg-accent/[0.06]" : "border-line-strong hover:border-fg-3/50 hover:bg-raised/50")}>
                          <span className={cn("mt-0.5 grid size-4.5 shrink-0 place-items-center rounded-[5px] border", on ? "border-accent bg-accent text-accent-ink" : "border-fg-3/60")}>{on && <Check className="size-3" strokeWidth={3} />}</span>
                          <span className="min-w-0">
                            <span className="block text-[13.5px] font-medium">{s.name}</span>
                            <span className="block truncate text-[12px] text-fg-3">{s.price ?? s.endpoint}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {d.custom.length > 0 && (
                    <ul className="mt-3 divide-y divide-line rounded-xl border border-line-strong">
                      {d.custom.map((a) => (
                        <li key={a} className="flex items-center gap-3 px-3.5 py-2.5">
                          <span className="min-w-0 flex-1"><span className="block text-[13px] text-fg-2">Unlisted</span><span className="num block truncate text-[12px] text-fg-3">{a}</span></span>
                          <button className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-raised hover:text-bad" aria-label="Remove" onClick={() => set({ custom: d.custom.filter((x) => x !== a) })}><Trash2 className="size-4" /></button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); const a = add.trim(); if (isAddress(a, prefix)) { set({ custom: [...new Set([...d.custom, a])] }); setAdd(""); } }}>
                    <input className={cn(inputCls, "num text-[13px]")} value={add} onChange={(e) => setAdd(e.target.value)} placeholder={`${prefix}:… another address`} spellCheck={false} autoCapitalize="off" />
                    <Button type="submit" disabled={!isAddress(add.trim(), prefix)}><Plus className="size-4" /> Add</Button>
                  </form>
                  {add.trim() && !isAddress(add.trim(), prefix) && <p className="mt-1.5 text-[12px] text-bad">Not a valid {prefix} address.</p>}
                  <p className="mt-3 text-[12px] text-fg-3">The runner's fee address is added too. This list is fixed once the grant exists.</p>
                </div>
                <div>
                  <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold"><ShieldCheck className="size-4 text-fg-3" /> You, as owner</div>
                  <Field label="Your Kaspa address" hint={ownerNote ?? "Your key is the only one that can stop the grant and take back what's left. The runner never sees it."}
                    error={d.owner.trim() && !owner ? "That isn't a Kaspa address (kaspatest:…) or public key." : undefined}>
                    <span className="flex gap-2">
                      <input className={cn(inputCls, "num text-[13px]")} value={d.owner} onChange={(e) => set({ owner: e.target.value })} placeholder={`${prefix}:…`} spellCheck={false} autoCapitalize="off" />
                      {hasKasware() && <Button type="button" onClick={useKasware}><Wallet className="size-4" /> KasWare</Button>}
                    </span>
                  </Field>
                </div>
              </div>
            )}

            {err && <p className="mt-5 rounded-lg bg-bad/10 px-3 py-2.5 text-[13px] text-bad">{err}</p>}
            <div className="mt-8 flex items-center justify-between gap-3 border-t border-line pt-5">
              {step > 0 ? <Button variant="ghost" onClick={() => setStep(step - 1)}><ArrowLeft className="size-4" /> Back</Button> : <span />}
              <div className="flex items-center gap-3">
                {blocker && <span className="hidden text-[12.5px] text-fg-3 sm:inline">{blocker}</span>}
                {step === 0 && <Button variant="primary" disabled={!!blocker} onClick={() => setStep(1)}>Continue <ArrowRight className="size-4" /></Button>}
                {step === 1 && <Button variant="primary" disabled={!!blocker || busy} onClick={create}>{busy ? "Creating…" : "Create agent"} <ArrowRight className="size-4" /></Button>}
              </div>
            </div>
            {blocker && <p className="mt-3 text-right text-[12.5px] text-fg-3 sm:hidden">{blocker}</p>}
          </Card>

          <Card className="h-fit p-5 lg:sticky lg:top-24">
            <div className="flex items-center gap-2 text-[13px] text-fg-3"><ShieldCheck className="size-4 text-accent" /> What the network will enforce</div>
            <div className="mt-3 text-[17px] font-semibold">{d.name.trim() || "Your agent"}</div>
            <dl className="mt-3 divide-y divide-line">
              <Row label="Budget"><span className="num">{kasOk(d.budget) ? `${d.budget} KAS` : "—"}</span></Row>
              <Row label="Per payment"><span className="num">{kasOk(d.cap) ? `${d.cap} KAS` : "—"}</span></Row>
              <Row label="Per period"><span className="num">{kasOk(d.cap) ? `${+(c * 5).toFixed(8)} KAS / 100 s` : "—"}</span></Row>
              <Row label="Payees">{payees.length ? `${payees.length} + runner fee` : "—"}</Row>
              <Row label="Term">{days > 0 ? `${days} days` : "—"}</Row>
              <Row label="Owner"><span className="num">{owner ? short(owner, 8, 6) : "—"}</span></Row>
            </dl>
            {kasOk(d.budget) && <p className="mt-4 rounded-lg bg-raised px-3 py-2.5 text-[12.5px] leading-relaxed text-fg-2">You'll send about <span className="num text-fg">{(b + Math.max(0.1, b / 10) + 0.01).toFixed(2)} KAS</span>: the budget plus what its payments' network fees come from.</p>}
          </Card>
        </div>
      )}
    </>
  );
}
