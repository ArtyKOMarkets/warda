/**
 * One seam for reaching the chain, over either encoding it speaks.
 *
 * Every tool that reads or spends used to call `NodeClient.open` directly,
 * which meant every one of them required a kaspad started with
 * `--rpclisten-json=`. That requirement was the single largest thing between
 * somebody and their first Warda payment, and it was never a protocol
 * requirement — kaspad's wRPC speaks two encodings, borsh is the default, and
 * borsh is the only one the sixteen public resolvers serve.
 *
 * ## Why this is in `src` and not in `tools`
 *
 * It began in `sdk/tools/chain.ts`, where the CLI could reach it and nothing
 * else could. A library that wants to hold a grant — an agent, an extension,
 * anything embedded — then had two options: import from another package's
 * tools directory, or write its own. The second is how this repo has lost the
 * most time, five separate occasions of one thing extracted and then copied,
 * so the answer is to move the reusable half here and leave behind only what
 * genuinely belongs to a command line.
 *
 * What stayed in `tools`, and why, is the useful part of this boundary:
 *
 *   reading argv          a library has no argv, and guessing at one is how
 *                         `--borsh` came to inherit `WARDA_RPC_JSON`
 *   the process-level
 *   unhandled-rejection
 *   guard                 a CLI owns its process; a library is a guest in
 *                         somebody else's
 *
 * Both of those are decisions about a program. Everything below is a decision
 * about a chain.
 *
 * ## `borsh` is a choice, not a fallback
 *
 * Reaching for a stranger's node because yours is not configured would make
 * the most consequential decision here the one nobody made. A resolver does
 * not remove the question of whose node you believe; it answers it on your
 * behalf. So the caller asks for borsh explicitly.
 *
 * What makes that acceptable is that the four health checks run either way. On
 * your own node "synced, indexed, right network, understands covenants" are
 * assumptions worth making; on a resolver-chosen stranger they are questions,
 * and three of the four ways it can be wrong produce a plausible answer rather
 * than an error. `inspect` asks them of a `BorshReader` exactly as it asks
 * them of a `NodeClient`, which is why the reader implements `Inspectable`.
 */
import { fileURLToPath } from "node:url";
import { sep } from "node:path";
import { env } from "./env.ts";
import {
  NodeClient,
  formatHealth,
  inspect,
  type Inspectable,
  type NodeHealth,
  type OpenOptions,
} from "./node.ts";

/**
 * What a caller needs from a chain connection.
 *
 * Narrow on purpose: it is what makes a `NodeClient` and a `BorshReader`
 * interchangeable here. Widening it would quietly re-couple everything to the
 * JSON transport, which is how that requirement reached every tool the first
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
  /* An ordinary version-0 payment, a different call because it takes a
     different type — see `v0.ts`. Only the relay half of an x402 `exact`
     purchase uses it, and both clients have it. */
  | "submitOrdinaryPayment"
> & { readonly url: string };

export interface ChainOptions extends OpenOptions {
  /** Reach the chain over borsh, through a public resolver. */
  borsh?: boolean;
  /**
   * A borsh endpoint the caller NAMED — and deliberately separate from `url`.
   *
   * `url` arrives having already been merged with `WARDA_RPC_JSON` by most
   * callers, and that variable holds a JSON listener by name and by
   * definition. Merged, the two cannot be told apart, so a machine with it
   * exported ran borsh against its own JSON port. Borsh to a JSON listener
   * connects and is then dropped, which surfaces as `WebSocket disconnected`
   * from a wasm background task and reads like the public resolvers being
   * flaky. JSON and borsh are different ports on a kaspad, not different
   * spellings.
   */
  borshUrl?: string;
}

/**
 * `@warda_protocol/borsh`, described rather than imported.
 *
 * `typeof import("@warda_protocol/borsh")` is the obvious spelling and it
 * breaks the build — but only on the SECOND run, which is the interesting
 * part. That package's own types reference this one, which resolves through
 * the workspace symlink to `sdk/dist`, so the compiler pulls this package's
 * OUTPUT back in as INPUT and refuses to overwrite it. A clean tree builds
 * fine; a rebuild does not.
 *
 * Describing the two calls used here keeps borsh genuinely optional — a
 * nominal type dependency on a package listed as an optional peer is a
 * contradiction — and it is what `@warda_protocol/vendor` already does with
 * the same module for the same reason.
 */
interface BorshModule {
  BorshReader: {
    open(options: { networkId: string; url?: string }): Promise<
      Chain & Inspectable & { readonly canSubmit: boolean; close(): Promise<void> }
    >;
  };
}

export interface OpenedChain {
  client: Chain;
  health: NodeHealth;
  transport: "json" | "borsh";
}

/**
 * Would `npm install <pkg>` — without `-g` — put a package where THIS module can
 * see it?
 *
 * Exported because it decides a sentence a newcomer reads at the one moment they
 * are most likely to give up, and a decision that shapes advice deserves a test of
 * its own rather than a test of the paragraph it ends up in.
 *
 * It is one question: is this module inside the directory the user is standing in?
 * Node resolves a bare specifier by walking up from the importing module, so a
 * package installed into the cwd's `node_modules` is reachable from a module under
 * the cwd and from nowhere else.
 *
 * The first version matched the path against `/lib/node_modules/`, which is what a
 * global install looks like — and also what `~/proj/node_modules/@warda_protocol/kaspa`
 * looks like, a LOCAL dependency that would then be told to use `-g`. The same
 * error mirrored. A pattern that describes the usual shape of an answer is not the
 * question.
 *
 * The separator matters: a raw `startsWith` makes `/tmp/warda-abc` a child of
 * `/tmp/warda-a`.
 */
export function insideCwd(moduleUrl: string, cwd: string): boolean {
  let self: string;
  try {
    self = fileURLToPath(moduleUrl);
  } catch {
    /* Not a file URL at all — bundled into something served, or a data: URL. No
       claim either way, and the safer default is the advice that works from a
       project directory. */
    return true;
  }
  if (self === cwd) return true;
  return self.startsWith(cwd.endsWith(sep) ? cwd : cwd + sep);
}

export async function openChain(options: ChainOptions = {}): Promise<OpenedChain> {
  if (!options.borsh) {
    const { client, health } = await NodeClient.open(options);
    return { client, health, transport: "json" };
  }

  let mod: BorshModule;
  try {
    mod = (await import("@warda_protocol/borsh")) as unknown as BorshModule;
  } catch {
    /**
     * `-g` when this is running from a global install, and it usually is.
     *
     * The message said `npm install @warda_protocol/borsh @kluster/kaspa-wasm`
     * unconditionally. A newcomer follows /start, which says
     * `npm install -g @warda_protocol/cli`, runs `warda node --borsh` because the
     * CLI's own help says to run it first, gets this, runs exactly what it says in
     * their project directory — and gets the identical message again, because a
     * global bin does not resolve a local node_modules. Following the instruction
     * literally leaves you where you started, which is the worst kind of error
     * text: it is correct advice given to the wrong layout, and there is nothing in
     * it to suggest that is what happened.
     *
     * Detected from this module's own path rather than from an env var, because
     * that is the thing that decides the answer. Found by installing the published
     * CLI in a clean container and walking /start as a stranger would.
     */
    const global = !insideCwd(import.meta.url, process.cwd());
    const g = global ? "-g " : "";
    throw new Error(
      "borsh needs the transport package and a WASM build that can express a covenant.\n\n" +
        `  npm install ${g}@warda_protocol/borsh @kluster/kaspa-wasm\n\n` +
        (global
          ? "The -g matters: warda is running from a global install, so a package put in a\n" +
            "project's node_modules is invisible to it. Without it this message repeats\n" +
            "unchanged after you have done exactly what it asked.\n\n"
          : "") +
        "Both are optional: a node of your own makes them unnecessary.",
    );
  }

  const networkId = options.networkId ?? env("WARDA_NETWORK") ?? "testnet-10";
  const client = await mod.BorshReader.open({ networkId, url: options.borshUrl });

  /* Checked before anything is signed, because a build that cannot carry a
     covenant fails in the one direction that produces a TRANSACTION rather
     than an error. `canSubmit` is answered by CONSTRUCTING a binding, not by
     reading a version, so it starts saying yes the day upstream ships one
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
        `It was chosen by a resolver rather than by you, which is the trade borsh makes ` +
        `— so these checks are the part that is not optional. Every one of them fails by ` +
        `returning a plausible answer rather than an error.`,
    );
  }
  return { client, health, transport: "borsh" };
}
