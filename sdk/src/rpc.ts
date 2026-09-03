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
  /**
   * Candidates, tried in order until one opens. A single unreachable node is
   * the commonest reason a working setup stops working, and it is not worth a
   * failed run when the caller knows about three of them.
   */
  urls?: string[];
  /** Per-call ceiling. A synced node answers these in milliseconds. */
  timeoutMs?: number;
  /** How long to wait for each socket to open. */
  connectTimeoutMs?: number;
}

const DEFAULT_URL = "ws://127.0.0.1:18210";

/**
 * Where to look, in order of how much the caller has said.
 *
 * An explicit `url` wins over a list, a list wins over the environment, and
 * localhost is what is left when nobody has said anything. `WARDA_RPC_JSON`
 * accepts several URLs separated by commas, so an operator with three nodes
 * can express that without touching code.
 */
export function candidateUrls(options: RpcOptions = {}): string[] {
  if (options.url) return [options.url];
  if (options.urls?.length) return options.urls;
  const env = process.env.WARDA_RPC_JSON;
  if (env) return env.split(",").map((u) => u.trim()).filter(Boolean);
  return [DEFAULT_URL];
}

const LOCAL_HINT =
  `The JSON wRPC port is separate from the Borsh one (testnet: 18210 vs 17210)\n` +
  `and only listens if kaspad was started with --rpclisten-json=<host:port>.\n` +
  `Note the '=': the flag rejects a space-separated value.\n\n` +
  `If you do not run a node: set WARDA_RESOLVER to a Kaspa Resolver and use\n` +
  `NodeClient.open(), which finds a public one and then checks it is worth\n` +
  `believing before you build anything against it.`;

function openSocket(url: string, timeoutMs: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      // A malformed URL throws synchronously, and its message names neither
      // the URL nor the fact that this was a connection attempt.
      reject(new Error(`${url} is not a usable WebSocket url: ${(e as Error).message}`));
      return;
    }
    const timer = setTimeout(() => reject(new Error(`timed out connecting to ${url}`)), timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`cannot reach ${url}`));
    });
  });
}

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


/**
 * `JSON.parse`, without silently rounding the u64s a Kaspa node sends.
 *
 * kaspad writes u64 fields as raw JSON NUMBERS, and JSON has one numeric type:
 * a double. `getCoinSupply` on testnet-10 answers with a circulating supply of
 * 2,690,917,752,273,334,000 sompi — nearly three hundred times
 * `Number.MAX_SAFE_INTEGER` — so by the time `JSON.parse` returns, the value
 * has already been rounded to the nearest representable double and the true
 * digits are gone. No check downstream can recover them; `toBigInt` can only
 * refuse, which is what it did, and refusing is the right answer to a value
 * that is already wrong.
 *
 * The fix has to happen during parsing, and Node gives exactly the hook for
 * it: a reviver's third argument carries `source`, the original literal text
 * as it appeared in the document. An integer literal that a double cannot hold
 * exactly is handed on as a STRING, which `toBigInt` already accepts, so the
 * exact digits survive and nothing downstream changes.
 *
 * Deliberately narrow. Safe integers stay numbers, so every field that was a
 * number before still is; floats are untouched; strings are untouched. Only a
 * value that would otherwise be quietly wrong changes shape.
 *
 * On a runtime that does not supply `source` this is exactly `JSON.parse`, and
 * `toBigInt` refuses the oversized values as before. That is a worse outcome
 * and not a dangerous one: the failure is loud.
 */
export function parseJsonPreservingIntegers(text: string): any {
  return JSON.parse(text, function (_key, value, context?: { source?: string }) {
    if (typeof value !== "number" || Number.isSafeInteger(value)) return value;
    const source = context?.source;
    return source !== undefined && /^-?\d+$/.test(source) ? source : value;
  });
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

  /**
   * Opens the first candidate that answers.
   *
   * Every failure is kept and reported together. One node being down and every
   * node being down look identical from a single error message, and they call
   * for completely different responses.
   */
  static async connect(options: RpcOptions = {}): Promise<RpcConnection> {
    const urls = candidateUrls(options);
    const timeoutMs = options.timeoutMs ?? 15_000;
    const connectTimeoutMs = options.connectTimeoutMs ?? 8_000;

    const failures: string[] = [];
    for (const url of urls) {
      try {
        return new RpcConnection(await openSocket(url, connectTimeoutMs), timeoutMs, url);
      } catch (e) {
        failures.push(`  ${(e as Error).message}`);
      }
    }
    throw new Error(
      (urls.length === 1
        ? `${failures[0]!.trim()}.\n`
        : `none of the ${urls.length} nodes answered:\n${failures.join("\n")}\n`) +
        LOCAL_HINT,
    );
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
          reply = parseJsonPreservingIntegers(String(ev.data));
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
