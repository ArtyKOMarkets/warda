/**
 * The paid path, with no chain and no money.
 *
 * The unit tests stop before anything is signed, which leaves the branch that
 * can actually lose money untested: a purchase that pays. This drives the real
 * Agent against the fake kaspad and the fake 402 vendor the buy path already
 * uses — a WebSocket node you can lie to, and a vendor whose mode changes
 * between requests.
 *
 * The test that matters is the second one. A vendor that takes the money and
 * then fails to serve is the case this package's ordering exists for, and it
 * is not reachable from a unit test because nothing has been paid.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };
import {
  EMPTY_RESERVE, fromHex, payToScriptHashScript, scriptHashFor, scriptHashToAddress,
  scriptPublicKeyToWire, templateIdFor, type CovenantTemplate,
} from "@warda_protocol/kaspa";
import { startFakeNode, type FakeNode } from "../../test/harness/fake-node.ts";
import { startFakeVendor } from "../../test/harness/fake-vendor.ts";

import { Agent } from "../src/agent.ts";
import { memoryStore, type Manifest } from "../src/store.ts";
import { toGrant } from "../src/grant.ts";

const repo = (p: string) => fileURLToPath(new URL("../../" + p, import.meta.url));
const MANIFEST = JSON.parse(readFileSync(repo("covenant/deploy/grant-demo.json"), "utf8")) as Manifest;
const RECIPIENTS = readFileSync(repo("covenant/deploy/demo-recipients.txt"), "utf8").split(/\r?\n/);
const TEMPLATE = covenantTemplate as unknown as CovenantTemplate;
/* Published on /attack on purpose: the covenant bounds this key, not secrecy. */
const SECRET = fromHex("9fccfb08645b4a5a49f0f461b9ae7209865c234f941e9d4679e8a18da77af2ad");

/** Put the grant's coin where the covenant will look for it. */
function fund(node: FakeNode, m: Manifest): void {
  const { authority, state } = toGrant(m, RECIPIENTS, TEMPLATE);
  const hash = scriptHashFor(TEMPLATE, { authority, state });
  node.utxos = [{
    address: scriptHashToAddress(hash, "kaspatest"),
    transactionId: "aa".repeat(32),
    index: 0,
    amount: BigInt(m.grant_value),
    scriptPublicKey: scriptPublicKeyToWire(payToScriptHashScript(fromHex(hash))),
    blockDaaScore: 1n,
    covenantId: m.covenant_id,
  }];
  /* Far enough along that the claimed epoch is not BEHIND the one the record
     holds. The covenant refuses a spend claiming an earlier epoch — the index
     only moves forward — and this is a real manifest that has been spending
     for weeks. */
  node.daaScore = BigInt(m.not_before) + (BigInt(m.epoch_index) + 1n) * BigInt(m.epoch_length);
}

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const c of closers) await c();
});

async function bench() {
  const node = await startFakeNode();
  const vendor = await startFakeVendor();
  /* Arrow-wrapped: these are methods, and pushing them detached loses `this`,
     which leaves both servers listening and the test runner never exits. */
  closers.push(() => node.close(), () => vendor.close());
  fund(node, MANIFEST);
  const store = memoryStore(MANIFEST);
  const agent = await Agent.open({
    store,
    recipients: RECIPIENTS,
    sign: SECRET,
    url: node.url,
    networkId: "testnet-10",
    template: TEMPLATE,
  });
  closers.push(() => agent.close());
  return { node, vendor, store, agent };
}

test("a purchase pays, is served, and advances the record exactly once", async () => {
  const { node, vendor, store, agent } = await bench();

  const before = store.current();
  const out = await agent.fetch(vendor.url);

  assert.equal(out.response.status, 200);
  assert.ok(out.paid, "a 402 that was served must report what it cost");
  assert.ok(vendor.served.includes(out.paid.txid), "the vendor served against this payment");
  assert.equal(node.submitted.length, 1, "one purchase is one transaction");

  const after_ = store.current();
  assert.ok(after_.spent_total > before.spent_total, "the budget was charged");
  /* The coin loses payment AND fee; the budget only the payment. Getting this
     wrong drifts by one fee per purchase and is invisible until something
     reconciles against the chain. */
  assert.equal(
    after_.grant_value,
    before.grant_value - Number(out.paid.amountSompi) - Number(agent.fee),
  );
  assert.equal(
    after_.spent_total - before.spent_total,
    Number(out.paid.amountSompi),
    "the budget is charged the payment, not the payment plus the fee",
  );
});

test("a vendor that takes the money and does not serve leaves the record alone", async () => {
  const { node, vendor, store, agent } = await bench();
  const before = store.current();

  /* `late`, not `down`. A vendor that is down never quotes, so nothing is
     paid and there is nothing to get wrong. `late` quotes, accepts the
     payment, and then answers every re-presentation with "still settling" —
     money on chain, goods not delivered, which is the case this package's
     ordering exists for.
     
     One attempt, because the default is measured in seconds and the branch
     under test is what happens when they run out. */
  vendor.mode = "late";
  await assert.rejects(() => agent.fetch(vendor.url, undefined, { maxSettleAttempts: 1 }));

  assert.equal(node.submitted.length, 1, "the payment really was broadcast");
  assert.deepEqual(
    store.current(),
    before,
    "an undelivered purchase is a debt to collect, and the proof needed to collect it " +
      "is lost the moment the record is advanced past it",
  );
  /* And the in-memory grant HAS moved, which is the asymmetry: the wallet
     knows more than the record does, and that is the recoverable direction. */
  assert.ok(agent.state.spentTotal > BigInt(before.spent_total));
});

test("the record is advanced, not replaced — unmodelled fields survive", async () => {
  const { vendor, store, agent } = await bench();
  await agent.fetch(vendor.url);
  const after_ = store.current();
  assert.equal(after_.covenant_id, MANIFEST.covenant_id);
  assert.equal(after_.principal, MANIFEST.principal);
  assert.equal(after_.recipients_root, MANIFEST.recipients_root);
});
