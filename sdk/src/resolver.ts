/**
 * Finding a node when you do not run one.
 *
 * Everything else in this package works offline. This is the one place that
 * needs a network, and until now it needed a very specific one: a kaspad on
 * localhost, started with `--rpclisten-json=`, `--utxoindex`, and a build new
 * enough to know about covenants. That is a reasonable ask of an operator and
 * an unreasonable one of somebody trying the SDK for ten minutes.
 *
 * The Kaspa Resolver removes it. It is a load balancer over the Public Node
 * Network: ask it for a node and it hands back the least-loaded one, as a
 * wRPC WebSocket URL.
 *
 *   GET {resolver}/v2/kaspa/{networkId}/{tls}/wrpc/{encoding}
 *   → {"uid": "...", "url": "wss://..."}
 *
 * ## Why this is not the thing we refused to do
 *
 * A REST facade over Kaspa — the kind that takes a transaction as JSON and
 * submits it for you — cannot be used here, and the reason is specific rather
 * than ideological. Those services model a transaction with a pre-covenant
 * schema. Hand one a covenant spend and it accepts it, drops the fields it has
 * no place for, and submits something well-formed with no binding. The
 * signature then fails to verify against a transaction nobody knowingly built.
 *
 * A resolver does none of that. It answers one question — which node should I
 * talk to — and then gets out of the way; the connection that follows is wRPC
 * to a real kaspad, byte for byte the same conversation as with a local one.
 * What it costs is trust in whoever runs that node, which is why
 * `NodeClient.open` interrogates it before believing a word it says.
 */

/** What the resolver returns. `uid` identifies the node; `url` is a wRPC socket. */
export interface NodeDescriptor {
  uid: string;
  url: string;
}

export interface ResolveOptions {
  /** The resolver's base URL. No default: see `WARDA_RESOLVER` below. */
  resolver?: string;
  /** As kaspad names it: `mainnet`, `testnet-10`, `testnet-11`. */
  networkId?: string;
  /** `tls` demands an encrypted socket; `any` accepts either. */
  tls?: "tls" | "any";
  timeoutMs?: number;
}

/**
 * No resolver host is compiled in, and that is deliberate.
 *
 * A hardcoded list is a list of parties this SDK vouches for, and it would go
 * stale in a package that gets published once and installed for years. Naming
 * the resolver is a decision about who you are willing to trust with the
 * question "which node should I use", and it belongs to whoever is running
 * the agent — so it comes from `WARDA_RESOLVER` or from the caller.
 */
export function resolverFrom(options: ResolveOptions = {}): string | undefined {
  return options.resolver ?? process.env.WARDA_RESOLVER ?? undefined;
}

/** The path the resolver expects, version 2 of its API. */
export function resolverUrl(base: string, networkId: string, tls: "tls" | "any"): string {
  const root = base.replace(/\/+$/, "");
  // `json`, not `borsh`: this SDK speaks the JSON wRPC encoding, and asking for
  // the wrong one returns a node whose socket will never answer a call.
  return `${root}/v2/kaspa/${networkId}/${tls}/wrpc/json`;
}

/**
 * Ask a resolver for a node.
 *
 * Failures here are reported with the URL that produced them. A resolver that
 * is down, or that has no node for the network you asked about, is a different
 * problem from a node that is down, and telling them apart from the message is
 * the difference between checking your config and checking your firewall.
 */
export async function resolveNode(options: ResolveOptions = {}): Promise<NodeDescriptor> {
  const base = resolverFrom(options);
  if (!base) {
    throw new Error(
      `no resolver configured. Set WARDA_RESOLVER to the base URL of a Kaspa ` +
        `Resolver, or pass { resolver } — or point the SDK at a node directly ` +
        `with WARDA_RPC_JSON. This package ships no default resolver host on ` +
        `purpose: which one you trust is your decision, not a constant in a ` +
        `dependency.`,
    );
  }
  const networkId = options.networkId ?? process.env.WARDA_NETWORK ?? "testnet-10";
  const url = resolverUrl(base, networkId, options.tls ?? "any");

  const signal = AbortSignal.timeout(options.timeoutMs ?? 8_000);
  let response: Response;
  try {
    response = await fetch(url, { signal, headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`resolver ${url} did not answer: ${(e as Error).message}`);
  }
  if (!response.ok) {
    throw new Error(
      `resolver ${url} answered ${response.status}. A 404 here usually means no ` +
        `node in its pool serves ${networkId} over the JSON encoding.`,
    );
  }
  const body = (await response.json()) as Partial<NodeDescriptor>;
  if (typeof body?.url !== "string" || !body.url) {
    throw new Error(`resolver ${url} returned no node url: ${JSON.stringify(body)}`);
  }
  return { uid: String(body.uid ?? ""), url: body.url };
}
