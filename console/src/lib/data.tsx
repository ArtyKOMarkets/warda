import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fromHostedRow, fromReading, hostedMeta, type AgentView } from "./model";
import { api, loadRunner, saveRunner, type RunnerConfig } from "./runner";
import { pubkeyToAddress } from "./kaspa";

export interface Service { id: string; name: string; operator: string | null; endpoint: string | null; price: string | null; priceKas: number | null; address: string | null }

interface Data {
  agents: AgentView[];
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
      id: s.id, name: s.name, operator: s.operator ?? null, endpoint: s.endpoint ?? null,
      price: pr ? `${pr.amount} ${pr.asset} / ${pr.unit}` : null, priceKas: pr?.asset === "KAS" && Number(pr.amount) > 0 ? Number(pr.amount) : null, address,
    };
  });
}

export function DataProvider({ children }: { children: ReactNode }) {
  const [runner, setRunnerState] = useState<RunnerConfig>(loadRunner);
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

  const value = useMemo<Data>(() => ({
    agents, services, loading, errors, runner, updatedAt,
    setRunner: (c) => { saveRunner(c); setRunnerState(c); },
    reload: () => load(runner),
  }), [agents, services, loading, errors, runner, updatedAt, load]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useData(): Data {
  const v = useContext(Ctx);
  if (!v) throw new Error("useData outside DataProvider");
  return v;
}
