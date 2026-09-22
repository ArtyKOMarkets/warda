/**
 * Job templates: a job someone found useful, published so others can copy it
 * onto their own agent in one click.
 *
 * A template is the job's shape and nothing private. Publishing strips the
 * Telegram chat a notification goes to (a copy goes to its new owner's chat),
 * and refuses jobs that call a URL of the author's own — a webhook or an http
 * call is usually a secret in disguise. A copied job is checked against the
 * copier's grant like any other: a payee they do not have, or an amount over
 * their cap, is refused at copy time rather than at payment time.
 */
import { formatKas } from "@warda_protocol/core";
import type { Workflow } from "./workflow.ts";

export interface Template {
  id: string;
  title: string;
  description: string;
  /** The job as POST /v1/workflows takes it, without `agent`. */
  job: Record<string, unknown>;
  author: string;
  createdAt: number;
  copies: number;
  featured?: boolean;
}

/** A parsed workflow back into the JSON a person writes. */
export function jobJson(wf: Workflow): Record<string, unknown> {
  const trigger = wf.trigger.type === "schedule" ? { type: "schedule", cron: wf.trigger.cron.source } : { ...wf.trigger };
  return {
    name: wf.name.replace(/^🤖\s*/, ""),
    trigger,
    ...(wf.conditions.length ? { if: wf.conditions.map((c) => ({ ...c })) } : {}),
    then: wf.actions.map((a) => {
      switch (a.type) {
        case "pay-x402":
          return { type: a.type, url: a.url, method: a.method, maxKas: formatKas(a.maxSompi), ...(a.body !== undefined ? { body: a.body } : {}) };
        case "send":
          return { type: a.type, to: a.to, kas: formatKas(a.sompi) };
        case "notify":
          return { type: a.type, channel: a.channel, to: a.to, text: a.text };
        case "http":
          return { type: a.type, url: a.url, method: a.method, ...(a.body !== undefined ? { body: a.body } : {}) };
        case "approval":
          return { type: a.type, op: a.op, note: a.note };
      }
    }),
  };
}

/** What may be published of a job, or why not. */
export function publishable(wf: Workflow): { job: Record<string, unknown> } | { refused: string } {
  for (const a of wf.actions) {
    if (a.type === "http") return { refused: "a job that calls a URL of your own cannot be published — the URL is often a secret" };
    if (a.type === "notify" && a.channel === "webhook") return { refused: "a job that posts to your webhook cannot be published — the URL is often a secret" };
  }
  if (wf.trigger.type === "webhook") return { refused: "a webhook job cannot be published: its trigger is your secret URL" };
  const job = jobJson(wf);
  job.then = (job.then as Record<string, unknown>[]).map((a) => (a.type === "notify" ? { ...a, to: "" } : a));
  return { job };
}

export const FEATURED: Template[] = [
  {
    id: "featured-daily-fact", featured: true, author: "Warda", createdAt: 0, copies: 0,
    title: "Buy something useful every morning",
    description: "An x402 API every day at 8 UTC, never more than 0.05 KAS. Swap in any paid URL.",
    job: { name: "Morning purchase", trigger: { type: "schedule", cron: "0 8 * * *" },
      then: [{ type: "pay-x402", url: "https://warda-demo-api.vercel.app/fact", method: "GET", maxKas: "0.05" }] },
  },
  {
    id: "featured-ask-first", featured: true, author: "Warda", createdAt: 0, copies: 0,
    title: "Buy daily — but ask me first",
    description: "Same purchase, but each run waits for your Approve on Telegram. Nothing is paid on silence.",
    job: { name: "Morning purchase, asks first", trigger: { type: "schedule", cron: "0 8 * * *" },
      then: [
        { type: "approval", op: "continue", note: "The morning purchase wants to run (up to 0.05 KAS)." },
        { type: "pay-x402", url: "https://warda-demo-api.vercel.app/fact", method: "GET", maxKas: "0.05" },
      ] },
  },
  {
    id: "featured-low-budget", featured: true, author: "Warda", createdAt: 0, copies: 0,
    title: "Tell me when a fifth is left",
    description: "A Telegram message when the budget drops under 20%, with what is left.",
    job: { name: "Budget low", trigger: { type: "grant", when: "budget-below", percent: 20 },
      then: [{ type: "notify", channel: "telegram", to: "", text: "{{agent}} has {{grant.availableKas}} KAS left ({{grant.spentPercent}}% spent)." }] },
  },
  {
    id: "featured-ending", featured: true, author: "Warda", createdAt: 0, copies: 0,
    title: "Two days before it ends",
    description: "A reminder 48 hours before the grant's term is over, while there is time to top it up.",
    job: { name: "Ending soon", trigger: { type: "grant", when: "expiring-within", hours: 48 },
      then: [{ type: "notify", channel: "telegram", to: "", text: "{{agent}}'s grant ends in {{grant.hoursToExpiry}} hours with {{grant.availableKas}} KAS left. Top it up in Your agents." }] },
  },
];
