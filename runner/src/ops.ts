/**
 * Telling the operator when the runner itself is in trouble.
 *
 * An owner hears about their own agent — a refused payment, a budget running
 * low — through their own jobs. What nobody heard about until now was the
 * runner failing underneath them: the minute tick stopping, Turnkey refusing
 * to sign, the chain unreadable, a payment broadcast and never delivered.
 * Each of those now sends one Telegram message to the operator's chat.
 *
 * At most one message per kind per hour; what happened in between is counted
 * and said in the next one, so a bad hour is one message, not sixty.
 */
import type { RunRecord } from "./store.ts";
import type { Registry } from "./registry.ts";

export type OpsKind = "tick-failed" | "tick-gap" | "signing" | "chain" | "undelivered" | "run-failed" | "funding";

const HOUR = 3_600_000;
/** A gap between ticks longer than this is reported when ticks resume. */
export const TICK_GAP_MS = 10 * 60_000;

export interface Ops {
  report(kind: OpsKind, text: string): Promise<void>;
  /** Called at the start of every tick. */
  tickSeen(now: number): Promise<void>;
  /** Called when a run finishes; says nothing unless the runner is at fault or money is stuck. */
  runFinished(run: RunRecord): Promise<void>;
  lastTickAt(): Promise<number | null>;
}

/** Which problem a finished run is, from the operator's side — or null for none. */
export function classify(run: RunRecord): { kind: OpsKind; detail: string } | null {
  const last = [...run.steps].reverse().find((s) => s.status === "failed" || s.detail);
  const detail = (last?.detail ?? run.note ?? "").slice(0, 240);
  if (run.status === "undelivered") return { kind: "undelivered", detail };
  if (run.status === "undecided") return { kind: "chain", detail: detail || "the grant could not be read" };
  if (run.status !== "failed") return null;
  if (/turnkey|sign(ing|ature)?\b|resource to sign|permission/i.test(detail)) return { kind: "signing", detail };
  return { kind: "run-failed", detail };
}

const TITLES: Record<OpsKind, string> = {
  "tick-failed": "The runner's tick failed",
  "tick-gap": "The runner's tick stopped for a while",
  signing: "Turnkey did not sign",
  chain: "The chain could not be read",
  undelivered: "A payment went out and was not delivered",
  "run-failed": "A run failed",
  funding: "Funding an agent failed",
};

export function createOps(o: {
  registry: Registry;
  now: () => number;
  /** Sends to the operator's chat; absent means ops alerts are off. */
  send?: (text: string) => Promise<void>;
}): Ops {
  const report = async (kind: OpsKind, text: string) => {
    if (!o.send) return;
    const now = o.now();
    const last = Number((await o.registry.getMeta(`ops:${kind}:at`)) ?? 0);
    const held = Number((await o.registry.getMeta(`ops:${kind}:held`)) ?? 0);
    if (now - last < HOUR) {
      await o.registry.setMeta(`ops:${kind}:held`, String(held + 1));
      return;
    }
    const more = held > 0 ? `\n\n(${held} more like this in the hour before, not sent separately.)` : "";
    try {
      await o.send(`⚠️ Warda runner — ${TITLES[kind]}\n\n${text}${more}`);
      await o.registry.setMeta(`ops:${kind}:at`, String(now));
      await o.registry.setMeta(`ops:${kind}:held`, "0");
    } catch {
      // Telegram down is not a reason to fail a tick.
    }
  };
  return {
    report,
    async tickSeen(now) {
      const prev = Number((await o.registry.getMeta("lastTickAt")) ?? 0);
      await o.registry.setMeta("lastTickAt", String(now));
      if (prev && now - prev > TICK_GAP_MS) {
        const min = Math.round((now - prev) / 60_000);
        await report("tick-gap", `No tick for ${min} minutes (the last was ${new Date(prev).toISOString()}). ` +
          `Ticks are back now. Scheduled jobs in between did not run on time; each ran its latest missed slot once.`);
      }
    },
    async runFinished(run) {
      const c = classify(run);
      if (!c) return;
      await report(c.kind, `Agent ${run.agent}, run ${run.id} (${run.trigger}): ${run.status}.\n${c.detail}`);
    },
    async lastTickAt() {
      const v = await o.registry.getMeta("lastTickAt");
      return v ? Number(v) : null;
    },
  };
}
