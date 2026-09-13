/**
 * A kaspad you can lie to, and lie with.
 *
 * `buy.ts` could not be tested without a chain, which is why every bug in it
 * was found by spending real money on a real network. This is a WebSocket
 * server speaking the four methods Warda actually calls, over the wire format
 * kaspad uses — which is JSON-RPC-shaped but NOT JSON-RPC: a reply carries its
 * result in `params`, not in `result`. Getting that wrong is why a naive fake
 * would hang rather than fail, so it is the one detail worth stating twice.
 *
 * What makes it useful is not that it answers, but that it can answer BADLY,
 * in each of the ways a real node ruins a day:
 *
 *   healthy        synced, utxo-indexed, on the network it claims
 *   unsynced       a stale DAA score, so an epoch a spend claims is already gone
 *   noIndex        address queries answer with silence rather than an error
 *   wrongNetwork   every address derives perfectly and nothing is ever found
 *   preCovenant    covenantId dropped, so a spend is built with no binding
 *   rejectSubmit   the node refuses the transaction, with a message
 *
 * Those are the four checks `inspect` makes and the two ways a submit fails.
 * Each of them produces a PLAUSIBLE WRONG ANSWER on a real node, which is the
 * entire reason they are checked — and until now the only way to see one was
 * to find a node in that state.
 */
import { WebSocketServer, type WebSocket } from "ws";

export type NodeMood = "healthy" | "unsynced" | "noIndex" | "wrongNetwork" | "preCovenant" | "rejectSubmit";

export interface FakeUtxo {
  address: string;
  transactionId: string;
  index: number;
  amount: bigint;
  scriptPublicKey: string;
  blockDaaScore: bigint;
  covenantId?: string;
}

export interface FakeNode {
  url: string;
  mood: NodeMood;
  /** The UTXO set this node believes in. Mutable: a spend can change it. */
  utxos: FakeUtxo[];
  /** Everything submitted, in order, as the node received it. */
  submitted: Record<string, unknown>[];
  /** Bump it to make the chain advance under a test. */
  daaScore: bigint;
  close(): Promise<void>;
}

/** kaspad emits u64s as raw JSON numbers; bigints must not become strings. */
const wire = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));

export async function startFakeNode(options: { network?: string } = {}): Promise<FakeNode> {
  const state = {
    mood: "healthy" as NodeMood,
    utxos: [] as FakeUtxo[],
    submitted: [] as Record<string, unknown>[],
    daaScore: 567_600_000n,
    network: options.network ?? "kaspa-testnet-10",
  };

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw) => {
      let req: { id?: number; method?: string; params?: Record<string, unknown> };
      try { req = JSON.parse(String(raw)); } catch { return; }
      const reply = (params: unknown) => socket.send(wire({ id: req.id, method: req.method, params }));
      const fail = (message: string) => socket.send(wire({ id: req.id, method: req.method, error: { message } }));

      switch (req.method) {
        case "getInfo":
          return reply({
            serverVersion: "2.0.1-fake",
            isSynced: state.mood !== "unsynced",
            isUtxoIndexed: state.mood !== "noIndex",
            mempoolSize: 0,
            p2pId: "fake",
          });

        case "getBlockDagInfo":
          return reply({
            network: state.mood === "wrongNetwork" ? "kaspa-mainnet" : state.network,
            // Far behind, so any epoch a spend claims has already passed.
            virtualDaaScore: state.mood === "unsynced" ? 1_000n : state.daaScore,
            blockCount: 1,
            sink: "00".repeat(32),
            pruningPointHash: "00".repeat(32),
            tipHashes: ["00".repeat(32)],
          });

        case "getUtxosByAddresses": {
          /* Silence, not an error. That is what a node without --utxoindex
             does, and it is indistinguishable from a grant that has moved —
             which is precisely why `inspect` refuses such a node rather than
             letting a tool report the grant gone. */
          if (state.mood === "noIndex") return reply({ entries: [] });
          const want = new Set((req.params?.addresses as string[]) ?? []);
          const entries = state.utxos
            .filter((u) => want.has(u.address))
            .map((u) => ({
              address: u.address,
              outpoint: { transactionId: u.transactionId, index: u.index },
              utxoEntry: {
                amount: u.amount,
                scriptPublicKey: u.scriptPublicKey,
                blockDaaScore: u.blockDaaScore,
                isCoinbase: false,
                ...(state.mood === "preCovenant" || !u.covenantId ? {} : { covenantId: u.covenantId }),
              },
            }));
          return reply({ entries });
        }

        case "submitTransaction": {
          const tx = (req.params?.transaction ?? {}) as Record<string, unknown>;
          if (state.mood === "rejectSubmit") {
            return fail(
              `Rejected transaction ${tx.id ?? "?"}: transaction is not standard: ` +
                `transaction has 822000 fees which is under the required amount of 974600`,
            );
          }
          state.submitted.push(tx);
          return reply({ transactionId: String(tx.id ?? "fa".repeat(32)) });
        }

        default:
          return fail(`method not supported by this fake node: ${req.method}`);
      }
    });
  });

  await new Promise<void>((r) => wss.once("listening", () => r()));
  const port = (wss.address() as { port: number }).port;

  return {
    url: `ws://127.0.0.1:${port}`,
    get mood() { return state.mood; },
    set mood(m: NodeMood) { state.mood = m; },
    get utxos() { return state.utxos; },
    set utxos(u: FakeUtxo[]) { state.utxos = u; },
    get daaScore() { return state.daaScore; },
    set daaScore(d: bigint) { state.daaScore = d; },
    submitted: state.submitted,
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}
