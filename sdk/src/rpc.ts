/**
 * The wRPC JSON transport: one WebSocket, one envelope, one error shape.
 *
 * Kaspa's wRPC looks like JSON-RPC and is not. Three differences will each
 * cost you an afternoon if you assume the familiar shape:
 *
 *   1. A reply carries its result in `params`, NOT in `result`. The `result`
 *      field is commented out in workflow-rpc's `messages.rs` in favour of
 *      reusing `params` for both directions. Reading replies as JSON-RPC 2.0
 *      finds every one of them empty, successfully, forever.
 *   2. A request with no `id` is a NOTIFICATION. The server runs it and sends
 *      nothing back, so a client that omits the id waits out its own timeout
 *      on a call the node actually performed.
 *   3. `error.code` is always 0. The server maps every failure to code 0 and
 *      puts the real information in `message`. Branching on the code
 *      distinguishes nothing.
 *
 * Anything the server cannot parse is a `MalformedMessage`, which closes the
 * socket rather than replying — so a bad request looks like a network fault.
 */

/** What the server sends. `error` and `params` are mutually exclusive. */
export interface RpcReply {
  id?: number;
  method?: string;
  params?: unknown;
  error?: { code?: number; message?: string; data?: unknown } | string;
}

export class RpcError extends Error {
  readonly method: string;
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = "RpcError";
    this.method = method;
  }
}

export interface RpcOptions {
  /** Defaults to `WARDA_RPC_JSON`, else the testnet JSON port. */
  url?: string;
  /** Per-call ceiling. A synced node answers these in milliseconds. */
  timeoutMs?: number;
}

const DEFAULT_URL = "ws://127.0.0.1:18210";

/**
 * JSON cannot carry a u64 faithfully: above 2^53 a literal loses digits during
 * `JSON.parse` and nothing reports it. Rather than hand back a value that is
 * quietly wrong, every integer crossing this boundary is checked.
 *
 * On the way OUT the check is unnecessary — a bigint is written as raw digits
 * below — but on the way IN it is the only thing standing between a corrupted
 * amount and a signature over it.
 */
export function toBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "string") return BigInt(value);
  if (typeof value !== "number") throw new Error(`${label}: expected a number, got ${typeof value}`);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `${label}: ${value} exceeds what a JSON number holds exactly, so the value ` +
        `received here has already lost precision. Refusing to return it.`,
    );
  }
  return BigInt(value);
}

const BIG_OPEN = "\u0000<bigint:";
const BIG_CLOSE = ">\u0000";

/**
 * `JSON.stringify` with bigint support, emitting raw digits rather than a
 * quoted string — serde deserializes a u64 from a JSON number, and would
 * reject `"1000000000"` where it wants `1000000000`.
 *
 * The token is wrapped in NULs, which JSON.stringify escapes as `\u0000`, so
 * it cannot collide with a hex string or an address in the payload.
 */
export function stringify(value: unknown): string {
  const text = JSON.stringify(value, (_k, v) =>
    typeof v === "bigint" ? `${BIG_OPEN}${v.toString()}${BIG_CLOSE}` : v,
  );
  return text.replace(/"\\u0000<bigint:(-?\d+)>\\u0000"/g, "$1");
}

/** A live connection. One socket, many calls, ids allocated in order. */
export class RpcConnection {
  private nextId = 1;
  private readonly socket: WebSocket;
  private readonly timeoutMs: number;
  readonly url: string;

  // Written out rather than declared as constructor parameter properties:
  // node's --experimental-strip-types erases types without rewriting syntax,
  // and a parameter property is syntax, not a type. This package runs from
  // source with no build step, so it stays inside what stripping can do.
  private constructor(socket: WebSocket, timeoutMs: number, url: string) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.url = url;
  }

  static async connect(options: RpcOptions = {}): Promise<RpcConnection> {
    const url = options.url ?? process.env.WARDA_RPC_JSON ?? DEFAULT_URL;
    const timeoutMs = options.timeoutMs ?? 15_000;
    const socket = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), 8_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(
          new Error(
            `cannot reach ${url}.\n` +
              `The JSON wRPC port is separate from the Borsh one (testnet: 18210 vs 17210)\n` +
              `and only listens if kaspad was started with --rpclisten-json=<host:port>.\n` +
              `Note the '=': the flag rejects a space-separated value.`,
          ),
        );
      });
    });

    return new RpcConnection(socket, timeoutMs, url);
  }

  /** Sends one request and resolves with its `params`. Throws on `error`. */
  call(method: string, params: unknown = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.removeEventListener("message", onMessage);
        reject(new RpcError(method, `no reply within ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      const onMessage = (ev: MessageEvent) => {
        let reply: RpcReply;
        try {
          reply = JSON.parse(String(ev.data));
        } catch {
          return; // not parseable; if it was ours the timeout reports it
        }
        if (reply.id !== id) return; // a notification, or another call's reply
        clearTimeout(timer);
        this.socket.removeEventListener("message", onMessage);
        if (reply.error !== undefined && reply.error !== null) {
          const text =
            typeof reply.error === "string" ? reply.error : (reply.error.message ?? "unknown error");
          reject(new RpcError(method, text));
          return;
        }
        resolve(reply.params);
      };

      this.socket.addEventListener("message", onMessage);
      // The id is what makes this a call rather than a notification.
      this.socket.send(stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}
