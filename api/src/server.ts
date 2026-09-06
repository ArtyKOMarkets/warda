/**
 * The HTTP surface. Routing, limits, and turning every failure into something
 * a caller can act on.
 *
 * There is no framework here on purpose. The whole service is five routes over
 * a node connection, and a dependency that parses request bodies is a
 * dependency that can parse them differently than the tests did.
 *
 * The error contract is the part worth reading. A verifier is used precisely
 * when somebody cannot tell a typo from a lie, so "400 Bad Request" alone is a
 * failure of the product. Every rejection names the field and says what would
 * have been valid, and the one failure that is NOT the caller's fault — a node
 * that cannot be trusted — is a 503 that says which check failed rather than a
 * 200 with a plausible answer in it.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ManifestError } from "./manifest.ts";
import { NodeSource, NodeUnusable, type ChainSource, type NodeOptions } from "./node.ts";
import { authority, grantAt, health, locate, verify, RequestError, type Reply } from "./routes.ts";

export interface ServeOptions extends NodeOptions {
  port?: number;
  host?: string;
  /** Largest request body accepted, in bytes. */
  maxBodyBytes?: number;
}

const DEFAULT_MAX_BODY = 1_048_576;

const INDEX = {
  service: "warda-verify",
  what:
    "Answers a counterparty's questions about a Warda grant by reading a Kaspa node. " +
    "Decides nothing: the covenant enforces on chain, and every answer here is a " +
    "re-derivation of what it would decide.",
  endpoints: {
    "GET /health": "the node this service reads, and whether it can be believed",
    "POST /v1/verify":
      "{ manifest, recipients?, network?, feeSompi? } — does the chain agree with these terms",
    "GET /v1/grant/{address}":
      "what a node alone can say about an address, and what it cannot say at all",
    "POST /v1/authority":
      "{ manifest, recipients, payment: { amountSompi, payTo } } — would the covenant refuse this payment, and why",
    "POST /v1/locate":
      "{ manifest, payments: [{ valueSompi, blockDaaScore }], subsets? } — where a stale manifest's grant moved to",
  },
  source: "https://github.com/ArtyKOMarkets/warda",
} as const;

function send(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    // A verifier nobody can call from a page is a verifier nobody calls. The
    // service holds no credentials and reads only public chain state, so there
    // is nothing here for a cross-origin request to steal.
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "cache-control": "no-store",
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) {
      throw new RequestError(
        413,
        `request body exceeds ${limit} bytes. A manifest is a few hundred bytes; a body ` +
          `this large is not one.`,
      );
    }
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new RequestError(400, `the request body is not valid JSON: ${(e as Error).message}`);
  }
}

function failure(e: unknown): Reply {
  if (e instanceof ManifestError) {
    return { status: 400, body: { ok: false, error: "invalid_manifest", field: e.field, message: e.message } };
  }
  if (e instanceof RequestError) {
    return {
      status: e.status,
      body: { ok: false, error: "invalid_request", field: e.field, message: e.message },
    };
  }
  if (e instanceof NodeUnusable) {
    return { status: 503, body: { ok: false, error: "node_unusable", message: e.message } };
  }
  // Anything else is this service's fault, and saying so beats implying the
  // caller sent something wrong.
  return {
    status: 500,
    body: {
      ok: false,
      error: "internal",
      message: `this service failed while answering: ${(e as Error).message}`,
    },
  };
}

export function handler(source: ChainSource, options: ServeOptions = {}) {
  const limit = options.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === "OPTIONS") {
      send(res, 204, null);
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    let reply: Reply;
    try {
      if (req.method === "GET" && path === "/") {
        reply = { status: 200, body: INDEX };
      } else if (req.method === "GET" && path === "/health") {
        reply = await health(source);
      } else if (req.method === "GET" && path.startsWith("/v1/grant/")) {
        reply = await grantAt(source, decodeURIComponent(path.slice("/v1/grant/".length)));
      } else if (req.method === "POST" && path === "/v1/verify") {
        reply = await verify(source, await readBody(req, limit));
      } else if (req.method === "POST" && path === "/v1/authority") {
        reply = await authority(source, await readBody(req, limit));
      } else if (req.method === "POST" && path === "/v1/locate") {
        reply = await locate(source, await readBody(req, limit));
      } else {
        reply = {
          status: 404,
          body: {
            ok: false,
            error: "no_such_route",
            message: `${req.method} ${path} is not a route here.`,
            endpoints: INDEX.endpoints,
          },
        };
      }
    } catch (e) {
      reply = failure(e);
    }
    send(res, reply.status, reply.body);
  };
}

export interface Running {
  server: Server;
  source: NodeSource;
  port: number;
  close(): Promise<void>;
}

export async function serve(options: ServeOptions = {}): Promise<Running> {
  const source = new NodeSource(options);
  const server = createServer((req, res) => {
    void handler(source, options)(req, res);
  });
  const port = options.port ?? Number(process.env.PORT ?? 8477);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const bound = server.address();
  return {
    server,
    source,
    port: typeof bound === "object" && bound ? bound.port : port,
    close: () =>
      new Promise<void>((resolve) => {
        source.close();
        server.close(() => resolve());
      }),
  };
}
