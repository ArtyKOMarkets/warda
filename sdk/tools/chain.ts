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

import { openChain as openChainCore, type ChainOptions, type OpenedChain } from "@warda_protocol/kaspa";

export type { Chain, ChainOptions, OpenedChain } from "@warda_protocol/kaspa";

/**
 * The reusable half now lives in `@warda_protocol/kaspa`.
 *
 * What remains here is everything that is a decision about a PROGRAM rather
 * than about a chain: reading argv, and installing a process-level handler. A
 * library has no argv and does not own the process it runs in, and both of
 * those facts have already cost this repo a defect — see the two comments
 * below, which are the reasons rather than the rules.
 */

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
 * Once merged they could not be told apart — so a machine with WARDA_RPC_JSON
 * exported in its shell ran `--borsh` against its own JSON port. Borsh to a
 * JSON listener connects and is dropped, which surfaced as `WebSocket
 * disconnected` out of a wasm background task, and looked for two days like
 * the public resolvers being flaky. It was a local node refusing an encoding
 * it does not speak.
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
 * The WASM client reports a lost connection OUT OF BAND, and Node kills the
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
 * handler is the only place it can be caught, and a CLI owns its process where
 * a library does not — which is precisely why this did NOT move to `src` with
 * the rest of this file.
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

/**
 * The tools' entry point: argv answers the two questions the library will not
 * guess at, and the process guard goes in before anything can drop a socket.
 */
export async function openChain(options: ChainOptions = {}): Promise<OpenedChain> {
  const borsh = options.borsh ?? borshRequested();
  if (!borsh) return openChainCore(options);
  guardAgainstSilentDisconnect();
  return openChainCore({ ...options, borsh: true, borshUrl: options.borshUrl ?? namedBorshEndpoint() });
}
