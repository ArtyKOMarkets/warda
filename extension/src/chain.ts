/**
 * Talking to a node from a service worker.
 *
 * ## Why this connects and disconnects rather than holding a socket open
 *
 * An MV3 service worker is terminated after about thirty seconds idle, and a
 * WebSocket does keep it alive — traffic on one resets the idle timer as of
 * Chrome 116, which is what makes a live wallet possible at all. But "keep the
 * worker alive forever with a heartbeat" is a battery bill paid by every user
 * so that a console nobody is looking at can watch a chain nobody is spending
 * on. A grant that moves does so on the order of a payment, not a frame.
 *
 * So this opens a connection when there is a question, answers it, and closes.
 * The alarm that refreshes in the background wakes the worker anyway. When
 * there is a reason for live push — a spend appearing as it happens while the
 * console is open — the keepalive is the known answer and can be added
 * without moving anything else.
 *
 * ## Why it goes through `inspect`
 *
 * The node this talks to is, by default, somebody else's — the project's own
 * four-method proxy. Three of the four ways a node can be wrong produce a
 * plausible answer rather than an error: not synced, no UTXO index, or the
 * wrong network entirely, where every address is well formed and empty. The
 * SDK already knows how to ask; the console asks the same way rather than
 * inventing a lighter check that misses the case that matters.
 */
import { NodeClient, inspect } from "@warda_protocol/kaspa";
import type { NodeStatus } from "./messages.ts";
import { settings } from "./store.ts";

/** Open, hand the client to `use`, and always close. */
export async function withNode<T>(use: (client: NodeClient) => Promise<T>): Promise<T> {
  const s = await settings();
  const client = await NodeClient.connect({ url: s.nodeUrl, timeoutMs: 15_000 });
  try {
    return await use(client);
  } finally {
    client.close();
  }
}

export async function status(): Promise<NodeStatus> {
  const s = await settings();
  try {
    return await withNode(async (client) => {
      const health = await inspect(client, { networkId: s.network, tolerate: true });
      const failed = Object.entries(health.checks)
        // The covenant check needs a grant address to probe and has none here.
        // Reporting it as a failure would make a healthy node look broken.
        .filter(([name, c]) => name !== "covenants" && !c.ok)
        .map(([, c]) => c.detail);
      return {
        url: health.url,
        reachable: true,
        detail: failed.length ? failed.join(" · ") : "synced, indexed, right network",
        network: health.network,
        daaScore: health.virtualDaaScore.toString(),
      };
    });
  } catch (e) {
    return {
      url: s.nodeUrl,
      reachable: false,
      detail: (e as Error).message,
      network: null,
      daaScore: null,
    };
  }
}
