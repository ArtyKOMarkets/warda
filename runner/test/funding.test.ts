import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { fromHex, payToPubkeyScript, toHex } from "@warda_protocol/kaspa";
import { Funder, checkLimits, createPlan, createTopUp, depositUri, maxDeposit, requiredDeposit, MAX_DEPOSIT_DEFAULT, type FundingChain, type Limits } from "../src/funding.ts";
import { memoryRegistry } from "../src/registry.ts";
import { memoryStore } from "../src/store.ts";
import { EnvelopeVault, localMasterKey } from "../src/vault.ts";

const KAS = 100_000_000n;
const VENDOR = "16e6af2030f7e4510d1a417391a7ff7ccad21864f17eef7ee035f0453e21a033";
const RUNNER = "3c693f61fbc35d1fd4dcec2bbbab692be38656e6fd5a4077ee495afcb23535a1";
const owner = () => toHex(schnorr.getPublicKey(new Uint8Array(randomBytes(32))));

async function bench(o: { failSubmit?: number } = {}) {
  const store = memoryStore();
  const registry = memoryRegistry();
  const vault = new EnvelopeVault(localMasterKey(new Uint8Array(randomBytes(32))), store);
  const utxos = new Map<string, Awaited<ReturnType<FundingChain["utxos"]>>>();
  const submitted: string[] = [];
  let fail = o.failSubmit ?? 0;
  const chain: FundingChain = {
    async daa() { return 577_000_000n; },
    async utxos(a) { return structuredClone(utxos.get(a) ?? []); },
    async submit(tx) {
      if (fail-- > 0) throw new Error("connection reset");
      submitted.push(JSON.stringify(tx.outputs.map((x) => x.value.toString())));
      return "ok";
    },
  };
  const agentKey = await vault.create("bot");
  const principal = owner();
  const plan = await createPlan({
    vault, registry, agent: "bot", agentKey, principal, revocation: owner(),
    limits: { budget: KAS, maxPerSpend: KAS / 5n, epochLimit: KAS / 2n, epochLength: 1000n, days: 7 },
    recipients: [VENDOR, RUNNER], prefix: "kaspatest", now: 1,
  });
  const deposit = (value: bigint, n = 1) => {
    const list = utxos.get(plan.depositAddress) ?? [];
    list.push({
      outpoint: { transactionId: new Uint8Array(randomBytes(32)), index: n },
      entry: { value, scriptPublicKey: payToPubkeyScript(fromHex(plan.depositKey)), blockDaaScore: 1n, isCoinbase: false },
    });
    utxos.set(plan.depositAddress, list);
  };
  return { registry, vault, chain, plan, deposit, submitted, utxos, principal, funder: new Funder({ registry, vault, chain, prefix: "kaspatest" }) };
}

test("the deposit needed covers the budget, genesis, and the grant's own spend fees", () => {
  const l = { budget: KAS, maxPerSpend: KAS / 5n, epochLimit: KAS / 2n, epochLength: 1000n, days: 7 };
  assert.equal(requiredDeposit(l), KAS + 1_000_000n + 10_000_000n);
  assert.equal(requiredDeposit({ ...l, budget: 10n * KAS }), 10n * KAS + 1_000_000n + KAS);
});

test("nothing happens until one payment covers it", async () => {
  const b = await bench();
  assert.match(depositUri(b.plan), /^kaspatest:q[a-z0-9]+\?amount=1\.11$/);
  assert.deepEqual(await b.funder.tick(), []);
  b.deposit(KAS / 2n, 1);
  b.deposit(KAS, 2);
  assert.deepEqual(await b.funder.tick(), []);
  const p = (await b.registry.getPlan("bot"))!;
  assert.equal(p.status, "awaiting-deposit");
  assert.match(p.note!, /one transaction/);
  assert.equal(b.submitted.length, 0);
});

test("a full deposit becomes a grant owned by the owner's keys, in one transaction, once", async () => {
  const b = await bench();
  b.deposit(BigInt(b.plan.required));
  assert.deepEqual(await b.funder.tick(), ["bot"]);
  assert.equal(b.submitted.length, 1);
  assert.deepEqual(JSON.parse(b.submitted[0]!), [(BigInt(b.plan.required) - 1_000_000n).toString()],
    "the whole coin goes into the grant; nothing comes back to the deposit key");
  const g = (await b.registry.getGrant("bot"))!;
  assert.equal(g.manifest.principal, b.principal);
  assert.equal(g.manifest.agent, b.plan.agentKey);
  assert.equal(g.manifest.budget, Number(KAS));
  assert.equal(g.manifest.delegation_depth, 1, "room for one level of sub-agents");
  const p = (await b.registry.getPlan("bot"))!;
  assert.equal(p.status, "funded");
  assert.equal(p.genesisTxid, p.built!.txid);
  assert.deepEqual(await b.funder.tick(), [], "a funded plan is never touched again");
  assert.equal(b.submitted.length, 1);
});

test("a failed broadcast is retried as the SAME transaction, never a second grant", async () => {
  const b = await bench({ failSubmit: 1 });
  b.deposit(BigInt(b.plan.required));
  assert.deepEqual(await b.funder.tick(), []);
  const first = (await b.registry.getPlan("bot"))!;
  assert.equal(first.status, "submitting");
  assert.match(first.note!, /connection reset/);
  const manifest = (await b.registry.getGrant("bot"))!.manifest;
  assert.deepEqual(await b.funder.tick(), ["bot"]);
  const second = (await b.registry.getPlan("bot"))!;
  assert.equal(second.genesisTxid, first.built!.txid);
  assert.deepEqual((await b.registry.getGrant("bot"))!.manifest, manifest);
});

test("a genesis that landed although its broadcast looked failed is recognised, not rebuilt", async () => {
  const b = await bench({ failSubmit: 99 });
  b.deposit(BigInt(b.plan.required));
  await b.funder.tick();
  const p = (await b.registry.getPlan("bot"))!;
  b.utxos.set(p.built!.grantAddress, [{
    outpoint: { transactionId: new Uint8Array(32), index: 0 },
    entry: { value: 1n, scriptPublicKey: payToPubkeyScript(new Uint8Array(32)), blockDaaScore: 2n, isCoinbase: false },
  }]);
  assert.deepEqual(await b.funder.tick(), ["bot"]);
  assert.equal(b.submitted.length, 0);
});

test("the owner's key cannot be the agent's", async () => {
  const b = await bench();
  await assert.rejects(createPlan({
    vault: b.vault, registry: b.registry, agent: "bot2", agentKey: b.plan.agentKey, principal: b.plan.agentKey,
    revocation: owner(), limits: { budget: KAS, maxPerSpend: KAS, epochLimit: KAS, epochLength: 1000n, days: 1 },
    recipients: [VENDOR], prefix: "kaspatest", now: 1,
  }), /cannot be the agent's key/);
});

test("a deposit that never became a grant goes back to the owner's key, and cancels the plan", async () => {
  const { refundDeposit } = await import("../src/funding.ts");
  const b = await bench();
  b.deposit(KAS / 2n);
  const out = await refundDeposit({ plan: (await b.registry.getPlan("bot"))!, registry: b.registry, vault: b.vault, chain: b.chain, prefix: "kaspatest", now: 2 });
  assert.equal(out.length, 1);
  assert.equal(out[0]!.value, KAS / 2n - 1_000_000n);
  assert.equal(b.submitted.length, 1);
  const p = (await b.registry.getPlan("bot"))!;
  assert.equal(p.status, "refunded");
  assert.equal(p.refunds!.length, 1);
  assert.deepEqual(await b.funder.tick(), [], "a refunded plan is never funded afterwards");
});

test("no refund while the grant is being created from the deposit", async () => {
  const { refundDeposit } = await import("../src/funding.ts");
  const b = await bench({ failSubmit: 1 });
  b.deposit(BigInt(b.plan.required));
  await b.funder.tick();
  await assert.rejects(
    refundDeposit({ plan: (await b.registry.getPlan("bot"))!, registry: b.registry, vault: b.vault, chain: b.chain, prefix: "kaspatest", now: 2 }),
    /being created/,
  );
});

test("top-up: a successor grant for the same agent, from its own deposit key, with the fee address brought up to date", async () => {
  const b = await bench();
  b.deposit(BigInt(b.plan.required));
  await b.funder.tick();
  const first = (await b.registry.getGrant("bot"))!;
  const NEW_FEE = "7e".repeat(32);
  const top = await createTopUp({
    vault: b.vault, registry: b.registry, agent: "bot", record: first, previous: (await b.registry.getPlan("bot"))!,
    limits: { budget: 2n * KAS }, feePayee: NEW_FEE, oldFeePayees: [RUNNER], prefix: "kaspatest", now: 2,
  });
  assert.equal(top.round, 2);
  assert.notEqual(top.depositAddress, b.plan.depositAddress, "a new deposit key");
  assert.equal(top.agentKey, first.manifest.agent, "the same agent key");
  assert.equal(top.principal, first.manifest.principal);
  assert.deepEqual(top.recipients, [VENDOR, NEW_FEE], "the old fee address is replaced by the current one");
  assert.equal(top.limits.budget, (2n * KAS).toString());
  assert.equal(top.limits.maxPerSpend, first.manifest.max_per_spend.toString(), "unchanged limits carry over");
  assert.equal(top.replaces!.manifest.covenant_id, first.manifest.covenant_id);

  await assert.rejects(() => createTopUp({
    vault: b.vault, registry: b.registry, agent: "bot", record: first, previous: top,
    feePayee: NEW_FEE, prefix: "kaspatest", now: 3,
  }), /already waiting/);

  // Until the deposit arrives the old grant is still the agent's.
  await b.funder.tick();
  assert.equal((await b.registry.getGrant("bot"))!.manifest.covenant_id, first.manifest.covenant_id);

  const list = b.utxos.get(top.depositAddress) ?? [];
  list.push({ outpoint: { transactionId: new Uint8Array(randomBytes(32)), index: 0 },
    entry: { value: BigInt(top.required), scriptPublicKey: payToPubkeyScript(fromHex(top.depositKey)), blockDaaScore: 1n, isCoinbase: false } });
  b.utxos.set(top.depositAddress, list);
  assert.deepEqual(await b.funder.tick(), ["bot"]);
  const next = (await b.registry.getGrant("bot"))!;
  assert.notEqual(next.manifest.covenant_id, first.manifest.covenant_id);
  assert.equal(next.manifest.budget, Number(2n * KAS));
  assert.equal(next.manifest.agent, first.manifest.agent);
  assert.equal((await b.registry.getPlan("bot"))!.status, "funded");
});

/* ------------------------------------------------------------------------
   The funding window has a size now.

   DESIGN.md has always disclosed the window — between the deposit landing
   and the genesis confirming, the runner controls that coin outright — and
   disclosure is not a bound. Its size was unlimited: quote a grant of any
   budget and somebody sends that much to a key the runner holds alone.
   ------------------------------------------------------------------------ */
test("the runner refuses to quote a deposit above the cap", () => {
  const under: Limits = { budget: 90n * KAS, maxPerSpend: KAS, epochLimit: KAS, epochLength: 1000n, days: 7 };
  assert.equal(checkLimits(under), null, "90 KAS is inside the 100 KAS cap");

  /* The cap is on the DEPOSIT, not the budget, and the two differ: the
     deposit adds the genesis fee and a tenth of the budget as a spend
     buffer. So a budget under the cap can still be refused, which is the
     case worth pinning — it is the one somebody would get wrong by checking
     the friendlier number. */
  const over: Limits = { ...under, budget: 95n * KAS };
  assert.ok(requiredDeposit(over) > MAX_DEPOSIT_DEFAULT, "a 95 KAS budget needs more than 100 KAS deposited");
  const why = checkLimits(over);
  assert.ok(why && why.includes("will not quote above"), `expected a refusal naming the cap, got ${why}`);
});

test("there is no value of RUNNER_MAX_DEPOSIT that turns the cap off", () => {
  const prev = process.env.RUNNER_MAX_DEPOSIT;
  try {
    for (const bad of ["0", "-1"]) {
      process.env.RUNNER_MAX_DEPOSIT = bad;
      assert.throws(() => maxDeposit(), /no value that disables this cap/, `${bad} must be refused`);
    }
    process.env.RUNNER_MAX_DEPOSIT = "not-a-number";
    assert.throws(() => maxDeposit(), /not a number of sompi/);

    process.env.RUNNER_MAX_DEPOSIT = "5000000000";
    assert.equal(maxDeposit(), 5_000_000_000n, "a deliberate figure is honoured");

    delete process.env.RUNNER_MAX_DEPOSIT;
    assert.equal(maxDeposit(), MAX_DEPOSIT_DEFAULT, "absent means the default, not unlimited");
  } finally {
    if (prev === undefined) delete process.env.RUNNER_MAX_DEPOSIT;
    else process.env.RUNNER_MAX_DEPOSIT = prev;
  }
});
