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

// ---- the client ----------------------------------------------------------

export class NodeClient {
  private readonly rpc: RpcConnection;
  private constructor(rpc: RpcConnection) {
    this.rpc = rpc;
  }

  static async connect(options: RpcOptions = {}): Promise<NodeClient> {
    return new NodeClient(await RpcConnection.connect(options));
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
          `to its successor address, not that it is gone.`,
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
