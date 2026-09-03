/**
 * One reading of the Kaspa network, taken at one moment, from one node.
 *
 * ## Why a reading and not a report
 *
 * Nothing here computes anything. A reading is what a node said, when it said
 * it, and — just as important — what it would not say. The arithmetic lives in
 * `digest.ts` and takes two readings, because every number worth publishing in
 * a daily digest is a DIFFERENCE between two moments, and a difference cannot
 * be recovered from a single snapshot however rich that snapshot is.
 *
 * This split is the whole reason the agent needs no indexer, no archive node
 * and no history: it does not ask the chain what happened yesterday. It asks
 * the chain where it is now, writes that down, and yesterday's answer is the
 * file it wrote yesterday.
 *
 * ## Why so much of it is optional
 *
 * Four of these fields come from RPC methods this repo had never called before
 * the agent needed them. A method a node does not implement, or implements
 * with a field spelled differently than expected, must not take down an
 * unattended agent — and it must not silently become a zero, which is worse,
 * because a zero renders as a real measurement.
 *
 * So the required set is exactly what `NodeClient` already wraps and this repo
 * has run against a live node for months. Everything else is attempted, and
 * when it fails the reason is recorded in `missing` and the digest omits that
 * line. A digest with four lines and a footnote is a true digest. A digest with
 * five lines where the fifth is a zero is a lie.
 */
import { NodeClient, type NodeHealth } from "../../sdk/src/node.ts";
import { toBigInt } from "../../sdk/src/rpc.ts";

/** A method that did not answer, and what it said instead. */
export interface Missing {
  method: string;
  why: string;
}

export interface ChainReading {
  /** The agent's clock, ISO-8601 UTC. Cross-checked against the chain in `digest.ts`. */
  at: string;
  /** Which network. Two readings from different networks are not comparable. */
  network: string;
  /** Which node answered, and what it is running. */
  node: { url: string; serverVersion: string; synced: boolean };

  // ---- always present: wrapped by NodeClient, exercised for months ----

  /** Monotonic. The chain's own clock. */
  daaScore: bigint;
  /** The selected-chain tip at the moment of reading. */
  sink: string;
  /** How many tips the virtual had. A DAG breathes; this is the breath. */
  tips: number;
  /** Transactions the node was holding, unaccepted, at the moment of reading. */
  mempoolSize: bigint;
  /** Blocks in the node's DAG. NOT monotonic — pruning removes them. */
  blockCount: bigint;

  // ---- attempted: absent rather than wrong ----

  /** Blue blocks in the sink's past. Monotonic. Excludes reds by definition. */
  blueScore?: bigint;
  /** Sompi in existence. Monotonic, and its delta is the network's emission. */
  circulatingSompi?: bigint;
  /** The cap, for context. Constant, but read rather than hardcoded. */
  maxSompi?: bigint;
  /** The node's own estimate over its own window. Not a measurement. */
  hashesPerSecond?: bigint;

  /** What could not be read. Empty is the happy path; non-empty is still valid. */
  missing: Missing[];
}

/**
 * Attempt a call this repo has not proven against a live node.
 *
 * The parse runs inside the try on purpose: a method that answers with a field
 * spelled differently fails here, in the same place and with the same handling
 * as a method that does not exist. Both mean "this node will not tell me", and
 * distinguishing them would only produce two ways to write the same footnote.
 */
async function attempt<T>(
  missing: Missing[],
  client: NodeClient,
  method: string,
  params: unknown,
  parse: (reply: Record<string, unknown>) => T,
): Promise<T | undefined> {
  let reply: Record<string, unknown> | undefined;
  try {
    reply = (await client.connection.call(method, params)) as Record<string, unknown>;
    return parse(reply);
  } catch (e) {
    const why = e instanceof Error ? e.message.split("\n")[0]! : String(e);
    missing.push({
      method,
      /**
       * When the node ANSWERED and the parse is what failed, the reply's own
       * field names go in the footnote.
       *
       * These three methods are the only ones in this repository that were
       * written against protocol documentation rather than against a live
       * node's replies. If kaspad spells one of them differently than expected,
       * the failure is a one-character fix — but only if the error says what
       * the node actually sent, rather than "expected a number, got undefined"
       * and leaving somebody to go and look.
       */
      why: reply ? `${why} — the node replied with: ${Object.keys(reply).join(", ") || "{}"}` : why,
    });
    return undefined;
  }
}

/**
 * Read the network once.
 *
 * `health` is required rather than re-derived because `NodeClient.open` has
 * already asked whether this node is worth believing, and a reading taken from
 * a node that failed those checks should carry the node's identity so the
 * question can be asked again later of the file rather than of memory.
 */
export async function readChain(client: NodeClient, health: NodeHealth): Promise<ChainReading> {
  const at = new Date().toISOString();
  const [info, dag] = await Promise.all([client.getInfo(), client.getBlockDagInfo()]);

  const missing: Missing[] = [];

  const supply = await attempt(missing, client, "getCoinSupply", {}, (r) => ({
    circulating: toBigInt(r.circulatingSompi, "circulatingSompi"),
    max: toBigInt(r.maxSompi, "maxSompi"),
  }));

  const blueScore = await attempt(missing, client, "getSinkBlueScore", {}, (r) =>
    toBigInt(r.blueScore, "blueScore"),
  );

  // windowSize 1000 is the node's own default in every kaspad this was written
  // against; naming it makes the digest able to say what window the estimate
  // covers instead of presenting a number with no provenance.
  const hashesPerSecond = await attempt(
    missing,
    client,
    "estimateNetworkHashesPerSecond",
    { windowSize: 1000 },
    (r) => toBigInt(r.networkHashesPerSecond, "networkHashesPerSecond"),
  );

  return {
    at,
    network: dag.network,
    node: { url: health.url, serverVersion: info.serverVersion, synced: info.isSynced },
    daaScore: dag.virtualDaaScore,
    sink: dag.sink,
    tips: dag.tipHashes.length,
    mempoolSize: info.mempoolSize,
    blockCount: dag.blockCount,
    blueScore,
    circulatingSompi: supply?.circulating,
    maxSompi: supply?.max,
    hashesPerSecond,
    missing,
  };
}

// ---- storage -------------------------------------------------------------
//
// Readings are written as JSON with every bigint QUOTED, which is the opposite
// of what `rpc.stringify` does and deliberately so. That one emits raw digits
// because a Rust node deserializing a u64 wants a JSON number. This one is
// read back by JSON.parse — in a browser, in jq, in a later run of this agent —
// and a raw 4821003112000000 silently loses its low digits the moment anything
// with IEEE doubles touches it. A quoted string cannot be misread by accident.

const BIGINT_FIELDS = [
  "daaScore",
  "mempoolSize",
  "blockCount",
  "blueScore",
  "circulatingSompi",
  "maxSompi",
  "hashesPerSecond",
] as const;

export function encodeReading(reading: ChainReading): string {
  return (
    JSON.stringify(reading, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n"
  );
}

export function decodeReading(text: string): ChainReading {
  const raw = JSON.parse(text) as Record<string, unknown>;
  for (const field of BIGINT_FIELDS) {
    const v = raw[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string" && typeof v !== "number") {
      throw new Error(`${field}: expected a decimal string, got ${typeof v}`);
    }
    raw[field] = BigInt(v);
  }
  if (typeof raw.at !== "string" || !raw.network || !raw.missing) {
    throw new Error("not a chain reading: missing at/network/missing");
  }
  return raw as unknown as ChainReading;
}
