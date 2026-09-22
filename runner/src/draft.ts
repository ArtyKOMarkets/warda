/**
 * A sentence in, a workflow out — as a DRAFT the owner confirms.
 *
 * "Buy the weather every morning, never more than 0.05 KAS" becomes the same
 * JSON a person would have written, produced by Claude through a forced tool
 * call so the answer is structured rather than prose. Nothing here saves or
 * runs anything: the draft goes back to the console as a card, and only the
 * owner pressing Add turns it into a job — through the same POST /v1/workflows,
 * the same parser, and the same checks against the grant as a hand-written one.
 *
 * The model is told the grant's real limits and payees, so a draft is usually
 * possible; when it is not, it says why instead of inventing a payee. It can
 * still be wrong, which is exactly why it is a card and not an action.
 */
import { formatKas } from "@warda_protocol/core";
import type { GrantView } from "./grant.ts";
import { parseWorkflow, WorkflowError } from "./workflow.ts";

export interface Drafter {
  draft(input: { agent: string; text: string; grant: GrantView | null; now: number }): Promise<Draft>;
}

export type Draft =
  | { ok: true; workflow: Record<string, unknown>; summary: string; notes: string[] }
  | { ok: false; reason: string };

const WORKFLOW_SCHEMA = {
  type: "object",
  properties: {
    possible: { type: "boolean", description: "false if the request cannot be expressed with these triggers and actions, or would need a payee the grant does not allow" },
    reason: { type: "string", description: "when not possible: one sentence the owner will read, saying what is missing" },
    summary: { type: "string", description: "one plain sentence describing what the job will do, for the owner to confirm" },
    name: { type: "string", description: "a short name, under 40 characters" },
    trigger: {
      type: "object",
      description: "schedule {type:'schedule', cron:'m h * * *' in UTC}; webhook {type:'webhook'}; manual {type:'manual'}; grant {type:'grant', when:'budget-below', percent} or {type:'grant', when:'expiring-within', hours}",
      properties: {
        type: { type: "string", enum: ["schedule", "webhook", "manual", "grant"] },
        cron: { type: "string" },
        when: { type: "string", enum: ["budget-below", "expiring-within"] },
        percent: { type: "number" },
        hours: { type: "number" },
      },
      required: ["type"],
    },
    if: {
      type: "array",
      description: "optional conditions, all must hold. field: grant.availableKas | grant.spentPercent | grant.hoursToExpiry | trigger.body.<name>",
      items: {
        type: "object",
        properties: {
          field: { type: "string" },
          op: { type: "string", enum: ["<", "<=", ">", ">=", "==", "!="] },
          value: {},
        },
        required: ["field", "op", "value"],
      },
    },
    then: {
      type: "array",
      description:
        "actions in order. pay-x402 {type, url (https), maxKas:'0.05'}: buy from a paid API. send {type, to: an allowed payee address, kas:'0.1'}. " +
        "notify {type, channel:'telegram', text} (no 'to': it goes to the owner's connected Telegram; text may use {{agent}} {{grant.availableKas}} {{grant.spentPercent}} {{grant.hoursToExpiry}} {{run.lastTxid}}). " +
        "http {type, url, method}. approval {type, op:'continue', note}: pauses the run and asks the owner (Telegram buttons or the console) — the actions after it run only if they approve; use it for ask-me-before-paying. approval {type, op:'topup'|'renew'|'revoke', note}: asks the owner to act on the grant themselves.",
      items: { type: "object" },
    },
  },
  required: ["possible"],
};

function context(agent: string, g: GrantView | null, now: number): string {
  if (!g) return `Agent ${agent} has no readable grant right now; draft the job anyway, and do not use send actions.`;
  const h = g.expiresAtMs === null ? null : Math.round((g.expiresAtMs - now) / 3_600_000);
  return [
    `Agent: ${agent}.`,
    `Its grant allows paying ONLY these addresses: ${g.payees.join(", ")}. The last of them is usually the runner's own fee address; never pay it in a job.`,
    `Any single payment is at most ${formatKas(g.maxPerSpend)} KAS. Budget ${formatKas(g.budgetTotal)} KAS, ${formatKas(g.spentTotal)} spent.`,
    h === null ? "" : `The grant ends in about ${h} hours.`,
    `The Warda demo vendor sells paid (HTTP 402) endpoints at https://warda-demo-api.vercel.app/fact and /weather, each around 0.03 KAS.`,
    `Times are UTC. The current time is ${new Date(now).toISOString()}.`,
  ].filter(Boolean).join("\n");
}

export function claudeDrafter(o: { apiKey: string; model?: string; fetchImpl?: typeof fetch }): Drafter {
  const f = o.fetchImpl ?? fetch;
  const model = o.model ?? "claude-haiku-4-5";
  return {
    async draft({ agent, text, grant, now }) {
      const res = await f("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": o.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 1024,
          system:
            "You turn one sentence from the owner of a Warda agent into a job for the Warda runner. The agent's spending is " +
            "bounded by a Kaspa covenant grant, so you must stay inside its payees and per-payment cap. Prefer the simplest " +
            "job that does what was asked. Amounts are KAS strings like \"0.05\". Never invent an address. Always answer with the tool.",
          tools: [{ name: "propose_workflow", description: "The job, or why it is not possible.", input_schema: WORKFLOW_SCHEMA }],
          tool_choice: { type: "tool", name: "propose_workflow" },
          messages: [{ role: "user", content: `${context(agent, grant, now)}\n\nThe owner asks: ${text.slice(0, 600)}` }],
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`the drafting model answered ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
      }
      const j = (await res.json()) as { content?: { type: string; input?: Record<string, unknown> }[] };
      const input = j.content?.find((c) => c.type === "tool_use")?.input;
      if (!input) return { ok: false, reason: "the drafting model did not propose anything; try saying it differently" };
      return shape(agent, input, now);
    },
  };
}

/** Everything the model says goes through the same parser as a person's JSON. */
export function shape(agent: string, input: Record<string, unknown>, now: number): Draft {
  if (input.possible === false) return { ok: false, reason: String(input.reason || "that is not something this agent can do") };
  const workflow: Record<string, unknown> = {
    agent,
    name: typeof input.name === "string" ? input.name.slice(0, 60) : "New job",
    trigger: input.trigger,
    ...(Array.isArray(input.if) && input.if.length ? { if: input.if } : {}),
    then: input.then,
  };
  try {
    parseWorkflow(workflow, { id: "draft", now });
  } catch (e) {
    if (e instanceof WorkflowError) return { ok: false, reason: `the draft did not make a valid job (${e.message}); try saying it differently` };
    throw e;
  }
  return { ok: true, workflow, summary: String(input.summary ?? ""), notes: [] };
}
