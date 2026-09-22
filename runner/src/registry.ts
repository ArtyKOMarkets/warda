/**
 * Who owns what: accounts, their agents, each agent's grant, and the secret
 * behind each webhook URL.
 *
 * Kept apart from `Store` because the engine never needs it. The engine runs
 * workflows; the API decides who may create, read and fire them. A secret is
 * stored as its SHA-256 and compared in constant time; the plaintext exists
 * once, in the response that created it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Queryable } from "./store-pg.ts";
import { decode, encode } from "./store-pg.ts";
import type { Manifest } from "@warda_protocol/agent";

export interface GrantRecord {
  agent: string;
  manifest: Manifest;
  /** Allowlist members as the grant committed to them: addresses or x-only hex. */
  recipients: string[];
  updatedAt: number;
}

export interface Registry {
  createAccount(now: number): Promise<{ id: string; apiKey: string }>;
  accountFor(apiKey: string): Promise<string | null>;
  claimAgent(agent: string, account: string, now: number): Promise<boolean>;
  ownerOf(agent: string): Promise<string | null>;
  agentsOf(account: string): Promise<string[]>;
  putGrant(g: GrantRecord): Promise<void>;
  getGrant(agent: string): Promise<GrantRecord | null>;
  /** Returns the plaintext secret once. */
  createHook(workflowId: string): Promise<string>;
  checkHook(workflowId: string, secret: string): Promise<boolean>;
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const token = (prefix: string) => `${prefix}_${randomBytes(24).toString("base64url")}`;

function same(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function memoryRegistry(): Registry {
  const accounts = new Map<string, string>(); // keyHash -> id
  const owners = new Map<string, string>();
  const grants = new Map<string, GrantRecord>();
  const hooks = new Map<string, string>();
  return {
    async createAccount() {
      const id = token("acct");
      const apiKey = token("wk");
      accounts.set(sha256(apiKey), id);
      return { id, apiKey };
    },
    async accountFor(apiKey) {
      return accounts.get(sha256(apiKey)) ?? null;
    },
    async claimAgent(agent, account) {
      if (owners.has(agent)) return false;
      owners.set(agent, account);
      return true;
    },
    async ownerOf(agent) {
      return owners.get(agent) ?? null;
    },
    async agentsOf(account) {
      return [...owners].filter(([, a]) => a === account).map(([g]) => g);
    },
    async putGrant(g) {
      grants.set(g.agent, structuredClone(g));
    },
    async getGrant(agent) {
      const g = grants.get(agent);
      return g ? structuredClone(g) : null;
    },
    async createHook(id) {
      const s = token("wh");
      hooks.set(id, sha256(s));
      return s;
    },
    async checkHook(id, secret) {
      const h = hooks.get(id);
      return h !== undefined && same(h, sha256(secret));
    },
  };
}

export const REGISTRY_SCHEMA = `
create table if not exists runner_accounts (id text primary key, key_hash text not null unique, created_at bigint not null);
create table if not exists runner_agents (agent text primary key, account text not null, created_at bigint not null);
create index if not exists runner_agents_account on runner_agents (account);
create table if not exists runner_grants (agent text primary key, body jsonb not null, updated_at bigint not null);
create table if not exists runner_hooks (workflow_id text primary key, secret_hash text not null);
`;

export async function migrateRegistry(db: Queryable): Promise<void> {
  for (const stmt of REGISTRY_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
}

export function pgRegistry(db: Queryable): Registry {
  return {
    async createAccount(at) {
      const id = token("acct");
      const apiKey = token("wk");
      await db.query(`insert into runner_accounts (id, key_hash, created_at) values ($1,$2,$3)`, [id, sha256(apiKey), at]);
      return { id, apiKey };
    },
    async accountFor(apiKey) {
      const { rows } = await db.query(`select id from runner_accounts where key_hash = $1`, [sha256(apiKey)]);
      return rows[0] ? String(rows[0].id) : null;
    },
    async claimAgent(agent, account, at) {
      const { rows } = await db.query(
        `insert into runner_agents (agent, account, created_at) values ($1,$2,$3) on conflict (agent) do nothing returning agent`,
        [agent, account, at],
      );
      return rows.length === 1;
    },
    async ownerOf(agent) {
      const { rows } = await db.query(`select account from runner_agents where agent = $1`, [agent]);
      return rows[0] ? String(rows[0].account) : null;
    },
    async agentsOf(account) {
      const { rows } = await db.query(`select agent from runner_agents where account = $1 order by created_at`, [account]);
      return rows.map((r) => String(r.agent));
    },
    async putGrant(g) {
      await db.query(
        `insert into runner_grants (agent, body, updated_at) values ($1,$2::jsonb,$3)
         on conflict (agent) do update set body = excluded.body, updated_at = excluded.updated_at`,
        [g.agent, encode(g), g.updatedAt],
      );
    },
    async getGrant(agent) {
      const { rows } = await db.query(`select body from runner_grants where agent = $1`, [agent]);
      return rows[0] ? decode<GrantRecord>(rows[0].body) : null;
    },
    async createHook(id) {
      const s = token("wh");
      await db.query(
        `insert into runner_hooks (workflow_id, secret_hash) values ($1,$2)
         on conflict (workflow_id) do update set secret_hash = excluded.secret_hash`,
        [id, sha256(s)],
      );
      return s;
    },
    async checkHook(id, secret) {
      const { rows } = await db.query(`select secret_hash from runner_hooks where workflow_id = $1`, [id]);
      return rows[0] !== undefined && same(String(rows[0].secret_hash), sha256(secret));
    },
  };
}
