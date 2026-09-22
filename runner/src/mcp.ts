/**
 * MCP for one agent: its authority, its jobs, and a way to pay — over the
 * runner, with a key the agent never sees.
 *
 *   POST /mcp        Authorization: Bearer wat_…   (JSON-RPC 2.0)
 *
 * Streamable HTTP, answered as plain JSON (the transport allows it), with no
 * session: every call carries its token, and the token names exactly one
 * agent. It is written here rather than on top of the SDK's transport
 * because the whole surface is four methods and the runner is a fetch
 * handler; a Node request/response adapter would be most of the file.
 *
 * What an agent can do through this is what its grant allows and nothing
 * else: `pay` goes through the same run as any workflow — the preflight, the
 * txid recorded at broadcast, the fee — and the covenant decides the rest.
 */
import { formatKas } from "@warda_protocol/core";
import type { Engine } from "./engine.ts";
import type { FeePolicy } from "./fees.ts";
import { emptyLedger } from "./fees.ts";
import { hoursToExpiry, memberKey, spendable, type GrantReader } from "./grant.ts";
import type { Registry } from "./registry.ts";
import type { Store } from "./store.ts";
import { parseWorkflow } from "./workflow.ts";

export interface McpDeps {
  store: Store;
  registry: Registry;
  engine: Engine;
  grants: GrantReader;
  fees: FeePolicy;
  now?: () => number;
}

const PROTOCOL = "2025-06-18";

const TOOLS = [
  {
    name: "get_authority",
    description:
      "What this agent may spend right now, and why: budget left, the per-payment cap, who it may pay, when the grant ends. " +
      "These are limits every Kaspa node enforces; no request can raise them.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "pay",
    description:
      "Fetch a URL and pay for it if it answers HTTP 402, out of this agent's grant, never above max_kas. " +
      "Returns what the vendor served and the payment's transaction id. Refused, without paying, if the price is above " +
      "max_kas or anything the grant allows.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "https URL of the paid endpoint" },
        max_kas: { type: "string", description: "the most this one call may cost, in KAS, e.g. \"0.05\"" },
        method: { type: "string", enum: ["GET", "POST"] },
        body: { type: "string", description: "request body for POST (JSON as a string)" },
      },
      required: ["url", "max_kas"],
      additionalProperties: false,
    },
  },
  {
    name: "list_workflows",
    description: "The jobs the runner runs for this agent.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_workflow",
    description: "Run one of this agent's workflows now.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "list_runs",
    description: "What this agent has done recently: each run, each step, each payment's transaction id.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } }, additionalProperties: false },
  },
];

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

const out = (status: number, body: unknown) =>
  new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: body === null ? {} : { "content-type": "application/json" },
  });

const text = (v: unknown, isError = false) => ({
  content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) }],
  ...(isError ? { isError: true } : {}),
});

export function createMcp(d: McpDeps): (req: Request) => Promise<Response> {
  const now = d.now ?? Date.now;
  let n = 0;

  const call = async (agent: string, name: string, args: Record<string, unknown>) => {
    switch (name) {
      case "get_authority": {
        const g = await d.grants.read(agent);
        if (!g) return text("The grant could not be read right now (not funded yet, or the node did not answer). Nothing can be spent until it can.", true);
        const owed = ((await d.store.getLedger(agent)) ?? emptyLedger()).owed;
        const h = hoursToExpiry(g, now());
        return text({
          agent,
          status: g.status,
          spendableKas: formatKas(spendable(g, owed)),
          perPaymentCapKas: formatKas(g.maxPerSpend),
          epochRemainingKas: g.epochRemaining === null ? null : formatKas(g.epochRemaining),
          mayPay: g.payees,
          endsInHours: h === null ? null : Math.round(h),
          runnerFeesOwedKas: formatKas(owed),
          enforcedBy: "a Kaspa L1 covenant; the runner cannot raise any of these",
        });
      }
      case "pay": {
        const g = await d.registry.getGrant(agent);
        if (!g) return text("This agent has no grant yet, so it cannot pay anyone.", true);
        const fee = memberKey(d.fees.payee);
        if (!g.recipients.map(memberKey).includes(fee)) {
          return text("This agent's grant cannot pay the runner's fee, so the runner cannot pay for it. Its allowlist was fixed without the runner's fee address.", true);
        }
        const wf = parseWorkflow(
          {
            agent,
            name: "MCP pay",
            trigger: { type: "manual" },
            then: [{
              type: "pay-x402",
              url: args.url,
              maxKas: args.max_kas,
              ...(typeof args.method === "string" ? { method: args.method } : {}),
              ...(typeof args.body === "string" ? { body: args.body, contentType: "application/json" } : {}),
            }],
          },
          { id: `mcp-${agent}`, now: now() },
        );
        const r = await d.engine.runOnce(wf, `mcp:${now().toString(36)}${(n++).toString(36)}`, "mcp");
        const run = (await d.store.listRuns(agent, 5)).find((x) => x.id === r.run);
        const step = run?.steps[0];
        return text({
          status: run?.status ?? "not run",
          ...(step?.txid ? { txid: step.txid, paidKas: formatKas(BigInt(step.sompi ?? "0")) } : {}),
          detail: step?.detail ?? run?.note,
          served: r.bodies[0] ?? null,
        }, run?.status !== "ok");
      }
      case "list_workflows": {
        const wfs = await d.store.listWorkflows(agent);
        return text(wfs.filter((w) => !w.id.startsWith("mcp-")).map((w) => ({
          id: w.id, name: w.name, enabled: w.enabled,
          trigger: w.trigger.type === "schedule" ? `schedule ${w.trigger.cron.source}` : w.trigger.type,
          actions: w.actions.map((a) => a.type),
        })));
      }
      case "run_workflow": {
        const wf = await d.store.getWorkflow(String(args.id ?? ""));
        if (!wf || wf.agent !== agent) return text(`no workflow ${String(args.id)} for this agent`, true);
        const run = await d.engine.fire(wf.id, "manual");
        const rec = (await d.store.listRuns(agent, 5)).find((x) => x.id === run);
        return text(rec ?? { run });
      }
      case "list_runs": {
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10)));
        return text(await d.store.listRuns(agent, limit));
      }
      default:
        return null;
    }
  };

  return async (req: Request): Promise<Response> => {
    if (req.method !== "POST") return out(405, { error: "MCP here is POST-only (no server-initiated stream)" });
    const m = /^Bearer\s+(wat_[\w-]+)$/.exec(req.headers.get("authorization") ?? "");
    const agent = m ? await d.registry.agentForToken(m[1]!) : null;
    if (!agent) return out(401, { error: "an agent token is required: Authorization: Bearer wat_…" });
    let msg: Rpc;
    try {
      msg = (await req.json()) as Rpc;
    } catch {
      return out(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    }
    const reply = (result: unknown) => out(200, { jsonrpc: "2.0", id: msg.id ?? null, result });
    const fail = (code: number, message: string) => out(200, { jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
    if (msg.id === undefined) return out(202, null); // a notification: nothing to answer
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: "warda-runner", version: "0.1.0" },
          instructions:
            `You are acting as Warda agent "${agent}". Your spending is bounded by a Kaspa covenant: call get_authority ` +
            `before paying, and pay only through the pay tool. A refusal means the grant does not allow it; it is not an error to retry.`,
        });
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call": {
        const name = String(msg.params?.name ?? "");
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          const r = await call(agent, name, args);
          return r ? reply(r) : fail(-32602, `no tool ${name}`);
        } catch (e) {
          return reply(text((e as Error).message, true));
        }
      }
      default:
        return fail(-32601, `method ${msg.method} is not supported`);
    }
  };
}
