#!/usr/bin/env node
/**
 * Capture what a real resolver actually sends, shape included.
 *
 *     node test/harness/capture-borsh.mjs > test/fixtures/borsh-utxo.json
 *
 * Run from a machine with egress to the Kaspa resolvers. It connects over
 * borsh, asks for a known-funded address, and writes down the reply.
 *
 * ## Why this is not `JSON.stringify(entry)`
 *
 * The bug this exists to prevent was not about VALUES. Every value in my
 * hand-written fake was right. The wasm-bindgen objects the WASM client
 * returns carry their fields as getters on the PROTOTYPE, and object spread
 * copies own enumerable properties only — so the normaliser produced `{}` and
 * every field came back undefined.
 *
 * JSON.stringify reads getters. It would have recorded perfect values and
 * silently flattened them into own properties, producing a fixture that
 * agrees with the wrong assumption — the same fixture I wrote by hand, with
 * more steps.
 *
 * So the capture records the SHAPE: which keys are own, which are inherited,
 * what the constructor is called. The fixture builder then rebuilds an object
 * with the same split, and a test against it fails the way production did.
 */
import { writeFileSync } from "node:fs";

const ADDRESS =
  process.argv[2] ?? "kaspatest:qqtwdteqxrm7g5gdrfqh8yd8la7v45scvnchamm7uq6lq3f7yxsrx5umtwam4";
const NETWORK = process.argv[3] ?? "testnet-10";

/** Own vs inherited, and the values, read the way the reader reads them. */
function describe(o, depth = 0) {
  if (o === null || typeof o !== "object") {
    return { kind: typeof o, value: typeof o === "bigint" ? String(o) : o };
  }
  const own = Object.keys(o);
  const proto = Object.getPrototypeOf(o);
  const inherited = proto && proto !== Object.prototype
    ? Object.getOwnPropertyNames(proto).filter((k) => k !== "constructor")
    : [];
  const values = {};
  for (const k of [...own, ...inherited]) {
    try {
      const v = o[k];
      // A bigint is TAGGED, not merely stringified. JSON has one number type
      // and no bigint, so an untagged "3000000" is indistinguishable from a
      // string field — and a fixture that rebuilds it as a string does not
      // reproduce what the client sends.
      values[k] = depth < 2 && v && typeof v === "object"
        ? describe(v, depth + 1)
        : typeof v === "bigint" ? { kind: "bigint", value: String(v) } : v;
    } catch (e) {
      values[k] = `<<threw: ${e.message}>>`;
    }
  }
  return {
    kind: "object",
    constructor: o.constructor?.name ?? null,
    ownKeys: own,
    prototypeKeys: inherited,
    // The line that matters: what a spread would have produced.
    spreadYields: Object.keys({ ...o }),
    values,
  };
}

const k = await import("kaspa-wasm32-sdk");
const rpc = new k.RpcClient({
  resolver: new k.Resolver(),
  networkId: NETWORK,
  encoding: k.Encoding.Borsh,
});
await rpc.connect();
process.stderr.write(`connected: ${rpc.url}\n`);

const reply = await rpc.getUtxosByAddresses({ addresses: [ADDRESS] });
const entries = reply.entries ?? reply;
process.stderr.write(`entries: ${entries.length}\n`);
if (!entries.length) {
  process.stderr.write(`nothing at ${ADDRESS}. Pass a funded address as argv[2].\n`);
  process.exit(1);
}

const capture = {
  _comment:
    "Captured from a live Kaspa resolver over borsh by test/harness/capture-borsh.mjs. " +
    "Records SHAPE as well as values: wasm-bindgen objects carry their fields as prototype " +
    "getters, and a fixture that loses that distinction agrees with the bug it should catch. " +
    "`spreadYields` is the evidence — if it is empty, spreading this object produces nothing.",
  capturedAt: new Date().toISOString(),
  resolver: rpc.url,
  network: NETWORK,
  address: ADDRESS,
  replyIsArray: Array.isArray(reply),
  replyKeys: Array.isArray(reply) ? null : Object.keys(reply),
  entryCount: entries.length,
  entry: describe(entries[0]),
};

process.stdout.write(JSON.stringify(capture, null, 2) + "\n");
await rpc.disconnect();
