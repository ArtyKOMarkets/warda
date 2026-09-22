/**
 * A workflow: WHEN a trigger fires, IF every condition holds, THEN run the
 * actions in order.
 *
 * Parsed from plain JSON, because a workflow is written by a person in the
 * console, by an agent over MCP, or by Claude from a sentence — and all three
 * must land on the same checked shape. Nothing here evaluates code: conditions
 * are field/operator/value triples over a fixed set of fields.
 *
 * Amounts are KAS as decimal strings at the edge and sompi inside. A KAS
 * figure is one a person can check by eye; 20000000 is not.
 */
import { kas } from "@warda_protocol/core";
import { minimumIntervalMs, parseCron, type Cron } from "./cron.ts";

export type Trigger =
  | { type: "schedule"; cron: Cron }
  | { type: "webhook" }
  | { type: "manual" }
  | { type: "grant"; when: "budget-below"; percent: number }
  | { type: "grant"; when: "expiring-within"; hours: number };

export type Authority = "agent" | "none" | "owner";

export type Action =
  | { type: "pay-x402"; url: string; method: string; body?: string; contentType?: string; maxSompi: bigint }
  | { type: "send"; to: string; sompi: bigint }
  | { type: "notify"; channel: "telegram" | "webhook"; to: string; text: string }
  | { type: "http"; url: string; method: string; body?: string }
  | { type: "approval"; op: "topup" | "renew" | "revoke"; note: string };

export const AUTHORITY: Record<Action["type"], Authority> = {
  "pay-x402": "agent",
  send: "agent",
  notify: "none",
  http: "none",
  approval: "owner",
};

export const FIELDS = [
  "grant.availableKas",
  "grant.spentPercent",
  "grant.hoursToExpiry",
  "trigger.body",
] as const;
export type Field = (typeof FIELDS)[number] | `trigger.body.${string}`;
export type Op = "<" | "<=" | ">" | ">=" | "==" | "!=";

export interface Condition {
  field: Field;
  op: Op;
  value: number | string | boolean;
}

export interface Workflow {
  id: string;
  agent: string;
  name: string;
  enabled: boolean;
  trigger: Trigger;
  conditions: Condition[];
  actions: Action[];
  createdAt: number;
}

export class WorkflowError extends Error {}

const MAX_ACTIONS = 10;
const MIN_INTERVAL_MS = 60_000;
const OPS: Op[] = ["<", "<=", ">", ">=", "==", "!="];

type J = Record<string, unknown>;
const obj = (v: unknown, where: string): J => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new WorkflowError(`${where} must be an object`);
  return v as J;
};
const str = (v: unknown, where: string): string => {
  if (typeof v !== "string" || v.trim() === "") throw new WorkflowError(`${where} must be a non-empty string`);
  return v;
};
const amount = (v: unknown, where: string): bigint => {
  const s = typeof v === "number" ? String(v) : v;
  try {
    const n = kas(str(s, where));
    if (n <= 0n) throw new Error("zero");
    return n;
  } catch {
    throw new WorkflowError(`${where} must be a positive KAS amount like "0.2", got ${JSON.stringify(v)}`);
  }
};
const https = (v: unknown, where: string): string => {
  const s = str(v, where);
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new WorkflowError(`${where} is not a URL: ${s}`);
  }
  if (u.protocol !== "https:") throw new WorkflowError(`${where} must be https: ${s}`);
  return s;
};

export function parseTrigger(v: unknown): Trigger {
  const t = obj(v, "trigger");
  switch (t.type) {
    case "schedule": {
      let cron: Cron;
      try {
        cron = parseCron(str(t.cron, "trigger.cron"));
      } catch (e) {
        throw new WorkflowError((e as Error).message);
      }
      const gap = minimumIntervalMs(cron);
      if (gap < MIN_INTERVAL_MS) throw new WorkflowError("a schedule may run at most once a minute");
      if (!Number.isFinite(gap)) throw new WorkflowError(`"${cron.source}" never runs in any two-week window`);
      return { type: "schedule", cron };
    }
    case "webhook":
    case "manual":
      return { type: t.type };
    case "grant": {
      if (t.when === "budget-below") {
        const p = Number(t.percent);
        if (!(p > 0 && p < 100)) throw new WorkflowError("trigger.percent must be between 0 and 100");
        return { type: "grant", when: "budget-below", percent: p };
      }
      if (t.when === "expiring-within") {
        const h = Number(t.hours);
        if (!(h > 0)) throw new WorkflowError("trigger.hours must be positive");
        return { type: "grant", when: "expiring-within", hours: h };
      }
      throw new WorkflowError(`trigger.when must be "budget-below" or "expiring-within", got ${JSON.stringify(t.when)}`);
    }
    default:
      throw new WorkflowError(
        `trigger.type must be schedule, webhook, manual or grant, got ${JSON.stringify(t.type)}`,
      );
  }
}

export function parseAction(v: unknown, i: number): Action {
  const a = obj(v, `then[${i}]`);
  const w = (k: string) => `then[${i}].${k}`;
  switch (a.type) {
    case "pay-x402": {
      const out: Action = {
        type: "pay-x402",
        url: https(a.url, w("url")),
        method: typeof a.method === "string" ? a.method.toUpperCase() : "GET",
        maxSompi: amount(a.maxKas, w("maxKas")),
      };
      if (typeof a.body === "string") out.body = a.body;
      if (typeof a.contentType === "string") out.contentType = a.contentType;
      return out;
    }
    case "send":
      return { type: "send", to: str(a.to, w("to")), sompi: amount(a.kas, w("kas")) };
    case "notify": {
      if (a.channel !== "telegram" && a.channel !== "webhook") {
        throw new WorkflowError(`${w("channel")} must be telegram or webhook`);
      }
      const to = a.channel === "webhook" ? https(a.to, w("to")) : str(a.to, w("to"));
      return { type: "notify", channel: a.channel, to, text: str(a.text, w("text")) };
    }
    case "http": {
      const out: Action = {
        type: "http",
        url: https(a.url, w("url")),
        method: typeof a.method === "string" ? a.method.toUpperCase() : "POST",
      };
      if (typeof a.body === "string") out.body = a.body;
      return out;
    }
    case "approval": {
      if (a.op !== "topup" && a.op !== "renew" && a.op !== "revoke") {
        throw new WorkflowError(`${w("op")} must be topup, renew or revoke`);
      }
      return { type: "approval", op: a.op, note: typeof a.note === "string" ? a.note : "" };
    }
    default:
      throw new WorkflowError(
        `then[${i}].type must be pay-x402, send, notify, http or approval, got ${JSON.stringify(a.type)}. ` +
          `There is no action that uses the owner's key directly: top-up, renew and revoke are ` +
          `"approval" actions, which ask the owner to sign in their own wallet.`,
      );
  }
}

function parseCondition(v: unknown, i: number): Condition {
  const c = obj(v, `if[${i}]`);
  const field = str(c.field, `if[${i}].field`);
  if (!(FIELDS as readonly string[]).includes(field) && !field.startsWith("trigger.body.")) {
    throw new WorkflowError(`if[${i}].field must be one of ${FIELDS.join(", ")} or trigger.body.<name>`);
  }
  if (!OPS.includes(c.op as Op)) throw new WorkflowError(`if[${i}].op must be one of ${OPS.join(" ")}`);
  const value = c.value;
  if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
    throw new WorkflowError(`if[${i}].value must be a number, string or boolean`);
  }
  return { field: field as Field, op: c.op as Op, value };
}

export function parseWorkflow(v: unknown, meta: { id: string; now: number }): Workflow {
  const w = obj(v, "workflow");
  const then = w.then;
  if (!Array.isArray(then) || then.length === 0) throw new WorkflowError("then must list at least one action");
  if (then.length > MAX_ACTIONS) throw new WorkflowError(`a workflow may have at most ${MAX_ACTIONS} actions`);
  const conds = w.if === undefined ? [] : w.if;
  if (!Array.isArray(conds)) throw new WorkflowError("if must be a list of conditions");
  return {
    id: meta.id,
    agent: str(w.agent, "agent"),
    name: typeof w.name === "string" && w.name.trim() ? w.name.trim() : "Untitled workflow",
    enabled: w.enabled !== false,
    trigger: parseTrigger(w.trigger),
    conditions: conds.map(parseCondition),
    actions: then.map(parseAction),
    createdAt: meta.now,
  };
}

/** What a workflow's authority requirement is: the strongest of its actions. */
export function authorityOf(wf: Pick<Workflow, "actions">): Authority {
  const seen = new Set(wf.actions.map((a) => AUTHORITY[a.type]));
  return seen.has("owner") ? "owner" : seen.has("agent") ? "agent" : "none";
}

export function spends(wf: Pick<Workflow, "actions">): boolean {
  return wf.actions.some((a) => AUTHORITY[a.type] === "agent");
}
