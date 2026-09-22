import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };
import { fromHex, payToPubkeyScript, scriptHashFor, scriptHashToAddress, toHex, type CovenantTemplate } from "@warda_protocol/kaspa";
import { toGrant } from "@warda_protocol/agent";
import { Funder, createPlan, type FundingChain } from "../src/funding.ts";
import { delegate } from "../src/delegate.ts";
import { memoryRegistry } from "../src/registry.ts";
import { memoryStore } from "../src/store.ts";
import { EnvelopeVault, localMasterKey } from "../src/vault.ts";

const KAS = 100_000_000n;
const VENDOR = "16e6af2030f7e4510d1a417391a7ff7ccad21864f17eef7ee035f0453e21a033";
const RUNNER = "3c693f61fbc35d1fd4dcec2bbbab692be38656e6fd5a4077ee495afcb23535a1";
const owner = () => toHex(schnorr.getPublicKey(new Uint8Array(randomBytes(32))));
const TEMPLATE = covenantTemplate as unknown as CovenantTemplate;

async function funded(o: { failSubmit?: boolean } = {}) {
  const store = memoryStore();
  const registry = memoryRegistry();
  const vault = new EnvelopeVault(localMasterKey(new Uint8Array(randomBytes(32))), store);
  const utxos = new Map<string, Awaited<ReturnType<FundingChain["utxos"]>>>();
  const submitted: unknown[] = [];
  let failNext = false;
  const chain: FundingChain = {
    async daa() { return 577_000_000n; },
    async utxos(a) { return structuredClone(utxos.get(a) ?? []); },
    async submit(tx) { if (failNext) throw new Error("rejected: bad fee"); submitted.push(tx); return "ok"; },
  };
  const agentKey = await vault.create("boss");
  const plan = await createPlan({
    vault, registry, agent: "boss", agentKey, principal: owner(), revocation: owner(),
    limits: { budget: KAS, maxPerSpend: KAS / 5n, epochLimit: KAS / 2n, epochLength: 1000n, days: 7 },
    recipients: [VENDOR, RUNNER], prefix: "kaspatest", now: 1,
  });
  utxos.set(plan.depositAddress, [{ outpoint: { transactionId: new Uint8Array(randomBytes(32)), index: 0 },
    entry: { value: BigInt(plan.required), scriptPublicKey: payToPubkeyScript(fromHex(plan.depositKey)), blockDaaScore: 1n, isCoinbase: false } }]);
  await new Funder({ registry, vault, chain, prefix: "kaspatest" }).tick();
  // Put the grant's coin where the chain would have it.
  const rec = (await registry.getGrant("boss"))!;
  const g = toGrant(rec.manifest, rec.recipients, TEMPLATE);
  const addr = scriptHashToAddress(scriptHashFor(TEMPLATE, { authority: g.authority, state: g.state }), "kaspatest");
  utxos.set(addr, [{ outpoint: { transactionId: new Uint8Array(randomBytes(32)), index: 0 },
    entry: { value: BigInt(rec.manifest.grant_value), scriptPublicKey: { version: 0, script: new Uint8Array(0) }, blockDaaScore: 2n, isCoinbase: false,
      covenantId: fromHex(rec.manifest.covenant_id) } }]);
  if (o.failSubmit) failNext = true;
  submitted.length = 0; // the genesis
  return { registry, vault, chain, submitted, rec };
}

test("a sub-agent: a child grant with part of the budget, narrower, same owner keys; the parent reserves it", async () => {
  const b = await funded();
  const r = await delegate({ registry: b.registry, vault: b.vault, chain: b.chain, prefix: "kaspatest",
    parent: "boss", child: "helper", terms: { budget: KAS / 5n, maxPerSpend: KAS / 50n, days: 2 }, now: 5 });
  assert.equal(b.submitted.length, 1);
  const child = (await b.registry.getGrant("helper"))!;
  assert.equal(child.parent, "boss");
  assert.equal(child.manifest.budget, Number(KAS / 5n));
  assert.equal(child.manifest.max_per_spend, Number(KAS / 50n));
  assert.equal(child.manifest.delegation_depth, 0, "a sub-agent cannot delegate further");
  assert.equal(child.manifest.principal, b.rec.manifest.principal, "same owner");
  assert.equal(child.manifest.covenant_id, b.rec.manifest.covenant_id, "same covenant lineage");
  assert.ok(child.manifest.expires_at < b.rec.manifest.expires_at, "a shorter term");
  assert.equal(child.manifest.agent, await b.vault.publicKey("helper"), "the runner holds the helper's key");
  const parent = (await b.registry.getGrant("boss"))!;
  assert.equal(parent.manifest.reserved, Number(KAS / 5n), "the parent reserves what the child received");
  assert.notEqual(parent.manifest.reserve_root, b.rec.manifest.reserve_root);
  assert.match(r.childAddress, /^kaspatest:/);

  await assert.rejects(() => delegate({ registry: b.registry, vault: b.vault, chain: b.chain, prefix: "kaspatest",
    parent: "helper", child: "grandchild", terms: { budget: 1000n, maxPerSpend: 1000n }, now: 6 }), /without room for sub-agents/);
});

test("a delegation the network refuses leaves the parent as it was and no child", async () => {
  const b = await funded({ failSubmit: true });
  await assert.rejects(() => delegate({ registry: b.registry, vault: b.vault, chain: b.chain, prefix: "kaspatest",
    parent: "boss", child: "helper", terms: { budget: KAS / 5n, maxPerSpend: KAS / 50n }, now: 5 }), /did not take/);
  assert.equal(await b.registry.getGrant("helper"), null);
  assert.deepEqual((await b.registry.getGrant("boss"))!.manifest, b.rec.manifest);
});

test("more than the parent has left, or a higher cap, is refused before anything is signed", async () => {
  const b = await funded();
  await assert.rejects(() => delegate({ registry: b.registry, vault: b.vault, chain: b.chain, prefix: "kaspatest",
    parent: "boss", child: "h1", terms: { budget: 2n * KAS, maxPerSpend: KAS / 50n }, now: 5 }), /exceeds the parent's uncommitted/);
  await assert.rejects(() => delegate({ registry: b.registry, vault: b.vault, chain: b.chain, prefix: "kaspatest",
    parent: "boss", child: "h2", terms: { budget: KAS / 10n, maxPerSpend: KAS }, now: 5 }), /cannot raise the per-spend cap/);
  assert.equal(b.submitted.length, 0);
});
