/**
 * Giving a helper's unused budget back to its parent.
 *
 * Settlement spends BOTH grants in one transaction: the parent runs
 * `reabsorb`, signed by the parent's AGENT key (the runner holds it, in
 * Turnkey), and the helper runs `settle`, signed by the owner's REVOCATION key
 * — which the runner never holds, by design. So this is two steps:
 *
 *   1. The runner builds the transaction, signs the parent's half, and hands
 *      the owner a document with everything needed to rebuild it.
 *   2. The owner's own machine rebuilds it from that document, checks what it
 *      would sign (how much comes back, to which grant), signs the helper's
 *      half with the revocation key, and sends the signature back. The runner
 *      checks it against the revocation key, joins the halves and broadcasts.
 *
 * The covenant decides the rest: the parent's reserve is released, what the
 * helper spent is charged to the parent, and the helper's coin lands in the
 * parent. LIFO: only the most recently created helper of a parent can be
 * returned (the reserve is a hash chain).
 */
import { templateFor } from "@warda_protocol/kaspa/templates";
import {
  attachReabsorbSignatures,
  buildUnsignedReabsorb,
  fromHex,
  scriptHashFor,
  scriptHashToAddress,
  templateFingerprint,
  toHex,
  toWireMulti,
  verifyDigest,
  type CovenantTemplate,
  type GrantState,
  type NetworkPrefix,
  type ReabsorbPlan,
} from "@warda_protocol/kaspa";
import { formatKas } from "@warda_protocol/core";
import { toGrant, type Manifest } from "@warda_protocol/agent";
import { randomBytes } from "node:crypto";
import type { Registry, GrantRecord } from "./registry.ts";
import type { KeyVault } from "./vault.ts";
import type { FundingChain } from "./funding.ts";
import type { Store } from "./store.ts";

/* Resolved per GRANT, at the point of use.
   A module-level `const TEMPLATE = <the packaged one>` is what stopped the
   agent fleet on 25 September: it makes the covenant a property of the
   installation rather than of the grant, and every address derived from the
   pair is well-formed and empty. A runner outlives a covenant freeze by
   definition — it holds grants issued months apart — so this is the file where
   one pinned template is least defensible. */
export const SETTLE_FEE = 5_000_000n;
const COMPUTE_BUDGET = 24;
const TTL_MS = 30 * 60_000;

const BIG: (keyof GrantState)[] = ["budgetTotal", "maxPerSpend", "epochLimit", "epochLength", "notBefore", "expiresAt",
  "delegationDepth", "spentTotal", "reserved", "epochIndex", "epochSpent"];
const stateOut = (s: GrantState) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
export const stateIn = (o: Record<string, unknown>): GrantState =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, BIG.includes(k as keyof GrantState) ? BigInt(String(v)) : v])) as unknown as GrantState;

interface Coin { txid: string; index: number; value: string; blockDaaScore: string; isCoinbase: boolean; covenantId: string }
const coinIn = (c: Coin) => ({
  outpointTransactionId: fromHex(c.txid), outpointIndex: c.index, value: BigInt(c.value),
  blockDaaScore: BigInt(c.blockDaaScore), isCoinbase: c.isCoinbase, covenantId: fromHex(c.covenantId),
});

/** What the owner signs from. Everything in it is public; nothing in it is a key. */
export interface ReturnDoc {
  kind: "warda-return";
  version: 1;
  id: string;
  runner: string;
  prefix: string;
  template: string;
  parent: { agent: string; address: string };
  child: { agent: string; address: string };
  authority: { principalKey: string; revocationKey: string };
  parentState: Record<string, unknown>;
  childState: Record<string, unknown>;
  prevRoot: string;
  parentUtxo: Coin;
  childUtxo: Coin;
  fee: string;
  computeBudget: number;
  childSighash: string;
  says: string;
  expiresAt: number;
}

/**
 * The plan a return document describes.
 *
 * `template` is taken from the DOCUMENT, which has always carried the
 * fingerprint of the covenant the settlement was built under — it just was not
 * read back. The old code pinned the packaged template here, so a return doc
 * written before a covenant freeze and countersigned after it would rebuild the
 * plan under different bytecode and derive addresses neither party agreed to.
 * The field was in the document for exactly this and nothing used it.
 */
export function planOf(doc: Pick<ReturnDoc, "template" | "authority" | "parentState" | "childState" | "prevRoot" | "parentUtxo" | "childUtxo" | "fee" | "computeBudget">): ReabsorbPlan {
  return {
    template: templateFor({ covenant: doc.template }, "this return document"),
    authority: doc.authority,
    parentState: stateIn(doc.parentState),
    childState: stateIn(doc.childState),
    prevRoot: doc.prevRoot,
    parentUtxo: coinIn(doc.parentUtxo),
    childUtxo: coinIn(doc.childUtxo),
    fee: BigInt(doc.fee),
    computeBudget: doc.computeBudget,
  };
}

export async function prepareReturn(o: {
  registry: Registry; vault: KeyVault; chain: FundingChain; prefix: NetworkPrefix;
  child: string; runnerUrl: string; now: number;
}): Promise<ReturnDoc> {
  const c = await o.registry.getGrant(o.child);
  if (!c?.parent) throw new Error(`${o.child} is not a helper; only a helper's budget can be returned to a parent`);
  const p = await o.registry.getGrant(c.parent);
  if (!p) throw new Error(`${c.parent} has no grant on record`);
  const cm = c.manifest as Manifest, pm = p.manifest as Manifest;
  const prevRoot = String(cm.parent_reserve_root_before ?? "");
  if (!/^[0-9a-f]{64}$/.test(prevRoot)) throw new Error("this helper's record does not say where its parent's reserve stood; it cannot be returned automatically");
  /* One template for BOTH, and checked. A settlement is a single transaction
     spending the child and the parent together, so they cannot be under
     different covenants — and if the records say they are, that is a fact worth
     refusing on rather than deriving two addresses from. */
  const TEMPLATE = templateFor(pm, `${c.parent}'s grant`);
  if (cm.covenant && pm.covenant && cm.covenant !== pm.covenant) {
    throw new Error(
      `${o.child} was issued under covenant ${cm.covenant} and its parent ${c.parent} under ` +
        `${pm.covenant}. A settlement spends both in one transaction, so it cannot span two ` +
        `covenants; the records disagree and nothing has been built.`,
    );
  }
  const cg = toGrant(cm, c.recipients, TEMPLATE), pg = toGrant(pm, p.recipients, TEMPLATE);
  const where = (g: typeof cg) => scriptHashToAddress(scriptHashFor(TEMPLATE, { authority: g.authority, state: g.state }), o.prefix);
  const pAddr = where(pg), cAddr = where(cg);
  const [pu, cu] = await Promise.all([o.chain.utxos(pAddr), o.chain.utxos(cAddr)]);
  const pc = pu.find((u) => u.entry.covenantId), cc = cu.find((u) => u.entry.covenantId);
  if (!pc) throw new Error(`${c.parent}'s grant is not at its recorded address this moment — a payment may be in flight. Try again in a minute.`);
  if (!cc) throw new Error(`${o.child}'s grant is not at its recorded address this moment — a payment may be in flight, or it was already returned or revoked.`);
  const coin = (u: typeof pc): Coin => ({
    txid: toHex(u.outpoint.transactionId), index: u.outpoint.index, value: u.entry.value.toString(),
    blockDaaScore: u.entry.blockDaaScore.toString(), isCoinbase: u.entry.isCoinbase, covenantId: toHex(u.entry.covenantId!),
  });
  const base = {
    /* The covenant both halves are under, stated in the document so that
       whoever countersigns it rebuilds the same plan — see planOf. */
    template: templateFingerprint(TEMPLATE),
    authority: pg.authority, parentState: stateOut(pg.state), childState: stateOut(cg.state), prevRoot,
    parentUtxo: coin(pc), childUtxo: coin(cc), fee: SETTLE_FEE.toString(), computeBudget: COMPUTE_BUDGET,
  };
  const plan = planOf(base);
  const built = buildUnsignedReabsorb(plan);
  const parentSig = await (await o.vault.signer(c.parent))(built.parentSighash);
  if (!verifyDigest(parentSig, built.parentSighash, fromHex(pg.state.agentKey))) throw new Error("the parent's signature did not verify; nothing was prepared");
  const left = cg.state.budgetTotal - cg.state.spentTotal;
  const doc: ReturnDoc = {
    kind: "warda-return", version: 1, id: `ret_${randomBytes(12).toString("hex")}`,
    runner: o.runnerUrl, prefix: o.prefix,
    parent: { agent: c.parent, address: pAddr }, child: { agent: o.child, address: cAddr },
    ...base,
    childSighash: toHex(built.childSighash),
    says: `Return ${o.child}'s unused ${formatKas(left)} KAS of budget to ${c.parent}. ${o.child}'s grant ends; ${c.parent}'s reserve is released ` +
      `and ${formatKas(cg.state.spentTotal)} KAS it spent is charged to ${c.parent}. ${formatKas(built.recovered)} KAS of coin lands in ${c.parent}'s grant.`,
    expiresAt: o.now + TTL_MS,
  };
  await o.registry.setMeta(`return:${doc.id}`, JSON.stringify({ doc, parentSig: toHex(parentSig) }));
  return doc;
}

export async function completeReturn(o: {
  registry: Registry; store: Store; chain: FundingChain; id: string; signature: string; now: number;
}): Promise<{ txid: string; parent: string; child: string; recoveredKas: string }> {
  const raw = await o.registry.getMeta(`return:${o.id}`);
  if (!raw) throw new Error("no such return, or it was already completed");
  const { doc, parentSig } = JSON.parse(raw) as { doc: ReturnDoc; parentSig: string };
  if (o.now > doc.expiresAt) throw new Error("this return expired; prepare it again (the grants may have moved since)");
  const sig = fromHex(o.signature.trim().toLowerCase());
  const plan = planOf(doc);
  const built = buildUnsignedReabsorb(plan);
  if (toHex(built.childSighash) !== doc.childSighash) throw new Error("the transaction does not rebuild to what was prepared; nothing was sent");
  if (sig.length !== 65 || !verifyDigest(sig, built.childSighash, fromHex(doc.authority.revocationKey))) {
    throw new Error("that signature is not the revocation key's over this return; nothing was sent");
  }
  const tx = attachReabsorbSignatures(plan, built, fromHex(parentSig), sig);
  const txid = toWireMulti(tx, built.entries, "@warda_protocol/runner (return)").txid;

  const [p, c] = await Promise.all([o.registry.getGrant(doc.parent.agent), o.registry.getGrant(doc.child.agent)]);
  if (!p || !c) throw new Error("the grants on record changed; prepare the return again");
  const s = built.successorState;
  const parentNext: GrantRecord = {
    ...p,
    manifest: { ...p.manifest, spent_total: Number(s.spentTotal), reserved: Number(s.reserved), reserve_root: s.reserveRoot,
      epoch_index: Number(s.epochIndex), epoch_spent: Number(s.epochSpent), grant_value: Number(built.recovered) } as Manifest,
    updatedAt: o.now,
  };
  // WRITTEN BEFORE BROADCAST: the parent's next address derives from this state.
  await o.registry.putGrant(parentNext);
  await o.registry.deleteGrant(doc.child.agent);
  try {
    await o.chain.submit(tx);
  } catch (e) {
    const msg = (e as Error).message;
    if (!/already|in the mempool/i.test(msg)) {
      await o.registry.putGrant(p);
      await o.registry.putGrant(c);
      throw new Error(`the network did not take the return: ${msg}. Nothing moved; prepare it again.`);
    }
  }
  for (const wf of await o.store.listWorkflows(doc.child.agent)) if (wf.enabled) await o.store.putWorkflow({ ...wf, enabled: false });
  await o.registry.setMeta(`return:${o.id}`, "");
  await o.registry.setMeta(`returned:${doc.child.agent}`, JSON.stringify({ txid, to: doc.parent.agent, at: o.now }));
  return { txid, parent: doc.parent.agent, child: doc.child.agent, recoveredKas: formatKas(built.recovered) };
}
