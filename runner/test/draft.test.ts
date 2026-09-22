import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeDrafter, shape } from "../src/draft.ts";

const answer = (input: Record<string, unknown>) =>
  (async () => new Response(JSON.stringify({ content: [{ type: "tool_use", name: "propose_workflow", input }] }), { status: 200 })) as unknown as typeof fetch;

test("a sentence becomes a job the ordinary parser accepts", async () => {
  let sent: Record<string, any> | null = null;
  const f = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ content: [{ type: "tool_use", input: {
      possible: true, summary: "Buys a fact every morning at 09:00 UTC, never more than 0.05 KAS.", name: "Morning fact",
      trigger: { type: "schedule", cron: "0 9 * * *" },
      then: [{ type: "pay-x402", url: "https://warda-demo-api.vercel.app/fact", maxKas: "0.05" }],
    } }] }));
  }) as unknown as typeof fetch;
  const d = await claudeDrafter({ apiKey: "k", fetchImpl: f }).draft({ agent: "bot", text: "buy a fact every morning", grant: null, now: 0 });
  assert.equal(d.ok, true);
  if (d.ok) assert.equal((d.workflow.trigger as { cron: string }).cron, "0 9 * * *");
  assert.equal(sent!.tool_choice.name, "propose_workflow", "the answer is forced into the schema");
  assert.match(sent!.messages[0].content, /buy a fact every morning/);
});

test("the model saying no is passed on as a reason, not a job", async () => {
  const d = await claudeDrafter({ apiKey: "k", fetchImpl: answer({ possible: false, reason: "that payee is not on the grant" }) })
    .draft({ agent: "bot", text: "pay alice 5 KAS", grant: null, now: 0 });
  assert.deepEqual(d, { ok: false, reason: "that payee is not on the grant" });
});

test("a malformed draft is refused by the same parser a person's JSON meets", () => {
  const d = shape("bot", { possible: true, trigger: { type: "schedule", cron: "every morning" }, then: [] }, 0);
  assert.equal(d.ok, false);
  const e = shape("bot", { possible: true, trigger: { type: "manual" }, then: [{ type: "revoke" }] }, 0);
  assert.equal(e.ok, false);
});
