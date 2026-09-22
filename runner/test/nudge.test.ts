import { test } from "node:test";
import assert from "node:assert/strict";
import { lowReason, nudgeLow } from "../src/nudge.ts";
import { memoryRegistry } from "../src/registry.ts";
import { memoryStore } from "../src/store.ts";
import type { GrantView } from "../src/grant.ts";

const KAS = 100_000_000n;

test("low: under a fifth of the budget, or under two days; ended grants are not nagged", () => {
  assert.equal(lowReason({ budget: KAS, left: KAS / 2n, hoursLeft: 100 }), null);
  assert.match(lowReason({ budget: KAS, left: KAS / 10n, hoursLeft: 100 })!, /0\.1 KAS of 1 left \(10%\)/);
  assert.match(lowReason({ budget: KAS, left: KAS, hoursLeft: 20 })!, /ends in 20 hours/);
  assert.equal(lowReason({ budget: KAS, left: 0n, hoursLeft: -1 }), null);
});

test("nudge: once per grant, only to owners with Telegram, at most hourly", async () => {
  const registry = memoryRegistry();
  const store = memoryStore();
  const a = await registry.createAccount(1);
  await registry.claimAgent("bot", a.id, 1);
  await registry.claimAgent("quiet", (await registry.createAccount(1)).id, 1);
  await registry.setTelegram(a.id, "42");
  for (const agent of ["bot", "quiet"]) {
    await registry.putGrant({ agent, manifest: { covenant_id: "c1" } as never, recipients: [], updatedAt: 1 });
  }
  const view: GrantView = { address: "x", status: "ACTIVE", budgetTotal: KAS, spentTotal: KAS - KAS / 10n, reserved: 0n,
    maxPerSpend: KAS / 10n, epochRemaining: null, coin: KAS, payees: [], expiresAtMs: 10 * 86_400_000 };
  const sent: [string, string][] = [];
  const run = (now: number) => nudgeLow({ registry, store, grants: { read: async () => structuredClone(view) }, now, consoleUrl: "https://c.test/app",
    send: async (c, t) => void sent.push([c, t]) });
  assert.deepEqual(await run(1_000), ["bot"]);
  assert.equal(sent[0]![0], "42");
  assert.match(sent[0]![1], /bot has 0\.1 KAS of 1 left[\s\S]*https:\/\/c\.test\/app#\/hagents/);
  assert.deepEqual(await run(1_000 + 3_600_000), [], "the same grant is not told twice");
  await registry.putGrant({ agent: "bot", manifest: { covenant_id: "c2" } as never, recipients: [], updatedAt: 2 });
  assert.deepEqual(await run(1_000 + 3_600_000 + 60_000), [], "not more than hourly");
  assert.deepEqual(await run(1_000 + 7_200_000 + 60_000), ["bot"], "a new grant is its own");
});
