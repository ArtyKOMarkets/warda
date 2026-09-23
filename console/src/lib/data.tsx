import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { allPayments, fromHostedRow, fromReading, hasGrant, hostedMeta, type AgentView } from "./model";
import { useWallet } from "./connect";
import { api, loadRunner, saveRunner, type RunnerConfig } from "./runner";
import { pubkeyToAddress } from "./kaspa";

export interface Service {
  id: string; name: string; description: string | null; operator: string | null; endpoint: string | null;
  price: string | null; priceKas: number | null; address: string | null;
  /** What the operator says it sells, as the registry's capability strings. */
  capabilities: string[];
  /** The price as listed: "0.04", "KAS", "request". */
  priceAmount: string | null; priceAsset: string | null; priceUnit: string | null;
  /** How it takes payment: the protocol name, and whether it speaks Warda. */
  protocol: string | null; warda: boolean; network: string | null;
  /** The operator's own note about the listing, and the day it was listed. */
  operatorNote: string | null; listedAt: string | null;
  /** The payee as published, before it is read as an address. */
  payee: string | null;
}

/** A service agents here already pay that has never asked to be listed. */
export interface Unlisted { name: string; endpoint: string | null; why: string | null; payee: string | null; address: string | null }

/** Which reading of the registry is on screen. A live answer is not the file. */
export interface RegistryRead { live: boolean; words: string }

export type Scope = "mine" | "warda";
export type Range = "7" | "30" | "all";
interface Data {
  /** In scope: yours, or Warda's published examples when nothing of yours is connected. */
  agents: AgentView[];
  /** Everything read, whatever the scope. */
  all: AgentView[];
  scope: Scope;
  setScope: (s: Scope) => void;
  /** How far back the tiles, charts and tables look. */
  range: Range;
  setRange: (r: Range) => void;
  /** One box that filters every view: an agent, a payee, a grant address, an endpoint. */
  filter: string;
  setFilter: (f: string) => void;
  /** True when the scope is what you have, rather than a visit to the examples. */
  yours: boolean;
  /** When the chain was last read for these agents, and how many readings did not load. */
  readAt: string | null;
  missing: number;
  services: Service[];
  /** Known, not listed: from the published file, which is the only place they are written down. */
  unlisted: Unlisted[];
  /** Null when neither the registry nor the published file answered. */
  registry: RegistryRead | null;
  loading: boolean;
  /** Per source, so one failing does not blank the other. */
  errors: { published?: string; hosted?: string };
  runner: RunnerConfig;
  setRunner: (c: RunnerConfig) => void;
  reload: () => void;
  updatedAt: number | null;
}

const Ctx = createContext<Data | null>(null);

async function json(path: string) {
  const r = await fetch(path, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${path} answered ${r.status}`);
  return r.json();
}

/** Payee names come only from the Services registry. Anything else is unlisted. */
function serviceLabels(services: Service[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of services) if (s.address) m.set(s.address, s.name);
  return m;
}

/** A published payee key, read as the address a grant would name. */
function payeeAddress(payee: string, network: string | null): string | null {
  const prefix = String(network ?? "kaspa:testnet-10").includes("mainnet") ? "kaspa" : "kaspatest";
  return payee.includes(":") ? payee : /^[0-9a-f]{64}$/i.test(payee) ? pubkeyToAddress(payee, prefix) : null;
}

function toServices(list: any): Service[] {
  return (Array.isArray(list) ? (list as any[]) : []).map((s) => {
    const payee = String(s.payee ?? "");
    const pay = s.payment ?? {};
    const net = pay.network ? String(pay.network) : null;
    const address = payeeAddress(payee, net);
    const pr = s.pricing;
    return {
      id: String(s.id ?? s.name ?? payee), name: String(s.name ?? s.id ?? "Unnamed listing"), description: s.description ?? null,
      operator: s.operator ?? null, endpoint: s.endpoint ?? null,
      price: pr ? `${pr.amount} ${pr.asset} / ${pr.unit}` : null, priceKas: pr?.asset === "KAS" && Number(pr.amount) > 0 ? Number(pr.amount) : null, address,
      capabilities: Array.isArray(s.capabilities) ? s.capabilities.map(String) : [],
      priceAmount: pr?.amount != null ? String(pr.amount) : null, priceAsset: pr?.asset ?? null, priceUnit: pr?.unit ?? null,
      protocol: pay.protocol ?? null, warda: pay.warda === true, network: net,
      operatorNote: s.operatorNote ?? null, listedAt: s.listedAt ?? null, payee: payee || null,
    };
  });
}

function toUnlisted(list: any): Unlisted[] {
  return (Array.isArray(list) ? (list as any[]) : []).map((u) => {
    const payee = String(u.payee ?? "");
    return { name: String(u.name ?? u.endpoint ?? "Unnamed"), endpoint: u.endpoint ?? null, why: u.why ?? null, payee: payee || null, address: payeeAddress(payee, u.network ?? null) };
  });
}

/* The same two sources /network reads: the hosted registry, which re-fetches
   every source from its operator's domain and re-checks its signature on each
   request, and the published file, which is a statement about the last commit.
   A live answer replaces the list; it never merges with it, and the page says
   which reading it is showing, because a cached list and a live one are
   different claims. */
function liveRegistry(file: any): Promise<{ services: Service[]; words: string } | null> {
  const base = String(file?.registry ?? "").replace(/\/+$/, "");
  if (!base) return Promise.resolve(null);
  return fetch(`${base}/services`, { cache: "no-cache", signal: AbortSignal.timeout(8000) })
    .then((r) => (r.ok ? r.json() : null))
    .then((l) => (l && Array.isArray(l.services) ? { services: toServices(l.services), words: `live from ${base.replace(/^https?:\/\//, "")}` } : null))
    .catch(() => null);
}

export function DataProvider({ children }: { children: ReactNode }) {
  const { wallet } = useWallet();
  const [runner, setRunnerState] = useState<RunnerConfig>(loadRunner);
  const [scope, setScope] = useState<Scope>("mine");
  const [picked, setPicked] = useState(false);   // the person chose a scope; stop following the wallet
  const [range, setRange] = useState<Range>("30");
  const [filter, setFilter] = useState("");
  const [missing, setMissing] = useState(0);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [unlisted, setUnlisted] = useState<Unlisted[]>([]);
  const [registry, setRegistry] = useState<RegistryRead | null>(null);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Data["errors"]>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const gen = useRef(0);

  const load = useCallback(async (c: RunnerConfig) => {
    const my = ++gen.current;
    setLoading(true);
    const errs: Data["errors"] = {};
    const file = await json("/services.json").catch(() => null);
    const svc = toServices(file?.services);
    // Started here, read below: the registry answers while the chain is being read.
    const live = liveRegistry(file);
    const labels = serviceLabels(svc);

    const published = (async () => {
      try {
        const idx = await json("/agents.json");
        const ids: string[] = idx.ids ?? [];
        const rows = await Promise.all(ids.map((id) => json(`/agent-${id}.json`).then((r) => fromReading(r, "published", id, labels)).catch(() => null)));
        setMissing(rows.filter((x) => !x).length);
        return rows.filter((x): x is AgentView => !!x);
      } catch (e) {
        errs.published = (e as Error).message;
        return [];
      }
    })();

    const hosted = (async () => {
      if (!c.key) return [];
      try {
        const list = await api<{ agents: any[] }>(c, "GET", "/v1/agents?detail=1");
        return await Promise.all(list.agents.map(async (row) => {
          try {
            const r = await api(c, "GET", `/v1/agents/${encodeURIComponent(row.agent)}/reading`);
            const v = fromReading(r, "hosted", row.agent, labels);
            v.hosted = hostedMeta(row);
            v.parent = row.parent ?? v.parent;
            if (row.lastRun?.at) {
              const at = new Date(row.lastRun.at).toISOString();
              if (!v.lastActive || at > v.lastActive) v.lastActive = at;
            }
            // Before funding there is no grant to read; the row knows the plan.
            if (v.budget === null) v.budget = fromHostedRow(row).budget;
            if (row.state && !["active", "paying"].includes(row.state) && v.status === "active") v.status = fromHostedRow(row).status;
            return v;
          } catch {
            return fromHostedRow(row);
          }
        }));
      } catch (e) {
        errs.hosted = (e as Error).message;
        return [];
      }
    })();

    const [p, h, l] = await Promise.all([published, hosted, live]);
    if (my !== gen.current) return;
    setServices(l ? l.services : svc);
    setUnlisted(toUnlisted(file?.known_but_unlisted));
    setRegistry(l ? { live: true, words: l.words } : file ? { live: false, words: "the published list \u2014 the registry did not answer" } : null);
    setAgents([...h, ...p]);
    setErrors(errs);
    setLoading(false);
    setUpdatedAt(Date.now());
  }, []);

  useEffect(() => { load(runner); }, [load, runner]);
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible") load(runner); }, 60_000);
    return () => clearInterval(t);
  }, [load, runner]);

  /* Whose agents these are. A published reading is yours when it names your
     connected key; a hosted one is yours because the runner holds it for you.
     With neither a wallet nor a runner key there is nothing of yours to show,
     so the console shows Warda's own agents and says they are examples. */
  const key = wallet?.family === "kaspa" ? wallet.key : null;
  const mine = useMemo(() => agents.filter((a) => a.source === "hosted" || (key && (a.principalKey === key || a.ownerKey === key || a.agentKey === key))), [agents, key]);
  const yours = mine.length > 0;
  /* Which set is on screen. A connected wallet means "mine"; disconnecting
     goes back to Warda's own agents, which is what the console shows anyone
     with nothing connected. Choosing a scope yourself sticks until the
     wallet changes. */
  useEffect(() => { if (!picked) setScope(wallet ? "mine" : "warda"); }, [wallet, picked]);
  const want = picked ? scope : wallet ? "mine" : "warda";
  const inScope = want === "warda" || !yours ? agents.filter((a) => a.source === "published") : mine;
  const readAt = inScope.map((a) => a.checkedAt).filter(Boolean).sort().pop() ?? null;

  const value = useMemo<Data>(() => ({
    agents: inScope, all: agents, scope: yours ? want : "warda", setScope: (x: Scope) => { setPicked(true); setScope(x); }, yours, readAt, missing,
    range, setRange, filter, setFilter,
    services, unlisted, registry, loading, errors, runner, updatedAt,
    setRunner: (c) => { saveRunner(c); setRunnerState(c); },
    reload: () => load(runner),
  }), [inScope, agents, yours, scope, readAt, missing, services, unlisted, registry, loading, errors, runner, updatedAt, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): Data {
  const v = useContext(Ctx);
  if (!v) throw new Error("useData outside DataProvider");
  return v;
}

/* The range and the filter, applied. A payment is in range by its date; an
   agent matches the filter by its name, its mission, its grant address, a
   payee or an endpoint it has paid. */
export function inRange(at: string | number | null | undefined, range: Range): boolean {
  if (range === "all") return true;
  if (!at) return false;
  const t = typeof at === "number" ? at : new Date(at).getTime();
  return Date.now() - t <= Number(range) * 86_400_000;
}
export function agentHit(a: AgentView, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return [a.label, a.id, a.mission, a.grantAddress, a.covenantId, a.agentKey, ...a.payees.map((p) => p.address), ...a.payees.map((p) => p.label ?? ""), ...a.payments.map((p) => p.url ?? "")]
    .some((v) => String(v ?? "").toLowerCase().includes(s));
}
export function paymentHit(p: { url?: string | null; payTo?: string | null; host?: string | null; task?: string | null }, a: AgentView, q: string): boolean {
  if (!q) return true;
  const s = q.toLowerCase();
  return [p.url, p.payTo, p.host, p.task, a.label, a.id].some((v) => String(v ?? "").toLowerCase().includes(s));
}

/**
 * How much is in each section — the numbers the sidebar puts beside its links.
 *
 * ## What they count, and what they deliberately do not
 *
 * Scope and the filter box apply, because both are global: the filter's own
 * contract in `Data` is that it filters every view, so a badge that ignored it
 * would contradict the page one click away. A page's own tabs and its local
 * search do not apply — the badge answers "how much is in here", which is the
 * question you ask BEFORE clicking, and the tab bar answers the rest on
 * arrival. Landing on Agents shows Live while the badge counts all of them,
 * and the tab bar says `All n` beside it with the same n.
 *
 * ## Why null is a value here
 *
 * A count of 0 is a claim: there is nothing. `null` is the other thing that
 * can be true — nothing was read. The Services page already draws this
 * distinction in prose ("that is not 'no services'; it is one reading that did
 * not load"), and a sidebar that flattened it to `0` would put the stronger
 * claim next to the link to the page that refuses to make it.
 */
export function useCounts(): Record<string, number | null> {
  const { agents, services, registry, filter, loading } = useData();
  return useMemo(() => {
    const hit = agents.filter((a) => agentHit(a, filter));
    const read = !loading || agents.length > 0;
    return {
      agents: read ? hit.length : null,
      grants: read ? hit.filter(hasGrant).length : null,
      activity: read ? allPayments(agents).filter(({ p, a }) => paymentHit(p, a, filter)).length : null,
      /* Neither source answered: not zero services, no reading. */
      services: !services.length && !registry ? null : services.length,
    };
  }, [agents, services, registry, filter, loading]);
}
