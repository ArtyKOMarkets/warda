/**
 * Which transport the tools reach the chain over, and who decides.
 *
 * Every tool that reads or spends used to call `NodeClient.open` directly,
 * which meant every tool required a kaspad started with `--rpclisten-json=`.
 * That requirement was the single largest thing standing between somebody and
 * their first Warda payment, and it turned out not to be a protocol
 * requirement at all.
 *
 * kaspad's wRPC speaks two encodings. JSON exists only when an operator asks
 * for it; borsh is the default, and the only one the sixteen public resolvers
 * serve. The reason the buyer's half stayed on JSON was that the published
 * WASM client predated covenants — and since borsh is POSITIONAL, a struct its
 * encoder does not know about is not an unknown field but an absent one, so a
 * grant spend through it would have been well-formed, correctly signed, and
 * bound to nothing. rusty-kaspa's own bindings have carried covenants since
 * Toccata; the gap was in packaging, and `@warda_protocol/borsh` now closes it
 * against a build that has them, checking both encoders agree on the
 * transaction id before anything is broadcast.
 *
 * ## Still a choice, still made by the person
 *
 * `--borsh` is a flag rather than a fallback. Reaching for a stranger's node
 * because yours is not configured would make the most consequential decision
 * in these tools the one nobody made — and a resolver does not remove the
 * question of whose node you believe, it answers it on your behalf.
 *
 * What makes that acceptable is that the four health checks run either way. On
 * your own node "synced, indexed, right network, understands covenants" are
 * assumptions worth making; on a resolver-chosen stranger they are questions,
 * and three of the four ways it can be wrong produce a plausible answer rather
 * than an error. `inspect` asks them of a `BorshReader` exactly as it asks
 * them of a `NodeClient`, which is the whole reason the reader implements
 * `Inspectable`.
 */

import {
  NodeClient,
  formatHealth,
  inspect,
  type NodeHealth,
  type OpenOptions,
} from "@warda_protocol/kaspa";

/**
 * What the tools need from a chain connection.
 *
 * Narrow on purpose: it is what makes a `NodeClient` and a `BorshReader`
 * interchangeable at this seam. Widening it would quietly re-couple the tools
 * to the JSON transport, which is how the requirement got everywhere the first
 * time.
 */
export type Chain = Pick<
  NodeClient,
  | "close"
  | "getInfo"
  | "getBlockDagInfo"
  | "getUtxosByAddresses"
  | "grantUtxo"
  | "submitTransaction"
> & { readonly url: string };

export interface ChainOptions extends OpenOptions {
  /** Reach the chain over borsh, through a public resolver. */
  borsh?: boolean;
}

/** `--borsh` on the command line, or `WARDA_BORSH=1` in the environment. */
export function borshRequested(argv: string[] = process.argv.slice(2)): boolean {
  return argv.includes("--borsh") || process.env.WARDA_BORSH === "1";
}

/**
 * How long to wait for a resolver-chosen node, and why there is a limit at all.
 *
 * `RpcClient.connect` does not time out. It retries, forever, in silence — so
 * a blocked outbound wss (a proxy, a container egress policy, a firewall that
 * drops rather than refuses) looks exactly like a slow network, and the tool
 * simply never returns. "Nothing happened" is the single worst failure a
 * first-run transport can have, because there is nothing to search for.
 */
const CONNECT_TIMEOUT_MS = 20_000;

async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    /* The timer must not be what keeps the process alive: on the happy path
       this loses the race and its only remaining job is to stop existing. */
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer!);
  }
}

export interface OpenedChain {
  client: Chain;
  health: NodeHealth;
  transport: "json" | "borsh";
}

export async function openChain(options: ChainOptions = {}): Promise<OpenedChain> {
  if (!(options.borsh ?? borshRequested())) {
    const { client, health } = await NodeClient.open(options);
    return { client, health, transport: "json" };
  }

  let mod: typeof import("@warda_protocol/borsh");
  try {
    mod = await import("@warda_protocol/borsh");
  } catch {
    throw new Error(
      "--borsh needs the borsh transport and a WASM build that can express a covenant.\n\n" +
        "  npm install @warda_protocol/borsh @kluster/kaspa-wasm\n\n" +
        "Both are optional: a node of your own makes them unnecessary.",
    );
  }

  const networkId = options.networkId ?? process.env.WARDA_NETWORK ?? "testnet-10";
  const client = await withDeadline(
    mod.BorshReader.open({
      networkId,
      /* A url here is still a borsh url — someone pointing this at their OWN
         node over the default encoding, which is a reasonable thing to want and
         costs nothing to allow. It is not the JSON url from --rpc. */
      url: options.url,
    }),
    CONNECT_TIMEOUT_MS,
    `no answer from a ${networkId} node over borsh within ${CONNECT_TIMEOUT_MS / 1000}s.\n\n` +
      `The resolver hands out public nodes, and reaching one is a plain outbound wss\n` +
      `connection — which a corporate proxy, a container egress policy or a firewall\n` +
      `will block silently rather than refuse. It looks identical to a slow network.\n\n` +
      `  curl -sS https://beacon.kaspa-ng.org/v2/kaspa/${networkId}/wrpc/borsh\n\n` +
      `If that does not answer either, the problem is between you and the internet\n` +
      `rather than in the transport. A node of your own over --rpc needs no egress.`,
  );

  /* Checked before anything is signed, because a build that cannot carry a
     covenant fails in the one direction that produces a transaction rather
     than an error. `canSubmit` is answered by CONSTRUCTING a binding, not by
     reading a version, so it will start saying yes the day upstream ships one
     without anything here changing. */
  if (!client.canSubmit) {
    await client.close();
    throw new Error(
      "the WASM build installed cannot express a covenant, so it must not build a spend.\n\n" +
        "Borsh is positional: a struct the encoder does not know about is not an unknown\n" +
        "field, it is an ABSENT one. A grant spend through such a build would be\n" +
        "well-formed, correctly signed, and bound to nothing.\n\n" +
        "  npm install @kluster/kaspa-wasm\n\n" +
        "kaspa-wasm32-sdk@0.15.2 is the one that cannot. A packaging gap upstream, not a\n" +
        "protocol one.",
    );
  }

  let health: NodeHealth;
  try {
    health = await inspect(client, options);
  } catch (e) {
    await client.close();
    throw e;
  }
  if (!health.usable && !options.tolerate) {
    await client.close();
    throw new Error(
      `this node cannot be trusted with a grant:\n\n${formatHealth(health)}\n\n` +
        `It was chosen by a resolver rather than by you, which is the trade --borsh makes ` +
        `— so these checks are the part that is not optional. Every one of them fails by ` +
        `returning a plausible answer rather than an error.`,
    );
  }
  return { client: client as unknown as Chain, health, transport: "borsh" };
}
