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
 * A borsh endpoint the caller NAMED, and nothing else.
 *
 * Read from argv here rather than taken from `options.url`, and the difference
 * is the whole point. Every tool computes its url as
 * `flag("rpc") ?? process.env.WARDA_RPC_JSON`, which merges two things that
 * must not be merged on this transport:
 *
 *   --rpc alongside --borsh   an endpoint somebody chose for borsh
 *   WARDA_RPC_JSON            a JSON listener, by name and by definition
 *
 * Once merged, openChain could not tell them apart — so a machine with
 * WARDA_RPC_JSON exported in its shell ran `--borsh` against its own JSON
 * port. Borsh to a JSON listener connects and is dropped, which surfaced as
 * `WebSocket disconnected` out of a wasm background task, and looked like the
 * public resolvers being flaky. It was a local node refusing an encoding it
 * does not speak.
 *
 * JSON and borsh are different ports on a kaspad, not different spellings.
 * The environment variable's own name says which one it holds, so on this path
 * it is ignored rather than guessed at.
 */
function namedBorshEndpoint(argv: string[] = process.argv.slice(2)): string | undefined {
  const i = argv.indexOf("--rpc");
  const url = i >= 0 ? argv[i + 1] : undefined;
  return url && !url.startsWith("--") ? url : undefined;
}

/**
 * The connect deadline lives in `@warda_protocol/borsh`, not here.
 *
 * It was here first, as one timeout around the whole thing, and the message it
 * could produce was "nothing answered in 20 seconds" — true of a blocked HTTPS
 * lookup, a blocked outbound wss, a resolver with no node for your network,
 * and a node that is down. Four causes, four different things to do, one
 * message. The transport knows which stage it is in; this does not.
 */
export interface OpenedChain {
  client: Chain;
  health: NodeHealth;
  transport: "json" | "borsh";
}

/**
 * The WASM client reports a lost connection OUT OF BAND, and Node 24 kills the
 * process for it.
 *
 * `RPC Server (remote error) -> WebSocket disconnected` does not arrive by
 * rejecting the call you are awaiting. It surfaces from the client's own
 * background task, as a rejection nobody is holding — and unhandled rejections
 * have been fatal since Node 15 by default. So a dropped socket does not fail
 * the operation, it terminates the program, with a wasm stack trace and no
 * indication of which command was running or how far it got.
 *
 * That is not something the borsh package can fix from the inside: the
 * rejection is not reachable from any promise it hands out. A process-level
 * handler is the only place it can be caught, and a CLI tool owns its process
 * where a library does not — so it lives here, in `sdk/tools`, and not in
 * `@warda_protocol/borsh`.
 *
 * It converts, it does not swallow. A dropped connection is a real failure of
 * whatever was in flight, so this still exits non-zero; what changes is that
 * the exit says which node dropped out and what to do, and anything that is
 * NOT a transport error is re-thrown so a genuine bug still crashes loudly.
 */
let guarded = false;
function guardAgainstSilentDisconnect(): void {
  if (guarded) return;
  guarded = true;
  process.on("unhandledRejection", (reason) => {
    const text = reason instanceof Error ? reason.message : String(reason);
    if (!/WebSocket disconnected|RPC Server \(remote error\)|not connected/i.test(text)) {
      throw reason;
    }
    console.error(
      `\nThe connection to the node dropped: ${text}\n\n` +
        `This arrives from the WASM client's background task rather than from the call\n` +
        `that was running, so there is no way to tell you which step it interrupted.\n` +
        `Assume nothing after the last line printed above completed.\n\n` +
        `If money was involved, CHECK BEFORE RETRYING — a submit that was accepted and\n` +
        `then lost the socket looks identical here to one that never arrived.\n\n` +
        `An IMMEDIATE disconnect usually means the endpoint does not speak borsh: JSON\n` +
        `and borsh are different ports on a kaspad, not different spellings, and a JSON\n` +
        `listener accepts the socket and then drops it. A borsh url ends /wrpc/borsh.\n\n` +
        `  warda find            where the grant is now\n` +
        `  warda activity        what was attempted, refusals included\n\n` +
        `Running again picks a different node. If it keeps happening, name one that\n` +
        `works: --rpc wss://<host>/kaspa/<network>/wrpc/borsh`,
    );
    process.exit(5);
  });
}

export async function openChain(options: ChainOptions = {}): Promise<OpenedChain> {
  if (!(options.borsh ?? borshRequested())) {
    const { client, health } = await NodeClient.open(options);
    return { client, health, transport: "json" };
  }

  guardAgainstSilentDisconnect();

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
  /* Deliberately NOT options.url. See `namedBorshEndpoint`: the callers have
     already merged --rpc with WARDA_RPC_JSON by the time it arrives here, and
     one of those two is a JSON listener that cannot answer borsh. */
  const client = await mod.BorshReader.open({
    networkId,
    url: namedBorshEndpoint(),
  });

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
