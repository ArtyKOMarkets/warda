import type { IncomingMessage, ServerResponse } from "node:http";
import { research } from "./service.js";
import { config } from "./config.js";

export async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body, null, 2));
  };
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost");
  const origin = `https://${host}`;
  /* Vercel rewrites /verify to /api/verify; the path the buyer asked for is
     what the quote and the record are about. */
  const url = new URL(req.url ?? "/", origin);
  if (url.pathname.startsWith("/api/")) url.pathname = url.pathname === "/api/index" ? "/" : url.pathname.slice(4);

  const cfg = config(origin);
  if ("missing" in cfg) {
    return send(503, { error: "this Researcher is not configured", missing: cfg.missing, charged: false });
  }
  try {
    const header = req.headers["x-payment"];
    const r = await research(url, header === undefined ? null : String(header), cfg);
    send(r.status, r.body);
  } catch (e) {
    send(500, { error: (e as Error).message });
  }
}
