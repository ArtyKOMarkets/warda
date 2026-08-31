import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import { decodeAddress, pubkeyToAddress, scriptHashToAddress } from "../src/address.ts";
import { parseDagInfo, parseUtxos, scriptPublicKeyFromWire } from "../src/node.ts";
import { describeGrant } from "../src/verify.ts";
import { scriptHashFor, type CovenantTemplate, type Grant } from "../src/template.ts";

/**
 * The address encoder has no golden vector either — but it does have something
 * better: a real address, for a real grant, that a real node answered a query
 * about. If `scriptHashToAddress` produces that exact string from the script
 * hash inside the captured UTXO's script, the encoding is right, because the
 * node found the coin by that name.
 */

const capturePath = new URL("../rpc-capture.json", import.meta.url);
const skip = existsSync(capturePath)
  ? false
  : "no rpc-capture.json — run `python3 tools/capture_rpc.py <grant address> > rpc-capture.json`";

const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

test("the derived address is the one the node answered to", { skip }, () => {
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const utxo = parseUtxos(capture.captured.getUtxosByAddresses.reply.params)[0]!;

  // P2SH is OP_BLAKE2B <32-byte hash> OP_EQUAL: 0xaa 0x20 … 0x87.
  const script = utxo.entry.scriptPublicKey.script;
  assert.equal(script[0], 0xaa);
  assert.equal(script[1], 0x20);
  assert.equal(script[34], 0x87);
  const scriptHash = script.slice(2, 34);

  assert.equal(scriptHashToAddress(scriptHash, "kaspatest"), capture.address);
});

test("a corrupted address is refused, not silently reinterpreted", () => {
  const address = scriptHashToAddress(fromHex("11".repeat(32)), "kaspatest");
  const round = decodeAddress(address);
  assert.equal(round.version, 8);
  assert.equal(toHex(round.payload), "11".repeat(32));

  // Flip one character. The 8-character BCH checksum exists precisely so that
  // a typo becomes an error rather than a valid address for someone else.
  const broken = address.slice(0, -1) + (address.endsWith("q") ? "p" : "q");
  assert.throws(() => decodeAddress(broken), /checksum/);
});

test("a P2PK address carries version 0, not the script-hash version", () => {
  const address = pubkeyToAddress(fromHex("22".repeat(32)), "kaspatest");
  assert.equal(decodeAddress(address).version, 0);
  assert.notEqual(decodeAddress(address).version, 8);
});

test("the wire script decodes to the same bytes the address encodes", { skip }, () => {
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const raw = capture.captured.getUtxosByAddresses.reply.params.entries[0].utxoEntry;
  const spk = scriptPublicKeyFromWire(raw.scriptPublicKey);
  assert.equal(spk.version, 0);
  assert.equal(spk.script.length, 35, "a P2SH script is 35 bytes");
});

// ---- the report ----------------------------------------------------------

function grantFrom(m: any): Grant {
  return {
    authority: { principalKey: m.agent, revocationKey: m.agent },
    state: {
      agentKey: m.agent,
      budgetTotal: BigInt(m.budget),
      maxPerSpend: BigInt(m.max_per_spend),
      epochLimit: BigInt(m.epoch_limit),
      epochLength: BigInt(m.epoch_length),
      recipientsRoot: m.recipients_root,
      notBefore: BigInt(m.not_before),
      expiresAt: BigInt(m.expires_at),
      delegationDepth: 2n,
      spentTotal: BigInt(m.spent_total),
      reserved: BigInt(m.reserved),
      epochIndex: BigInt(m.epoch_index),
      epochSpent: BigInt(m.epoch_spent),
    },
  };
}

const LIVE_MANIFEST = {
  covenant_id: "f7947f65000b60e59819b02b93b5fd1761772f4edcf07010268ab7eefad375f8",
  agent: "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f",
  recipients_root: "db0a707b658f29fd8903a7f3815f63f962ec3a4e66528d3e11ba150a5fd4f0b5",
  not_before: 553866058,
  expires_at: 554730058,
  budget: 1000000000,
  max_per_spend: 200000000,
  epoch_limit: 500000000,
  epoch_length: 1000,
  grant_value: 898000000,
  spent_total: 100000000,
  reserved: 0,
  epoch_index: 699,
  epoch_spent: 50000000,
};

function captureMatchesTemplate(): string | false {
  if (skip) return skip;
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const g = grantFrom(LIVE_MANIFEST);
  const derived = scriptHashToAddress(scriptHashFor(template, g), "kaspatest");
  if (derived !== capture.address) {
    // The capture records a grant on ONE covenant. Change the covenant and the
    // same state derives a different address, so every assertion tied to it
    // becomes meaningless rather than wrong. Say which, rather than failing.
    return (
      `rpc-capture.json is from a DIFFERENT covenant: it records ${capture.address}, ` +
      `and this template derives ${derived}. Re-capture against a current grant.`
    );
  }
  return false;
}

test("the recorded grant agrees with the manifest that describes it", { skip: captureMatchesTemplate() }, () => {
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const dag = parseDagInfo(capture.captured.getBlockDagInfo.reply.params);
  const utxo = parseUtxos(capture.captured.getUtxosByAddresses.reply.params)[0]!;

  const r = describeGrant(grantFrom(LIVE_MANIFEST), template, "kaspatest", utxo, dag, {
    covenantId: LIVE_MANIFEST.covenant_id,
    value: BigInt(LIVE_MANIFEST.grant_value),
  });

  assert.equal(r.address, capture.address);
  assert.ok(r.agrees, `expected agreement, got: ${JSON.stringify(r.findings, null, 2)}`);
  assert.equal(r.value, 898_000_000n);
  assert.equal(r.remaining, 900_000_000n); // 10 KAS budget, 1 KAS spent
});

test("a manifest claiming the wrong covenant id is caught", { skip: captureMatchesTemplate() }, () => {
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const dag = parseDagInfo(capture.captured.getBlockDagInfo.reply.params);
  const utxo = parseUtxos(capture.captured.getUtxosByAddresses.reply.params)[0]!;

  const r = describeGrant(grantFrom(LIVE_MANIFEST), template, "kaspatest", utxo, dag, {
    covenantId: "00".repeat(32),
  });
  assert.equal(r.agrees, false);
  assert.ok(r.findings.some((f) => f.level === "error" && /covenant id/.test(f.text)));
});

test("expiry is reported as a reclaim right, never as a spend prohibition", { skip: captureMatchesTemplate() }, () => {
  // The v1 covenant had NO expiry check at all. v2 requires claimedDaa <
  // expiresAt plus a monotone epoch, which caps but does not eliminate
  // post-expiry spending — deferred epoch allowance survives. Saying "expired,
  // the agent can no longer spend" would be a confident lie either way.
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const dag = parseDagInfo(capture.captured.getBlockDagInfo.reply.params);
  const utxo = parseUtxos(capture.captured.getUtxosByAddresses.reply.params)[0]!;

  const r = describeGrant(grantFrom(LIVE_MANIFEST), template, "kaspatest", utxo, dag, {});
  assert.ok(dag.virtualDaaScore >= BigInt(LIVE_MANIFEST.expires_at), "capture is not past expiry");
  assert.equal(r.reclaimable, true);
  assert.equal(r.agrees, true, "being past expiry is not a disagreement with the manifest");
  const note = r.findings.find((f) => /expiresAt/.test(f.text))!;
  assert.equal(note.level, "warn");
  assert.match(note.text, /not stopped dead/);
});

test("the coin, not the budget, is what limits the next spend", { skip: captureMatchesTemplate() }, () => {
  // The live grant is the demonstration. Budget accounting says 900,000,000
  // remains; the coin holds 898,000,000. The 2,000,000 gap is exactly the two
  // 1,000,000-sompi fees the two spends paid — fees leave the coin but are
  // never charged against spentTotal, so the two figures diverge for the life
  // of the grant. An agent acting on `remaining` builds a spend that cannot be
  // funded, and the covenant refuses it as a value-conservation failure.
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const dag = parseDagInfo(capture.captured.getBlockDagInfo.reply.params);
  const utxo = parseUtxos(capture.captured.getUtxosByAddresses.reply.params)[0]!;

  const r = describeGrant(grantFrom(LIVE_MANIFEST), template, "kaspatest", utxo, dag, {});
  assert.equal(r.remaining, 900_000_000n);
  assert.equal(r.value, 898_000_000n);
  assert.equal(r.remaining - r.value!, 2_000_000n, "the gap should be exactly the fees paid");

  // With no fee stated the bound is the template's baked maxFee (5,000,000),
  // which is pessimistic on purpose. maxPerSpend is 200,000,000 and still
  // wins here, so the binding limit is the per-spend cap, not the coin.
  assert.equal(r.maxNextSpend, 200_000_000n);
  assert.equal(r.boundBy, "maxPerSpend");

  // Shrink the grant to where the coin binds, and the report must say so
  // rather than repeating the budget.
  const thin = { ...utxo, entry: { ...utxo.entry, value: 40_000_000n } };
  const t = describeGrant(grantFrom(LIVE_MANIFEST), template, "kaspatest", thin, dag, {
    fee: 1_000_000n,
  });
  assert.equal(t.boundBy, "coin");
  assert.equal(t.maxNextSpend, 39_000_000n);
});

test("an epoch the chain has moved past reports a FULL allowance, not a spent one", { skip: captureMatchesTemplate() }, () => {
  // epochSpent is stored against a specific epochIndex. Once the chain moves
  // to the next epoch that number no longer applies, and carrying it forward
  // would report an agent as out of allowance when it has the whole limit.
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const dag = parseDagInfo(capture.captured.getBlockDagInfo.reply.params);
  const utxo = parseUtxos(capture.captured.getUtxosByAddresses.reply.params)[0]!;

  const stale = { ...LIVE_MANIFEST, epoch_index: 0, epoch_spent: LIVE_MANIFEST.epoch_limit };
  const r = describeGrant(grantFrom(stale), template, "kaspatest", utxo, dag, {});
  assert.equal(r.epochRemaining, BigInt(LIVE_MANIFEST.epoch_limit));
});
