/**
 * Kaspa over borsh — reading, and now writing.
 *
 * kaspad's wRPC speaks two encodings. Borsh is the default and the only one
 * the sixteen public resolvers serve; JSON exists only when an operator passes
 * `--rpclisten-json=`, which almost nobody does. That is the whole reason this
 * package exists: without it, every Warda tool needs a node run by the person
 * running the tool, and "run a DAG node" is a real thing to ask of someone who
 * just wants to sell an API for a fifth of a cent.
 *
 * ## This file used to end with a refusal
 *
 * For two versions `submitTransaction` threw, and the reason was good: borsh
 * is POSITIONAL. There are no field names on the wire, so a struct the encoder
 * does not know about is not an unknown field — it is an absent one, and
 * absence shifts everything after it. `kaspa-wasm32-sdk@0.15.2` was built
 * before covenants; the string "covenant" does not occur in its types. Hand it
 * a grant spend and it serializes a transaction that is well-formed, correctly
 * signed, and bound to nothing — a payment that means nothing, submitted
 * successfully. Refusing was the only honest option available.
 *
 * What changed is not the argument, it is the premise. rusty-kaspa's own wasm
 * bindings have carried covenants since Toccata, and builds from those
 * revisions are published. So the buyer's node requirement was never a
 * protocol limit; it was a PACKAGING limit, and `submit.ts` lifts it without
 * asking anyone to trust a binary: the covenant binding is part of the
 * sighash, so any disagreement between what we signed and what the encoder
 * produced shows up in the transaction id, and every submit checks that before
 * the network sees anything. Read `submit.ts` for the full argument.
 *
 * The refusal survives, narrowed to the case that still deserves it: a module
 * that cannot express a covenant is rejected by construction rather than by
 * version number, because upstream may ship one tomorrow.
 *
 * ## What the reading half is still for
 *
 * A seller never submits anything. `@warda_protocol/vendor` calls exactly
 * `getUtxosByAddresses` — is the coin I was promised actually in the UTXO set —
 * and `@warda_protocol/verify` adds `getBlockDagInfo` for the epoch. Both are
 * reads, and neither touches a covenant field, because the coin a vendor is
 * paid with is an ordinary P2PK output to the vendor's own address. So a
 * vendor needs no covenant-carrying build and no node; a buyer needs the
 * build, and still no node.
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
  toHex,
  transactionId,
  type AddressUtxo,
  type DagInfo,
  type Inspectable,
  type NodeInfo,
  type Transaction,
} from "@warda_protocol/kaspa";
import { encodeForSubmit, supportsCovenants, type WasmModule } from "./submit.ts";

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
  /**
   * kaspad's `getInfo`, and NOT `getServerInfo`. See `BorshReader.getInfo`.
   *
   * Optional only so that a client written against the older version of this
   * interface — which asked for `getServerInfo` — is a type error at the seam
   * rather than a silently wrong answer at runtime.
   */
  getInfo?(): Promise<Record<string, unknown>>;
  getServerInfo(): Promise<Record<string, unknown>>;
  getBlockDagInfo(): Promise<Record<string, unknown>>;
  getUtxosByAddresses(request: { addresses: string[] }): Promise<unknown>;
  /**
   * Optional, because a read-only consumer of this interface is a real thing —
   * `@warda_protocol/vendor` never submits — and requiring the method would
   * make every such caller stub out a function it must never call. A reader
   * whose client lacks it is read-only, and says so rather than crashing.
   */
  submitTransaction?(request: {
    transaction: unknown;
    allowOrphan?: boolean;
  }): Promise<{ transactionId?: unknown }>;
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
  /**
   * The WASM module itself, when one is already loaded or when the caller
   * wants to choose the build.
   *
   * Submitting needs the MODULE, not just the client: a transaction has to be
   * constructed through the same bindings that will serialize it. Passing a
   * `client` without a `wasm` therefore leaves this reader read-only, which is
   * the safe direction for a seam the tests use.
   */
  wasm?: unknown;
  /** What to call the module in errors. Defaults to whatever was loaded. */
  wasmName?: string;
}

/**
 * Thrown when this reader has a client but no module to build a spend with.
 *
 * Narrower than it used to be. It no longer means "borsh cannot write" — it
 * means this particular reader was opened with a `client` and no `wasm`, so it
 * can talk to a node but cannot construct a transaction. A module that is
 * present but covenant-blind raises `CovenantsUnsupported` instead, which is a
 * different problem with a different fix.
 */
export class WriteNotSupported extends Error {
  constructor() {
    super(
      "this reader has no WASM module, so it cannot build a transaction to submit.\n\n" +
        "Submitting needs the module, not just the client: the transaction has to be " +
        "constructed through the same bindings that will serialize it. A reader opened with " +
        "`client` and no `wasm` is read-only by construction.\n\n" +
        "Pass `wasm` to `BorshReader.open`, or let it load one itself by omitting `client`.",
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
 *
 * A covenant-carrying module removes the third cause — it deserializes the
 * field, so an absence is the node's absence — and then the check runs for
 * real. This is thrown only when the module in use cannot express a covenant,
 * which is exactly when the ambiguity is back.
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
  private readonly wasm: unknown;
  private readonly wasmName: string;

  private constructor(rpc: WasmRpc, endpoint: string, wasm: unknown, wasmName: string) {
    this.rpc = rpc;
    this.endpoint = endpoint;
    this.wasm = wasm;
    this.wasmName = wasmName;
  }

  static async open(options: BorshOptions = {}): Promise<BorshReader> {
    /* A caller-supplied `client` does NOT imply a module. The tests pass a
       plain object here, and a reader built on one must not believe it can
       construct a transaction — hence `options.wasm` rather than anything
       inferred from the client. */
    /* A supplied client is connected here; one this built is connected ALREADY,
       by `constructClient`, because separating discovery from the connect is
       the only way the two failures can be told apart — and the second attempt
       would be at best a no-op and at worst an "already connected". */
    if (options.client) {
      await options.client.connect();
    }
    const loaded = options.client
      ? { rpc: options.client, wasm: options.wasm, name: options.wasmName ?? "the supplied module" }
      : await constructClient(options);
    return new BorshReader(
      loaded.rpc,
      loaded.rpc.url ?? options.url ?? "borsh:resolver",
      loaded.wasm,
      loaded.name,
    );
  }

  /**
   * Can this reader build and broadcast a Warda spend?
   *
   * Worth asking BEFORE a grant is funded rather than after it is signed, so
   * the tools can say "install a covenant-carrying build" at the point where
   * that costs nothing.
   */
  get canSubmit(): boolean {
    return this.carriesCovenants && typeof this.rpc.submitTransaction === "function";
  }

  /**
   * Kept separate from `canSubmit` on purpose.
   *
   * Reading a grant and spending one need different things. The covenant
   * question is about the DESERIALIZER — can the field survive the trip at
   * all — and a client that happens to be read-only has no bearing on it. A
   * vendor auditing a grant it was paid from is exactly this case, and folding
   * the two together would have sent them to install a transport they never
   * use.
   */
  private get carriesCovenants(): boolean {
    return this.wasm !== undefined && supportsCovenants(this.wasm);
  }

  get url(): string {
    return this.endpoint;
  }

  async close(): Promise<void> {
    await this.rpc.disconnect();
  }

  /**
   * `getInfo`, which is a DIFFERENT CALL from `getServerInfo`, not a rename.
   *
   * This used to call `getServerInfo` with a comment saying the WASM client
   * merely spells `getInfo` differently and "the reply is the same reply". It
   * is not. They are two RPCs with two response types:
   *
   *   getInfo        p2pId, mempoolSize, serverVersion, isUtxoIndexed, isSynced
   *   getServerInfo  rpcApiVersion, serverVersion, networkId, hasUtxoIndex,
   *                  isSynced, virtualDaaScore
   *
   * `hasUtxoIndex` and `isUtxoIndexed` are the same question under two names,
   * and the shared parser reads the second one. So a perfectly good node came
   * back with `isUtxoIndexed: undefined`, which `Boolean()` makes `false`, and
   * `inspect` reported NO UTXO INDEX — the single check whose failure reads as
   * "your grant is gone". p2pId and mempoolSize were empty and zero for the
   * same reason, and nobody looks at those, which is why it survived.
   *
   * Reported by the first person to run --borsh against a real resolver. It
   * could not have been caught here: the fake in the tests was written from
   * the same belief as the code.
   *
   * The fix is not to translate the names — it is to call the RPC that answers
   * the question being asked. Both transports now make the same call and the
   * shared parser sees one shape, which is the thing that was supposed to be
   * true all along.
   */
  async getInfo(): Promise<NodeInfo> {
    if (typeof this.rpc.getInfo === "function") return parseInfo(await this.rpc.getInfo());
    /* A client from before this distinction was understood. Its getServerInfo
       answer is translated rather than trusted, so the wrong-name failure
       cannot come back through an old seam. */
    const r = await this.rpc.getServerInfo();
    return parseInfo({ ...r, isUtxoIndexed: r.isUtxoIndexed ?? r.hasUtxoIndex });
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

  /**
   * A grant's single live coin.
   *
   * A grant is one coin by construction — spending it produces exactly one
   * successor — so anything else is a question about which address is being
   * looked at rather than about the grant. Duplicated from `NodeClient`
   * deliberately: it is four lines of arithmetic over `getUtxosByAddresses`,
   * and importing it would make this package depend on the JSON transport's
   * class to talk to a resolver.
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
   * Does the node report covenant ids?
   *
   * Answerable only with a covenant-carrying module. Without one the absence
   * of the field has three possible causes and one observation cannot separate
   * them — see `CovenantUnanswerable`. With one, the deserializer is no longer
   * a suspect, and this becomes the same two-cause check `NodeClient` runs.
   */
  async assertCovenantAware(grantAddress: string): Promise<void> {
    if (!this.carriesCovenants) throw new CovenantUnanswerable();
    const utxos = await this.getUtxosByAddresses([grantAddress]);
    if (utxos.length === 0) {
      throw new Error(
        `no UTXO at ${grantAddress}, so covenant-awareness cannot be checked there.\n` +
          `A grant is one coin by construction. An empty answer means the grant has been ` +
          `spent, or this node is not utxo-indexed, or it is on another network — and none ` +
          `of those is a covenant problem.`,
      );
    }
    if (!utxos[0]!.entry.covenantId) {
      throw new Error(
        `the UTXO at ${grantAddress} reports no covenant id.\n` +
          `The module in use does carry the field, so this is the node: either it predates ` +
          `covenants, or something in between dropped it. Building a spend from this entry ` +
          `would produce a transaction with no binding — well-formed, and refused by every ` +
          `node that does know about covenants.`,
      );
    }
  }

  /**
   * Build, check, broadcast.
   *
   * The id is computed twice on the way out — once by this SDK, once by the
   * WASM encoder — and they must agree before anything is sent. It is then
   * checked a third time against what the node answers, which is free and
   * covers the case where the reply belongs to a different transaction
   * entirely. See `submit.ts` for why the first check is the load-bearing one.
   */
  async submitTransaction(tx: Transaction, allowOrphan = false): Promise<string> {
    if (this.wasm === undefined || typeof this.rpc.submitTransaction !== "function") {
      throw new WriteNotSupported();
    }
    const transaction = encodeForSubmit(tx, this.wasm as WasmModule, this.wasmName);
    const reply = await this.rpc.submitTransaction({ transaction, allowOrphan });
    const id = reply?.transactionId;
    if (!id) throw new Error("submitTransaction returned no transaction id");

    const ours = toHex(transactionId(tx));
    if (String(id) !== ours) {
      throw new Error(
        `the node accepted a transaction with an id this SDK did not predict.\n\n` +
          `  expected  ${ours}\n` +
          `  node said ${String(id)}\n\n` +
          `This one IS broadcast — unlike a pre-flight disagreement, it is too late to refuse. ` +
          `Look up the id the node gave before spending again: the grant's successor is at ` +
          `that transaction, not the predicted one.`,
      );
    }
    return ours;
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
      /* The field that separates a grant from an ordinary coin, and the one
         this reader could not carry at all until there was a module that
         deserializes it. `parseUtxos` hex-decodes it through `String()`,
         which is what a wasm `Hash` answers with, so it is passed along as
         the object rather than stringified here. Undefined stays undefined:
         that is the ambiguity `assertCovenantAware` exists to resolve, and
         resolving it here would be a guess. */
      covenantId: inner.covenantId ?? inner.covenant_id,
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
 * Load a module, construct the client, and say what is missing when nothing loads.
 *
 * TWO candidates, in this order, and the order is not a preference between
 * vendors — it is "covenants first". `kaspa-wasm32-sdk` is the official
 * package and the one most people already have; it is second only because the
 * published build predates covenants. The moment upstream ships one that does
 * not, `supportsCovenants` will return true for it and the first candidate
 * stops mattering. Nothing here checks a version or a package name for that
 * reason.
 *
 * Both are optional peer dependencies. They carry multi-megabyte wasm
 * binaries, and a vendor accepting payments needs neither of them to be the
 * covenant-carrying one.
 */
const WASM_CANDIDATES = ["@kluster/kaspa-wasm", "kaspa-wasm32-sdk"] as const;

interface LoadedClient {
  rpc: WasmRpc;
  wasm: unknown;
  name: string;
}

export async function loadWasm(): Promise<{ module: unknown; name: string }> {
  const notes: string[] = [];
  let fallback: { module: unknown; name: string } | undefined;

  for (const name of WASM_CANDIDATES) {
    let m: unknown;
    try {
      m = await import(name);
    } catch {
      notes.push(`  ${name} — not installed`);
      continue;
    }
    if (supportsCovenants(m)) return { module: m, name };
    /* Kept rather than discarded: reading works fine through a covenant-blind
       module, and a vendor is the majority case. It only stops being enough
       at the moment somebody tries to submit, where the error names the gap. */
    notes.push(`  ${name} — installed, but cannot express a covenant`);
    fallback ??= { module: m, name };
  }

  if (fallback) return fallback;
  throw new Error(
    "no Kaspa WASM module is installed.\n\n" +
      notes.join("\n") +
      "\n\nOne of these is needed for the borsh transport; both are optional peer " +
      "dependencies because each ships a wasm binary.\n\n" +
      "  npm install @kluster/kaspa-wasm     # reads and submits Warda spends\n" +
      "  npm install kaspa-wasm32-sdk        # reads only, today",
  );
}

/**
 * Two stages, timed separately, because they fail for different reasons.
 *
 * The first version of this called `new RpcClient({resolver})` and let the
 * client do both: ask a resolver which node to use, then connect to it. That
 * is one call and it hides the distinction that matters. `RpcClient.connect`
 * has no timeout of its own — it retries forever, in silence — so a wrapper
 * with a deadline around the pair can only ever say "nothing answered in 20
 * seconds", which is true of a blocked HTTPS lookup, a blocked outbound wss, a
 * resolver with no node for your network, and a node that is simply down.
 *
 * Four causes, four different things to do about them, one message. So the
 * stages are separate and each says what it was doing:
 *
 *   discovery   HTTPS to the community resolvers. Blocked here and nothing
 *               else can happen; reachable here and the transport is fine.
 *   connect     wss to the ONE node discovery chose. A failure here names that
 *               node, which makes "try another" a thing you can do.
 */
const DISCOVER_MS = 15_000;

/**
 * The resolver domains this build really uses, for the error message only.
 *
 * Read out of the WASM binary rather than from memory or from a wiki: the TOML
 * compiled into `@kluster/kaspa-wasm@2.0.1` has the `*.kaspa-ng.org`,
 * `.io` and `.net` groups COMMENTED OUT, so a message naming one of those
 * sends somebody to curl a host the client will never contact — and a 502 from
 * it looks like a diagnosis. It is not; it is a different server being down.
 *
 * Nothing reads these to connect. They exist so the suggestion in an error is
 * a host that was actually going to be tried.
 */
const RESOLVER_DOMAINS = ["kaspa.stream", "kaspa.red", "kaspa.green", "kaspa.blue"];
/* One per domain, and the path is the one the client really requests — note
   the `any` segment, which is easy to leave out and turns a working probe into
   a 404 that reads like the resolver is broken. */
const RESOLVER_PROBES = ["eric.kaspa.stream", "john.kaspa.red", "jake.kaspa.green", "noah.kaspa.blue"];
const CONNECT_MS = 20_000;

/**
 * Run a stage, and make sure its failure says which stage it was.
 *
 * Both outcomes go through `describe`, and that is the point. A deadline alone
 * handles the case where nothing answers — but discovery can also fail FAST,
 * and wasm-bindgen rejects with a value that is often not an `Error` at all, so
 * the caller printed `undefined` and the whole diagnosis was lost. Which was
 * the original complaint in a new costume: a transport that fails without
 * saying anything.
 *
 * So a rejection is wrapped with the same explanation the timeout would have
 * given, with whatever the underlying value stringifies to appended. The user
 * gets the same guidance either way, and the raw cause is still there for the
 * case where it turns out to matter.
 */
function textOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    const s = String(e);
    return s === "[object Object]" ? JSON.stringify(e) : s;
  } catch {
    return "an error that cannot be printed";
  }
}

async function stage<T>(work: Promise<T>, ms: number, describe: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT_${ms}`)), ms);
    /* Must not hold the process open: on the happy path this loses the race
       and its only remaining job is to stop existing. */
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    return await Promise.race([work, expiry]);
  } catch (e) {
    const timedOut = e instanceof Error && e.message === `TIMEOUT_${ms}`;
    throw new Error(
      (timedOut ? `nothing answered within ${ms / 1000}s.\n\n` : `${textOf(e)}\n\n`) + describe(),
    );
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Which node, according to the community resolvers.
 *
 * Exported because it answers a question worth asking on its own — "is the
 * resolver reachable from here at all" — without opening a socket or loading a
 * grant. That is the first thing to know when `--borsh` does not work.
 */
export async function discover(wasm: unknown, networkId: string): Promise<string> {
  const k = wasm as {
    Resolver: new () => { getUrl(encoding: unknown, networkId: string): Promise<string> };
    Encoding: { Borsh: unknown };
  };
  return stage(
    new k.Resolver().getUrl(k.Encoding.Borsh, networkId),
    DISCOVER_MS,
    () =>
      `Discovery failed. This step is plain HTTPS to the community resolvers — it is not\n` +
      `the chain, and no WebSocket has been attempted yet. A proxy, a container egress\n` +
      `policy or a firewall that DROPS rather than refuses looks exactly like a timeout\n` +
      `here; all sixteen resolvers being unreachable looks like a fast failure.\n\n` +
      `Ask one of them directly. The list is compiled into the WASM build, and these are\n` +
      `the four domains it actually uses — ${RESOLVER_DOMAINS.join(", ")}:\n\n` +
      RESOLVER_PROBES.map((h) => `  curl -sS https://${h}/v2/kaspa/${networkId}/any/wrpc/borsh`).join("\n") +
      `\n\nA 502 from one of them is that one being down, not a network problem — the\n` +
      `resolver is meant to route around it. All four failing is the network.\n\n` +
      `Either way there is a way past: point at a borsh endpoint directly, which skips\n` +
      `discovery entirely.\n\n` +
      `  --rpc wss://<host>/kaspa/${networkId}/wrpc/borsh`,
  );
}

async function constructClient(options: BorshOptions): Promise<LoadedClient> {
  const loaded = options.wasm
    ? { module: options.wasm, name: options.wasmName ?? "the supplied module" }
    : await loadWasm();
  const k = loaded.module as any;
  const networkId = options.networkId ?? process.env.WARDA_NETWORK ?? "testnet-10";

  const url = options.url ?? (await discover(loaded.module, networkId));
  const rpc = new k.RpcClient({ url, networkId, encoding: k.Encoding.Borsh });
  /* The advice differs, so the two cases are written out rather than shared.
     A resolver-chosen node can simply be retried into a different one; an
     endpoint somebody typed cannot, and telling them to "run it again" would
     be advice that cannot work. */
  const named = options.url !== undefined;

  await stage(
    rpc.connect(),
    CONNECT_MS,
    () =>
      `Could not open a WebSocket to ${url}.\n\n` +
      (named
        ? `You named this endpoint, so no resolver was involved and nothing else was\n` +
          `tried. Check the host and the path — a borsh url ends /wrpc/borsh, and the\n` +
          `JSON one a node only serves with --rpclisten-json= is a different port.\n\n` +
          `Drop --rpc to let a resolver pick a node instead.`
        : `A resolver chose this node and it did not accept a connection — so discovery\n` +
          `worked and the problem is the socket. That node may be down or overloaded;\n` +
          `running this again picks a different one.`) +
      `\n\nRpcClient.connect does not give up on its own: it retries in silence, which is\n` +
      `why there is a deadline here at all.`,
  );

  /* Connected already, so `BorshReader.open`'s own connect is a no-op. Doing it
     here is what lets the two failures above be told apart at all. */
  return { rpc, wasm: loaded.module, name: loaded.name };
}
