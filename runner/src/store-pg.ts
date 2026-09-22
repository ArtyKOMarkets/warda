/**
 * The runner's store on Postgres (Neon in production, PGlite in tests).
 *
 * Takes anything with `query(text, params) -> { rows }` — Neon's `Pool`,
 * `pg`'s, PGlite — so this file has no driver dependency and the tests run
 * the real SQL against a real Postgres with no network.
 *
 * Two things the schema is doing on purpose:
 *
 * - `runs (workflow_id, key)` is UNIQUE, and `claimRun` is an INSERT that
 *   does nothing on conflict. That constraint is rule 1 of the engine — one
 *   run per slot, ever — enforced by the database rather than by whichever
 *   worker happened to look first. Two workers racing get one run.
 * - `vault.agent` is the primary key and `putVault` never updates. A second
 *   key for an agent would orphan the first grant, so the database refuses.
 *
 * Bodies are JSON with bigints and Sets tagged, because a Workflow carries
 * sompi as bigint and a parsed cron as Sets, and plain JSON silently turns
 * the first into an error and the second into `{}`.
 */
import type { Approval, Edge, RunRecord, Store, VaultRecord } from "./store.ts";
import type { FeeLedger } from "./fees.ts";
import type { Workflow } from "./workflow.ts";

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export const SCHEMA = `
create table if not exists runner_workflows (
  id text primary key,
  agent text not null,
  enabled boolean not null,
  body jsonb not null,
  created_at bigint not null
);
create index if not exists runner_workflows_agent on runner_workflows (agent);
create table if not exists runner_runs (
  id text primary key,
  workflow_id text not null,
  agent text not null,
  key text not null,
  started_at bigint not null,
  body jsonb not null,
  unique (workflow_id, key)
);
create index if not exists runner_runs_agent on runner_runs (agent, started_at desc);
create table if not exists runner_cursors (workflow_id text primary key, at bigint not null);
create table if not exists runner_edges (workflow_id text primary key, edge text not null check (edge in ('clear','firing')));
create table if not exists runner_ledgers (agent text primary key, body jsonb not null);
create table if not exists runner_vault (agent text primary key, public_key text not null, body jsonb not null);
create table if not exists runner_approvals (id text primary key, agent text not null, body jsonb not null);
`;

export function encode(v: unknown): string {
  return JSON.stringify(v, function (_k, x) {
    if (typeof x === "bigint") return { $big: x.toString() };
    if (x instanceof Set) return { $set: [...x] };
    return x;
  });
}

export function decode<T>(v: unknown): T {
  const text = typeof v === "string" ? v : JSON.stringify(v);
  return JSON.parse(text, (_k, x) => {
    if (x && typeof x === "object" && !Array.isArray(x)) {
      if (typeof x.$big === "string" && Object.keys(x).length === 1) return BigInt(x.$big);
      if (Array.isArray(x.$set) && Object.keys(x).length === 1) return new Set(x.$set);
    }
    return x;
  }) as T;
}

export async function migrate(db: Queryable): Promise<void> {
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
}

export function pgStore(db: Queryable): Store {
  const one = async <T>(text: string, params: unknown[]): Promise<T | null> => {
    const { rows } = await db.query(text, params);
    return rows[0] ? decode<T>(rows[0].body) : null;
  };
  return {
    async putWorkflow(wf: Workflow) {
      await db.query(
        `insert into runner_workflows (id, agent, enabled, body, created_at) values ($1,$2,$3,$4::jsonb,$5)
         on conflict (id) do update set enabled = excluded.enabled, body = excluded.body`,
        [wf.id, wf.agent, wf.enabled, encode(wf), wf.createdAt],
      );
    },
    getWorkflow: (id) => one<Workflow>(`select body from runner_workflows where id = $1`, [id]),
    async listWorkflows(agent) {
      const { rows } = agent === undefined
        ? await db.query(`select body from runner_workflows order by created_at`)
        : await db.query(`select body from runner_workflows where agent = $1 order by created_at`, [agent]);
      return rows.map((r) => decode<Workflow>(r.body));
    },
    async claimRun(run: RunRecord) {
      const { rows } = await db.query(
        `insert into runner_runs (id, workflow_id, agent, key, started_at, body) values ($1,$2,$3,$4,$5,$6::jsonb)
         on conflict (workflow_id, key) do nothing returning id`,
        [run.id, run.workflowId, run.agent, run.key, run.startedAt, encode(run)],
      );
      return rows.length === 1;
    },
    async updateRun(run: RunRecord) {
      await db.query(`update runner_runs set body = $2::jsonb where workflow_id = $1 and key = $3`, [
        run.workflowId, encode(run), run.key,
      ]);
    },
    async listRuns(agent, limit = 50) {
      const { rows } = await db.query(
        `select body from runner_runs where agent = $1 order by started_at desc, id desc limit $2`,
        [agent, limit],
      );
      return rows.map((r) => decode<RunRecord>(r.body));
    },
    async runsSince(since, limit = 5000) {
      const { rows } = await db.query(
        `select body from runner_runs where started_at >= $1 order by started_at desc, id desc limit $2`,
        [since, limit],
      );
      return rows.map((r) => decode<RunRecord>(r.body));
    },
    async staleRuns(before) {
      const { rows } = await db.query(
        `select body from runner_runs where started_at < $1 and body->>'status' = 'running' limit 100`,
        [before],
      );
      return rows.map((r) => decode<RunRecord>(r.body));
    },
    async getCursor(id) {
      const { rows } = await db.query(`select at from runner_cursors where workflow_id = $1`, [id]);
      return rows[0] ? Number(rows[0].at) : null;
    },
    async setCursor(id, at) {
      await db.query(
        `insert into runner_cursors (workflow_id, at) values ($1,$2) on conflict (workflow_id) do update set at = excluded.at`,
        [id, at],
      );
    },
    async getEdge(id) {
      const { rows } = await db.query(`select edge from runner_edges where workflow_id = $1`, [id]);
      return rows[0] ? (rows[0].edge as Edge) : null;
    },
    async setEdge(id, edge) {
      await db.query(
        `insert into runner_edges (workflow_id, edge) values ($1,$2) on conflict (workflow_id) do update set edge = excluded.edge`,
        [id, edge],
      );
    },
    getLedger: (agent) => one<FeeLedger>(`select body from runner_ledgers where agent = $1`, [agent]),
    async setLedger(agent, l) {
      await db.query(
        `insert into runner_ledgers (agent, body) values ($1,$2::jsonb) on conflict (agent) do update set body = excluded.body`,
        [agent, encode(l)],
      );
    },
    getVault: (agent) => one<VaultRecord>(`select body from runner_vault where agent = $1`, [agent]),
    async putVault(rec) {
      const { rows } = await db.query(
        `insert into runner_vault (agent, public_key, body) values ($1,$2,$3::jsonb) on conflict (agent) do nothing returning agent`,
        [rec.agent, rec.publicKey, encode(rec)],
      );
      if (rows.length !== 1) throw new Error(`agent ${rec.agent} already has a key; refusing to replace it`);
    },
    async putApproval(a: Approval) {
      await db.query(
        `insert into runner_approvals (id, agent, body) values ($1,$2,$3::jsonb) on conflict (id) do update set body = excluded.body`,
        [a.id, a.agent, encode(a)],
      );
    },
    async listApprovals(agent) {
      const { rows } = await db.query(`select body from runner_approvals where agent = $1 order by id`, [agent]);
      return rows.map((r) => decode<Approval>(r.body));
    },
  };
}
