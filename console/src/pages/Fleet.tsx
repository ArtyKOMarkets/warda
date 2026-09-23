import { useMemo, useState } from "react";
import { AlertTriangle, Check, ClipboardList, Layers, Wallet } from "lucide-react";
import { useData, agentHit } from "@/lib/data";
import { useWallet } from "@/lib/connect";
import { spendable, type AgentView } from "@/lib/model";
import { kas } from "@/lib/format";
import { href } from "@/lib/router";
import { commandFor } from "@/lib/commands";
import { cn } from "@/lib/cn";
import { AgentMark, BudgetRing } from "@/components/agent";
import { Badge, Button, Card, CardHeader, Copy, Empty, Kas, PageHeader, Stat, StatusBadge, Tabs } from "@/components/ui";
import { ScopeBanner } from "@/components/scope";
import { hueOf } from "@/components/charts";
import { Lineage } from "@/components/lineage";
import { agentName } from "./shared";

/* The fleet: every grant at once, what each is short of, and the commands
   that act on a handful of them. The console signs nothing — a bulk action
   is one command per grant, for the machine that holds the keys. */

type Flag = { word: string; tone: "warn" | "bad" };
function flagsOf(a: AgentView): Flag[] {
  const out: Flag[] = [];
  if (a.status === "ended") return out;
  const can = spendable(a);
  if (a.expired) out.push({ word: "expired — reclaim", tone: "warn" });
  if (can !== null && a.maxPerPayment !== null && can <= a.maxPerPayment) out.push({ word: "cannot pay in full", tone: "bad" });
  if (a.budget && can !== null && can / a.budget < 0.2 && !a.expired) out.push({ word: "under 20% left", tone: "warn" });
  if (!a.expired && a.expiresInDaa !== null && a.expiresInDaa < 3 * 864_000) out.push({ word: "ends in under 3 days", tone: "warn" });
  if (a.reconciliation?.unrecorded && a.reconciliation.unrecorded > 0) out.push({ word: "spending with no receipt", tone: "warn" });
  return out;
}

export function Fleet() {
  const { agents, filter } = useData();
  const { wallet } = useWallet();
  const [f, setF] = useState<"all" | "live" | "attention" | "ended">("all");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<"revoke" | "reclaim" | "topup" | null>(null);

  const rows = agents.filter((a) => agentHit(a, filter)).map((a) => ({ a, flags: flagsOf(a) }));
  const live = rows.filter((r) => r.a.status !== "ended");
  const attention = rows.filter((r) => r.flags.length);
  const shown = f === "all" ? rows : f === "live" ? live : f === "attention" ? attention : rows.filter((r) => r.a.status === "ended");

  const unspent = live.reduce((s, r) => s + (spendable(r.a) ?? 0), 0);
  const authorised = rows.reduce((s, r) => s + (r.a.budget ?? 0), 0);
  const largest = Math.max(0, ...live.map((r) => spendable(r.a) ?? 0));
  const bal = wallet?.family === "kaspa" && wallet.bal && typeof wallet.bal === "object" ? wallet.bal : null;
  const walletKas = bal ? bal.total / 1e8 : null;
  const capital = useMemo(() => {
    const parts = live.filter((r) => (spendable(r.a) ?? 0) > 0).map((r) => ({ key: r.a.key, label: agentName(r.a), value: spendable(r.a)! }));
    if (walletKas) parts.push({ key: "__wallet", label: "Unallocated — in your wallet", value: walletKas });
    return parts.sort((x, y) => y.value - x.value);
  }, [live, walletKas]);
  const capitalTotal = capital.reduce((s, x) => s + x.value, 0);

  const toggle = (k: string) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const chosen = rows.filter((r) => sel.has(r.a.key));
  const skipped = bulk ? chosen.filter((r) => (bulk === "revoke" ? r.a.status === "ended" : bulk === "reclaim" ? r.a.status === "ended" || !r.a.expired : r.a.status === "ended")) : [];
  const doable = bulk ? chosen.filter((r) => !skipped.includes(r)) : [];
  const script = doable.map((r) => `# ${agentName(r.a)}\n${commandFor(bulk!, r.a.payees[0]?.address)}`).join("\n\n");

  return (
    <>
      <ScopeBanner />
      <PageHeader title="Fleet" sub="Every grant at once: where the capital sits, what needs attention, and the commands that act on several at a time." />

      <Card className="grid grid-cols-[minmax(0,1fr)] grid-cols-2 items-start gap-x-6 gap-y-6 p-5 sm:p-6 lg:grid-cols-4">
        <Stat label="Unspent authority" hint={`of ${kas(authorised)} KAS ever authorised`}><Kas value={kas(unspent)} /></Stat>
        <Stat label="Largest exposure" hint={unspent > 0 ? `${Math.round((largest / unspent) * 100)}% of what is unspent` : "nothing unspent"} className="lg:border-l lg:border-line lg:pl-6"><Kas value={kas(largest)} /></Stat>
        <Stat label="Needs attention" hint="grants with a flag below" className="lg:border-l lg:border-line lg:pl-6"><span className="num">{attention.length}</span></Stat>
        <Stat label="Grants" hint={`${live.length} live · ${rows.length - live.length} ended`} className="lg:border-l lg:border-line lg:pl-6"><span className="num">{rows.length}</span></Stat>
      </Card>

      <Card className="mt-4 p-5 sm:p-6">
        <div className="flex items-center gap-2 text-[15px] font-semibold"><Wallet className="size-4 text-fg-3" /> Where the capital sits</div>
        {capitalTotal > 0 ? (
          <>
            <div className="mt-4 flex h-3 w-full overflow-hidden rounded-full">
              {capital.map((c, i) => <div key={c.key} title={`${c.label}: ${kas(c.value)} KAS`} style={{ width: `${(c.value / capitalTotal) * 100}%`, background: c.key === "__wallet" ? "var(--color-line-strong)" : hueOf(i) }} />)}
            </div>
            <ul className="mt-4 grid grid-cols-[minmax(0,1fr)] gap-x-6 gap-y-1.5 sm:grid-cols-2">
              {capital.map((c, i) => (
                <li key={c.key} className="flex items-center gap-2 text-[12.5px]">
                  <span className="size-2.5 shrink-0 rounded-sm" style={{ background: c.key === "__wallet" ? "var(--color-line-strong)" : hueOf(i) }} />
                  <span className="min-w-0 flex-1 truncate">{c.label}</span>
                  <span className="num text-fg-2">{kas(c.value)}</span>
                  <span className="num w-10 text-right text-fg-3">{Math.round((c.value / capitalTotal) * 100)}%</span>
                </li>
              ))}
            </ul>
            {!walletKas && <p className="mt-3 text-[12px] text-fg-3">Connect a Kaspa wallet and what it holds shows here as unallocated.</p>}
          </>
        ) : <p className="mt-3 text-[13px] text-fg-3">Nothing unspent to place.</p>}
      </Card>

      <Tabs className="mb-4 mt-8" value={f} onChange={setF} items={[
        { value: "all", label: "All", count: rows.length },
        { value: "live", label: "Live", count: live.length },
        { value: "attention", label: "Needs attention", count: attention.length },
        { value: "ended", label: "Ended", count: rows.length - live.length },
      ]} />

      <Card className="overflow-hidden">
        {/* On a phone the commands only appear once something is ticked, so the
            list starts at the top of the card instead of below a toolbar. */}
        <div className="flex items-center gap-2 border-b border-line px-4 py-3 sm:px-5">
          <span className={cn("text-[12.5px] text-fg-3", !sel.size && "hidden sm:inline")}>
            {sel.size ? `${sel.size} selected` : "Select grants to act on several at once"}
          </span>
          <span className="flex-1" />
          <div className={cn("flex flex-wrap items-center justify-end gap-2", !sel.size && "hidden sm:flex")}>
            <Button size="sm" variant="ghost" onClick={() => setSel(new Set(shown.map((r) => r.a.key)))}>Select all</Button>
            <Button size="sm" variant="ghost" disabled={!sel.size} onClick={() => { setSel(new Set()); setBulk(null); }}>Clear</Button>
            <Button size="sm" variant="danger" disabled={!sel.size} onClick={() => setBulk("revoke")}>Revoke</Button>
            <Button size="sm" disabled={!sel.size} onClick={() => setBulk("reclaim")}>Reclaim expired</Button>
            <Button size="sm" disabled={!sel.size} onClick={() => setBulk("topup")}>Renew</Button>
          </div>
          {!sel.size && <span className="text-[12.5px] text-fg-3 sm:hidden">Tick a grant to act on several at once</span>}
        </div>
        {bulk && (
          <div className="rise border-b border-line p-5">
            {doable.length ? (
              <>
                <div className="flex items-center gap-2 text-[13.5px] font-medium"><ClipboardList className="size-4 text-fg-3" /> {doable.length} command{doable.length === 1 ? "" : "s"}, for the machine that holds the keys</div>
                <div className="mt-2 flex items-start rounded-lg border border-line-strong bg-bg">
                  <pre className="num min-w-0 flex-1 overflow-x-auto whitespace-pre p-3 text-[12px] leading-relaxed text-fg-2">{script}</pre>
                  <Copy text={script} className="m-1.5 shrink-0" label="Copy the commands" />
                </div>
              </>
            ) : <p className="text-[13px] text-fg-3">Nothing selected can take that command.</p>}
            {skipped.length > 0 && (
              <p className="mt-3 text-[12.5px] text-warn">Skipped: {skipped.map((r) => `${agentName(r.a)} (${r.a.status === "ended" ? "already ended" : "term has not ended"})`).join(", ")}.</p>
            )}
            <Button size="sm" variant="ghost" className="mt-3" onClick={() => setBulk(null)}>Close</Button>
          </div>
        )}
        {!shown.length ? <Empty icon={<Layers className="size-5" />} title="Nothing here" /> : (<>
          {/* A phone gets one card per grant; the table needs a wider screen than it has. */}
          <ul className="divide-y divide-line lg:hidden">
            {shown.map(({ a, flags }) => (
              <li key={a.key} className={cn("px-4 py-3.5", sel.has(a.key) && "bg-raised/40")}>
                <div className="flex items-start gap-3">
                  <button role="checkbox" aria-checked={sel.has(a.key)} onClick={() => toggle(a.key)} aria-label={`Select ${agentName(a)}`}
                    className="-m-2 grid shrink-0 place-items-center p-2">
                    <span className={cn("grid size-5 place-items-center rounded-[6px] border", sel.has(a.key) ? "border-accent bg-accent text-accent-ink" : "border-fg-3/60")}>
                      {sel.has(a.key) && <Check className="size-3.5" strokeWidth={3} />}
                    </span>
                  </button>
                  <a href={href("agents", a.key)} className="flex min-w-0 flex-1 items-start gap-3">
                    <AgentMark agent={a} size={28} className="rounded-lg" />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[14px] font-medium">{agentName(a)}</span>
                        <StatusBadge status={a.status} />
                      </div>
                      <div className="mt-1.5 flex items-baseline gap-1.5 text-[13px]">
                        <Kas value={kas(spendable(a))} unit={false} className="text-[15px] font-semibold" />
                        <span className="text-fg-3">of {kas(a.budget)} KAS · {a.status === "ended" || a.expired ? "ended" : a.expiresIn ?? "—"}</span>
                      </div>
                      {flags.length > 0 && <span className="mt-2 flex flex-wrap gap-1">{flags.map((fl) => <Badge key={fl.word} tone={fl.tone}>{fl.word}</Badge>)}</span>}
                    </div>
                    <BudgetRing a={a} size={36} width={4.5} bare className="mt-0.5" />
                  </a>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto lg:block">
            <table className="w-full min-w-[860px] text-left text-[13.5px]">
              <thead className="border-b border-line text-[12px] text-fg-3"><tr>
                <th className="w-10 px-4 py-3" />{["Agent", "State", "Can still pay", "Of budget", "Per payment", "Term", "Flags"].map((h) => <th key={h} className="px-4 py-3 font-medium">{h}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-line">
                {shown.map(({ a, flags }) => (
                  <tr key={a.key} className={cn("transition hover:bg-raised/50", sel.has(a.key) && "bg-raised/40")}>
                    <td className="px-4 py-3.5"><button role="checkbox" aria-checked={sel.has(a.key)} onClick={() => toggle(a.key)} className={cn("grid size-4 place-items-center rounded-[5px] border", sel.has(a.key) ? "border-accent bg-accent text-accent-ink" : "border-fg-3/60")}>{sel.has(a.key) && <Check className="size-3" strokeWidth={3} />}</button></td>
                    <td className="px-4"><a href={href("agents", a.key)} className="flex items-center gap-2.5"><AgentMark agent={a} size={24} className="rounded-md" />{agentName(a)}</a></td>
                    <td className="px-4"><StatusBadge status={a.status} /></td>
                    <td className="px-4"><Kas value={kas(spendable(a))} unit={false} /></td>
                    <td className="px-4"><span className="flex items-center gap-2"><BudgetRing a={a} size={22} width={3.5} bare /><span className="num text-fg-2">{kas(a.budget)}</span></span></td>
                    <td className="num px-4 text-fg-2">{kas(a.maxPerPayment)}</td>
                    <td className="px-4 text-fg-2">{a.status === "ended" || a.expired ? "ended" : a.expiresIn ?? "—"}</td>
                    <td className="px-4"><span className="flex flex-wrap gap-1">{flags.map((fl) => <Badge key={fl.word} tone={fl.tone}>{fl.word}</Badge>)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>)}
      </Card>

      <Lineage className="mt-4" agents={agents} title="Who delegated to whom" sub="A helper can only ever get less than its parent" />

      <div className="mt-4 grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-2">
      <Templates />
      <RulesInForce agents={agents} />
      </div>

      <Card className="mt-4 p-5">
        <div className="flex items-center gap-2 text-[15px] font-semibold"><AlertTriangle className="size-4 text-warn" /> Risk controls</div>
        <p className="mt-2 text-[13px] text-fg-2">Rules the console runs for you, so you hear about these before they bite.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={href("alerts", "rules")} className="rounded-lg border border-line-strong px-3 py-2 text-[13px] transition hover:bg-raised">Tell me when an agent is running out →</a>
          <a href={href("alerts", "rules")} className="rounded-lg border border-line-strong px-3 py-2 text-[13px] transition hover:bg-raised">Tell me before a term ends →</a>
        </div>
      </Card>
    </>
  );
}

/** Who delegated to whom. */

/* Shapes for a new grant, kept in this browser. The three that come with the
   console are shapes, not recommendations, and delete like any other. */
const TKEY = "warda.console.templates";
interface Tpl { name: string; budget: number; cap: number; epoch: number; days: number }
const TPL0: Tpl[] = [
  { name: "API buyer", budget: 50, cap: 1, epoch: 5, days: 30 },
  { name: "Researcher", budget: 200, cap: 5, epoch: 20, days: 30 },
  { name: "Short-lived worker", budget: 10, cap: 0.5, epoch: 2, days: 1 },
];
const tplGet = (): Tpl[] => { try { const t = JSON.parse(localStorage.getItem(TKEY) || "null"); return Array.isArray(t) ? t : TPL0; } catch { return TPL0; } };
const tplSet = (t: Tpl[]) => { try { localStorage.setItem(TKEY, JSON.stringify(t)); } catch { /* */ } };

function Templates() {
  const [list, setList] = useState<Tpl[]>(tplGet);
  const [adding, setAdding] = useState(false);
  const [d, setD] = useState<Tpl>({ name: "", budget: 10, cap: 1, epoch: 5, days: 30 });
  const save = (l: Tpl[]) => { setList(l); tplSet(l); };
  return (
    <Card>
      <CardHeader title="Grant shapes" sub="Kept in this browser. Use one and the create page opens filled in." action={<Button size="sm" variant="ghost" onClick={() => setAdding(!adding)}>{adding ? "Close" : "Add one"}</Button>} />
      <ul className="mt-2 divide-y divide-line">
        {list.length ? list.map((t, i) => (
          <li key={t.name + i} className="flex items-center gap-3 px-5 py-3 text-[13px]">
            <div className="min-w-0 flex-1"><div className="font-medium">{t.name}</div>
              <div className="num text-[11.5px] text-fg-3">{t.budget} KAS budget · {t.cap} a payment · {t.epoch} per period · {t.days} day{t.days === 1 ? "" : "s"}</div></div>
            <a className="inline-flex h-9 shrink-0 items-center rounded-lg border border-line-strong px-3 text-[12.5px] transition hover:bg-raised" href={href("create", "", String(t.budget), String(t.cap))}>Use</a>
            <button aria-label={`Delete ${t.name}`} className="grid size-9 shrink-0 place-items-center rounded-lg text-[16px] text-fg-3 transition hover:bg-raised hover:text-bad" onClick={() => save(list.filter((_, j) => j !== i))}>×</button>
          </li>
        )) : <li className="px-5 py-6 text-center text-[13px] text-fg-3">No shapes. Add one.</li>}
      </ul>
      {adding && (
        <div className="rise grid grid-cols-[minmax(0,1fr)] gap-3 border-t border-line p-5 sm:grid-cols-5">
          {([["name", "Name"], ["budget", "Budget"], ["cap", "Per payment"], ["epoch", "Per period"], ["days", "Days"]] as const).map(([k, label]) => (
            <label key={k} className="block"><span className="mb-1 block text-[11.5px] text-fg-3">{label}</span>
              <input className="num h-9 w-full rounded-lg border border-line-strong bg-bg px-2.5 text-[13px] focus:border-accent/60 focus:outline-none"
                value={String(d[k])} onChange={(e) => setD({ ...d, [k]: k === "name" ? e.target.value : Number(e.target.value.replace(/[^\d.]/g, "")) || 0 })} /></label>
          ))}
          <div className="sm:col-span-5"><Button size="sm" disabled={!d.name.trim()} onClick={() => { save([...list, d]); setAdding(false); setD({ name: "", budget: 10, cap: 1, epoch: 5, days: 30 }); }}>Save the shape</Button></div>
        </div>
      )}
    </Card>
  );
}

/** Every limit these grants enforce, in one place. Not events — rules. */
function RulesInForce({ agents }: { agents: AgentView[] }) {
  const rows = agents.flatMap((a) => a.derived.map((d) => ({ a, d })));
  if (!rows.length) return null;
  return (
    <Card>
      <CardHeader title="Rules in force" sub="Worked out from each grant's own terms — things that cannot happen" />
      <ul className="mt-2 max-h-[420px] divide-y divide-line overflow-y-auto">
        {rows.map(({ a, d }, i) => (
          <li key={i} className="px-5 py-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px]"><a href={href("agents", a.key, "blocked")} className="font-medium hover:text-accent">{agentName(a)}</a><span className="text-fg-3">· {d.rule}</span></div>
            <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-fg-3">{d.why}</p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
