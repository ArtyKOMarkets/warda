import { useEffect, useRef, useState } from "react";
import { CircleCheck, Download, FileJson, Loader2, LogOut, Send, Trash2, Upload, RefreshCw, KeyRound } from "lucide-react";
import { useWallet } from "@/lib/connect";
import { accountApi, useAccount, ownKey, type Me, type Own, type Reading } from "@/lib/account";
import { useData } from "@/lib/data";
import { href } from "@/lib/router";
import { kas, short, ago } from "@/lib/format";
import { cn } from "@/lib/cn";
import { AgentMark } from "./agent";
import { Badge, Button, Card, CardHeader, Empty, StatusBadge, type Tone } from "./ui";
import { inputCls } from "./form";

const RULE_WORD: Record<string, [string, Tone]> = { firing: ["firing", "warn"], clear: ["clear", "ok"], undecided: ["no reading", "bad"], insufficient: ["learning", "muted"] };
export const ruleState = (s: string | null): [string, Tone] => (s && RULE_WORD[s]) || ["not run yet", "muted"];
export const ruleSay = (m: string | null) => (m ? m.split("\n\n").slice(-2, -1)[0] || m : "no message sent yet");
const KIND_WORD: Record<string, string> = { "balance-at-or-above": "Money arrived", "budget-low": "Running out", expiring: "Nearly over", "spending-anomaly": "Spending spike" };
export const kindWord = (k: string) => KIND_WORD[k] ?? k;

function Section({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return <div className={cn("border-t border-line px-5 py-5", className)}><div className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-fg-3">{title}</div>{children}</div>;
}

function useConfirm(ms = 6000) {
  const [armed, setArmed] = useState(false);
  const t = useRef<number | undefined>(undefined);
  useEffect(() => () => clearTimeout(t.current), []);
  return { armed, arm: () => { setArmed(true); clearTimeout(t.current); t.current = window.setTimeout(() => setArmed(false), ms); }, reset: () => setArmed(false) };
}

export function ConsoleAccount() {
  const { wallet } = useWallet();
  const { up, me, signIn, signOut, reload, setMe } = useAccount();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async (op: "signin" | "link") => { setBusy(true); setMsg("Asking your wallet to sign the sign-in message…"); setMsg(await signIn(op)); setBusy(false); };

  // Stripe comes back to /app?billing=…#/account
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("billing");
    if (!q) return;
    history.replaceState(null, "", location.pathname + location.hash);
    setMsg(q === "cancelled" ? "Checkout cancelled. Nothing was charged." : "Payment received. Stripe tells this site within a minute; reload if your plan has not changed yet.");
  }, []);

  if (up === null) return <Card className="p-5"><Loader2 className="size-4 animate-spin text-fg-3" /></Card>;
  if (up === false) return <Card className="p-5"><div className="text-[15px] font-semibold">Console account</div><p className="mt-2 text-[13px] text-fg-3">Accounts are not set up on this site yet. Everything else still works, kept in this browser.</p></Card>;

  if (!me) {
    return (
      <Card className="p-5">
        <div className="text-[15px] font-semibold">Console account</div>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-2">
          {wallet ? `Sign in with ${wallet.name} to keep your tracked grants and alert rules on every device, and to have the console run your alerts for you. Signing in is a plain-text message: it cannot move funds and costs nothing.`
            : "Connect a wallet above, then sign in with it. Your tracked grants and alert rules follow you to every device."}
        </p>
        {wallet && <Button variant="primary" className="mt-4" disabled={busy || !!wallet.problem} onClick={() => go("signin")}>{busy ? <Loader2 className="size-4 animate-spin" /> : <KeyRound className="size-4" />} Sign in with {wallet.name}</Button>}
        {msg && <p className="mt-3 text-[12.5px] text-fg-2">{msg}</p>}
      </Card>
    );
  }

  const onAccount = wallet && me.wallets.some((x) => x.address.toLowerCase() === wallet.address.toLowerCase());
  return (
    <Card>
      <div className="flex items-start justify-between gap-3 p-5">
        <div>
          <div className="flex items-center gap-2 text-[15px] font-semibold">Console account <Badge tone="accent">{me.plan}</Badge></div>
          <p className="mt-1.5 text-[13px] text-fg-3">Your tracked grants and rules are kept with your account on every device; anything marked "this browser only" stays here.</p>
        </div>
        <Button size="sm" variant="ghost" onClick={signOut}><LogOut className="size-3.5" /> Sign out</Button>
      </div>
      {msg && <p className="mx-5 mb-4 text-[12.5px] text-fg-2">{msg}</p>}

      <Section title="Wallets on this account">
        <ul className="space-y-2">
          {me.wallets.map((x) => (
            <li key={x.address} className="flex items-center gap-3 rounded-xl border border-line-strong px-3.5 py-2.5">
              <div className="min-w-0 flex-1"><div className="num truncate text-[13px]">{short(x.address, 14, 6)}</div><div className="text-[12px] text-fg-3">{x.family === "kaspa" ? "Kaspa — can hold a grant's key" : "Ethereum-style"}</div></div>
              {wallet && x.address.toLowerCase() === wallet.address.toLowerCase() && <Badge tone="ok" dot>connected</Badge>}
            </li>
          ))}
        </ul>
        {wallet && !onAccount && <Button size="sm" className="mt-3" disabled={busy} onClick={() => go("link")}>Add {short(wallet.address, 10, 4)} to this account</Button>}
      </Section>

      <Telegram me={me} reload={reload} setMe={setMe} />
      <Email me={me} setMe={setMe} />
      <Plan me={me} setMsg={setMsg} />
      <Rules me={me} reload={reload} />
      <Danger setMsg={setMsg} />
    </Card>
  );
}

function Telegram({ me, reload, setMe }: { me: Me; reload: () => Promise<void>; setMe: (m: Me) => void }) {
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const c = useConfirm();
  useEffect(() => { if (me.telegramChatId) setWaiting(false); }, [me.telegramChatId]);
  const connect = async () => {
    const w = window.open("about:blank", "_blank");
    setErr(null);
    const j = await accountApi<{ url: string }>("tglink", {});
    if (!j.ok) { w?.close(); setErr(j.message || "Could not make a link just now."); return; }
    if (w) w.location.href = j.url; else location.href = j.url;
    setWaiting(true);
    let n = 0;
    const t = setInterval(async () => { if (++n > 60) { clearInterval(t); setWaiting(false); return; } await reload(); }, 3000);
  };
  const off = async () => {
    if (!c.armed) { c.arm(); return; }
    c.reset();
    const j = await accountApi<{ account: Me }>("settings", { telegramChatId: null, email: me.email });
    if (j.ok) setMe(j.account); else setErr(j.message);
  };
  const on = !!me.telegramChatId;
  return (
    <Section title="Where alerts go">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[14px] font-medium"><Send className="size-4 text-fg-3" /> Telegram <Badge tone={on ? "ok" : "muted"} dot>{on ? "connected" : "not connected"}</Badge></div>
        {!on && me.telegramReady && <Button size="sm" variant="primary" disabled={waiting} onClick={connect}>{waiting ? <><Loader2 className="size-3.5 animate-spin" /> Waiting for Start…</> : "Connect Telegram"}</Button>}
        {on && <Button size="sm" variant={c.armed ? "danger" : "ghost"} onClick={off}>{c.armed ? "Press again to stop alerts" : "Disconnect"}</Button>}
      </div>
      <p className="mt-2 text-[12.5px] leading-relaxed text-fg-3">
        {!me.telegramReady ? "Telegram delivery is not switched on for this site yet — rules still run, and what they would have sent is kept below."
          : on ? "Alerts from your rules come to your Telegram. The bot can only send you messages — it can never move funds."
          : waiting ? "Press Start in Telegram, then come back — this updates by itself."
          : "One tap: Telegram opens, you press Start, and alerts from your rules come to your phone."}
      </p>
      <p className="mt-1 text-[12px] text-fg-3">This is your console account's Telegram. Hosted agents' approvals use the runner's, under Alerts.</p>
      {err && <p className="mt-2 text-[12.5px] text-bad">{err}</p>}
    </Section>
  );
}

function Email({ me, setMe }: { me: Me; setMe: (m: Me) => void }) {
  const [v, setV] = useState(me.email ?? "");
  const [say, setSay] = useState<string | null>(null);
  const save = async () => { const j = await accountApi<{ account: Me }>("settings", { email: v.trim() || null }); setSay(j.ok ? "Saved." : j.message || "Not saved."); if (j.ok) setMe(j.account); };
  return (
    <Section title="Email — optional">
      <div className="flex gap-2"><input className={inputCls} type="email" value={v} onChange={(e) => setV(e.target.value)} placeholder="you@example.com" /><Button onClick={save}>Save</Button></div>
      <p className="mt-2 text-[12px] text-fg-3">{say ?? "Kept for receipts and a later email channel. Not needed to sign in."}</p>
    </Section>
  );
}

const PLANS = [
  { id: "free", name: "Free", px: "$0", say: "Everything in the browser: wallets, tracked grants, analytics, the local alerts script." },
  { id: "pro", name: "Pro", px: "$29 / month", say: "Grants synced to every device, alerts the console runs, spending spikes, following moved grants, history charts." },
  { id: "team", name: "Team", px: "$199 / month", say: "Pro, for several people's wallets on one account. Roles are next." },
];
function Plan({ me, setMsg }: { me: Me; setMsg: (s: string) => void }) {
  const b = me.billing ?? ({} as Me["billing"]);
  const cur = me.plan;
  const bill = async (op: "checkout" | "portal", body: object = {}) => { setMsg("Opening Stripe…"); const j = await accountApi<{ url: string }>(op, body); if (j.ok && j.url) location.href = j.url; else setMsg((!j.ok && j.message) || "Billing did not answer."); };
  const cards = [...(cur === "beta" ? [{ id: "beta", name: "Beta", px: "free", say: `Everything in Pro while accounts are new${b.enforced ? "" : " — nothing to pay yet"}.` }] : []), ...PLANS.filter((p) => !(cur === "beta" && p.id === "free"))];
  return (
    <Section title="Plan">
      <div className="grid gap-2 sm:grid-cols-3">
        {cards.map((p) => {
          const now = p.id === cur;
          return (
            <div key={p.id} className={cn("flex flex-col rounded-xl border p-3.5", now ? "border-accent/50 bg-accent/[0.05]" : "border-line-strong")}>
              <div className="text-[13.5px] font-semibold">{p.name}{now && <span className="font-normal text-accent"> — your plan{b.status && b.status !== "active" ? ` (${b.status})` : ""}</span>}</div>
              <div className="num mt-0.5 text-[12.5px] text-fg-2">{p.px}</div>
              <p className="mt-1.5 flex-1 text-[12px] leading-snug text-fg-3">{p.say}</p>
              {b.enabled && p.id !== "free" && p.id !== "beta" && !now && <Button size="sm" className="mt-3" onClick={() => bill("checkout", { plan: p.id })}>{cur === "pro" || cur === "team" ? "Switch to" : "Choose"} {p.name}</Button>}
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[12px] text-fg-3">
        {b.customer && <><button className="text-fg-2 underline-offset-4 hover:underline" onClick={() => bill("portal")}>Manage billing, invoices and cancellation</button> — on Stripe's own page. Card details never reach this site. </>}
        {b.enabled ? "Paid by card on Stripe's own page. No percentage of any payment, ever — the plan is the only charge." : "Paid plans open when billing is switched on for this site."}
      </p>
    </Section>
  );
}

export function RuleList({ me, reload, empty }: { me: Me; reload: () => Promise<void>; empty?: React.ReactNode }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const remove = async (id: string) => { setBusy(id); const j = await accountApi("unrule", { id }); if (!j.ok) setErr(j.message); await reload(); setBusy(null); };
  if (!me.rules.length) return <>{empty ?? <p className="text-[13px] text-fg-3">None yet. Build one on <a className="text-fg-2 hover:text-accent" href={href("alerts", "rules")}>Alerts</a>.</p>}</>;
  return (
    <>
      <ul className="space-y-2">
        {me.rules.map((r) => {
          const [word, tone] = ruleState(r.state);
          return (
            <li key={r.id} className="flex items-start gap-3 rounded-xl border border-line-strong px-3.5 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13.5px] font-medium">{r.id}<span className="font-normal text-fg-3">· {kindWord(r.rule.kind)}</span><Badge tone={tone} dot>{word}</Badge></div>
                <div className="mt-1 line-clamp-2 text-[12px] text-fg-3">{ruleSay(r.lastMessage)}</div>
              </div>
              <Button size="sm" variant="ghost" disabled={busy === r.id} onClick={() => remove(r.id)} aria-label={`Remove ${r.id}`}><Trash2 className="size-3.5" /></Button>
            </li>
          );
        })}
      </ul>
      {err && <p className="mt-2 text-[12.5px] text-bad">{err}</p>}
    </>
  );
}

function Rules({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  return <Section title="Rules this account runs"><RuleList me={me} reload={reload} /></Section>;
}

function Danger({ setMsg }: { setMsg: (s: string) => void }) {
  const { signOut } = useAccount();
  const c = useConfirm();
  const exp = async () => {
    const j = await accountApi("export");
    if (!j.ok) { setMsg(j.message); return; }
    try {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([JSON.stringify(j, null, 2)], { type: "application/json" }));
      a.download = `warda-account-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    } catch { setMsg("This browser would not take the download."); }
  };
  const del = async () => {
    if (!c.armed) { c.arm(); return; }
    const j = await accountApi("delete", {});
    if (j.ok) { await signOut(); setMsg("Deleted. Your tracked grants are still in this browser."); } else setMsg(j.message);
  };
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4">
      <p className="max-w-md text-[12px] text-fg-3">Beta: free while accounts are new. Stored: the wallet addresses above, the grants you sync, your rules and where alerts go. Never stored: a key, a seed, or money.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="ghost" onClick={exp}><Download className="size-3.5" /> Export everything</Button>
        <Button size="sm" variant={c.armed ? "danger" : "ghost"} onClick={del}>{c.armed ? "Press again — this cannot be undone" : "Delete this account"}</Button>
      </div>
    </div>
  );
}

/* ---- grants ---- */
export function KeyGrants() {
  const { wallet } = useWallet();
  const { agents } = useData();
  if (!wallet) return null;
  const k = wallet.key;
  const rows = agents.map((a) => {
    const roles: string[] = [];
    if (a.source === "hosted") roles.push("owner");
    else if (k) {
      if (a.principalKey === k) roles.push("principal");
      if (a.ownerKey === k && a.ownerKey !== a.principalKey) roles.push("revocation");
      if (a.agentKey === k) roles.push("agent");
    }
    return { a, roles };
  }).filter((x) => x.roles.length && x.a.source === "published");
  return (
    <Card>
      <CardHeader title="Grants your key is on" sub="Published grants that name this key as principal, revocation or agent" />
      <div className="mt-3">
        {wallet.family === "evm" ? <p className="px-5 pb-5 text-[13px] text-fg-3">None can: a grant names a Kaspa key, and this is an Ethereum-style account. Grants you track by their grant.json work from any account.</p>
          : !rows.length ? <p className="px-5 pb-5 text-[13px] leading-relaxed text-fg-3">No published grant names this key. That isn't the same as having none: a grant only shows here if this site publishes its reading. Track your own below.</p>
          : <ul className="divide-y divide-line">{rows.map(({ a, roles }) => (
            <li key={a.key}><a href={href("agents", a.key)} className="flex items-center gap-3 px-5 py-3 transition hover:bg-raised/40">
              <AgentMark agent={a} size={28} />
              <div className="min-w-0 flex-1"><div className="text-[13.5px] font-medium">Agent {a.label} <span className="font-normal text-fg-3">· you are its {roles.join(" and ")}</span></div><div className="truncate text-[12px] text-fg-3">{a.mission}</div></div>
              <StatusBadge status={a.status} />
              <span className="num hidden text-[12.5px] text-fg-2 sm:inline">{kas(a.remaining)} KAS left</span>
            </a></li>
          ))}</ul>}
      </div>
    </Card>
  );
}

const BOUND: Record<string, string> = { maxPerSpend: "the per-payment cap", epoch: "this period's limit", budget: "what is left of the budget", coin: "the coin itself" };
function daaSpan(n: number) { const s = n / 10; return s < 5400 ? `${Math.max(1, Math.round(s / 60))} min` : s < 172800 ? `${Math.round(s / 3600)} hours` : `${Math.round(s / 86400)} days`; }
function stateOf(rd: Reading | undefined, m: Own["m"]): [string, Tone] {
  if (!rd || rd.st === "reading") return ["reading…", "muted"];
  if (rd.st === "none") return ["no reading", "warn"];
  if (rd.st === "node") return ["verifier unsure", "warn"];
  if (rd.st !== "read") return ["refused", "bad"];
  if (!rd.r.found) return ["not at this state", "warn"];
  if (!rd.r.agrees) return ["disagrees", "bad"];
  const daa = Number(rd.from?.virtualDaaScore || 0);
  if (daa && daa >= Number(m.expires_at)) return ["expired", "warn"];
  if (daa && m.not_before != null && daa < Number(m.not_before)) return ["not yet", "warn"];
  return ["live", "ok"];
}

export function TrackedGrants() {
  const { own, readings, addGrant, readGrant } = useAccount();
  const [errs, setErrs] = useState<string[]>([]);
  const [paste, setPaste] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const onFiles = async (list: FileList | null) => {
    const out: string[] = [];
    for (const f of Array.from(list ?? [])) {
      if (f.size > 65536) { out.push(`${f.name}: ${Math.round(f.size / 1024)} KB — a manifest is under 1 KB, so this is not one`); continue; }
      const e = addGrant(await f.text(), f.name); if (e) out.push(e);
    }
    setErrs(out); if (file.current) file.current.value = "";
  };

  return (
    <Card>
      <CardHeader title="Grants you track" sub={own.length ? `${own.length} in this browser` : "Any grant, by its grant.json"}
        action={<div className="flex gap-2">
          {own.length > 0 && <Button size="sm" variant="ghost" onClick={() => own.forEach((x) => readGrant(x.m))}><RefreshCw className="size-3.5" /> Read again</Button>}
          <Button size="sm" onClick={() => file.current?.click()}><Upload className="size-3.5" /> Add grant.json</Button>
        </div>} />
      <input ref={file} type="file" accept=".json,application/json" multiple hidden onChange={(e) => onFiles(e.target.files)} />
      <div className="px-5 pt-3">
        <p className="text-[12.5px] leading-relaxed text-fg-3">A grant this site doesn't publish can still be read. Add the grant.json that <span className="num">warda grant</span> wrote and the verifier checks it against the chain, now. A manifest holds public keys and limits, never a secret. It's kept in this browser{" "}and sent only to the verifier.{" "}
          <button className="text-fg-2 underline-offset-4 hover:underline" onClick={() => setPaste(paste === null ? "" : null)}>{paste === null ? "Paste instead" : "Close"}</button></p>
        {paste !== null && (
          <div className="rise mt-3">
            <textarea rows={5} className={cn(inputCls, "num h-auto py-2.5 text-[12px]")} placeholder='{"covenant_id": "…", "principal": "…", …}' value={paste} onChange={(e) => setPaste(e.target.value)} />
            <Button size="sm" className="mt-2" disabled={!paste.trim()} onClick={() => { const e = addGrant(paste, "pasted"); setErrs(e ? [e] : []); if (!e) setPaste(null); }}>Add this grant</Button>
          </div>
        )}
        {errs.length > 0 && <p className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-[12.5px] text-bad">{errs.join(" · ")}</p>}
      </div>
      <div className="mt-4">
        {!own.length ? <Empty icon={<FileJson className="size-5" />} title="None yet" className="py-10">Add the grant.json for any grant — one you funded, one you're the agent of, or one someone gave you terms for.</Empty>
          : <ul className="divide-y divide-line border-t border-line">{own.map((x) => <OwnRow key={ownKey(x.m)} x={x} rd={readings[ownKey(x.m)]} />)}</ul>}
      </div>
    </Card>
  );
}

function OwnRow({ x, rd }: { x: Own; rd: Reading | undefined }) {
  const { wallet } = useWallet();
  const { me, history, removeGrant, readGrant, setLocal, replaceManifest } = useAccount();
  const [payee, setPayee] = useState(x.payee ?? "");
  const [note, setNote] = useState<string | null>(x.note ?? null);
  const [looking, setLooking] = useState(false);
  const m = x.m, k = ownKey(m);
  const [word, tone] = stateOf(rd, m);
  const r = rd?.st === "read" && rd.r.found ? rd.r : null;
  const K = (s: any) => (s?.sompi != null ? kas(Number(s.sompi) / 1e8, { max: 2 }) : "—");
  const K2 = (n: any) => kas(Number(n) / 1e8, { max: 4 });
  const daa = rd?.st === "read" ? Number(rd.from?.virtualDaaScore || 0) : 0;
  const role = wallet?.key ? [m.principal === wallet.key && "principal", m.revocation === wallet.key && m.revocation !== m.principal && "revocation", m.agent === wallet.key && "agent"].filter(Boolean) : [];
  const hist = history?.[k];
  const follow = async () => {
    setLooking(true);
    const p = await accountApi("payee", { key: k, payee: payee.trim() });
    if (!p.ok) { setNote(p.message); setLooking(false); return; }
    if (!payee.trim()) { setNote(""); setLooking(false); return; }
    const f = await accountApi<{ found: boolean; note: string; manifest?: any }>("follow", { key: k, network: "testnet-10" });
    setNote(f.ok ? f.note : f.message || "The follow did not run.");
    if (f.ok && f.found && f.manifest) replaceManifest(k, f.manifest);
    setLooking(false);
  };
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone} dot>{word}</Badge>
        <span className="text-[14px] font-medium">Grant {m.covenant_id ? String(m.covenant_id).slice(0, 8) + "…" : short(m.principal)}</span>
        {role.length > 0 && <Badge tone="accent">you are its {role.join(" and ")}</Badge>}
        <span className="text-[12px] text-fg-3">added {String(x.added).slice(0, 10)}</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Left to spend", r ? `${K(r.remaining)} KAS` : "—", `of a ${K2(m.budget)} KAS budget`],
          ["Next payment, at most", r ? `${K(r.maxNextSpend)} KAS` : "—", r?.boundBy ? `bound by ${BOUND[r.boundBy] ?? r.boundBy}` : `cap ${K2(m.max_per_spend)} KAS each`],
          ["This period", r ? `${K(r.epochRemaining)} KAS` : "—", `of ${K2(m.epoch_limit)} KAS per ${daaSpan(Number(m.epoch_length))}`],
          ["Term", daa ? (Number(m.expires_at) > daa ? `ends in ~${daaSpan(Number(m.expires_at) - daa)}` : `ended ${daaSpan(daa - Number(m.expires_at))} ago`) : `at DAA ${m.expires_at}`, "enforced by the covenant, not by this page"],
        ].map(([l, v, s]) => <div key={l} className="min-w-0"><div className="text-[11.5px] text-fg-3">{l}</div><div className="num mt-1 truncate text-[14px]">{v}</div><div className="mt-0.5 text-[11.5px] leading-snug text-fg-3">{s}</div></div>)}
      </div>
      {rd && "err" in rd && <p className="mt-3 text-[12.5px] text-warn">{rd.err}</p>}
      {rd?.st === "read" && !rd.r.found && (
        <div className="mt-3 rounded-lg bg-raised px-3 py-2.5 text-[12.5px] leading-relaxed text-fg-2">
          Nothing at the address this manifest derives. Every payment moves a grant, so a stale manifest looks exactly like this — and so does one that was revoked or reclaimed. To bring it up to date, where the manifest lives:
          <div className="num mt-2 rounded bg-bg px-2 py-1.5 text-[11.5px]">warda find grant.json --vendor &lt;a payee it paid&gt; --write</div>
          then add the updated file here; it replaces this one.
        </div>
      )}
      {rd?.st === "read" && (rd.r.findings ?? []).length > 0 && <ul className="mt-2 list-disc pl-5 text-[12px] text-fg-3">{rd.r.findings.map((f: any, i: number) => <li key={i}>{f.text}</li>)}</ul>}
      {hist && hist.length > 1 && <Spark hist={hist} budget={Number(m.budget)} />}
      {me && !x.local && (
        <div className="mt-3 flex gap-2">
          <input className={cn(inputCls, "num h-9 text-[12px]")} value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="One address this grant pays — lets the console follow it when it moves" spellCheck={false} />
          <Button size="sm" disabled={looking} onClick={follow}>{looking ? "Looking…" : x.payee ? "Find it now" : "Save"}</Button>
        </div>
      )}
      {note && <p className="mt-2 text-[12px] text-fg-3">{note}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => readGrant(m)}><RefreshCw className="size-3.5" /> Read again</Button>
        <Button size="sm" variant="ghost" onClick={() => removeGrant(k)}><Trash2 className="size-3.5" /> Stop tracking</Button>
        {me && <Button size="sm" variant="ghost" onClick={() => setLocal(k, !x.local)}>{x.local ? "Sync to my account" : "Keep in this browser only"}</Button>}
        {me && <span className="flex items-center gap-1 text-[12px] text-fg-3">{x.local ? "this browser only" : x.synced ? <><CircleCheck className="size-3.5 text-ok" /> synced to your account</> : "syncing…"}</span>}
      </div>
    </li>
  );
}

function Spark({ hist, budget }: { hist: { at: string; remainingSompi: string }[]; budget: number }) {
  const W = 300, H = 44, vals = hist.map((h) => Number(h.remainingSompi));
  const max = Math.max(budget || 0, ...vals) || 1, t0 = new Date(hist[0]!.at).getTime(), t1 = new Date(hist[hist.length - 1]!.at).getTime() || t0 + 1;
  const pts = hist.map((h, i) => [((new Date(h.at).getTime() - t0) / Math.max(1, t1 - t0)) * (W - 4) + 2, H - 3 - (vals[i]! / max) * (H - 8)]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0]!.toFixed(1)} ${p[1]!.toFixed(1)}`).join(" ");
  return (
    <figure className="mt-3">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-11 w-full" role="img" aria-label="Authority left over time">
        <path d={`${d} L${pts[pts.length - 1]![0]} ${H} L2 ${H} Z`} fill="var(--color-accent)" fillOpacity="0.12" />
        <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <figcaption className="text-[11.5px] text-fg-3">Authority left, hourly, {ago(hist[0]!.at)} to now — kept by your account.</figcaption>
    </figure>
  );
}
