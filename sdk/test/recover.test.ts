import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  bytecodeFor,
  decodeGrant,
  grantFromSignatureScript,
  redeemScriptFrom,
  scriptHashFor,
  templateIdFor,
  type CovenantTemplate,
  type Grant,
} from "../src/template.ts";
import { scriptHashToAddress } from "../src/address.ts";
import { attachSignature, buildUnsignedSpend, successorState } from "../src/spend.ts";
import { EMPTY_RESERVE } from "../src/keys.ts";
import { decodeAddress } from "../src/address.ts";
import { fromHex } from "../src/bytes.ts";
import { toWire } from "../src/wire.ts";

/**
 * Recovery, checked against the chain rather than against itself.
 *
 * Every number below came off testnet-10 on 1 September 2026, when an agent
 * paid a metered API out of a grant. The two addresses are the ones the network
 * actually held before and after: the first is where the funded grant sat, the
 * second is where the covenant forced its continuation to go. Neither was
 * chosen by this test.
 *
 * That matters because the failure mode of a decoder is agreeing with the
 * encoder that wrote it. A round trip through `bytecodeFor` and `decodeGrant`
 * would pass just as happily if BOTH were wrong about the layout — the grant
 * would simply live at an address neither the chain nor anyone else could name.
 * Anchoring on a transaction the network validated is the only check that can
 * catch a shared mistake.
 *
 * Receipt: x402/demo/receipt.json, txid
 * 267e1bac1270fde34d9719d676b378745fb57007062cd1b6de52f2d2a4af433e
 */

const LIVE = {
  addressBefore: "kaspatest:pqckh2ay4rxxtpuv3g9snaclza47tz0f0uxmfwsaflr0uupmg4yx6eddrwck5",
  addressAfter: "kaspatest:pp985pts8r297cpl8u28e6hpztxj4mss9fpnvcjzla4p79rrl7glw5apwk4dg",
  vendor: "kaspatest:qrn33jmrmhwjjey5m2khdlun9a6e20c02z4rq060n8gy43s9zmt5q8hpd8ym5",
  amount: 20_000_000n,
  agent: "3c693f61fbc35d1fd4dcec2bbbab692be38656e6fd5a4077ee495afcb23535a1",
  principal: "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f",
  recipientsRoot: "db0a707b658f29fd8903a7f3815f63f962ec3a4e66528d3e11ba150a5fd4f0b5",
  covenantId: "221dc89d6f998cd9699125a79bb0b0071513837399fa5d8835e8585a5b9b0df4",
  notBefore: 558_974_403n,
  expiresAt: 584_894_403n,
  /** The spend landed in epoch 5 — recovered from the chain address itself. */
  claimedDaa: 558_979_403n,
};

const tpl: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

const authority = { principalKey: LIVE.principal, revocationKey: LIVE.principal };
const genesisState = {
  agentKey: LIVE.agent,
  budgetTotal: 300_000_000n,
  maxPerSpend: 50_000_000n,
  epochLimit: 100_000_000n,
  epochLength: 1_000n,
  recipientsRoot: LIVE.recipientsRoot,
  notBefore: LIVE.notBefore,
  expiresAt: LIVE.expiresAt,
  delegationDepth: 2n,
  templateId: templateIdFor(tpl, authority),
  spentTotal: 0n,
  reserved: 0n,
  epochIndex: 0n,
  epochSpent: 0n,
  reserveRoot: EMPTY_RESERVE,
};
const grant: Grant = { authority, state: genesisState };
const address = (g: Grant) => scriptHashToAddress(scriptHashFor(tpl, g), "kaspatest");

test("the grant the chain funded is the one this SDK derives", () => {
  assert.equal(address(grant), LIVE.addressBefore);
});

test("the successor the chain forced is the one successorState computes", () => {
  const next = successorState(genesisState, LIVE.amount, LIVE.claimedDaa);
  assert.equal(address({ authority, state: next }), LIVE.addressAfter);
  assert.equal(next.spentTotal, LIVE.amount);
  assert.equal(next.epochIndex, 5n);
});

/** The whole recovery path, on a transaction shaped exactly like the live one. */
function liveSpendWire() {
  const plan = {
    template: tpl,
    authority,
    state: genesisState,
    amount: LIVE.amount,
    recipient: decodeAddress(LIVE.vendor).payload,
    proof: { siblings: [], left: [] },
    claimedDaa: LIVE.claimedDaa,
    fee: 2_000_000n,
    utxo: {
      outpointTransactionId: fromHex("11".repeat(32)),
      outpointIndex: 0,
      value: 300_000_000n,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: fromHex(LIVE.covenantId),
    },
    computeBudget: 1_000_000,
  };
  const unsigned = buildUnsignedSpend(plan);
  return toWire(attachSignature(plan, unsigned, new Uint8Array(65)), unsigned.entry);
}

test("a spend publishes the grant it spent, and it decodes to the original", () => {
  const wire = liveSpendWire();
  const recovered = grantFromSignatureScript(fromHex(wire.inputs[0]!.signatureScriptHex), tpl);
  assert.deepEqual(recovered.state, genesisState);
  assert.deepEqual(recovered.authority, authority);
  assert.equal(address(recovered), LIVE.addressBefore);
});

test("recovery walks the spend forward to the address the chain holds", () => {
  const wire = liveSpendWire();
  const spent = grantFromSignatureScript(fromHex(wire.inputs[0]!.signatureScriptHex), tpl);
  // Output 1 is the payment; the amount that moves the state is what the
  // RECIPIENT got, never the change.
  const next = successorState(spent.state, BigInt(wire.outputs[1]!.value), BigInt(wire.lockTime));
  const successor = { authority: spent.authority, state: next };
  assert.equal(address(successor), LIVE.addressAfter);
  // And the self-check the tool performs: the derived successor must be the
  // output this transaction actually pays.
  assert.equal(wire.outputs[0]!.scriptPublicKeyHex, "aa20" + scriptHashFor(tpl, successor) + "87");
});

test("a signature script with no covenant in it is refused, not guessed at", () => {
  assert.throws(
    () => redeemScriptFrom(new Uint8Array(200), tpl),
    /no \d+-byte redeem script/,
  );
});

test("the recipients root is recovered, so the allowlist survives too", () => {
  const wire = liveSpendWire();
  const recovered = grantFromSignatureScript(fromHex(wire.inputs[0]!.signatureScriptHex), tpl);
  // Recovering the root is what lets a rebuilt manifest still prove inclusion:
  // without it the grant is reachable but unspendable.
  assert.equal(recovered.state.recipientsRoot, LIVE.recipientsRoot);
});

test("decoding under the wrong template refuses rather than inventing a grant", () => {
  const code = bytecodeFor(tpl, grant);
  assert.throws(() => decodeGrant({ ...tpl, bytecodeLen: code.length - 1 }, code), /DIFFERENT covenant/);
});
