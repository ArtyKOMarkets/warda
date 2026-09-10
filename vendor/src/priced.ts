/**
 * The ten-line version.
 *
 * `settle` is the whole protocol and takes eight things. Most sellers have one
 * endpoint, one price and one address, and should not have to assemble a state
 * machine to charge for it — so this wraps it into the two shapes people
 * actually deploy: a node:http handler and a Fetch handler.
 *
 *     export default priced(
 *       { payTo: process.env.PAY_TO!, sompi: 4_000_000n, network: "mainnet",
 *         secret: process.env.QUOTE_SECRET! },
 *       async () => ({ answer: 42 }),
 *     );
 *
 * Everything the wrapper decides for you is a default you can override, except
 * one: it will not start without a quote secret, and it will not invent one.
 * A generated-per-process secret makes every quote unverifiable by the next
 * process, which on a serverless host is most of them — the failure would be
 * intermittent, would look like a buyer problem, and would land after the money
 * was spent.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { openNode } from "./node.ts";
import { inMemorySpent, type SpentStore } from "./spent.ts";
import { settle, type SaleTerms } from "./settle.ts";

export interface PricedOptions extends Omit<SaleTerms, "resource"> {
  /** Signs quotes. Required, and must be the same across every instance. */
  secret: string;
  /** What is being sold. Defaults to the request path. */
  resource?: string;
  /** How long a quote is good for. Default two minutes. */
  ttlMs?: number;
  /** Your node's JSON wRPC url. Falls back to WARDA_RPC_JSON. */
  rpc?: string;
  /** A Kaspa Resolver, used only when the node above is unreachable. */
  resolver?: string;
  /** Replay protection. Defaults to per-process memory, which warns. */
  spent?: SpentStore;
}

export type Deliver = (context: { txid: string }) => unknown | Promise<unknown>;

function prepare(options: PricedOptions) {
  if (!options.secret) {
    throw new Error(
      "@warda_protocol/vendor: `secret` is required and cannot be generated for you. It signs " +
        "quotes, so every instance must use the SAME value — a per-process secret makes each " +
        "quote unverifiable by the next process, which under a serverless host is most of them.",
    );
  }
  const spent = options.spent ?? inMemorySpent();
  return { spent };
}

/** For `node:http`, and for hosts that hand you (req, res) — Vercel included. */
export function priced(options: PricedOptions, deliver: Deliver) {
  const { spent } = prepare(options);

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const resource = options.resource ?? (req.url ?? "/").split("?")[0]!;
    const header = req.headers["x-payment"];

    const result = await settle({
      terms: { ...options, resource },
      paymentHeader: header === undefined ? null : String(header),
      quote: { secret: options.secret, ttlMs: options.ttlMs },
      spent,
      openNode: () =>
        openNode({
          rpc: options.rpc ?? process.env.WARDA_RPC_JSON,
          resolver: options.resolver,
          network: options.network,
        }),
      deliver: () => deliver({ txid: decodeTxid(header) }),
    });

    res.writeHead(result.status, {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify(result.body, null, 2));
  };
}

/** For Fetch-shaped hosts: Workers, Deno, Bun, and Next's route handlers. */
export function pricedFetch(options: PricedOptions, deliver: Deliver) {
  const { spent } = prepare(options);

  return async function handler(request: Request): Promise<Response> {
    const header = request.headers.get("x-payment");
    const resource = options.resource ?? new URL(request.url).pathname;

    const result = await settle({
      terms: { ...options, resource },
      paymentHeader: header,
      quote: { secret: options.secret, ttlMs: options.ttlMs },
      spent,
      openNode: () =>
        openNode({
          rpc: options.rpc ?? process.env.WARDA_RPC_JSON,
          resolver: options.resolver,
          network: options.network,
        }),
      deliver: () => deliver({ txid: decodeTxid(header) }),
    });

    return new Response(JSON.stringify(result.body, null, 2), {
      status: result.status,
      headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
    });
  };
}

/* The txid is handed to `deliver` so a seller can file its own receipt against
   the payment. Decoding it a second time here rather than threading it out of
   settle keeps that function's return shape about the RESPONSE; by the time
   deliver runs the header has already been parsed and verified, so this cannot
   fail in a way that matters. */
function decodeTxid(header: string | string[] | null | undefined): string {
  if (!header) return "";
  try {
    const parsed = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
    return typeof parsed?.txid === "string" ? parsed.txid : "";
  } catch {
    return "";
  }
}
