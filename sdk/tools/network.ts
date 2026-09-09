/**
 * Which network is this, and did you mean it?
 *
 * Every tool here defaults to testnet-10, which is correct today and becomes
 * dangerous the moment mainnet is real. Two failures this guards, both of
 * which are silent:
 *
 * ## A prefix and a network that disagree
 *
 * `--prefix kaspatest --network mainnet` is not an error anywhere. It derives
 * a well-formed address that simply does not exist on the chain you are
 * talking to — and `node.ts` already describes the consequence in its own
 * words: *"every address you derive will be well-formed and absent"*. That is
 * the worst class of failure in this codebase: no exception, no refusal, just
 * money somewhere other than where you are looking. An empty address is
 * already indistinguishable from a drained, revoked or never-funded grant, so
 * a wrong-network address adds a fourth indistinguishable case.
 *
 * ## Mainnet by default rather than by decision
 *
 * The day these tools work on mainnet, the difference between testnet and real
 * money will be one flag nobody typed. So mainnet is not reachable by omission
 * here: it requires WARDA_MAINNET to be set, in words, by a person. That is
 * not security — anyone can set it — it is the difference between a mistake
 * and a decision, which is the only thing a guard at this layer can honestly
 * offer.
 *
 * ## And the key that is published on purpose
 *
 * `/attack` publishes a working agent secret so anyone can try to steal from a
 * live grant; the covenant is what stops them. On testnet that is the whole
 * point. On mainnet it is a loaded gun aimed at whoever reads the page and
 * follows the flow with real coin, and the person harmed would not be us.
 * Refused unconditionally, with no override: there is no argument for a
 * published private key holding real money.
 */
import type { NetworkPrefix } from "@warda_protocol/kaspa";

/**
 * Secrets this project has deliberately made public.
 *
 * Anything published anywhere belongs here. The demo agent's key is on
 * wardaprotocol.com/attack and in site/src/demo-grant.json, which is the point
 * of that page — a grant whose key is known and whose money is still bounded.
 */
const PUBLISHED_SECRETS = new Set([
  "9fccfb08645b4a5a49f0f461b9ae7209865c234f941e9d4679e8a18da77af2ad",
]);

const MAINNET_PREFIXES = new Set(["kaspa"]);
const MAINNET_IDS = new Set(["mainnet", "kaspa-mainnet"]);

export interface Resolved {
  prefix: NetworkPrefix;
  network: string;
  isMainnet: boolean;
}

/**
 * How this fails: a message and exit 2, not an exception.
 *
 * These are command-line tools and every other refusal in them prints a
 * sentence and exits. A thrown Error prints a stack trace with the guard's own
 * file and line at the top, which buries the one paragraph the operator needs
 * under the internals of the thing telling them. The message IS the product
 * here — a guard nobody reads is a guard that only annoys.
 */
function refuse(message: string): never {
  console.error(message);
  process.exit(2);
}

/**
 * Resolve and check the network a tool is about to act on.
 *
 * Call this once, near the top, in anything that derives an address or moves
 * value. It throws rather than returning a verdict: a caller that has to
 * remember to check the answer is a caller that will forget in exactly one
 * tool, and that tool is the one somebody runs at midnight.
 */
export function resolveNetwork(opts: {
  prefix?: string;
  network?: string;
  /** The secret about to be used, if this tool has one. Hex, no whitespace. */
  secret?: string;
  /** What the tool is about to do, for the message. e.g. "create a grant". */
  action?: string;
}): Resolved {
  const prefix = (opts.prefix ?? "kaspatest") as NetworkPrefix;
  const network = opts.network ?? process.env.WARDA_NETWORK ?? "testnet-10";
  const action = opts.action ?? "act";

  const prefixIsMain = MAINNET_PREFIXES.has(prefix);
  const networkIsMain = MAINNET_IDS.has(network);

  /* Disagreement first, because it is the failure that produces no error at
     all. Checked before the mainnet gate so that `--prefix kaspa --network
     testnet-10` is reported as the contradiction it is, rather than as a
     mainnet attempt the operator did not make. */
  if (prefixIsMain !== networkIsMain) {
    refuse(
      `the address prefix and the network disagree: "${prefix}" and "${network}".\n` +
        `  Nothing would fail. You would derive a well-formed address on the wrong chain,\n` +
        `  and it would hold nothing — which looks exactly like a grant that was drained,\n` +
        `  revoked, or never funded. Set both, or neither.`,
    );
  }

  if (opts.secret) assertKeyNotPublished(opts.secret, prefixIsMain);

  if (prefixIsMain && !process.env.WARDA_MAINNET) {
    refuse(
      `refusing to ${action} on MAINNET without being told to.\n\n` +
        `  Every tool here defaults to testnet, so the difference between free coins and\n` +
        `  real money is one flag — and a flag nobody typed is not a decision. Warda has\n` +
        `  not been audited, and the limits it enforces have only ever been tested with\n` +
        `  coins that are worth nothing.\n\n` +
        `  If you mean it:  export WARDA_MAINNET=1\n`,
    );
  }

  return { prefix, network, isMainnet: prefixIsMain };
}

/**
 * A key this project published on purpose must never hold real money.
 *
 * Separate from `resolveNetwork` because several tools read their secret after
 * resolving the network — through a helper that reports a missing key file
 * usefully — and reordering those declarations to satisfy a guard would be the
 * guard bending the program around itself.
 *
 * No override. There is no argument for a published private key on mainnet,
 * and the person harmed would be whoever read the page and followed along.
 */
export function assertKeyNotPublished(secret: string, isMainnet: boolean): void {
  if (!PUBLISHED_SECRETS.has(secret.trim().toLowerCase())) return;
  if (isMainnet) {
    refuse(
      `that key is PUBLISHED. It is on wardaprotocol.com/attack so that anyone can try\n` +
        `  to spend from a grant it controls, and the covenant is what stops them. On a\n` +
        `  testnet that is a demonstration. With real money it is a gift to whoever reads\n` +
        `  the page next, and the person who loses it would not be you.\n` +
        `  There is no flag for this.`,
    );
  }
  console.error(
    `note: this is the PUBLISHED demo key. Anyone can sign with it — that is deliberate,\n` +
      `      and only the covenant is keeping the money where it is.\n`,
  );
}

/**
 * The node to talk to: the flag, then the environment.
 *
 * Twelve of these tools demanded `--rpc` and eight fell back to
 * WARDA_RPC_JSON, which made `ops/node.env` — a file whose own header says
 * "source this before running anything that talks to the node" — false for
 * most of them. Nobody noticed because the tools people run by hand were in
 * the half that worked, and the ones in scripts were given the flag.
 *
 * It surfaced when ops/exercise-fees.sh sourced node.env, called quickstart,
 * and was told there was no node while a node was configured and running.
 *
 * One helper rather than sixteen copies of the same `??`, for the reason
 * members.ts gives in its own header: the copy that drifts is the one nobody
 * is looking at.
 */
export const rpcFrom = (flagValue?: string): string | undefined =>
  flagValue ?? process.env.WARDA_RPC_JSON;
