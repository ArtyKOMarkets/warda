/**
 * A typed client for the four node calls a grant actually needs.
 *
 * This is the piece that makes verification independent. Everything else in
 * this package can be checked against `golden-spend.json` — a recorded
 * reference — but a golden vector only proves two implementations agree. To
 * find out whether a grant on chain says what its manifest claims, something
 * has to read the UTXO set, and until now that meant a Rust toolchain.
 *
 * Four calls, no more: readiness, the DAA score, the grant's UTXO, and
 * broadcast. Subscriptions, mempool inspection and block queries are all
 * reachable through `RpcConnection.call` for anyone who wants them; they are
 * not wrapped here because an unused wrapper is an untested wrapper.
 *
 * ## The covenant field
 *
 * A covenant-aware node reports `covenantId` on a UTXO entry. A node built
 * before covenants omits the field entirely — and `undefined` is exactly what
 * a covenant-free P2PK UTXO reports too, so the two are indistinguishable one
 * entry at a time. That ambiguity is dangerous in one direction only: a spend
 * built from an entry whose covenant id was silently dropped carries no
 * binding, is well-formed, and is refused by the network for reasons that read
 * as a covenant bug. `assertCovenantAware` resolves it by asking a grant
 * address, where the field must be present.
 */

import { fromHex, toHex } from "./bytes.ts";
import { RpcConnection, toBigInt, type RpcOptions } from "./rpc.ts";
import { resolveNode, resolverFrom, type ResolveOptions } from "./resolver.ts";
import type { ScriptPublicKey, Transaction, TransactionOutpoint, UtxoEntry } from "./tx.ts";

// ---- script public keys --------------------------------------------------

/**
 * On the wire a script public key is a SINGLE HEX STRING, not an object: two
 * bytes of version, BIG-endian, then the script. Everything else in Kaspa's
 * serialization is little-endian, which makes this the one place a careful
 * reader gets it backwards.
 *
 * The node's deserializer also accepts `{version, script}`, so sending the
 * object form works and receiving it never happens. Encode the string.
 */
export function scriptPublicKeyToWire(spk: ScriptPublicKey): string {
  if (spk.version < 0 || spk.version > 0xffff) {
    throw new Error(`script public key version out of range: ${spk.version}`);
  }
  const be = spk.version.toString(16).padStart(4, "0");
  return be + toHex(spk.script);
}

export function scriptPublicKeyFromWire(value: unknown): ScriptPublicKey {
  if (typeof value === "object" && value !== null && "script" in value) {
    // The object form, in case a proxy re-encoded it on the way through.
    const o = value as { version?: number; script?: string };
    return { version: o.version ?? 0, script: fromHex(o.script ?? "") };
  }
  if (typeof value !== "string") {
    throw new Error(`script public key: expected a hex string, got ${typeof value}`);
  }
  if (value.length < 4) throw new Error(`script public key too short: "${value}"`);
  return {
    version: Number.parseInt(value.slice(0, 4), 16),
    script: fromHex(value.slice(4)),
  };
}

// ---- transactions --------------------------------------------------------

/**
 * A transaction in the shape `submitTransaction` wants.
 *
 * Two fields here are not optional in the way they look:
 *
 *   `mass` — the node's deserializer requires `storageMass` OR `mass` to be
 *   present and errors with "Either storageMass or mass must be provided" when
 *   both are absent. It is zero for everything this package builds; omitting
 *   it fails the request before the transaction is ever looked at.
 *
 *   `sigOpCount` — must be ZERO on a version-1 transaction, where the compute
 *   budget replaces it. A nonzero value is rejected outright with
 *   "RpcTransactionInput.sig_op_count is inconsistent with transaction
 *   version 1". Version 0 is the mirror image: the budget must be zero there.
 */
export function transactionToWire(tx: Transaction): Record<string, unknown> {
  const v1 = tx.version >= 1;
  return {
    version: tx.version,
    inputs: tx.inputs.map((i) => ({
      previousOutpoint: {
        transactionId: toHex(i.previousOutpoint.transactionId),
        index: i.previousOutpoint.index,
      },
      signatureScript: toHex(i.signatureScript),
      sequence: i.sequence,
      // Exactly one of these carries a value; the other must be 0.
      sigOpCount: 0,
      computeBudget: v1 ? i.computeBudget : 0,
    })),
    outputs: tx.outputs.map((o) => ({
      value: o.value,
      scriptPublicKey: scriptPublicKeyToWire(o.scriptPublicKey),
      covenant: o.covenant
        ? {
            authorizingInput: o.covenant.authorizingInput,
            covenantId: toHex(o.covenant.covenantId),
          }
        : null,
    })),
    lockTime: tx.lockTime,
    subnetworkId: toHex(tx.subnetworkId),
    gas: tx.gas,
    payload: toHex(tx.payload),
    mass: 0,
  };
}

// ---- results -------------------------------------------------------------

export interface NodeInfo {
  serverVersion: string;
  isSynced: boolean;
  isUtxoIndexed: boolean;
  mempoolSize: bigint;
  p2pId: string;
}

export interface DagInfo {
  network: string;
  virtualDaaScore: bigint;
  blockCount: bigint;
  sink: string;
  pruningPointHash: string;
  tipHashes: string[];
}

export interface AddressUtxo {
  address: string | null;
  outpoint: TransactionOutpoint;
  entry: UtxoEntry;
}

// ---- parsing ------------------------------------------------------------
//
// These take a reply's `params` and nothing else, so a recorded capture can be
// replayed through exactly the code a live connection uses. The client methods
// below are then only transport: call, parse, return. A fixture test that
// exercised a paraphrase of this logic would prove nothing.

export function parseInfo(r: Record<string, unknown>): NodeInfo {
  return {
    serverVersion: String(r.serverVersion ?? ""),
    isSynced: Boolean(r.isSynced),
    isUtxoIndexed: Boolean(r.isUtxoIndexed),
    mempoolSize: toBigInt(r.mempoolSize ?? 0, "mempoolSize"),
    p2pId: String(r.p2pId ?? ""),
  };
}

export function parseDagInfo(r: Record<string, unknown>): DagInfo {
  return {
    network: String(r.network ?? ""),
    virtualDaaScore: toBigInt(r.virtualDaaScore ?? 0, "virtualDaaScore"),
    blockCount: toBigInt(r.blockCount ?? 0, "blockCount"),
    sink: String(r.sink ?? ""),
    pruningPointHash: String(r.pruningPointHash ?? ""),
    tipHashes: (r.tipHashes as string[] | undefined) ?? [],
  };
}

export function parseUtxos(r: { entries?: unknown[] }): AddressUtxo[] {
  return (r.entries ?? []).map((raw, i) => {
    const e = raw as Record<string, any>;
    const outpoint = e.outpoint ?? {};
    const entry = e.utxoEntry ?? {};
    return {
      address: e.address ?? null,
      outpoint: {
        transactionId: fromHex(String(outpoint.transactionId ?? "")),
        index: Number(outpoint.index ?? 0),
      },
      entry: {
        value: toBigInt(entry.amount, `entry[${i}].amount`),
        scriptPublicKey: scriptPublicKeyFromWire(entry.scriptPublicKey),
        blockDaaScore: toBigInt(entry.blockDaaScore, `entry[${i}].blockDaaScore`),
        isCoinbase: Boolean(entry.isCoinbase),
        // Absent and null mean the same thing here: no covenant, OR a node
        // that cannot report one. `assertCovenantAware` tells them apart.
        covenantId:
          entry.covenantId === undefined || entry.covenantId === null
            ? undefined
            : fromHex(String(entry.covenantId)),
      },
    };
  });
}

// ---- is this node worth believing? ---------------------------------------

export interface NodeCheck {
  ok: boolean;
  detail: string;
}

export interface NodeHealth {
  url: string;
  serverVersion: string;
  network: string;
  virtualDaaScore: bigint;
  checks: Record<"synced" | "utxoIndexed" | "network" | "covenants", NodeCheck>;
  /** True when nothing that could silently produce a wrong answer is wrong. */
  usable: boolean;
}

export interface OpenOptions extends RpcOptions, ResolveOptions {
  /**
   * A grant address to probe covenant-awareness with. Strongly recommended:
   * it is the only one of these checks that cannot be made without one, and
   * the only failure that produces a transaction rather than an error.
   */
  grantAddress?: string;
  /** Return the report instead of throwing. Default false. */
  tolerate?: boolean;
}

/**
 * A node lying by omission is worse than a node that is down.
 *
 * Every check here exists because failing it produces a plausible WRONG ANSWER
 * rather than an error, and the wrong answer always reads as a bug in the
 * grant:
 *
 *   not utxo-indexed  `getUtxosByAddresses` returns an empty list, which is
 *                     indistinguishable from a grant that has been spent. The
 *                     tools would report the grant gone and be believed.
 *   wrong network     addresses derive perfectly and nothing is ever found.
 *                     Pointing a testnet manifest at a mainnet node looks
 *                     exactly like a lost grant.
 *   not synced        the DAA score is stale, so a spend claims an epoch the
 *                     chain has moved past and is refused for reasons that
 *                     point at the covenant's epoch logic.
 *   pre-covenant      `covenantId` is dropped from the UTXO entry, and the
 *                     spend built from it carries no binding at all.
 *
 * On your own node these are assumptions worth making. On somebody else's they
 * are questions worth asking, and asking costs two round trips.
 */
export async function inspect(client: NodeClient, options: OpenOptions = {}): Promise<NodeHealth> {
  const info = await client.getInfo();
  const dag = await client.getBlockDagInfo();
  const wanted = options.networkId ?? process.env.WARDA_NETWORK ?? null;

  const checks: NodeHealth["checks"] = {
    synced: {
      ok: info.isSynced,
      detail: info.isSynced
        ? "synced"
        : "NOT SYNCED — its DAA score is behind, so any epoch a spend claims from it may already be stale",
    },
    utxoIndexed: {
      ok: info.isUtxoIndexed,
      detail: info.isUtxoIndexed
        ? "utxo index present"
        : "NO UTXO INDEX — it answers address queries with an empty list rather than an error, which reads as 'your grant is gone'",
    },
    network: {
      // A null expectation is not a pass and not a failure: nobody said.
      ok: wanted === null || dag.network === wanted || dag.network.endsWith(wanted),
      detail:
        wanted === null
          ? `on ${dag.network} (nothing was asked, so nothing was checked)`
          : dag.network === wanted || dag.network.endsWith(wanted)
            ? `on ${dag.network}`
            : `on ${dag.network}, but ${wanted} was asked for — every address you derive will be well-formed and absent`,
    },
    covenants: { ok: false, detail: "" },
  };

  if (options.grantAddress) {
    try {
      await client.assertCovenantAware(options.grantAddress);
      checks.covenants = { ok: true, detail: "reports covenant ids" };
    } catch (e) {
      checks.covenants = { ok: false, detail: (e as Error).message.split("\n")[0]! };
    }
  } else {
    checks.covenants = {
      ok: true,
      detail:
        "UNCHECKED — pass grantAddress. A node that drops covenant ids produces an " +
        "unbound spend: well-formed, signed, and refused by everything that knows better",
    };
  }

  const usable = Object.values(checks).every((c) => c.ok);
  return {
    url: client.connection.url,
    serverVersion: info.serverVersion,
    network: dag.network,
    virtualDaaScore: dag.virtualDaaScore,
    checks,
    usable,
  };
}

export function formatHealth(h: NodeHealth): string {
  const lines = [`node ${h.url}`, `  version      : ${h.serverVersion}`, `  daa score    : ${h.virtualDaaScore}`];
  for (const [name, c] of Object.entries(h.checks)) {
    lines.push(`  ${(c.ok ? "ok  " : "FAIL")} ${name.padEnd(12)}: ${c.detail}`);
  }
  return lines.join("\n");
}

// ---- the client ----------------------------------------------------------

export class NodeClient {
  private readonly rpc: RpcConnection;
  private constructor(rpc: RpcConnection) {
    this.rpc = rpc;
  }

  static async connect(options: RpcOptions = {}): Promise<NodeClient> {
    return new NodeClient(await RpcConnection.connect(options));
  }

  /**
   * Connect to a node — your own, a list of them, or one a resolver picks —
   * and refuse to hand back one that would answer wrongly.
   *
   * Order of preference: an explicit url, then a list, then the resolver, then
   * localhost. The resolver is consulted only when nothing more specific was
   * given, so configuring one never overrides a node you named.
   *
   * `open` throws on a node that fails a check. That is the point: the whole
   * class of bug this prevents is a tool believing an answer it should have
   * refused, and returning a client with a warning attached would just move
   * the mistake one line down. Pass `tolerate` if you want the report instead.
   */
  static async open(options: OpenOptions = {}): Promise<{ client: NodeClient; health: NodeHealth }> {
    const named = options.url || options.urls?.length || process.env.WARDA_RPC_JSON;
    let client: NodeClient;
    if (!named && resolverFrom(options)) {
      const node = await resolveNode(options);
      client = await NodeClient.connect({ ...options, url: node.url });
    } else {
      client = await NodeClient.connect(options);
    }

    let health: NodeHealth;
    try {
      health = await inspect(client, options);
    } catch (e) {
      client.close();
      throw e;
    }
    if (!health.usable && !options.tolerate) {
      client.close();
      throw new Error(
        `this node cannot be trusted with a grant:\n\n${formatHealth(health)}\n\n` +
          `Every check above fails in the same direction — it returns a plausible ` +
          `answer rather than an error — which is why it is checked here rather ` +
          `than discovered later from a spend the network refused.`,
      );
    }
    return { client, health };
  }

  /** The underlying connection, for calls this class does not wrap. */
  get connection(): RpcConnection {
    return this.rpc;
  }

  close(): void {
    this.rpc.close();
  }

  async getInfo(): Promise<NodeInfo> {
    return parseInfo((await this.rpc.call("getInfo", {})) as Record<string, unknown>);
  }

  async getBlockDagInfo(): Promise<DagInfo> {
    return parseDagInfo((await this.rpc.call("getBlockDagInfo", {})) as Record<string, unknown>);
  }

  /**
   * Requires the node to be running with `--utxoindex`; without it the call
   * fails rather than returning nothing, which is the better failure.
   */
  async getUtxosByAddresses(addresses: string[]): Promise<AddressUtxo[]> {
    return parseUtxos(
      (await this.rpc.call("getUtxosByAddresses", { addresses })) as { entries?: unknown[] },
    );
  }

  /**
   * Broadcasts. Returns the id the node assigned, which this package's
   * `transactionId` should already have predicted — a mismatch means the two
   * disagree about serialization, and is worth checking before the second
   * spend rather than after.
   */
  async submitTransaction(tx: Transaction, allowOrphan = false): Promise<string> {
    const r = (await this.rpc.call("submitTransaction", {
      transaction: transactionToWire(tx),
      allowOrphan,
    })) as { transactionId?: string };
    if (!r.transactionId) throw new Error("submitTransaction returned no transaction id");
    return r.transactionId;
  }

  /**
   * Reads a grant's single live UTXO. A grant is one coin by construction —
   * spending it produces exactly one successor — so anything else means the
   * caller is looking at the wrong address, or at a state that has already
   * moved on.
   */
  async grantUtxo(address: string): Promise<AddressUtxo> {
    const utxos = await this.getUtxosByAddresses([address]);
    if (utxos.length === 0) {
      throw new Error(
        `no UTXO at ${address}.\n` +
          `A grant's address is derived from its state, and spending changes ` +
          `that state — so an empty result usually means the grant has moved ` +
          `to its successor address, not that it is gone.\n` +
          `If the transaction that created it was submitted moments ago, this is ` +
          `a race rather than a mistake: acceptance is not instant, and the ` +
          `address is empty until it happens.`,
      );
    }
    if (utxos.length > 1) {
      throw new Error(`${utxos.length} UTXOs at ${address}; a grant holds exactly one`);
    }
    return utxos[0]!;
  }

  /**
   * Establishes that this node can see covenants at all, by asking it about an
   * address known to hold one. Call it once per connection, before building
   * anything: the alternative is discovering it from a rejected spend, where
   * the symptom points at the covenant rather than at the node.
   */
  async assertCovenantAware(grantAddress: string): Promise<void> {
    const utxo = await this.grantUtxo(grantAddress);
    if (!utxo.entry.covenantId) {
      throw new Error(
        `the UTXO at ${grantAddress} reports no covenant id.\n` +
          `Either this node predates covenants, or the field was dropped by ` +
          `something in between. Building a spend from this entry would produce ` +
          `a transaction with no binding — well-formed, and refused by every ` +
          `node that does know about covenants.`,
      );
    }
  }
}
