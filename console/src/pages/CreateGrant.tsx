import { useEffect, useState } from "react";
import { useMarket } from "@/lib/account";
import { ArrowLeft, ArrowRight, Check, Copy as CopyIco, Download, Plus, ShieldCheck, Store, Trash2, Terminal } from "lucide-react";
import { useData } from "@/lib/data";
import { useWallet, VERIFY } from "@/lib/connect";
import { isAddress, ownerKey } from "@/lib/kaspa";
import { cn } from "@/lib/cn";
import { short } from "@/lib/format";
import { Button, Card, PageHeader, Row } from "@/components/ui";
import { Field, KasInput, inputCls, kasOk } from "@/components/form";

/* Your own grant: the agent key is generated on your machine by the command
   this page writes, and never typed, printed or sent. This page holds no key
   and signs nothing; it turns your limits into one command. */

const STEPS = ["Limits", "Who it may pay", "Keys and funding", "Create it"];
const SOMPI = 100_000_000;
const toS = (v: string) => (kasOk(v) ? Math.round(Number(v) * SOMPI) : null);
const kasStr = (n: number) => { const w = Math.floor(n / SOMPI), f = String(n % SOMPI).padStart(8, "0").replace(/0+$/, ""); return w + (f ? "." + f : ""); };

export function CreateGrant({ payee, budget0, cap0 }: { payee?: string; budget0?: string; cap0?: string }) {
  const { services } = useData();
  const { wallet } = useWallet();
  const [step, setStep] = useState(0);
  const [budget, setBudget] = useState(budget0 && kasOk(budget0) ? budget0 : "10");
  const [cap, setCap] = useState(cap0 && kasOk(cap0) ? cap0 : "1");
  const [epoch, setEpoch] = useState(cap0 && kasOk(cap0) ? String(+(Number(cap0) * 5).toFixed(8)) : "2");
  const [days, setDays] = useState("30");
  const [picked, setPicked] = useState<string[]>(payee && payee.includes(":") ? [payee] : []);
  const [custom, setCustom] = useState<string[]>([]);
  const mk = useMarket();
  const rate = mk && "rate" in mk ? mk.rate : null;
  const usd = (v: string) => (rate && kasOk(v) ? `≈ $${(Number(v) * rate).toLocaleString("en-US", { maximumFractionDigits: 2 })}` : null);
  const [add, setAdd] = useState("");
  const [relay, setRelay] = useState(false);
  const [revoke, setRevoke] = useState("");
  const [funder, setFunder] = useState("");
  const [look, setLook] = useState<{ bad?: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (!funder && wallet?.family === "kaspa") setFunder(wallet.address); }, [wallet]); // eslint-disable-line react-hooks/exhaustive-deps

  const b = toS(budget), c = toS(cap), e = epoch.trim() ? toS(epoch) : null, d = Number(days);
  const payees = [...new Set([...picked, ...custom])];
  const revKey = revoke.trim() ? ownerKey(revoke) : null;
  const svc = services.filter((s) => s.address?.startsWith("kaspatest:"));

  const problem = (s: number): string | null => {
    if (s === 0) {
      if (b == null) return "Set a budget above zero.";
      if (c == null || c > b) return "A single payment must be above zero and no more than the budget.";
      if (epoch.trim() && (e == null || e < c)) return "The per-period limit must be at least one payment.";
      if (!(d > 0 && d <= 3650)) return "How long should it run?";
    }
    if (s === 1 && !payees.length) return "A grant with no payee can pay nobody. Add at least one address.";
    if (s === 2 && revoke.trim() && !revKey) return "That isn't a Kaspa address or a 64-hex public key.";
    return null;
  };
  const blocker = problem(step);

  const cmd = b == null || c == null ? "" :
    "WARDA_SK=$(cat wallet.key) warda grant \\\n  --payees payees.txt \\\n" +
    `  --budget ${kasStr(b)} \\\n  --max-per-spend ${kasStr(c)} \\\n` +
    (e != null ? `  --epoch-limit ${kasStr(e)} \\\n` : "") +
    (d > 0 ? `  --days ${d} \\\n` : "") +
    (revKey ? `  --revocation ${revKey} \\\n` : "") +
    (relay ? "  --relay \\\n" : "") +
    "  --out grant.json";
  const need = b == null ? null : b + 1_000_000;

  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([payees.join("\n") + "\n"], { type: "text/plain" }));
    a.download = "payees.txt"; a.click();
  };

  const check = async () => {
    if (!isAddress(funder.trim())) { setLook({ bad: true, text: "Enter the address the KAS will land at." }); return; }
    if (need == null) { setLook({ bad: true, text: "Set a budget first — there's no figure to look for yet." }); return; }
    setLook({ text: "Looking…" });
    try {
      const r = await fetch(`${VERIFY}/v1/grant/${encodeURIComponent(funder.trim())}`);
      const g = r.ok ? (await r.json())?.result : null;
      if (!g) { setLook({ bad: true, text: "The verifier didn't answer. That isn't an empty address — it's no reading at all." }); return; }
      if (!g.found) { setLook({ bad: true, text: "Nothing there yet. Withdrawals take a few minutes." }); return; }
      const largest = parseInt(g.largest?.sompi ?? "0", 10), total = parseInt(g.total?.sompi ?? "0", 10);
      setLook(largest >= need ? { text: `Ready: ${kasStr(largest)} KAS in one coin, and ${kasStr(need)} is needed.` }
        : total >= need ? { bad: true, text: `Enough in total (${kasStr(total)} KAS across ${g.coins} coins) but not in one coin — the largest is ${kasStr(largest)} KAS. A grant is funded from a single coin: warda wallet consolidate` }
        : { bad: true, text: `Short: ${kasStr(total)} KAS there, ${kasStr(need)} needed.` });
    } catch { setLook({ bad: true, text: "The verifier didn't answer. That isn't an empty address — it's no reading at all." }); }
  };

  return (
    <>
      <PageHeader eyebrow={<a href="#/new" className="inline-flex items-center gap-1.5 hover:text-fg"><ArrowLeft className="size-4" /> New agent</a>}
        title="Create your own grant" sub="Your software holds the agent key. This page turns your limits into one command you run on your machine — it holds no key and signs nothing." />

      <ol className="mb-8 flex items-center gap-2 sm:gap-3">
        {STEPS.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2 sm:gap-3">
            <button disabled={i > step} onClick={() => setStep(i)} className={cn("grid size-7 shrink-0 place-items-center rounded-full text-[12px] font-semibold ring-1 transition",
              i < step ? "bg-accent text-accent-ink ring-accent" : i === step ? "bg-accent/15 text-accent ring-accent/50" : "bg-raised text-fg-3 ring-line-strong")}>
              {i < step ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
            </button>
            <span className={cn("hidden text-[13px] font-medium md:inline", i === step ? "text-fg" : "text-fg-3")}>{s}</span>
            {i < STEPS.length - 1 && <span className={cn("h-px flex-1", i < step ? "bg-accent/50" : "bg-line-strong")} />}
          </li>
        ))}
      </ol>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <Card className="p-6">
          {step === 0 && (
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Total budget" hint={usd(budget) ? `${usd(budget)} at the market price — the grant is in KAS, and nothing is enforced against a price.` : "The most it can ever spend from this grant."}><KasInput value={budget} onChange={(x) => setBudget(x.target.value)} /></Field>
              <Field label="Max per payment" hint={usd(cap) ? `${usd(cap)} · any single payment above this is refused.` : "Any single payment above this is refused."}><KasInput value={cap} onChange={(x) => setCap(x.target.value)} /></Field>
              <Field label="Limit per period" hint={`${usd(epoch) ? usd(epoch) + " · " : ""}per ~100 s of network time (1,000 DAA).`}><KasInput value={epoch} onChange={(x) => setEpoch(x.target.value)} /></Field>
              <Field label="Lasts" hint={d > 0 ? `${Math.round(d * 864000).toLocaleString("en-US")} blocks, at ten a second — then what's left is the principal's to reclaim` : undefined}>
                <span className="relative block"><input inputMode="numeric" className={cn(inputCls, "num pr-14")} value={days} onChange={(x) => setDays(x.target.value.replace(/[^\d.]/g, ""))} /><span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-fg-3">days</span></span>
              </Field>
              <p className="text-[12.5px] leading-relaxed text-fg-3 sm:col-span-2">None of these can be raised once the grant exists. They're compiled into the script that holds the coin; changing one means issuing a successor and ending this one.</p>
            </div>
          )}
          {step === 1 && (
            <div>
              <div className="mb-3 flex items-center gap-2 text-[14px] font-semibold"><Store className="size-4 text-fg-3" /> Who it may pay</div>
              <div className="grid gap-2 sm:grid-cols-2">
                {svc.map((s) => { const on = picked.includes(s.address!); return (
                  <button key={s.id} type="button" onClick={() => setPicked(on ? picked.filter((x) => x !== s.address) : [...picked, s.address!])}
                    className={cn("flex items-start gap-3 rounded-xl border p-3.5 text-left transition", on ? "border-accent/50 bg-accent/[0.06]" : "border-line-strong hover:bg-raised/50")}>
                    <span className={cn("mt-0.5 grid size-4 shrink-0 place-items-center rounded-[5px] border", on ? "border-accent bg-accent text-accent-ink" : "border-fg-3/60")}>{on && <Check className="size-3" strokeWidth={3} />}</span>
                    <span className="min-w-0"><span className="block text-[13.5px] font-medium">{s.name}</span><span className="block truncate text-[12px] text-fg-3">{s.price ?? s.endpoint}</span></span>
                  </button>
                ); })}
              </div>
              {custom.length > 0 && <ul className="mt-3 divide-y divide-line rounded-xl border border-line-strong">{custom.map((a) => (
                <li key={a} className="flex items-center gap-3 px-3.5 py-2.5"><span className="min-w-0 flex-1"><span className="block text-[13px] text-fg-2">Unlisted</span><span className="num block truncate text-[12px] text-fg-3">{a}</span></span>
                  <button className="grid size-8 place-items-center rounded-md text-fg-3 hover:bg-raised hover:text-bad" aria-label="Remove" onClick={() => setCustom(custom.filter((x) => x !== a))}><Trash2 className="size-4" /></button></li>
              ))}</ul>}
              <form className="mt-3 flex gap-2" onSubmit={(x) => { x.preventDefault(); const a = add.trim(); if (isAddress(a, "kaspatest")) { setCustom([...new Set([...custom, a])]); setAdd(""); } }}>
                <input className={cn(inputCls, "num text-[13px]")} value={add} onChange={(x) => setAdd(x.target.value)} placeholder="kaspatest:… another address" spellCheck={false} autoCapitalize="off" />
                <Button type="submit" disabled={!isAddress(add.trim(), "kaspatest")}><Plus className="size-4" /> Add</Button>
              </form>
              {add.trim() && !isAddress(add.trim(), "kaspatest") && <p className="mt-1.5 text-[12px] text-bad">Not a valid kaspatest address.</p>}
              <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13px] text-fg-2">
                <input type="checkbox" checked={relay} onChange={(x) => setRelay(x.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
                <span>Let it pay itself too — needed to buy from an x402 "exact" vendor through a relay hop. It costs the allowlist for that hop and nothing else.</span>
              </label>
              <p className="mt-3 text-[12px] leading-relaxed text-fg-3">A payee is an address, not a company. This list's root is compiled into the grant and can never be added to afterwards.</p>
            </div>
          )}
          {step === 2 && (
            <div className="space-y-6">
              <div>
                <div className="text-[14px] font-semibold">Its keys, which this page never sees</div>
                <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-3">The agent's key is made by the command in step 4, on your machine, and written to agent.key. The revocation key you make yourself and give only its public half:</p>
                <pre className="num mt-2 overflow-x-auto rounded-lg border border-line-strong bg-bg p-3 text-[12px] text-fg-2">warda key --out revocation.key   # can stop it at any moment, and receives nothing</pre>
                <Field className="mt-3" label="Revocation key — optional" error={revoke.trim() && !revKey ? "That isn't a Kaspa address or a 64-hex public key." : undefined}
                  hint="Its address or public key. Left blank, the stop is the funding key itself — fine for a first grant, wrong for anything left running.">
                  <input className={cn(inputCls, "num text-[13px]")} value={revoke} onChange={(x) => setRevoke(x.target.value)} placeholder="kaspatest:… or 64 hex" spellCheck={false} autoCapitalize="off" />
                </Field>
              </div>
              <div>
                <div className="text-[14px] font-semibold">Funding it</div>
                <Field className="mt-3" label="Your funding address — where the KAS is" hint="A grant is funded from one coin, so what matters is your largest coin, not your balance.">
                  <span className="flex gap-2"><input className={cn(inputCls, "num text-[13px]")} value={funder} onChange={(x) => setFunder(x.target.value)} placeholder="kaspatest:qq…" spellCheck={false} autoCapitalize="off" /><Button onClick={check}>Check it</Button></span>
                </Field>
                {look && <p className={cn("mt-2 text-[12.5px]", look.bad ? "text-warn" : "text-ok")}>{look.text}</p>}
                {need != null && <p className="mt-2 text-[12.5px] text-fg-3">You need <span className="num text-fg-2">{kasStr(need)} KAS</span> there as one coin — {kasStr(b!)} for the grant and 0.01 for the network fee.</p>}
              </div>
            </div>
          )}
          {step === 3 && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-[14px] font-semibold"><Terminal className="size-4 text-fg-3" /> Run this on your machine</div>
              <p className="text-[12.5px] leading-relaxed text-fg-3">Put payees.txt beside it. The command builds the grant locally, writes the manifest before it broadcasts, and prints the address the coin will live at.</p>
              <div className="relative rounded-lg border border-line-strong bg-bg">
                <pre className="num overflow-x-auto p-3 pr-12 text-[12.5px] leading-relaxed text-fg">{cmd}</pre>
                <button className="absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-md text-fg-3 hover:bg-raised hover:text-fg" aria-label="Copy the command"
                  onClick={() => navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>{copied ? <Check className="size-4 text-ok" /> : <CopyIco className="size-4" />}</button>
              </div>
              <Button onClick={download}><Download className="size-4" /> Download payees.txt</Button>
              <p className="rounded-lg bg-raised px-3 py-2.5 text-[12.5px] leading-relaxed text-fg-2">Keep grant.json and payees.txt. A grant's address comes from the numbers in that file, and a spend rebuilds its proof from the allowlist — lose either and the grant can be revoked, never spent. Then track it under Account → Tracked grants.</p>
            </div>
          )}

          <div className="mt-8 flex items-center justify-between gap-3 border-t border-line pt-5">
            {step > 0 ? <Button variant="ghost" onClick={() => setStep(step - 1)}><ArrowLeft className="size-4" /> Back</Button> : <span />}
            <div className="flex items-center gap-3">
              {blocker && <span className="hidden text-[12.5px] text-fg-3 sm:inline">{blocker}</span>}
              {step < 3 && <Button variant="primary" disabled={!!blocker} onClick={() => setStep(step + 1)}>Continue <ArrowRight className="size-4" /></Button>}
            </div>
          </div>
          {blocker && <p className="mt-3 text-right text-[12.5px] text-fg-3 sm:hidden">{blocker}</p>}
        </Card>

        <Card className="h-fit p-5 lg:sticky lg:top-24">
          <div className="flex items-center gap-2 text-[13px] text-fg-3"><ShieldCheck className="size-4 text-accent" /> What the network will enforce</div>
          <dl className="mt-3 divide-y divide-line">
            <Row label="Budget"><span className="num">{b != null ? `${kasStr(b)} KAS` : "—"}</span></Row>
            <Row label="Per payment"><span className="num">{c != null ? `${kasStr(c)} KAS` : "—"}</span></Row>
            <Row label="Per period"><span className="num">{e != null ? `${kasStr(e)} KAS / 100 s` : "—"}</span></Row>
            <Row label="Payees">{payees.length ? `${payees.length}${relay ? " + itself" : ""}` : "—"}</Row>
            <Row label="Term">{d > 0 ? `${d} days` : "—"}</Row>
            <Row label="Stop key"><span className="num">{revKey ? short(revKey, 8, 6) : "the funding key"}</span></Row>
          </dl>
          <p className="mt-4 text-[12px] leading-relaxed text-fg-3">Not settings: none of these can be raised after the grant exists. It's a script the network refuses to spend outside of.</p>
        </Card>
      </div>
    </>
  );
}
