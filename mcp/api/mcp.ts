/**
 * The Warda MCP server, reachable at a URL.
 *
 * Installing an MCP server is a real barrier: an agent framework has to be
 * told a command, that command has to exist on the machine, and somebody has
 * to decide it is safe to run. A hosted Streamable HTTP endpoint replaces all
 * of that with one line of config — which is the difference between "an agent
 * could use Warda" and "an agent can".
 *
 * ## Stateless on purpose
 *
 * Each request gets a fresh server and a fresh transport, with no session id.
 * That is not a limitation worked around; it is what a serverless function can
 * honestly promise. A session id implies a session, and the next request may
 * land on a different instance that has never heard of it — a stateful
 * endpoint here would work in testing and fail under load, which is the worst
 * shape a bug can have.
 *
 * Warda loses nothing by it. Every tool is a pure function of its arguments:
 * the grant is described in the call, the answer is derived, and nothing is
 * remembered between calls. There is no state here worth keeping because the
 * state lives on chain.
 *
 * ## What this endpoint can and cannot do
 *
 * It never sees a key, exactly as the stdio server never does. It returns
 * unsigned bytes and a digest; whoever holds the agent key signs wherever that
 * key lives. That property is what makes hosting this defensible at all — a
 * hosted server that signed would be a custodian with a public URL.
 *
 * It also has no chain access. The grant's UTXO is passed in. So the worst a
 * compromise of this host achieves is wrong ADVICE, and the covenant does not
 * consult advice.
 */
import { buildServer } from "../src/server.ts";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

export const config = { runtime: "nodejs" };

/**
 * Browsers preflight anything with a Content-Type, and an agent running in a
 * page is a client we want. Nothing here is authenticated, so a permissive
 * origin costs nothing: there is no cookie, no session, and no key to steal
 * with a cross-site request.
 */
const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, mcp-session-id, mcp-protocol-version, last-event-id, accept",
  "Access-Control-Expose-Headers": "mcp-session-id",
  "Access-Control-Max-Age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // A GET with no session is someone opening the URL in a browser, or a
  // health check. Answering it with a transport error tells them nothing; a
  // short description tells them what they found.
  if (req.method === "GET" && !req.headers.get("accept")?.includes("text/event-stream")) {
    return withCors(
      Response.json({
        name: "warda",
        transport: "streamable-http",
        description:
          "Economic authority for autonomous agents on Kaspa L1. POST MCP requests here. " +
          "This server never holds a key and never signs — it returns unsigned bytes and a digest.",
        docs: "https://wardaprotocol.com",
        source: "https://github.com/ArtyKOMarkets/warda",
      }),
    );
  }

  const server = buildServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    // No sessionIdGenerator: stateless. See the note at the top.
    sessionIdGenerator: undefined,
    // A serverless function is billed by wall clock, and every one of these
    // tools answers in a single round trip. An SSE stream held open would cost
    // money to deliver one message.
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    return withCors(await transport.handleRequest(req));
  } catch (e) {
    return withCors(
      Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error: " + (e as Error).message },
          id: null,
        },
        { status: 500 },
      ),
    );
  } finally {
    // The instance may be reused for the next request, so a transport left
    // connected would accumulate until it took the function down.
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
