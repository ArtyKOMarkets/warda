/**
 * Telling an owner their agent is about to stop, with the way to keep it going.
 *
 * Owners can write their own budget-below jobs, and some do. This is the one
 * nobody has to write: once an hour, any agent whose grant has under a fifth of
 * its budget left, or under two days to run, gets one Telegram message to its
 * owner with a link to top it up. Once per grant — a top-up is a new grant, so
 * the next one is told about in its turn.
 */
import { formatKas } from "@warda_protocol/core";
import type { Registry } from "./registry.ts";
import type { Store } from "./store.ts";
import { emptyLedger } from "./fees.ts";
import { hoursToExpiry, spendable, type GrantReader } from "./grant.ts";

const HOUR = 3_600_000;

export function lowReason(o: { budget: bigint; left: bigint; hoursLeft: number | null }): string | null {
  if (o.hoursLeft !== null && o.hoursLeft <= 0) return null; // ended: nothing to top up in time for
  if (o.budget > 0n && o.left * 5n < o.budget) {
    const pct = Number((o.left * 1000n) / o.budget) / 10;
    return `has ${formatKas(o.left)} KAS of ${formatKas(o.budget)} left (${pct}%)`;
  }
  if (o.hoursLeft !== null && o.hoursLeft < 48) return `ends in ${Math.max(1, Math.round(o.hoursLeft))} hours`;
  return null;
}

export async function nudgeLow(o: {
  registry: Registry;
  store: Store;
  grants: GrantReader;
  now: number;
  consoleUrl: string;
  send: (chat: string, text: string) => Promise<void>;
}): Promise<string[]> {
  const last = await o.registry.getMeta("nudge:at");
  if (last !== null && o.now - Number(last) < HOUR) return [];
  await o.registry.setMeta("nudge:at", String(o.now));
  const told: string[] = [];
  for (const { agent, account } of await o.registry.listAgents()) {
    const chat = await o.registry.telegramOf(account);
    if (!chat) continue;
    const record = await o.registry.getGrant(agent);
    const plan = await o.registry.getPlan(agent);
    if (!record || (plan && plan.status === "awaiting-deposit" && (plan.round ?? 1) > 1)) continue; // a top-up is already on its way
    const key = `nudge:${agent}`;
    if ((await o.registry.getMeta(key)) === record.manifest.covenant_id) continue;
    const g = await o.grants.read(agent).catch(() => null);
    if (!g) continue;
    const owed = ((await o.store.getLedger(agent)) ?? emptyLedger()).owed;
    const why = lowReason({ budget: g.budgetTotal, left: spendable(g, owed), hoursLeft: hoursToExpiry(g, o.now) });
    if (!why) continue;
    try {
      await o.send(chat, `⏳ Your agent ${agent} ${why}. When it runs out it stops — its jobs wait and nothing is paid.\n\n` +
        `Top it up (same agent, same jobs, one payment): ${o.consoleUrl}#/hagents`);
      await o.registry.setMeta(key, String(record.manifest.covenant_id));
      told.push(agent);
    } catch { /* Telegram down: try again next hour */ }
  }
  return told;
}
