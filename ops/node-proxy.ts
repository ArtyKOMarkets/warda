/**
 * A public front door for one kaspad, opened exactly four methods wide.
 *
 *   node --experimental-strip-types ops/node-proxy.ts --upstream ws://127.0.0.1:18210
 *
 * ## Why this exists
 *
 * A stranger following /start needs a node, and there is no public one they can
 * use: kaspad speaks JSON wRPC only when started with --rpclisten-json=, borsh
 * is the default, and every public resolver therefore answers 404 for json. So
 * the only node most readers could reach is one we point them at.
 *
 * ## Why not just publish the port
 *
 * Because kaspad's wRPC has no authentication and is not read-only. From
 * rusty-kaspa's own op list: AddPeer = 124, ResolveFinalityConflict = 132,
 * Shutdown = 133, Ban = 139, Unban = 140. Publishing the port on a page built
 * to attract strangers hands every reader the ability to stop the node, and
 * that node is also the one this project's agents, hourly readings and daily
 * purchases run against.
 *
 * Warda calls four methods. This forwards those four and refuses the rest BY
 * NAME, so the refusal is a fact about a list rather than a judgement about a
 * caller.
 *
 * ## What it deliberately does not do
 *
 * It does not authenticate, meter per-identity, or promise uptime. It is a
 * quickstart node: testnet, best effort, and the page says so. Anything more
 * is a service, and a service is a commitment this project has not made.
 */
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const arg = (name: string, fallback?: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};

const UPSTREAM = arg("upstream", process.env.WARDA_RPC_JSON) ?? "ws://127.0.0.1:18210";
const PORT = Number(arg("port", "8410"));

/* The whole allowlist. Adding to it is a decision, which is why it is a
   literal here and not derived from anything. */
const ALLOWED = new Set([
  "getInfo",
  "getBlockDagInfo",
  "getUtxosByAddresses",
  "submitTransaction",
]);

/* Per connection, not per IP: behind a tunnel every request arrives from the
   same address, so an IP bucket would be one bucket for everybody. This bounds
   what a single socket can do, and a flood of sockets is the tunnel's problem
   rather than something this can honestly solve. */
const WINDOW_MS = 10_000;
const MAX_PER_WINDOW = 60;

let served = 0;
let refused = 0;
let sockets = 0;

const server = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      upstream: UPSTREAM.replace(/\/\/.*@/, "//"),
      allowed: [...ALLOWED],
      served,
      refused,
      openSockets: sockets,
    }, null, 2));
    return;
  }
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({
    error: "this is a Warda quickstart node, not a web server",
    speak: "JSON wRPC over a WebSocket on this same port",
    allowed: [...ALLOWED],
  }, null, 2));
});

const wss = new WebSocketServer({ server });

wss.on("connection", (client) => {
  sockets++;
  const upstream = new WebSocket(UPSTREAM);
  const pending: string[] = [];
  let windowStart = Date.now();
  let inWindow = 0;

  /* A refusal has to look like a reply or the caller waits for its timeout.
     RpcConnection matches on `id` and reads `error` as a string, so this is
     shaped to be understood rather than merely sent. */
  const refuse = (id: unknown, message: string) => {
    refused++;
    client.send(JSON.stringify({ id: id ?? null, error: message }));
  };

  upstream.on("open", () => { for (const m of pending) upstream.send(m); pending.length = 0; });
  upstream.on("message", (data) => client.send(String(data)));
  upstream.on("close", () => client.close());
  upstream.on("error", () => {
    /* The node behind this is a laptop. Saying so is more use than a socket
       that simply dies, because the caller may be holding a payment. */
    try {
      client.send(JSON.stringify({
        id: null,
        error: "this quickstart node cannot reach its kaspad right now. It is best effort — " +
          "run your own with --rpclisten-json= and --utxoindex, and set WARDA_RPC_JSON.",
      }));
    } catch { /* the client may already be gone */ }
    client.close();
  });

  client.on("message", (data) => {
    const now = Date.now();
    if (now - windowStart > WINDOW_MS) { windowStart = now; inWindow = 0; }
    if (++inWindow > MAX_PER_WINDOW) {
      return refuse(null, `more than ${MAX_PER_WINDOW} calls in ${WINDOW_MS / 1000}s from one socket`);
    }

    const text = String(data);
    let parsed: { id?: unknown; method?: unknown };
    try {
      parsed = JSON.parse(text);
    } catch {
      return refuse(null, "not JSON");
    }

    const method = typeof parsed.method === "string" ? parsed.method : "";
    if (!ALLOWED.has(method)) {
      return refuse(
        parsed.id,
        `this node forwards only ${[...ALLOWED].join(", ")}. ` +
          `"${method || "(no method)"}" is not one of them — it is a public quickstart node, ` +
          `not your node. Run kaspad yourself for the rest.`,
      );
    }

    served++;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
    else pending.push(text);
  });

  client.on("close", () => { sockets--; upstream.close(); });
  client.on("error", () => upstream.close());
});

server.listen(PORT, () => {
  console.error(`warda node proxy on :${PORT} -> ${UPSTREAM}`);
  console.error(`  forwarding: ${[...ALLOWED].join(", ")}`);
  console.error(`  refusing everything else, including Shutdown, Ban and AddPeer`);
  console.error(`  health: http://127.0.0.1:${PORT}/health`);
});
