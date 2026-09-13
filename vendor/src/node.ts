/**
 * Getting a node to ask, and saying which one answered.
 *
 * A seller's entire security here is "the money is visibly in the UTXO set",
 * which makes the node answering that question part of the security. Reading
 * your own is the strong version. Everything else is a trade, and the trade is
 * worth naming rather than hiding: a dishonest node could report a payment
 * that does not exist and you would hand over the goods. That risk is the
 * SELLER's — a buyer loses nothing by it — which is why a fallback is offered
 * at all, and why what it cost you is reported in the response instead of
 * being left for someone to discover.
 *
 * ## Why the fallback exists
 *
 * The vendor this was extracted from pointed WARDA_RPC_JSON at a Cloudflare
 * quick tunnel, which is handed a new random hostname every time it restarts.
 * It restarted. Every paid request after that failed, including one already
 * paid for, and nothing said so. An endpoint that only works while one machine
 * is up is not published.
 */
import { NodeClient, resolveNode, resolverFrom } from "@warda_protocol/kaspa";

export interface NodeSource {
  /** Your node's JSON wRPC url. Tried first, always. */
  rpc?: string;
  /** A Kaspa Resolver, used only if `rpc` is absent or unreachable. */
  resolver?: string;
  /** Which chain, as kaspad names it: `mainnet`, `testnet-10`. */
  network: string;
  /**
   * Whether to fall back to a node this vendor does not control.
   *
   * `auto` (the default) tries a resolver, then borsh if it is installed.
   * `none` refuses, and the refusal is a legitimate position rather than a
   * test seam: the doc above names the trade honestly — a dishonest node
   * could report a payment that does not exist, and the loss is the
   * SELLER's — so a seller who would rather answer 503 than hand goods over
   * on a stranger's word should be able to say so.
   */
  fallback?: "auto" | "none";
  /**
   * The reader of last resort, injected.
   *
   * This exists because the fall-through it guards shipped broken: every test
   * covered a single step of the chain and none covered a step FAILING INTO
   * the next, which is the only behaviour a fallback has. A chain you cannot
   * make fail on purpose is a chain you have not tested.
   */
  loadFallbackReader?: () => Promise<FallbackReader | null>;
}

export interface OpenedNode {
  /* Narrowed from NodeClient: the fallback reader is not one, and the two
     calls this package makes are all either of them needs to provide. */
  client: Pick<NodeClient, "getUtxosByAddresses" | "close">;
  /** Sentence for the receipt: which node's word this is. */
  readFrom: string;
}

export async function openNode(source: NodeSource): Promise<OpenedNode> {
  let firstFailure: string | null = null;

  if (source.rpc) {
    try {
      return {
        client: await NodeClient.connect({ url: source.rpc }),
        readFrom: "this vendor's own node",
      };
    } catch (e) {
      firstFailure = (e as Error).message;
    }
  }

  const allowFallback = (source.fallback ?? "auto") === "auto";

  const resolver = allowFallback ? source.resolver ?? resolverFrom({}) : null;
  if (resolver) {
    /**
     * `resolveNode` then `open`, not `open` alone.
     *
     * `NodeClient.open` consults a resolver only when NO node is named, and it
     * counts WARDA_RPC_JSON as naming one — correctly, for its own purposes.
     * At this point that variable holds the url that just failed, so calling
     * `open()` here re-dials the dead host and throws the same error twice.
     * Resolving first and passing the url explicitly is what actually gets
     * past a configured-but-unreachable node.
     *
     * And WRAPPED, which it was not.
     *
     * A resolver that cannot be reached throws, and an unguarded throw here
     * left the whole function before the borsh fallback below was ever
     * consulted. So the fallback to the fallback was deployed and did
     * nothing — which is word for word what the comment at the top of this
     * file says went wrong the first time, reproduced one level down by the
     * change that was meant to fix it. Every step in a fallback chain has to
     * fail INTO the next one, or it is not a chain.
     */
    try {
      const found = await resolveNode({ resolver, networkId: source.network });
      const { client, health } = await NodeClient.open({
        url: found.url,
        networkId: source.network,
      });
      return {
        client,
        readFrom:
          `a public node found by a resolver (kaspad ${health.serverVersion}), because this ` +
          `vendor's own node could not be reached. A node this vendor does not control is ` +
          `answering whether you paid it.`,
      };
    } catch (e) {
      /* Kept for the final message, and only if nothing later succeeds. The
         JSON resolver failing is EXPECTED now — the public resolvers serve
         borsh — so it is not worth reporting on its own. */
      firstFailure = firstFailure ?? (e as Error).message;
    }
  }

  /**
   * Borsh, last, and only if it is installed.
   *
   * Optional rather than a dependency: it pulls a wasm binary, and a vendor
   * running its own JSON node should not have to download one to decline it.
   * The import is lazy for the same reason.
   */
  const load = source.loadFallbackReader ?? loadBorsh;
  const borsh = allowFallback ? await load() : null;
  if (borsh) {
    const client = await borsh.BorshReader.open({ networkId: source.network });
    return {
      client,
      readFrom:
        `a public node found by a resolver, over borsh, because this vendor's own node ` +
        `could not be reached. A node this vendor does not control is answering whether ` +
        `you paid it.`,
    };
  }

  throw new Error(
    (firstFailure ? `${firstFailure}\n\n` : "") +
      `This vendor has no node it can read.\n\n` +
      `  A seller never submits a transaction — it only asks whether a coin is at its own\n` +
      `  address — so it does not need a JSON node. Installing @warda_protocol/borsh lets\n` +
      `  this fall back to the public resolvers, which serve borsh and not JSON.\n\n` +
      `    npm install @warda_protocol/borsh kaspa-wasm32-sdk`,
  );
}

/**
 * `@warda_protocol/borsh` if it is there, and nothing if it is not.
 *
 * A missing optional dependency is a configuration fact, not an error: the
 * caller gets a message naming the install, rather than a module-resolution
 * stack trace from inside a payment.
 */
export interface FallbackReader {
  BorshReader: { open(o: { networkId: string }): Promise<Pick<NodeClient, "getUtxosByAddresses" | "close">> };
}

async function loadBorsh(): Promise<FallbackReader | null> {
  try {
    return (await import("@warda_protocol/borsh")) as never;
  } catch {
    return null;
  }
}
