import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { GrantWatcher } from "../src/watch.ts";
import { attachSignature, buildUnsignedSpend, successorState } from "../src/spend.ts";
import { attachExitSignature, buildUnsignedExit } from "../src/exit.ts";
import { scriptHashToAddress, decodeAddress } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { EMPTY_RESERVE } from "../src/keys.ts";
import { scriptHashFor, templateIdFor, type CovenantTemplate, type Grant } from "../src/template.ts";
import { payToScriptHashScript } from "../src/tx.ts";
import { transactionToWire } from "../src/node.ts";

/**
 * A watcher that follows a grant.
 *
 * The naive thing — watch the address — fails on the first spend, because a
 * grant's address is a hash of its state. Worse, it fails LOUDLY and wrongly:
 * an empty address is what a drained grant looks like, and what a revoked one
 * looks like, and what a grant that was never funded looks like. So these
 * tests are mostly about the watcher moving its own cursor correctly, and
 * about it saying "lost" when it genuinely cannot.
 *
 * The node is faked, because what is being tested is the following, not the
 * transport — and a fake lets a spend be put in the mempool on demand, which
 * a testnet does not.
 */

const tpl: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

const AGENT = "3c693f61fbc35d1fd4dcec2bbbab692be38656e6fd5a4077ee495afcb23535a1";
const PRINCIPAL = "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f";
const VENDOR = "kaspatest:qrn33jmrmhwjjey5m2khdlun9a6e20c02z4rq060n8gy43s9zmt5q8hpd8ym5";
const COVENANT_ID = "221dc89d6f998cd9699125a79bb0b0071513837399fa5d8835e8585a5b9b0df4";

const authority = { principalKey: PRINCIPAL, revocationKey: PRINCIPAL };
const state0 = {
  agentKey: AGENT,
  budgetTotal: 300_000_000n,
  maxPerSpend: 50_000_000n,
  epochLimit: 100_000_000n,
  epochLength: 1_000n,
  recipientsRoot: "db0a707b658f29fd8903a7f3815f63f962ec3a4e66528d3e11ba150a5fd4f0b5",
  notBefore: 558_974_403n,
  expiresAt: 584_894_403n,
  delegationDepth: 2n,
  templateId: templateIdFor(tpl, authority),
  spentTotal: 0n,
  reserved: 0n,
  epochIndex: 0n,
  epochSpent: 0n,
  reserveRoot: EMPTY_RESERVE,
};
const grant0: Grant = { authority, state: state0 };
const addr = (g: Grant) => scriptHashToAddress(scriptHashFor(tpl, g), "kaspatest");

function utxoAt(g: Grant, value: bigint, txid = "11".repeat(32)) {
  return {
    address: addr(g),
    outpoint: { transactionId: fromHex(txid), index: 0 },
    entry: {
      value,
      scriptPublicKey: payToScriptHashScript(fromHex(scriptHashFor(tpl, g))),
      blockDaaScore: 558_979_000n,
      isCoinbase: false,
      covenantId: fromHex(COVENANT_ID),
    },
  };
}

/** A real spend, in the shape a node's mempool reports one. */
function spendTx(g: Grant, amount: bigint, claimedDaa: bigint, value = 300_000_000n) {
  const plan = {
    template: tpl,
    authority: g.authority,
    state: g.state,
    amount,
    recipient: decodeAddress(VENDOR).payload,
    proof: { siblings: [], left: [] },
    claimedDaa,
    fee: 2_000_000n,
    utxo: {
      outpointTransactionId: fromHex("11".repeat(32)),
      outpointIndex: 0,
      value,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: fromHex(COVENANT_ID),
    },
    computeBudget: 1_000_000,
  };
  const u = buildUnsignedSpend(plan);
  const signed = attachSignature(plan, u, new Uint8Array(65));
  return { ...transactionToWire(signed), verboseData: { transactionId: "aa".repeat(32) } };
}

function exitTx(g: Grant, value = 300_000_000n) {
  const plan = {
    kind: "revoke" as const,
    template: tpl,
    authority: g.authority,
    state: g.state,
    utxo: {
      outpointTransactionId: fromHex("11".repeat(32)),
      outpointIndex: 0,
      value,
      blockDaaScore: 0n,
      isCoinbase: false,
      covenantId: fromHex(COVENANT_ID),
    },
    fee: 1_000_000n,
    computeBudget: 16,
    lockTime: 0n,
  };
  const u = buildUnsignedExit(plan);
  const signed = attachExitSignature(plan, u, new Uint8Array(65));
  return { ...transactionToWire(signed), verboseData: { transactionId: "bb".repeat(32) } };
}

/** A node that answers only what the watcher asks, and holds what we put in it. */
function fakeNode(opts: { utxos?: Record<string, unknown[]>; mempool?: unknown[]; noMempoolRpc?: boolean }) {
  let mempool = opts.mempool ?? [];
  const utxos = opts.utxos ?? {};
  const node = {
    connection: {
      url: "ws://fake",
      async call(method: string, params: any) {
        if (method !== "getMempoolEntriesByAddresses") throw new Error(`unexpected ${method}`);
        if (opts.noMempoolRpc) throw new Error("method not supported");
        return {
          entries: [{ address: params.addresses[0], sending: mempool.map((t) => ({ transaction: t })), receiving: [] }],
        };
      },
    },
    async getUtxosByAddresses(addresses: string[]) {
      return (utxos[addresses[0]!] ?? []) as any[];
    },
    setMempool(t: unknown[]) { mempool = t; },
    setUtxos(a: string, u: unknown[]) { utxos[a] = u; },
  };
  return node as any;
}

// ---- following -----------------------------------------------------------

test("a grant sitting still is reported live, not lost", async () => {
  const node = fakeNode({ utxos: { [addr(grant0)]: [utxoAt(grant0, 300_000_000n)] } });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0 });
  const r = await w.poll();
  assert.equal(r.lost, false);
  assert.equal(r.live?.entry.value, 300_000_000n);
  assert.deepEqual(r.transitions, []);
});

test("a spend in the mempool moves the watcher's cursor before it confirms", async () => {
  const claimed = 558_979_403n;
  const tx = spendTx(grant0, 20_000_000n, claimed);
  const next = { authority, state: successorState(state0, 20_000_000n, claimed) };
  const node = fakeNode({
    mempool: [tx],
    utxos: { [addr(grant0)]: [], [addr(next)]: [utxoAt(next, 278_000_000n)] },
  });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0 });
  const r = await w.poll();

  assert.equal(r.transitions.length, 1);
  const t = r.transitions[0]!;
  assert.equal(t.kind, "spend");
  assert.equal(t.amount, 20_000_000n);
  assert.equal(t.fromAddress, addr(grant0));
  assert.equal(t.toAddress, addr(next));
  // And the cursor followed: the grant is live at the NEW address, so the
  // watcher must not report a loss.
  assert.equal(w.address, addr(next));
  assert.equal(r.lost, false);
  assert.equal(r.live?.entry.value, 278_000_000n);
});

test("the state is read from the transaction, not from what the watcher believed", async () => {
  // The watcher is started with a STALE cursor — a grant that has already
  // spent. The transaction still carries the truth, so `from` is the real
  // spent state rather than the watcher's guess.
  const stale = { authority, state: { ...state0, spentTotal: 99_999n } };
  const tx = spendTx(grant0, 20_000_000n, 558_979_403n);
  const node = fakeNode({ mempool: [tx], utxos: {} });
  const w = new GrantWatcher(node, { template: tpl, grant: stale });
  const r = await w.poll();
  assert.equal(r.transitions[0]!.from.state.spentTotal, 0n);
  assert.equal(r.transitions[0]!.fromAddress, addr(grant0));
});

test("an empty address with nothing to explain it is reported LOST, not drained", async () => {
  const node = fakeNode({ utxos: {} });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0 });
  const r = await w.poll();
  assert.equal(r.lost, true);
  const a = r.alerts.find((x) => x.rule === "lost")!;
  // The distinction that matters: an empty address is not evidence of loss.
  assert.match(a.detail, /not necessarily gone/);
  assert.match(a.detail, /recover-grant/);
});

test("a node that will not answer the mempool leaves the watcher honest, not wrong", async () => {
  const node = fakeNode({ noMempoolRpc: true, utxos: {} });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0 });
  const r = await w.poll();
  assert.equal(r.lost, true);
  assert.equal(r.transitions.length, 0);
});

test("a revocation is recognised as the end, with no successor invented", async () => {
  const node = fakeNode({ mempool: [exitTx(grant0)], utxos: {} });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0 });
  const r = await w.poll();
  assert.equal(r.transitions[0]!.kind, "exit");
  assert.equal(r.transitions[0]!.toAddress, null);
  assert.ok(r.alerts.some((a) => a.rule === "ended"));
});

test("the same mempool transaction is not reported twice", async () => {
  const tx = spendTx(grant0, 20_000_000n, 558_979_403n);
  const node = fakeNode({ mempool: [tx], utxos: {} });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0 });
  assert.equal((await w.poll()).transitions.length, 1);
  assert.equal((await w.poll()).transitions.length, 0);
});

// ---- rules ---------------------------------------------------------------

test("a spend the covenant allows can still be a breach here", async () => {
  const tx = spendTx(grant0, 20_000_000n, 558_979_403n);
  const node = fakeNode({ mempool: [tx], utxos: {} });
  const w = new GrantWatcher(node, {
    template: tpl,
    grant: grant0,
    rules: { maxSpendSompi: 5_000_000n },
  });
  const b = (await w.poll()).alerts.find((a) => a.rule === "maxSpend")!;
  assert.equal(b.severity, "breach");
  // The gap a watcher exists to police: permitted, and not what you expected.
  assert.match(b.detail, /The covenant allowed it/);
});

test("rate is the signal a per-spend cap cannot give you", async () => {
  const node = fakeNode({ mempool: [], utxos: {} });
  const w = new GrantWatcher(node, {
    template: tpl,
    grant: grant0,
    rules: { rateLimit: { count: 2, windowMs: 60_000 } },
  });
  let breach;
  let g = grant0;
  for (let i = 0; i < 4; i++) {
    const claimed = 558_979_403n;
    const tx = spendTx(g, 1_000_000n, claimed, 300_000_000n);
    // A distinct id each round, so the dedupe does not swallow them.
    tx.verboseData = { transactionId: i.toString(16).padStart(2, "0").repeat(32) };
    node.setMempool([tx]);
    const r = await w.poll();
    breach = breach ?? r.alerts.find((a) => a.rule === "rate");
    g = r.transitions[0]?.to ?? g;
  }
  assert.ok(breach, "four spends against a limit of two should breach");
  // Every one of them was inside the per-spend cap, which is exactly what a
  // drain by a compromised agent looks like.
  assert.match(breach!.detail, /within the per-spend cap/);
});

test("a delegation is a notice by default and a breach when forbidden", async () => {
  // Shape alone: two outputs, the second a covenant. Built by hand because a
  // real delegation needs a child key and this is about classification.
  const tx = spendTx(grant0, 20_000_000n, 558_979_403n) as any;
  tx.outputs[1].scriptPublicKey = "0000" + "aa20" + "cc".repeat(32) + "87";
  const node = fakeNode({ mempool: [tx], utxos: {} });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0, rules: { forbidDelegation: true } });
  const r = await w.poll();
  assert.equal(r.transitions[0]!.kind, "delegation");
  assert.equal(r.transitions[0]!.followable, false);
  assert.equal(r.alerts.find((a) => a.rule === "delegation")!.severity, "breach");
});

// ---- arming --------------------------------------------------------------

test("a revocation can be built for exactly where the grant is now", async () => {
  const live = utxoAt(grant0, 300_000_000n);
  const node = fakeNode({ utxos: { [addr(grant0)]: [live] } });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0 });
  const r = await w.poll();
  const { plan, unsigned } = w.armRevocation(r.live!);
  assert.equal(unsigned.sighash.length, 32);
  assert.equal(unsigned.tx.outputs.length, 1, "a revocation sweeps to one output");
  assert.equal(unsigned.signingKey, "revocationKey");
  // The plan comes back with it: attaching a signature rebuilds the signature
  // script from the plan, so returning only the unsigned half would leave the
  // caller casting something plan-shaped into place — which typechecks and
  // produces a transaction that fails at the input.
  assert.equal(plan.kind, "revoke");
  assert.equal(plan.lockTime, 0n);
});

test("arming against somebody else's UTXO is refused", async () => {
  const other = { authority, state: { ...state0, spentTotal: 1n } };
  const live = utxoAt(other, 300_000_000n);
  const node = fakeNode({ utxos: { [addr(grant0)]: [live] } });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0 });
  // Signing over a coin this watcher is not following is the one mistake an
  // armed watcher must never be able to make.
  assert.throws(() => w.armRevocation(live as any), /not the grant this watcher is following/);
});

test("arming against a UTXO with no covenant id is refused", async () => {
  const live = utxoAt(grant0, 300_000_000n);
  const stripped = { ...live, entry: { ...live.entry, covenantId: undefined } };
  const node = fakeNode({ utxos: { [addr(grant0)]: [stripped] } });
  const w = new GrantWatcher(node, { template: tpl, grant: grant0 });
  // A revocation with no binding is well-formed, signed, and refused by every
  // node that knows about covenants — which reads as a covenant bug.
  assert.throws(() => w.armRevocation(stripped as any), /no covenant id/);
});
