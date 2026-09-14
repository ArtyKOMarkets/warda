/**
 * The Warda verification API, reachable at a URL.
 *
 * The point of hosting this is the one thing running it yourself cannot give
 * you: a counterparty checking a grant should not have to take the terms from
 * the party being verified, and "clone this repo first" is a request most of
 * them will not grant. Until it runs somewhere, the service is honest and
 * useless to a stranger.
 *
 * ## Why this is its own directory
 *
 * Same reason as `mcp/deploy`: a directory holding both a library and a
 * function is ambiguous, and Vercel guessed the library's entrypoint there and
 * deployed something that exported no handler. This directory holds nothing
 * but the function.
 *
 * It depends on the PUBLISHED `@warda_protocol/verify` rather than on the
 * working tree, which costs something real — it cannot serve unreleased code —
 * and buys something worth more: it exercises the package the way an
 * installing user does. That is the exact path that hid a covenant-template
 * bug for a whole release.
 *
 * ## Why there is no node here
 *
 * There used to have to be one. `verify` now falls through to borsh, which is
 * what the sixteen public resolvers actually serve, so this function reads a
 * node nobody here runs. Measured cold — wasm init, all sixteen resolvers
 * asked at once, four health checks — that path is well under a second on a
 * laptop, which is what made a function the right shape rather than a box.
 *
 * `@kluster/kaspa-wasm` is a dependency and NOT `kaspa-wasm32-sdk`, and the
 * difference is load-bearing. A vendor is paid at an ordinary P2PK address and
 * never reads a covenant field, so the pre-covenant build is correct for
 * `x402/demo-server`. This service reports a grant's TERMS: borsh is
 * positional, a field the deserializer does not know is absent rather than
 * unknown, and read through a covenant-blind build every grant on chain comes
 * back looking unbound — which is indistinguishable from the one real finding
 * this exists to report. `verify` refuses to serve from such a build. Swapping
 * this dependency does not degrade the service; it stops it.
 *
 * ## The source is module-scoped on purpose
 *
 * A warm container reuses it, so the connection and its 30-second health
 * recheck survive between invocations and only a cold start pays for
 * discovery. A cold start that pays it is still the measured sub-second path.
 * Nothing here is per-caller: two requests about the same grant must not be
 * able to get different answers because they landed on different nodes.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { NodeSource, handler } from "@warda_protocol/verify";

/**
 * Imported for the bundler, not for this file. Do not remove.
 *
 * `@warda_protocol/borsh` finds its WASM build with `await import(name)` over
 * a candidates array, which is what lets it feature-detect covenant support
 * instead of reading a version number, and what will let it adopt an upstream
 * covenant-carrying `kaspa-wasm32-sdk` with no code change. A file tracer
 * cannot follow a dynamic import whose specifier is a variable — so Vercel
 * concluded nothing needed these packages and shipped a function without
 * them.
 *
 * The first deployment failed exactly that way: both candidates installed at
 * build time, both "not installed" at runtime, reported from inside the
 * lambda by the loader's own message. A static reference is what puts them in
 * the bundle; `loadWasm` then resolves them from it, cached.
 *
 * `vercel.json` ALSO lists them under `includeFiles`, deliberately twice: this
 * import is a claim about how a bundler behaves, and the glob is not.
 */
import * as kluster from "@kluster/kaspa-wasm";

/**
 * Testnet by default, and not because of a missing configuration.
 *
 * Warda has run on testnet-10 only and is unaudited, and an unset network is
 * not a neutral state here: `inspect` treats "nothing was asked" as nothing to
 * check, so a silently mainnet-pointed verifier would pass its own health
 * check and answer confidently about the wrong chain.
 */
const source = new NodeSource({
  networkId: process.env.WARDA_NETWORK ?? "testnet-10",
  ...(process.env.WARDA_RPC_JSON ? { url: process.env.WARDA_RPC_JSON } : {}),
});

const serve = handler(source);

/* Referenced so the import above cannot be elided as unused. */
export const wasmBuild = typeof kluster === "object" ? "@kluster/kaspa-wasm" : "none";

export default function (req: IncomingMessage, res: ServerResponse): Promise<void> {
  return serve(req, res);
}
