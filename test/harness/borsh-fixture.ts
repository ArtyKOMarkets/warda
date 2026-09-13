/**
 * Rebuild a captured wasm object, prototype getters and all.
 *
 * `test/fixtures/borsh-utxo.json` was captured from a live resolver by
 * capture-borsh.mjs, and it records the SHAPE rather than just the values,
 * because the shape is what broke:
 *
 *   constructor    UtxoEntryReference
 *   ownKeys        ["__wbg_ptr"]
 *   prototypeKeys  ["entry","outpoint","address","amount","isCoinbase",…]
 *   spreadYields   ["__wbg_ptr"]
 *
 * Every field a reader wants is a getter on the prototype. The only own
 * property is a pointer into wasm memory. So `{...entry}` yields `{__wbg_ptr:
 * 12345}` — which is how a normaliser built on object spread produced an
 * empty entry and reported `amount: expected a number, got undefined`.
 *
 * A hand-written fake cannot reproduce that by accident: object literals have
 * own properties, and a fixture that loses the distinction agrees with the
 * bug it is supposed to catch. This one keeps it.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface Described {
  kind: string;
  constructor?: string | null;
  ownKeys?: string[];
  prototypeKeys?: string[];
  spreadYields?: string[];
  values?: Record<string, unknown>;
  value?: unknown;
}

const CAPTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/borsh-utxo.json", import.meta.url)), "utf8"),
) as { entry: Described; address: string; resolver: string; capturedAt: string };

export const capture = CAPTURE;

/**
 * Fields the WASM client hands back as bigint.
 *
 * These are kaspad's u64s. The capture had to stringify them to be JSON, and
 * it did not tag them, so the type has to be restored from the name. A
 * digits-only heuristic is not available: a transaction id is a 64-character
 * hex string and roughly one capture in 10^13 is all digits, which is the
 * kind of odds that pays out on the day it matters. capture-borsh.mjs now
 * tags them, so a future capture will not need this list.
 */
const U64 = new Set(["amount", "blockDaaScore", "mempoolSize", "virtualDaaScore", "blockCount"]);

/** Put back the bigints the capture had to stringify. */
function revive(v: unknown, key?: string): unknown {
  if (v !== null && typeof v === "object" && (v as Described).kind === "bigint") {
    return BigInt(String((v as Described).value));
  }
  if (typeof v === "string" && key && U64.has(key) && /^\d+$/.test(v)) return BigInt(v);
  return v;
}

/**
 * An object whose fields live where the real one's live.
 *
 * Own properties go on the instance; everything else becomes a
 * non-enumerable prototype getter, which is exactly what wasm-bindgen emits
 * and exactly what spread cannot see.
 */
function rebuild(d: Described): unknown {
  if (d.kind !== "object") return revive(d.kind === "bigint" ? d : d.value);
  const proto: Record<string, unknown> = {};
  const own: Record<string, unknown> = {};
  const values = d.values ?? {};

  for (const [k, raw] of Object.entries(values)) {
    const v = raw && typeof raw === "object" && (raw as Described).kind === "object"
      ? rebuild(raw as Described)
      : revive(raw, k);
    if ((d.ownKeys ?? []).includes(k)) own[k] = v;
    else Object.defineProperty(proto, k, { get: () => v, enumerable: false, configurable: true });
  }
  // Methods the real object carries. A probe that looks for one must find
  // it, and `toString` in particular must WORK: the real Address has a
  // working toString and a fixture whose toString returns undefined throws
  // "Cannot convert object to primitive value" — an error the real thing
  // never produces, which would send a reader chasing a bug in the fixture.
  for (const k of d.prototypeKeys ?? []) {
    // `in` would be wrong: `toString` is already reachable through
    // Object.prototype, so every object would keep the default and the
    // Address in this fixture would stringify to "[object Object]" — the
    // exact wrong answer the reader is being tested against.
    if (Object.prototype.hasOwnProperty.call(proto, k)) continue;
    const impl = k === "toString"
      ? () => stringify(d)
      : k === "toJSON"
      ? () => ({ ...values })
      : () => undefined;
    Object.defineProperty(proto, k, { value: impl, enumerable: false, configurable: true });
  }
  const o = Object.create(proto);
  // The pointer into wasm memory: the ONLY own property the real object has,
  // and therefore the only thing a spread of it yields. Keeping it means the
  // fixture reproduces `spreadYields: ["__wbg_ptr"]` rather than a slightly
  // tidier {} that no real client ever sends.
  for (const k of d.ownKeys ?? []) {
    if (!(k in own)) own[k] = k === "__wbg_ptr" ? 1_000_000 : undefined;
  }
  Object.assign(o, own);
  return o;
}

/** What the real object's `toString` returns, for the ones this needs. */
function stringify(d: Described): string {
  const v = d.values ?? {};
  // `constructor` is a captured field here, but on an object that lacks it
  // the name resolves up to Object.prototype's function. Hence the typeof.
  const ctor = typeof d.constructor === "string" ? d.constructor : "Object";
  if (ctor === "Address") return `${String(v.prefix)}:${String(v.payload)}`;
  return `[object ${ctor}]`;
}

/** One entry, in the shape a resolver really sends. */
export function capturedEntry(): object {
  return rebuild(CAPTURE.entry) as object;
}

/**
 * The same recorded entry with the flattened accessors removed.
 *
 * `UtxoEntryReference` repeats its fields twice: `amount` at the top and a
 * nested `entry` holding the same values. The repetition is a convenience of
 * the current wasm-bindgen output, not something kaspad sends, so a build that
 * stops repeating them is a change the reader should survive rather than
 * discover in a vendor. This is that object.
 */
export function capturedEntryNestedOnly(): object {
  const d = CAPTURE.entry;
  const keep = new Set(["entry", "outpoint", "address"]);
  const values = Object.fromEntries(
    Object.entries(d.values ?? {}).filter(([k]) => keep.has(k)),
  );
  return rebuild({
    ...d,
    prototypeKeys: (d.prototypeKeys ?? []).filter((k) => !["amount", "isCoinbase", "blockDaaScore", "scriptPublicKey"].includes(k)),
    values,
  }) as object;
}
