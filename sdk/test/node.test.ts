import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import { buildUnsignedSpend, type SpendPlan } from "../src/spend.ts";
import type { CovenantTemplate, GrantState } from "../src/template.ts";
import { stringify, toBigInt } from "../src/rpc.ts";
import {
  parseDagInfo,
  parseInfo,
  parseUtxos,
  scriptPublicKeyFromWire,
  scriptPublicKeyToWire,
  transactionToWire,
} from "../src/node.ts";

/**
 * The node client's wire format has no golden vector of its own — it lives in
 * someone else's source tree, and reading it carefully is not the same as
 * being right about it. So this file is in two halves.
 *
 * The first half pins the encoding decisions that a careful reader gets
 * BACKWARDS, each one taken from rusty-kaspa's own serde implementations. They
 * are asserted here so that a later "tidy-up" cannot quietly undo them.
 *
 * The second half replays `rpc-capture.json` — a recording of what a real
 * covenant-aware node said — through the same parsing functions the live
 * client uses. It skips, loudly, when the capture is absent, because a test
 * that silently passes on a missing fixture is worse than no test.
 */

const golden = JSON.parse(readFileSync(new URL("../golden-spend.json", import.meta.url), "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

function planFromGolden(): SpendPlan {
  const p = golden.params;
  const state: GrantState = {
    agentKey: p.agentKey,
    budgetTotal: BigInt(p.budgetTotal),
    maxPerSpend: BigInt(p.maxPerSpend),
    epochLimit: BigInt(p.epochLimit),
    epochLength: BigInt(p.epochLength),
    recipientsRoot: p.recipientsRoot,
    notBefore: BigInt(p.notBefore),
    expiresAt: BigInt(p.expiresAt),
    delegationDepth: BigInt(p.delegationDepth),
    spentTotal: BigInt(p.prevState.spentTotal),
    reserved: BigInt(p.prevState.reserved),
    epochIndex: BigInt(p.prevState.epochIndex),
    epochSpent: BigInt(p.prevState.epochSpent),
  };
  return {
    template,
    authority: { principalKey: p.principalKey, revocationKey: p.revocationKey },
    state,
    utxo: {
      outpointTransactionId: fromHex(golden.utxo.outpointTransactionId),
      outpointIndex: golden.utxo.outpointIndex,
      value: BigInt(golden.utxo.value),
      blockDaaScore: BigInt(golden.utxo.blockDaaScore),
      isCoinbase: golden.utxo.isCoinbase,
      covenantId: fromHex(golden.utxo.covenantId),
    },
    amount: BigInt(golden.spend.amount),
    recipient: fromHex(golden.recipients.target),
    proof: {
      siblings: golden.recipients.proof.siblings.map((s: string) => fromHex(s)),
      left: golden.recipients.proof.left,
    },
    claimedDaa: BigInt(golden.spend.claimedDaa),
    fee: BigInt(golden.spend.fee),
    computeBudget: golden.spend.computeBudget,
  };
}

// ---- encoding decisions --------------------------------------------------

test("a script public key goes on the wire as ONE hex string, version big-endian", () => {
  // Every other integer in Kaspa's serialization is little-endian. This one is
  // not: `ScriptPublicKey::serialize` calls `version.to_be_bytes()` when the
  // serializer is human-readable. Writing it LE produces "0100…" for version 0
  // — a well-formed string the node reads as version 256.
  const spk = { version: 0, script: fromHex("aa20" + "11".repeat(32) + "87") };
  const wire = scriptPublicKeyToWire(spk);

  assert.equal(wire.slice(0, 4), "0000");
  assert.equal(wire, "0000" + toHex(spk.script));

  const back = scriptPublicKeyFromWire(wire);
  assert.equal(back.version, 0);
  assert.equal(toHex(back.script), toHex(spk.script));
});

test("the object form is still accepted on the way in", () => {
  // The node never emits it, but a proxy might re-encode. Accepting both costs
  // four lines; failing to would look like a corrupt UTXO.
  const back = scriptPublicKeyFromWire({ version: 1, script: "51" });
  assert.equal(back.version, 1);
  assert.equal(toHex(back.script), "51");
});

test("a version-1 input reports its compute budget and a ZERO sigop count", () => {
  // `RpcInputWithVersion -> TransactionInput` refuses a nonzero sig_op_count
  // on a version-1 transaction outright: "RpcTransactionInput.sig_op_count is
  // inconsistent with transaction version 1". The two fields are exclusive,
  // not additive, and the version alone decides which one is live.
  const built = buildUnsignedSpend(planFromGolden());
  const wire = transactionToWire(built.tx) as any;

  assert.equal(wire.version, 1);
  assert.equal(wire.inputs[0].sigOpCount, 0, "a nonzero sigop count is rejected on v1");
  assert.equal(wire.inputs[0].computeBudget, golden.spend.computeBudget);
});

test("`mass` is present, because the node's deserializer requires it", () => {
  // RpcTransaction's Deserialize errors with "Either storageMass or mass must
  // be provided" when both are absent — before it looks at the transaction at
  // all. Omitting it fails a perfectly good spend at the front door.
  const wire = transactionToWire(buildUnsignedSpend(planFromGolden()).tx) as any;
  assert.equal(wire.mass, 0);
});

test("the covenant binding survives onto the wire", () => {
  // The single field most likely to be dropped by a second implementation,
  // and the one whose absence is invisible until a node refuses the spend.
  const wire = transactionToWire(buildUnsignedSpend(planFromGolden()).tx) as any;
  const bound = wire.outputs.filter((o: any) => o.covenant !== null);
  assert.ok(bound.length > 0, "no output carries a covenant binding");
  assert.equal(typeof bound[0].covenant.covenantId, "string");
  assert.equal(bound[0].covenant.covenantId.length, 64);
  assert.equal(typeof bound[0].covenant.authorizingInput, "number");
  assert.equal(bound[0].scriptPublicKey.slice(0, 4), "0000");
});

test("bigints serialize as raw JSON numbers, not quoted strings", () => {
  // serde wants a u64 from a JSON number. `"1000000000"` is a string and is
  // rejected. This is why the payload cannot go through plain JSON.stringify.
  const text = stringify({ value: 1_000_000_000n, script: "00ff" });
  assert.equal(text, '{"value":1000000000,"script":"00ff"}');
  assert.deepEqual(JSON.parse(text), { value: 1_000_000_000, script: "00ff" });
});

test("an integer JSON already rounded is refused rather than returned", () => {
  // Above 2^53 a JSON literal has lost digits by the time JSON.parse hands it
  // over, and nothing reports it. Returning it would put a wrong amount under
  // a signature.
  assert.equal(toBigInt(1_000_000_000, "amount"), 1_000_000_000n);
  assert.throws(() => toBigInt(2 ** 53 + 2, "amount"), /lost precision/);
});

// ---- fixture replay ------------------------------------------------------

const capturePath = new URL("../rpc-capture.json", import.meta.url);

test("a recorded node reply parses into the types the client returns", { skip: skipReason() }, () => {
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const reply = (m: string) => capture.captured[m].reply.params;

  const info = parseInfo(reply("getInfo"));
  assert.ok(info.serverVersion.length > 0, "no server version");
  assert.ok(
    info.isUtxoIndexed,
    "the node was captured without --utxoindex; getUtxosByAddresses cannot work",
  );

  const dag = parseDagInfo(reply("getBlockDagInfo"));
  assert.ok(dag.virtualDaaScore > 0n, "a DAA score of zero means the node had no chain");

  const utxos = parseUtxos(reply("getUtxosByAddresses"));
  assert.ok(utxos.length > 0, "the captured address held nothing");
  const entry = utxos[0]!.entry;
  assert.ok(entry.value > 0n);
  assert.equal(entry.scriptPublicKey.version, 0);
  assert.ok(entry.scriptPublicKey.script.length > 0, "an empty script means the hex split slipped");
});

test("the captured node reports a covenant id on a grant UTXO", { skip: skipReason() }, () => {
  // The whole point of the capture. `undefined` here is indistinguishable from
  // an ordinary covenant-free UTXO one entry at a time — which is exactly why
  // it has to be asserted against an address known to hold a covenant.
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const utxos = parseUtxos(capture.captured.getUtxosByAddresses.reply.params);
  const entry = utxos[0]!.entry;
  assert.ok(
    entry.covenantId,
    "the captured node reported no covenantId: either it predates covenants, " +
      "or the field was dropped in transit. A spend built from this entry " +
      "would carry no binding and be refused by every node that does know.",
  );
  assert.equal(entry.covenantId!.length, 32);
});

function skipReason(): string | false {
  return existsSync(capturePath)
    ? false
    : "no rpc-capture.json — run `python3 tools/capture_rpc.py <grant address> > rpc-capture.json` against a synced node";
}
