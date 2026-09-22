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
import type { Plan } from "./funding.ts";

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
  /** A token that acts as ONE agent over MCP. Returns the plaintext once. */
  createAgentToken(agent: string): Promise<string>;
  agentForToken(token: string): Promise<string | null>;
  /** A one-time code the owner sends the bot as /start <code>. */
  createTelegramLink(account: string, now: number): Promise<string>;
  /** Consumes a code younger than 15 minutes; returns its account. */
  consumeTelegramLink(code: string, now: number): Promise<string | null>;
  setTelegram(account: string, chat: string): Promise<void>;
  telegramOf(account: string): Promise<string | null>;
  /** Counts one use of `what` today; returns today's total. */
  bumpUsage(account: string, what: string, day: string): Promise<number>;
  putPlan(p: Plan): Promise<void>;
  getPlan(agent: string): Promise<Plan | null>;
  /** Plans not yet funded or failed. */
  pendingPlans(): Promise<Plan[]>;
  /** Small operational state: the last tick, when an ops alert was last sent. */
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
  /** For the operator's view. */
  listAccounts(): Promise<{ id: string; createdAt: number }[]>;
  listAgents(): Promise<{ agent: string; account: string; createdAt: number }[]>;
}

const TG_LINK_MS = 15 * 60_000;

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
  const plans = new Map<string, Plan>();
  const agentTokens = new Map<string, string>(); // hash -> agent
  const tgLinks = new Map<string, { account: string; at: number }>();
  const tgChats = new Map<string, string>();
  const usage = new Map<string, number>();
  const meta = new Map<string, string>();
  const accountsAt = new Map<string, number>();
  const agentsAt = new Map<string, number>();
  return {
    async getMeta(k) { return meta.get(k) ?? null; },
    async setMeta(k, v) { meta.set(k, v); },
    async listAccounts() { return [...accountsAt].map(([id, createdAt]) => ({ id, createdAt })); },
    async listAgents() {
      return [...owners].map(([agent, account]) => ({ agent, account, createdAt: agentsAt.get(agent) ?? 0 }));
    },
    async bumpUsage(account, what, day) {
      const k = `${account}|${what}|${day}`;
      const n = (usage.get(k) ?? 0) + 1;
      usage.set(k, n);
      return n;
    },
    async createTelegramLink(account, now) {
      const c = randomBytes(9).toString("base64url");
      tgLinks.set(sha256(c), { account, at: now });
      return c;
    },
    async consumeTelegramLink(code, now) {
      const k = sha256(code);
      const l = tgLinks.get(k);
      tgLinks.delete(k);
      return l && now - l.at < TG_LINK_MS ? l.account : null;
    },
    async setTelegram(account, chat) {
      tgChats.set(account, chat);
    },
    async telegramOf(account) {
      return tgChats.get(account) ?? null;
    },
    async createAgentToken(agent) {
      const t = token("wat");
      agentTokens.set(sha256(t), agent);
      return t;
    },
    async agentForToken(t) {
      return agentTokens.get(sha256(t)) ?? null;
    },
    async putPlan(p) {
      plans.set(p.agent, structuredClone(p));
    },
    async getPlan(agent) {
      const p = plans.get(agent);
      return p ? structuredClone(p) : null;
    },
    async pendingPlans() {
      return [...plans.values()].filter((p) => p.status === "awaiting-deposit" || p.status === "submitting").map((p) => structuredClone(p));
    },
    async createAccount(now) {
      const id = token("acct");
      const apiKey = token("wk");
      accounts.set(sha256(apiKey), id);
      accountsAt.set(id, now);
      return { id, apiKey };
    },
    async accountFor(apiKey) {
      return accounts.get(sha256(apiKey)) ?? null;
    },
    async claimAgent(agent, account, now) {
      if (owners.has(agent)) return false;
      owners.set(agent, account);
      agentsAt.set(agent, now);
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
create table if not exists runner_agent_tokens (token_hash text primary key, agent text not null, created_at bigint not null);
create table if not exists runner_tg_links (code_hash text primary key, account text not null, created_at bigint not null);
create table if not exists runner_tg_chats (account text primary key, chat text not null);
create table if not exists runner_usage (account text not null, what text not null, day text not null, n int not null, primary key (account, what, day));
create table if not exists runner_plans (agent text primary key, status text not null, body jsonb not null);
create table if not exists runner_meta (key text primary key, value text not null);
`;

export async function migrateRegistry(db: Queryable): Promise<void> {
  for (const stmt of REGISTRY_SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
}

export function pgRegistry(db: Queryable): Registry {
  return {
    async getMeta(k) {
      const { rows } = await db.query(`select value from runner_meta where key = $1`, [k]);
      return rows[0] ? String(rows[0].value) : null;
    },
    async setMeta(k, v) {
      await db.query(`insert into runner_meta (key, value) values ($1,$2) on conflict (key) do update set value = excluded.value`, [k, v]);
    },
    async listAccounts() {
      const { rows } = await db.query(`select id, created_at from runner_accounts order by created_at`);
      return rows.map((r) => ({ id: String(r.id), createdAt: Number(r.created_at) }));
    },
    async listAgents() {
      const { rows } = await db.query(`select agent, account, created_at from runner_agents order by created_at`);
      return rows.map((r) => ({ agent: String(r.agent), account: String(r.account), createdAt: Number(r.created_at) }));
    },
    async bumpUsage(account, what, day) {
      const { rows } = await db.query(
        `insert into runner_usage (account, what, day, n) values ($1,$2,$3,1)
         on conflict (account, what, day) do update set n = runner_usage.n + 1 returning n`,
        [account, what, day],
      );
      return Number(rows[0]!.n);
    },
    async createTelegramLink(account, now) {
      const c = randomBytes(9).toString("base64url");
      await db.query(`insert into runner_tg_links (code_hash, account, created_at) values ($1,$2,$3)`, [sha256(c), account, now]);
      return c;
    },
    async consumeTelegramLink(code, now) {
      const { rows } = await db.query(`delete from runner_tg_links where code_hash = $1 returning account, created_at`, [sha256(code)]);
      const r = rows[0];
      return r && now - Number(r.created_at) < TG_LINK_MS ? String(r.account) : null;
    },
    async setTelegram(account, chat) {
      await db.query(
        `insert into runner_tg_chats (account, chat) values ($1,$2) on conflict (account) do update set chat = excluded.chat`,
        [account, chat],
      );
    },
    async telegramOf(account) {
      const { rows } = await db.query(`select chat from runner_tg_chats where account = $1`, [account]);
      return rows[0] ? String(rows[0].chat) : null;
    },
    async createAgentToken(agent) {
      const t = token("wat");
      await db.query(`insert into runner_agent_tokens (token_hash, agent, created_at) values ($1,$2,$3)`, [sha256(t), agent, Date.now()]);
      return t;
    },
    async agentForToken(t) {
      const { rows } = await db.query(`select agent from runner_agent_tokens where token_hash = $1`, [sha256(t)]);
      return rows[0] ? String(rows[0].agent) : null;
    },
    async putPlan(p) {
      await db.query(
        `insert into runner_plans (agent, status, body) values ($1,$2,$3::jsonb)
         on conflict (agent) do update set status = excluded.status, body = excluded.body`,
        [p.agent, p.status, encode(p)],
      );
    },
    async getPlan(agent) {
      const { rows } = await db.query(`select body from runner_plans where agent = $1`, [agent]);
      return rows[0] ? decode<Plan>(rows[0].body) : null;
    },
    async pendingPlans() {
      const { rows } = await db.query(`select body from runner_plans where status in ('awaiting-deposit','submitting')`);
      return rows.map((r) => decode<Plan>(r.body));
    },
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
