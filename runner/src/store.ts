/**
 * Everything the runner persists, behind one interface. `memoryStore` is for
 * tests and local runs; Postgres implements the same surface next, and
 * `claimRun` becomes an INSERT against a unique (workflow, key) constraint.
 */
import type { Action, Workflow } from "./workflow.ts";
import type { FeeLedger } from "./fees.ts";

/** `undelivered`: a payment was broadcast and the vendor did not serve. Never retried by paying. */
export type RunStatus = "running" | "ok" | "skipped" | "refused" | "failed" | "undelivered" | "undecided" | "missed";

export interface Step {
  action: Action["type"];
  status: "ok" | "refused" | "failed" | "submitted" | "requested";
  detail?: string;
  /** Written the moment a payment is broadcast, before the vendor answers. */
  txid?: string;
  sompi?: string;
}

export interface RunRecord {
  id: string;
  workflowId: string;
  agent: string;
  /** Idempotency: one run per (workflow, key), ever. */
  key: string;
  trigger: string;
  startedAt: number;
  finishedAt?: number;
  status: RunStatus;
  steps: Step[];
  /** Whether this run accrued the runner fee. */
  charged: boolean;
  note?: string;
  /** A payment broadcast by the step still running. Survives a crash mid-step. */
  inflight?: Step;
}

export interface VaultRecord {
  agent: string;
  /** The x-only key the grant names as its agent. */
  publicKey: string;
  /** Which vault made it. Absent on records written before there were two. */
  provider?: "envelope" | "turnkey";
  /** envelope: the sealed secret, base64. turnkey: a JSON reference — no secret. */
  sealed: string;
  createdAt: number;
}

export interface Approval {
  id: string;
  agent: string;
  workflowId: string;
  runId: string;
  op: "topup" | "renew" | "revoke";
  note: string;
  createdAt: number;
  status: "pending" | "signed" | "dismissed";
}

export type Edge = "clear" | "firing";

export interface Store {
  putWorkflow(wf: Workflow): Promise<void>;
  getWorkflow(id: string): Promise<Workflow | null>;
  listWorkflows(agent?: string): Promise<Workflow[]>;

  /** Records the run if (workflowId, key) is new. False means it already ran. */
  claimRun(run: RunRecord): Promise<boolean>;
  updateRun(run: RunRecord): Promise<void>;
  listRuns(agent: string, limit?: number): Promise<RunRecord[]>;

  getCursor(workflowId: string): Promise<number | null>;
  setCursor(workflowId: string, at: number): Promise<void>;
  getEdge(workflowId: string): Promise<Edge | null>;
  setEdge(workflowId: string, edge: Edge): Promise<void>;

  getLedger(agent: string): Promise<FeeLedger | null>;
  setLedger(agent: string, ledger: FeeLedger): Promise<void>;

  getVault(agent: string): Promise<VaultRecord | null>;
  /** Refuses to overwrite: a second key for an agent orphans the first grant. */
  putVault(rec: VaultRecord): Promise<void>;

  putApproval(a: Approval): Promise<void>;
  listApprovals(agent: string): Promise<Approval[]>;
}

export function memoryStore(): Store {
  const wfs = new Map<string, Workflow>();
  const runs = new Map<string, RunRecord>();
  const cursors = new Map<string, number>();
  const edges = new Map<string, Edge>();
  const ledgers = new Map<string, FeeLedger>();
  const vault = new Map<string, VaultRecord>();
  const approvals = new Map<string, Approval>();
  const key = (r: Pick<RunRecord, "workflowId" | "key">) => `${r.workflowId}\u0000${r.key}`;
  const clone = <T>(v: T): T => structuredClone(v);
  return {
    async putWorkflow(wf) {
      wfs.set(wf.id, clone(wf));
    },
    async getWorkflow(id) {
      const w = wfs.get(id);
      return w ? clone(w) : null;
    },
    async listWorkflows(agent) {
      return [...wfs.values()].filter((w) => agent === undefined || w.agent === agent).map(clone);
    },
    async claimRun(run) {
      if (runs.has(key(run))) return false;
      runs.set(key(run), clone(run));
      return true;
    },
    async updateRun(run) {
      runs.set(key(run), clone(run));
    },
    async listRuns(agent, limit = 50) {
      return [...runs.values()]
        .filter((r) => r.agent === agent)
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, limit)
        .map(clone);
    },
    async getCursor(id) {
      return cursors.get(id) ?? null;
    },
    async setCursor(id, at) {
      cursors.set(id, at);
    },
    async getEdge(id) {
      return edges.get(id) ?? null;
    },
    async setEdge(id, e) {
      edges.set(id, e);
    },
    async getLedger(agent) {
      const l = ledgers.get(agent);
      return l ? clone(l) : null;
    },
    async setLedger(agent, l) {
      ledgers.set(agent, clone(l));
    },
    async getVault(agent) {
      const v = vault.get(agent);
      return v ? clone(v) : null;
    },
    async putVault(rec) {
      if (vault.has(rec.agent)) throw new Error(`agent ${rec.agent} already has a key; refusing to replace it`);
      vault.set(rec.agent, clone(rec));
    },
    async putApproval(a) {
      approvals.set(a.id, clone(a));
    },
    async listApprovals(agent) {
      return [...approvals.values()].filter((a) => a.agent === agent).map(clone);
    },
  };
}
