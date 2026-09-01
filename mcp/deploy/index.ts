/**
 * The Warda MCP server, reachable at a URL.
 *
 * Installing an MCP server is a real barrier: an agent framework has to be
 * told a command, that command has to exist on the machine, and somebody has
 * to decide it is safe to run. A hosted Streamable HTTP endpoint replaces all
 * of that with one line of config — which is the difference between "an agent
 * could use Warda" and "an agent can".
 *
 * ## Why this is its own directory, and why the file is called index.ts
 *
 * This Vercel version picks ONE root entrypoint per project and routes every
 * path to it — `/`, `/mcp` and `/favicon.ico` all arrive at the same function.
 * It finds that entrypoint by looking for `src/index.ts`, `index.ts` or a
 * `main` field, and it announces its choice in the build log:
 *
 *     ✓ Build complete — Using <file> as the root entrypoint.
 *
 * Two deploys were lost to reading past that line. Pointed at the package
 * directory it chose `src/server.ts`, the STDIO server, which exports no HTTP
 * handler. Pointed at the repo root it chose `src/index.ts`, the core library,
 * and reported `Invalid export found in module` — a library has named exports
 * and no default.
 *
 * So this directory contains exactly one candidate, and that candidate is the
 * handler. No `src/`, no `main`, no build script, and no `api/` directory to
 * be preferred or ignored depending on the version. Whatever Vercel picks
 * here, it can only pick this.
 *
 * It depends on the PUBLISHED `@warda_protocol/mcp` rather than on the working
 * tree, so the endpoint serves a released version by construction. That costs
 * something real — it cannot run unreleased code — and buys something worth
 * more: it exercises the package the way an installing user does, which is the
 * exact path that hid the covenant-template bug for a whole release.
 *
 * ## Why the Node signature and not a Web handler
 *
 * The obvious version of this file takes a `Request` and returns a `Response`,
 * and it is what the second attempt did. Vercel's Node runtime hands a
 * function `(IncomingMessage, ServerResponse)` instead, so the handler was
 * called with arguments it did not understand and the invocation failed with
 * no useful message.
 *
 * The Edge runtime IS web-standard and would have taken that handler — but it
 * has no filesystem, and reading the covenant template needs one. So: Node
 * runtime, Node signature, and the SDK's Node transport, which is built for
 * exactly this shape.
 *
 * ## Stateless on purpose
 *
 * Each request gets a fresh server and transport, with no session id. A
 * session id implies a session, and the next request may land on a different
 * instance that has never heard of it — a stateful endpoint here would work in
 * testing and fail under load, which is the worst shape a bug can have.
 *
 * Warda loses nothing by it: every tool is a pure function of its arguments,
 * because the state lives on chain.
 *
 * ## What it can and cannot do
 *
 * It never sees a key, exactly as the stdio server never does. It returns
 * unsigned bytes and a digest; whoever holds the agent key signs wherever that
 * key lives. A hosted server that signed would be a custodian with a public
 * URL. It has no chain access either — the grant's UTXO is passed in — so the
 * worst a compromise of this host achieves is wrong ADVICE, and the covenant
 * does not consult advice.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { buildServer } from "@warda_protocol/mcp";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/**
 * Browsers preflight anything with a Content-Type, and an agent running in a
 * page is a client we want. Nothing here is authenticated, so a permissive
 * origin costs nothing: there is no cookie, no session, and no key to steal
 * with a cross-site request.
 */
function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "content-type, mcp-session-id, mcp-protocol-version, last-event-id, accept",
  );
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
  res.setHeader("Access-Control-Max-Age", "86400");
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  cors(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  // A GET without an event-stream accept header is a person opening the URL,
  // or a health check. A transport error tells them nothing; this tells them
  // what they found.
  if (req.method === "GET" && !String(req.headers.accept ?? "").includes("text/event-stream")) {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        name: "warda",
        transport: "streamable-http",
        description:
          "Economic authority for autonomous agents on Kaspa L1. POST MCP requests here. " +
          "This server never holds a key and never signs — it returns unsigned bytes and a digest.",
        docs: "https://wardaprotocol.com",
        source: "https://github.com/ArtyKOMarkets/warda",
      }),
    );
    return;
  }

  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    // No sessionIdGenerator: stateless. See the note at the top.
    sessionIdGenerator: undefined,
    // A serverless function is billed by wall clock and every tool here
    // answers in one round trip. An SSE stream held open would cost money to
    // deliver a single message.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    // Vercel parses a JSON body onto req.body and leaves the stream consumed,
    // so the transport must be handed the parsed value rather than left to
    // read a stream that will never produce anything.
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error: " + (e as Error).message },
          id: null,
        }),
      );
    }
  } finally {
    // The instance is reused for the next request, so a transport left
    // connected accumulates until it takes the function down.
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
