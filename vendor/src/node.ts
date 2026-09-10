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
}

export interface OpenedNode {
  client: NodeClient;
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

  const resolver = source.resolver ?? resolverFrom({});
  if (resolver) {
    /**
     * `resolveNode` then `open`, not `open` alone.
     *
     * `NodeClient.open` consults a resolver only when NO node is named, and it
     * counts WARDA_RPC_JSON as naming one — correctly, for its own purposes.
     * At this point that variable holds the url that just failed, so calling
     * `open()` here re-dials the dead host and throws the same error twice.
     * The fallback existed, was deployed, and did nothing. Resolving first and
     * passing the url explicitly is what actually gets past a
     * configured-but-unreachable node.
     */
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
  }

  throw new Error(
    firstFailure
      ? `${firstFailure}\n\nNo resolver was configured, so there was nothing to fall back to.`
      : "no rpc url and no resolver: this vendor cannot read the chain",
  );
}
