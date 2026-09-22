/**
 * The engine: triggers → conditions → actions, inside the grant.
 *
 * Everything outside this file is a port — the chain, payments, messages,
 * storage — so the engine can be tested with no network and run for real by
 * `live.ts` with no change here.
 *
 * Three rules this file exists to keep:
 *
 * 1. **One run per (workflow, key), ever.** The key is the schedule slot or
 *    the webhook's idempotency key. It is claimed before anything happens, so
 *    a retry, a restart or two workers cannot pay twice for one slot.
 * 2. **A broadcast is recorded when it happens.** The txid is written to the
 *    run the moment a payment is submitted, before the vendor answers. Agent
 *    #005 was lost for two days because a tool that knew its txid behaved as
 *    if it did not.
 * 3. **No reading is not a reading.** A grant the runner cannot read is
 *    UNDECIDED. A grant trigger keeps its last state; a scheduled run is
 *    recorded as undecided and spends nothing.
 */
import { formatKas } from "@warda_protocol/core";
import { slotsBetween } from "./cron.ts";
import { accrue, emptyLedger, settled, settlementDue, type FeePolicy } from "./fees.ts";
import { hoursToExpiry, refusal, spendable, spentPercent, type GrantReader, type GrantView } from "./grant.ts";
import type { Approval, RunRecord, Step, Store } from "./store.ts";
import { fill } from "./template.ts";
import { spends, type Action, type Condition, type Workflow } from "./workflow.ts";

export interface X402Request {
  url: string;
  method: string;
  body?: string;
  contentType?: string;
}

export type X402Outcome =
  | { kind: "free"; status: number; body?: string }
  | { kind: "paid"; status: number; txid: string; sompi: bigint; body?: string }
  | { kind: "refused"; reason: string };

export interface Payments {
  /**
   * Buy one request. Must refuse — without paying — an invoice above
   * `limitSompi`, and must call `onSubmitted` as soon as a payment is
   * broadcast, before waiting on the vendor.
   */
  x402(
    agent: string,
    req: X402Request,
    limitSompi: bigint,
    onSubmitted: (txid: string, sompi: bigint) => Promise<void>,
  ): Promise<X402Outcome>;
  send(
    agent: string,
    to: string,
    sompi: bigint,
    onSubmitted: (txid: string, sompi: bigint) => Promise<void>,
  ): Promise<{ txid: string }>;
}

export interface Notifier {
  notify(channel: "telegram" | "webhook", to: string, text: string): Promise<void>;
}

export interface Http {
  request(url: string, method: string, body?: string): Promise<number>;
}

/** How an approval reaches the owner: the console inbox, their phone wallet. */
export interface Approvals {
  announce(a: Approval): Promise<void>;
}

export interface EngineOptions {
  store: Store;
  grants: GrantReader;
  payments: Payments;
  notifier: Notifier;
  http: Http;
  approvals: Approvals;
  fees: FeePolicy;
  /** The network fee a covenant spend costs, for the coin check. */
  networkFee: bigint;
  now?: () => number;
  id?: () => string;
}

export interface TickReport {
  started: string[];
  missed: number;
}

/** A run that has said "running" this long was interrupted. */
const STALE_MS = 5 * 60_000;

export class Engine {
  private readonly o: Required<EngineOptions>;

  constructor(opts: EngineOptions) {
    let n = 0;
    this.o = {
      now: Date.now,
      id: () => `run_${Date.now().toString(36)}_${(n++).toString(36)}`,
      ...opts,
    };
  }

  /** Saves a workflow, starting its schedule from now rather than the epoch. */
  async add(wf: Workflow): Promise<void> {
    await this.o.store.putWorkflow(wf);
    if ((await this.o.store.getCursor(wf.id)) === null) await this.o.store.setCursor(wf.id, this.o.now());
  }

  /** One pass over every enabled workflow. Called once a minute by the worker. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { started: [], missed: 0 };
    const now = this.o.now();
    await this.sweep(now);
    for (const wf of await this.o.store.listWorkflows()) {
      if (!wf.enabled) continue;
      if (wf.trigger.type === "schedule") {
        const since = (await this.o.store.getCursor(wf.id)) ?? wf.createdAt;
        const slots = slotsBetween(wf.trigger.cron, since, now);
        await this.o.store.setCursor(wf.id, now);
        if (slots.length === 0) continue;
        const [latest, ...older] = slots;
        for (const s of older) {
          report.missed++;
          await this.record(wf, `slot:${new Date(s).toISOString()}`, "schedule", "missed",
            "the runner was not running at this time; only the latest missed slot runs");
        }
        const id = await this.run(wf, `slot:${new Date(latest!).toISOString()}`, "schedule");
        if (id) report.started.push(id);
      } else if (wf.trigger.type === "grant") {
        const id = await this.edge(wf, now);
        if (id) report.started.push(id);
      }
    }
    return report;
  }

  /**
   * Runs the process died in the middle of — a serverless function that hit
   * its time limit, a restart. They would say "running" forever. A run with a
   * payment in flight becomes `undelivered` and keeps its txid (the coin
   * moved; never pay it again); anything else is `failed`, with the reason.
   */
  private async sweep(now: number): Promise<void> {
    for (const r of await this.o.store.staleRuns(now - STALE_MS)) {
      if (r.inflight?.txid) {
        r.steps.push({ ...r.inflight, detail: "broadcast, then the runner stopped before the vendor answered; resume with this txid, do not pay again" });
        r.status = "undelivered";
      } else {
        r.status = "failed";
      }
      delete r.inflight;
      r.note = "the runner stopped in the middle of this run";
      r.finishedAt = now;
      await this.o.store.updateRun(r);
    }
  }

  /** A webhook or a manual run. `key` makes a retried delivery a no-op. */
  async fire(workflowId: string, via: "webhook" | "manual", opts: { key?: string; body?: unknown } = {}) {
    const wf = await this.o.store.getWorkflow(workflowId);
    if (!wf) throw new Error(`no workflow ${workflowId}`);
    if (!wf.enabled) throw new Error(`workflow ${workflowId} is paused`);
    if (wf.trigger.type !== via && !(via === "manual")) {
      throw new Error(`workflow ${workflowId} is not triggered by ${via}`);
    }
    return this.run(wf, `${via}:${opts.key ?? this.o.id()}`, via, opts.body);
  }

  // ---- triggers -------------------------------------------------------------

  private async edge(wf: Workflow, now: number): Promise<string | null> {
    const t = wf.trigger;
    if (t.type !== "grant") return null;
    const g = await this.o.grants.read(wf.agent);
    if (!g) return null; // undecided: keep the last state, say nothing new
    const firing =
      t.when === "budget-below"
        ? 100 - spentPercent(g) < t.percent
        : (() => {
            const h = hoursToExpiry(g, now);
            return h !== null && h <= t.hours;
          })();
    const was = (await this.o.store.getEdge(wf.id)) ?? "clear";
    const is = firing ? "firing" : "clear";
    await this.o.store.setEdge(wf.id, is);
    if (was === "clear" && is === "firing") return this.run(wf, `edge:${now}`, `grant:${t.when}`);
    return null;
  }

  // ---- a run ----------------------------------------------------------------

  private async record(wf: Workflow, key: string, trigger: string, status: RunRecord["status"], note: string) {
    const run: RunRecord = {
      id: this.o.id(), workflowId: wf.id, agent: wf.agent, key, trigger,
      startedAt: this.o.now(), finishedAt: this.o.now(), status, steps: [], charged: false, note,
    };
    await this.o.store.claimRun(run);
  }

  /**
   * Run a workflow that is not stored — an agent's own request over MCP.
   * The same run, the same checks, the same fee; the vendor's answers come
   * back to the caller, because an agent that paid for a response wants it.
   */
  async runOnce(wf: Workflow, key: string, trigger: string): Promise<{ run: string | null; bodies: string[] }> {
    const bodies: string[] = [];
    const run = await this.run(wf, key, trigger, undefined, bodies);
    return { run, bodies };
  }

  private async run(wf: Workflow, key: string, trigger: string, body?: unknown, bodies?: string[]): Promise<string | null> {
    const run: RunRecord = {
      id: this.o.id(), workflowId: wf.id, agent: wf.agent, key, trigger,
      startedAt: this.o.now(), status: "running", steps: [], charged: false,
    };
    if (!(await this.o.store.claimRun(run))) return null;

    const finish = async (status: RunRecord["status"], note?: string) => {
      run.status = status;
      run.finishedAt = this.o.now();
      if (note) run.note = note;
      await this.o.store.updateRun(run);
      return run.id;
    };

    let g = await this.o.grants.read(wf.agent);
    if (!g) return finish("undecided", "the grant could not be read, so nothing was run");
    const ledger = (await this.o.store.getLedger(wf.agent)) ?? emptyLedger();

    if (!wf.conditions.every((c) => holds(c, g!, ledger.owed, this.o.now(), body))) {
      return finish("skipped", "a condition did not hold");
    }

    let executed = false;
    let status: RunRecord["status"] = "ok";
    let moved = false;
    for (const action of wf.actions) {
      // Re-read before a payment, and after one: a notification that follows
      // a purchase should report the grant as it is, not as it was.
      if (moved || spends({ actions: [action] })) {
        g = (await this.o.grants.read(wf.agent)) ?? null;
        if (!g) {
          run.steps.push({ action: action.type, status: "failed", detail: "the grant could not be read" });
          status = "undecided";
          break;
        }
      }
      const step = await this.act(wf, run, action, g!, ledger.owed, body, bodies);
      run.steps.push(step);
      if (step.txid) moved = true;
      await this.o.store.updateRun(run);
      if (step.status !== "refused" && step.status !== "failed") executed = true;
      if (step.status === "refused") { status = "refused"; break; }
      if (step.status === "failed") { status = "failed"; break; }
      if (step.status === "submitted") { status = "undelivered"; break; }
    }

    if (executed) {
      run.charged = true;
      await this.o.store.setLedger(wf.agent, accrue(ledger, this.o.fees));
      await this.settle(wf.agent);
    }
    return finish(status);
  }

  private async act(
    wf: Workflow, run: RunRecord, a: Action, g: GrantView, owed: bigint, _body: unknown, bodies?: string[],
  ): Promise<Step> {
    const now = this.o.now();
    let sent: { txid: string; sompi: bigint } | null = null;
    const onSubmitted = async (txid: string, sompi: bigint) => {
      // Rule 2: the coin has moved. Write it down before anything else can fail.
      sent = { txid, sompi };
      run.inflight = { action: a.type, status: "submitted", txid, sompi: sompi.toString() };
      await this.o.store.updateRun(run);
    };
    try {
      switch (a.type) {
        case "pay-x402": {
          const basic = refusal(g, 0n, { now, feesOwed: owed, networkFee: 0n });
          if (basic) return { action: a.type, status: "refused", detail: basic };
          const limit = [a.maxSompi, g.maxPerSpend, spendable(g, owed), g.epochRemaining ?? a.maxSompi]
            .reduce((x, y) => (y < x ? y : x));
          if (limit <= 0n) return { action: a.type, status: "refused", detail: "nothing is spendable" };
          const req: X402Request = { url: a.url, method: a.method };
          if (a.body !== undefined) req.body = a.body;
          if (a.contentType !== undefined) req.contentType = a.contentType;
          const out = await this.o.payments.x402(wf.agent, req, limit, onSubmitted);
          if (out.kind === "refused") return { action: a.type, status: "refused", detail: out.reason };
          if (bodies && out.body !== undefined) bodies.push(out.body);
          if (out.kind === "free") return { action: a.type, status: "ok", detail: `HTTP ${out.status}, no charge` };
          return {
            action: a.type,
            status: out.status >= 200 && out.status < 300 ? "ok" : "submitted",
            txid: out.txid,
            sompi: out.sompi.toString(),
            detail: out.status >= 200 && out.status < 300
              ? `paid ${formatKas(out.sompi)} KAS, HTTP ${out.status}`
              : `paid ${formatKas(out.sompi)} KAS and the vendor answered ${out.status}; resume with this txid, do not pay again`,
          };
        }
        case "send": {
          const why = refusal(g, a.sompi, { now, feesOwed: owed, payee: a.to, networkFee: this.o.networkFee });
          if (why) return { action: a.type, status: "refused", detail: why };
          const { txid } = await this.o.payments.send(wf.agent, a.to, a.sompi, onSubmitted);
          return { action: a.type, status: "ok", txid, sompi: a.sompi.toString(), detail: `sent ${formatKas(a.sompi)} KAS` };
        }
        case "notify": {
          await this.o.notifier.notify(a.channel, a.to, fill(a.text, context(wf, run, g, owed, now)));
          return { action: a.type, status: "ok" };
        }
        case "http": {
          const code = await this.o.http.request(a.url, a.method, a.body);
          return code >= 200 && code < 300
            ? { action: a.type, status: "ok", detail: `HTTP ${code}` }
            : { action: a.type, status: "failed", detail: `HTTP ${code}` };
        }
        case "approval": {
          const ap: Approval = {
            id: `apr_${run.id}`, agent: wf.agent, workflowId: wf.id, runId: run.id,
            op: a.op, note: a.note, createdAt: now, status: "pending",
          };
          await this.o.store.putApproval(ap);
          await this.o.approvals.announce(ap);
          return { action: a.type, status: "requested", detail: `asked the owner to ${a.op}` };
        }
      }
    } catch (e) {
      const msg = (e as Error).message;
      const s = sent as { txid: string; sompi: bigint } | null;
      if (s) {
        return {
          action: a.type, status: "submitted", txid: s.txid, sompi: s.sompi.toString(),
          detail: `broadcast, then: ${msg}. The coin has moved; resume with this txid, do not pay again`,
        };
      }
      return { action: a.type, status: "failed", detail: msg };
    } finally {
      delete run.inflight;
    }
  }

  /** Pays what the runner is owed, when it is worth a network fee to do so. */
  async settle(agent: string): Promise<string | null> {
    const ledger = (await this.o.store.getLedger(agent)) ?? emptyLedger();
    const g = await this.o.grants.read(agent);
    if (!g) return null;
    if (!settlementDue(ledger, this.o.fees, hoursToExpiry(g, this.o.now()))) return null;
    const amount = ledger.owed < g.maxPerSpend ? ledger.owed : g.maxPerSpend;
    const why = refusal(g, amount, { now: this.o.now(), feesOwed: 0n, payee: this.o.fees.payee, networkFee: this.o.networkFee });
    if (why) return null;
    let txid: string | null = null;
    const once = async (t: string) => {
      if (txid !== null) return;
      txid = t;
      await this.o.store.setLedger(agent, settled(ledger, amount, t));
    };
    try {
      const r = await this.o.payments.send(agent, this.o.fees.payee, amount, once);
      await once(r.txid);
    } catch {
      // Not broadcast: the debt stands. If it was, `once` already recorded it.
    }
    return txid;
  }
}

function context(wf: Workflow, run: RunRecord, g: GrantView, owed: bigint, now: number) {
  const h = hoursToExpiry(g, now);
  const last = [...run.steps].reverse().find((s) => s.txid);
  return {
    "grant.availableKas": formatKas(spendable(g, owed)),
    "grant.spentPercent": spentPercent(g).toFixed(1),
    "grant.hoursToExpiry": h === null ? null : h.toFixed(1),
    "grant.address": g.address,
    "workflow.name": wf.name,
    "agent": wf.agent,
    "run.lastTxid": last?.txid ?? null,
  };
}

function holds(c: Condition, g: GrantView, owed: bigint, now: number, body: unknown): boolean {
  let v: unknown;
  if (c.field === "grant.availableKas") v = Number(spendable(g, owed)) / 1e8;
  else if (c.field === "grant.spentPercent") v = spentPercent(g);
  else if (c.field === "grant.hoursToExpiry") v = hoursToExpiry(g, now);
  else if (c.field === "trigger.body") v = body;
  else {
    v = body;
    for (const k of c.field.slice("trigger.body.".length).split(".")) {
      v = typeof v === "object" && v !== null ? (v as Record<string, unknown>)[k] : undefined;
    }
  }
  if (v === null || v === undefined) return false;
  if (typeof c.value === "number") {
    const x = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(x)) return false;
    switch (c.op) {
      case "<": return x < c.value;
      case "<=": return x <= c.value;
      case ">": return x > c.value;
      case ">=": return x >= c.value;
      case "==": return x === c.value;
      case "!=": return x !== c.value;
    }
  }
  if (c.op === "==") return v === c.value;
  if (c.op === "!=") return v !== c.value;
  return false;
}
