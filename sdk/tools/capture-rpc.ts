/**
 * Records what your node actually says, so the client can be built against it.
 *
 * Every other part of this SDK is checked against a golden vector produced by
 * the reference implementation. A node client has no such vector — the wire
 * format lives in someone else's source tree, and reading it carefully is not
 * the same as being right about it. So: capture first, build second, and keep
 * the capture as the fixture the tests replay forever.
 *
 * Run once against a synced node:
 *
 *   node --experimental-strip-types tools/capture-rpc.ts > rpc-capture.json
 *
 * It reads nothing secret and writes nothing to the chain — four read-only
 * calls. Pass a grant address as the first argument to capture a UTXO that
 * actually carries a covenant, which is the case that matters:
 *
 *   node --experimental-strip-types tools/capture-rpc.ts kaspatest:pp... > rpc-capture.json
 */

const url = process.env.WARDA_RPC_JSON ?? "ws://127.0.0.1:18210";
const address = process.argv[2];

/**
 * The wRPC JSON envelope, from workflow-rpc's `messages.rs`.
 *
 * Note the response carries its result in `params`, NOT in `result` — the
 * `result` field is commented out in the source in favour of reusing `params`.
 * Assuming JSON-RPC 2.0 shape here would read every reply as empty.
 */
interface ServerMessage {
  id?: number;
  method?: string;
  params?: unknown;
  error?: { code?: number; message?: string } | string;
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), 8000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(
        new Error(
          `cannot reach ${url}.\n` +
            `The JSON wRPC port is separate from the Borsh one (testnet: 18210 vs 17210) and\n` +
            `is only open if kaspad was started with --rpclisten-json. Add it and restart,\n` +
            `or set WARDA_RPC_JSON to the right address.`,
        ),
      );
    });
  });
}

let nextId = 1;

function call(ws: WebSocket, method: string, params: unknown): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`${method}: no reply within 15s`)), 15000);

    const onMessage = (ev: MessageEvent) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return; // not for us; a malformed frame is the server's problem to report
      }
      if (msg.id !== id) return; // a notification, or another call's reply
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      resolve(msg);
    };

    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function main(): Promise<void> {
  const ws = await connect();

  const calls: { method: string; params: unknown; why: string }[] = [
    { method: "getInfo", params: {}, why: "readiness — is it synced, is the utxo index on" },
    { method: "getBlockDagInfo", params: {}, why: "the current DAA score" },
    {
      method: "getUtxosByAddresses",
      params: { addresses: address ? [address] : [] },
      why: address
        ? "a real grant UTXO, including its covenant id"
        : "shape only — pass a grant address to capture a covenant-bearing entry",
    },
  ];

  const captured: Record<string, unknown> = {};
  for (const c of calls) {
    const reply = await call(ws, c.method, c.params);
    captured[c.method] = { why: c.why, request: c.params, reply };
    console.error(
      reply.error
        ? `${c.method}: ERROR ${JSON.stringify(reply.error)}`
        : `${c.method}: ok`,
    );
  }
  ws.close();

  // A covenant-aware node reports `covenantId` on a UTXO entry. A node built
  // before covenants omits the field entirely, and a client that shrugged at
  // that would build spends with no binding — valid-looking, always refused.
  const utxos = (captured.getUtxosByAddresses as { reply: ServerMessage }).reply.params as
    | { entries?: { utxoEntry?: Record<string, unknown> }[] }
    | undefined;
  const first = utxos?.entries?.[0]?.utxoEntry;
  const verdict = !address
    ? "not checked — no address given"
    : !first
      ? "no UTXO found at that address; cannot tell"
      : "covenantId" in first
        ? "present — this node is covenant-aware"
        : "ABSENT — this node predates covenants, or the field was dropped in transit";
  captured._covenantAwareness = { verdict, sampledEntry: first ?? null };
  console.error(`covenant awareness: ${verdict}`);

  process.stdout.write(JSON.stringify({ url, address: address ?? null, captured }, null, 2) + "\n");
}

main().catch((e) => {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
});
