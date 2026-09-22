import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fromHostedRow, fromReading, hostedMeta, type AgentView } from "./model";
import { useWallet } from "./connect";
import { api, loadRunner, saveRunner, type RunnerConfig } from "./runner";
import { pubkeyToAddress } from "./kaspa";

export interface Service { id: string; name: string; description: string | null; operator: string | null; endpoint: string | null; price: string | null; priceKas: number | null; address: string | null }

export type Scope = "mine" | "warda";
interface Data {
  /** In scope: yours, or Warda's published examples when nothing of yours is connected. */
  agents: AgentView[];
  /** Everything read, whatever the scope. */
  all: AgentView[];
  scope: Scope;
  setScope: (s: Scope) => void;
  /** True when the scope is what you have, rather than a visit to the examples. */
  yours: boolean;
  /** When the chain was last read for these agents, and how many readings did not load. */
  readAt: string | null;
  missing: number;
  services: Service[];
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

function toServices(raw: any): Service[] {
  return ((raw?.services ?? []) as any[]).map((s) => {
    const payee = String(s.payee ?? "");
    const net = String(s.payment?.network ?? "kaspa:testnet-10");
    const prefix = net.includes("mainnet") ? "kaspa" : "kaspatest";
    const address = payee.includes(":") ? payee : /^[0-9a-f]{64}$/i.test(payee) ? pubkeyToAddress(payee, prefix) : null;
    const pr = s.pricing;
    return {
      id: s.id, name: s.name, description: s.description ?? null, operator: s.operator ?? null, endpoint: s.endpoint ?? null,
      price: pr ? `${pr.amount} ${pr.asset} / ${pr.unit}` : null, priceKas: pr?.asset === "KAS" && Number(pr.amount) > 0 ? Number(pr.amount) : null, address,
    };
  });
}

export function DataProvider({ children }: { children: ReactNode }) {
  const { wallet } = useWallet();
  const [runner, setRunnerState] = useState<RunnerConfig>(loadRunner);
  const [scope, setScope] = useState<Scope>("mine");
  const [missing, setMissing] = useState(0);
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [errors, setErrors] = useState<Data["errors"]>({});
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const gen = useRef(0);

  const load = useCallback(async (c: RunnerConfig) => {
    const my = ++gen.current;
    setLoading(true);
    const errs: Data["errors"] = {};
    const svc = toServices(await json("/services.json").catch(() => null));
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

    const [p, h] = await Promise.all([published, hosted]);
    if (my !== gen.current) return;
    setServices(svc);
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
  const inScope = scope === "warda" || !yours ? agents.filter((a) => a.source === "published") : mine;
  const readAt = inScope.map((a) => a.checkedAt).filter(Boolean).sort().pop() ?? null;

  const value = useMemo<Data>(() => ({
    agents: inScope, all: agents, scope: yours ? scope : "warda", setScope, yours, readAt, missing,
    services, loading, errors, runner, updatedAt,
    setRunner: (c) => { saveRunner(c); setRunnerState(c); },
    reload: () => load(runner),
  }), [inScope, agents, yours, scope, readAt, missing, services, loading, errors, runner, updatedAt, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): Data {
  const v = useContext(Ctx);
  if (!v) throw new Error("useData outside DataProvider");
  return v;
}
