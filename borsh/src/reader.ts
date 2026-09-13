/**
 * Reading Kaspa over borsh, and refusing to write over it.
 *
 * kaspad's wRPC speaks two encodings. Borsh is the default and the only one
 * the sixteen public resolvers serve; JSON exists only when an operator passes
 * `--rpclisten-json=`, which almost nobody does. That is the whole reason this
 * package exists: without it, every Warda tool needs a node run by the person
 * running the tool, and "run a DAG node" is a real thing to ask of someone who
 * just wants to sell an API for a fifth of a cent.
 *
 * ## Why this reads and does not write
 *
 * The obvious move is to route everything through the official WASM client and
 * delete the JSON transport. It does not work, and it fails quietly, which is
 * worse than failing.
 *
 * Borsh is POSITIONAL. There are no field names on the wire, so a struct the
 * encoder does not know about is not an unknown field — it is an absent one,
 * and absence shifts everything after it. The WASM SDK was built before
 * covenants: its `ITransactionOutput` is `{value, scriptPublicKey}` and the
 * string "covenant" does not appear in it anywhere. Hand it a grant spend and
 * it will serialize a transaction that is well-formed, correctly signed, and
 * carries no covenant binding at all — a payment that means nothing, submitted
 * successfully.
 *
 * So `submitTransaction` is not here. It is not missing because it was hard;
 * it is missing because the only honest version of it on this transport is a
 * silent loss of the one guarantee this protocol makes. Spending stays on the
 * JSON transport until the covenant-carrying transaction type exists upstream.
 *
 * ## What that leaves, which is more than it sounds
 *
 * A seller never submits anything. `@warda_protocol/vendor` calls exactly
 * `getUtxosByAddresses` — is the coin I was promised actually in the UTXO set —
 * and `@warda_protocol/verify` adds `getBlockDagInfo` for the epoch. Both are
 * reads, and neither touches a covenant field, because the coin a vendor is
 * paid with is an ordinary P2PK output to the vendor's own address. Which
 * means: with this reader, accepting Warda payments needs no node.
 *
 * The buyer still needs JSON. That asymmetry is the honest state of things,
 * and stating it is better than a transport that auto-detects its way into
 * building an unbound spend.
 *
 * ## The parsers are shared on purpose
 *
 * `parseInfo`, `parseDagInfo` and `parseUtxos` come straight from
 * `@warda_protocol/kaspa`. They were written to take a reply and nothing else,
 * so they do not know which transport carried it, and reusing them is what
 * keeps the two paths from disagreeing about what a UTXO is. A second parser
 * here would be a second thing to get wrong.
 */

import {
  parseDagInfo,
  parseInfo,
  parseUtxos,
  type AddressUtxo,
  type DagInfo,
  type Inspectable,
  type NodeInfo,
} from "@warda_protocol/kaspa";

/**
 * The part of `kaspa-wasm32-sdk`'s RpcClient this uses.
 *
 * Structural, and deliberately small. The WASM package is a peer dependency
 * carrying a multi-megabyte binary, and a test that needed it would be a test
 * nobody runs. Everything below is exercised against a plain object.
 */
export interface WasmRpc {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  readonly url: string | undefined;
  getServerInfo(): Promise<Record<string, unknown>>;
  getBlockDagInfo(): Promise<Record<string, unknown>>;
  getUtxosByAddresses(request: { addresses: string[] }): Promise<unknown>;
}

export interface BorshOptions {
  /** An explicit borsh endpoint. Omit to let the resolver choose one. */
  url?: string;
  /** Default `testnet-10`, or `WARDA_NETWORK`. */
  networkId?: string;
  /**
   * A client to use instead of constructing one. The seam the tests use, and
   * the escape hatch for anyone who already has a configured RpcClient.
   */
  client?: WasmRpc;
}

/** Thrown for the one method this transport must not provide. */
export class WriteNotSupported extends Error {
  constructor() {
    super(
      "submitTransaction is not available over borsh.\n\n" +
        "The WASM client's transaction type predates covenants — its output is " +
        "{value, scriptPublicKey} with no covenant field — so a grant spend " +
        "serialized through it would be well-formed, signed, and carry no " +
        "binding. It would be accepted by the encoder and mean nothing.\n\n" +
        "Build and submit over JSON-wRPC: a node with --rpclisten-json=, or " +
        "WARDA_RPC_JSON. Reads can stay here.",
    );
    this.name = "WriteNotSupported";
  }
}

/**
 * Thrown when someone asks this reader whether the node reports covenant ids.
 *
 * `NodeClient.assertCovenantAware` resolves a real ambiguity: an absent
 * `covenantId` means either "no covenant here" or "this node is too old to
 * say", and it tells them apart by asking an address where the field must be
 * present. On this transport there is a THIRD cause — the WASM deserializer
 * may never have carried the field in the first place — and three causes
 * cannot be separated by one observation.
 *
 * Answering anyway would be the worst option available: reporting a modern
 * node as pre-covenant sends the operator to replace a node that is fine, and
 * reporting the opposite would be a guess wearing a check's authority.
 */
export class CovenantUnanswerable extends Error {
  constructor() {
    super(
      "a borsh reader cannot say whether the node reports covenant ids.\n\n" +
        "An absent covenantId here has three possible causes — no covenant at " +
        "that address, a pre-covenant node, or a WASM deserializer that never " +
        "carried the field — and one observation cannot separate three causes. " +
        "So this is unknown rather than failed.\n\n" +
        "Reading a GRANT needs that field and therefore needs JSON. Reading a " +
        "PAYMENT does not: the coin a vendor is paid with is an ordinary P2PK " +
        "output, and nothing about it is covenant-carrying.",
    );
    this.name = "CovenantUnanswerable";
  }
}

/**
 * A read-only chain reader over borsh.
 *
 * Satisfies `Inspectable`, so the same four health checks run against it —
 * which matters MORE here, not less. On your own node, synced and utxo-indexed
 * are assumptions worth making. On a resolver-chosen stranger they are
 * questions, and three of the four ways it can be wrong produce a plausible
 * answer rather than an error.
 */
export class BorshReader implements Inspectable {
  private readonly rpc: WasmRpc;
  private readonly endpoint: string;

  private constructor(rpc: WasmRpc, endpoint: string) {
    this.rpc = rpc;
    this.endpoint = endpoint;
  }

  static async open(options: BorshOptions = {}): Promise<BorshReader> {
    const rpc = options.client ?? (await constructClient(options));
    await rpc.connect();
    return new BorshReader(rpc, rpc.url ?? options.url ?? "borsh:resolver");
  }

  get url(): string {
    return this.endpoint;
  }

  async close(): Promise<void> {
    await this.rpc.disconnect();
  }

  /**
   * The WASM client calls this `getServerInfo`; kaspad calls it `getInfo` and
   * so does everything else in this protocol. The reply is the same reply, so
   * the rename stops here rather than leaking into the shared parser.
   */
  async getInfo(): Promise<NodeInfo> {
    return parseInfo(await this.rpc.getServerInfo());
  }

  async getBlockDagInfo(): Promise<DagInfo> {
    return parseDagInfo(await this.rpc.getBlockDagInfo());
  }

  async getUtxosByAddresses(addresses: string[]): Promise<AddressUtxo[]> {
    const reply = (await this.rpc.getUtxosByAddresses({ addresses })) as
      | { entries?: unknown[] }
      | unknown[];
    const raw = Array.isArray(reply) ? reply : (reply?.entries ?? []);
    return parseUtxos({ entries: raw.map(nest) });
  }

  /** Always throws. See `CovenantUnanswerable` for why that is the answer. */
  async assertCovenantAware(_grantAddress: string): Promise<void> {
    throw new CovenantUnanswerable();
  }

  /** Always throws. See `WriteNotSupported` for why this is not implemented. */
  async submitTransaction(): Promise<never> {
    throw new WriteNotSupported();
  }
}

/**
 * The WASM client flattens a UTXO entry; the JSON transport nests it.
 *
 * kaspad answers `getUtxosByAddresses` with `{address, outpoint, utxoEntry:
 * {amount, ...}}`, and the shared parser reads that shape. The WASM client
 * hands back the same fields with no `utxoEntry` wrapper — `amount` sits at
 * the top of the entry beside `address`.
 *
 * The spike written before this package hedged on exactly that
 * (`entries[0].amount ?? entries[0].utxoEntry?.amount`) and the reader was
 * then built assuming the nested one, because the tests used a fake built
 * from the JSON shape. A fake made from an assumption checks the assumption
 * against itself. The first real resolver answered and the parser said
 * `entry[0].amount: expected a number, got undefined`.
 *
 * Both shapes are accepted now, and a third one fails with the keys it
 * actually saw rather than with a missing field — so the next surprise
 * describes itself instead of requiring a guess.
 */
function nest(raw: unknown): unknown {
  const e = raw as Record<string, unknown>;
  if (!e || typeof e !== "object") {
    throw new Error(`a UTXO entry from the borsh client is ${typeof e}, not an object`);
  }

  /**
   * Read by NAME. Never spread, never Object.keys.
   *
   * The WASM client hands back wasm-bindgen class instances, whose fields are
   * getters on the PROTOTYPE rather than own enumerable properties. Object
   * spread copies own enumerable properties only — so `{...entry}` on one of
   * these produces `{}`, and the first version of this function did exactly
   * that. It passed every test, because the tests used object literals, which
   * do have own properties. The live resolver answered and the shared parser
   * said `entry[0].amount: expected a number, got undefined`, which is what an
   * empty object looks like from one field down.
   *
   * Property ACCESS goes through a getter; destructuring and spread do not.
   * That distinction is the whole bug.
   */
  let inner = (e.utxoEntry ?? e) as Record<string, unknown>;
  let amount = inner.amount ?? inner.value;
  let spk = inner.scriptPublicKey ?? inner.script_public_key;

  /* One step down, and only after the flat read came back empty.
     `UtxoEntryReference` carries BOTH — `amount` at the top and a nested
     `entry` holding the same values — so today this never runs. It is here
     because the flattening is a convenience of the current wasm-bindgen
     output, not part of kaspad's reply, and a version that stops repeating
     the fields would otherwise take a vendor down with "expected a number,
     got undefined" for the second time. The capture proves the shape exists;
     the test below reads through it. */
  if (amount === undefined && e.entry && typeof e.entry === "object") {
    inner = e.entry as Record<string, unknown>;
    amount = inner.amount ?? inner.value;
    spk = inner.scriptPublicKey ?? inner.script_public_key;
  }
  const outpoint = (e.outpoint ?? inner.outpoint ?? {}) as Record<string, unknown>;

  if (amount === undefined || spk === undefined) {
    /* Object.keys is useless here for the same reason the spread was — a
       wasm object reports none. So the diagnosis lists what was PROBED and
       what each probe found, which is the information that was missing when
       this failed in production. */
    const probe = (name: string, v: unknown) => `${name}=${v === undefined ? "undefined" : typeof v}`;
    throw new Error(
      `a UTXO entry from the borsh client is in a shape this reader does not know.\n\n` +
        `  ${probe("utxoEntry", e.utxoEntry)} ${probe("amount", inner.amount)} ` +
        `${probe("value", inner.value)} ${probe("scriptPublicKey", inner.scriptPublicKey)} ` +
        `${probe("outpoint", e.outpoint)}\n\n` +
        `Expected kaspad's {address, outpoint, utxoEntry:{amount, scriptPublicKey,…}} or the ` +
        `WASM client's flattened equivalent. Note that its objects carry their fields as ` +
        `prototype getters, so they must be read by name.`,
    );
  }

  return {
    address: addressOf(e.address ?? inner.address),
    outpoint: {
      transactionId: outpoint.transactionId ?? outpoint.transaction_id,
      index: outpoint.index ?? 0,
    },
    utxoEntry: {
      amount,
      scriptPublicKey: spk,
      blockDaaScore: inner.blockDaaScore ?? inner.block_daa_score ?? 0n,
      isCoinbase: inner.isCoinbase ?? inner.is_coinbase ?? false,
    },
  };
}

/**
 * The address, as a string, whatever the transport called an address.
 *
 * `AddressUtxo.address` is typed `string | null` and the JSON transport sends
 * a string. The WASM client sends an `Address` INSTANCE — `{prefix, payload}`
 * behind getters, with a working `toString`. The first version of this reader
 * passed it through untouched, so the field held an object while claiming to
 * hold a string.
 *
 * Nothing broke, which is the reason it survived: a vendor matches a payment
 * by amount and transaction id and never reads this. It would have broken the
 * first time someone compared it to an address they had, or serialized it —
 * `JSON.stringify` of an Address is `{}`, so a report would have recorded a
 * payment to nowhere and looked fine doing it.
 *
 * Found by `test/fixtures/borsh-utxo.json`, a reply recorded from a live
 * resolver. No hand-written fake had produced it, because writing one means
 * already knowing.
 */
function addressOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "string") return v;
  if (typeof v !== "object") return null;
  const a = v as { prefix?: unknown; payload?: unknown };
  // Read prefix and payload FIRST. toString() is the canonical form on the
  // real Address, but a stub or a proxy can leave the inherited one in place,
  // and "[object Object]" in an address field is worse than a null.
  if (typeof a.prefix === "string" && typeof a.payload === "string") {
    return `${a.prefix}:${a.payload}`;
  }
  const s = String(v);
  return s.startsWith("[object ") ? null : s;
}

/**
 * Construct the real client, and say something useful when it is not installed.
 *
 * `kaspa-wasm32-sdk` is a peer dependency rather than a dependency because it
 * ships a wasm binary that no JSON user should have to download. The cost of
 * that choice is this error, and an error naming the package and the install
 * is cheaper than a megabyte in everyone's node_modules.
 */
async function constructClient(options: BorshOptions): Promise<WasmRpc> {
  let k: any;
  try {
    k = await import("kaspa-wasm32-sdk");
  } catch {
    throw new Error(
      "kaspa-wasm32-sdk is not installed.\n\n" +
        "It is a peer dependency: it carries a wasm binary, and only the borsh " +
        "path needs it.\n\n" +
        "  npm install kaspa-wasm32-sdk",
    );
  }
  const networkId = options.networkId ?? process.env.WARDA_NETWORK ?? "testnet-10";
  return options.url
    ? new k.RpcClient({ url: options.url, networkId, encoding: k.Encoding.Borsh })
    : new k.RpcClient({ resolver: new k.Resolver(), networkId, encoding: k.Encoding.Borsh });
}
