/**
 * Sub-agents: an agent hands part of its budget to a helper, and every Kaspa
 * node enforces the split.
 *
 * A delegation is one transaction from the parent's grant, signed by the
 * PARENT's agent key (the runner holds it, in Turnkey): the parent continues
 * with that budget reserved, and a child grant is born with it. The child may
 * only ever be narrower — less budget, a lower or equal cap, a shorter term,
 * the same payees — and it has the same OWNER keys as the parent, so the owner
 * can revoke or reclaim either. The runner holds the child's agent key too,
 * which is what makes it a hosted agent like any other: jobs, runs, MCP.
 *
 * A grant can delegate only if it was made with room to (delegation depth
 * above 0). Hosted grants made before sub-agents existed had none; a top-up
 * makes a successor that has.
 */
import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };
import {
  attachDelegationSignature,
  buildUnsignedDelegation,
  scriptHashFor,
  scriptHashToAddress,
  toHex,
  toWire,
  verifyDigest,
  fromHex,
  EMPTY_RESERVE,
  type CovenantTemplate,
  type NetworkPrefix,
} from "@warda_protocol/kaspa";
import { toGrant, type Manifest } from "@warda_protocol/agent";
import type { Registry } from "./registry.ts";
import type { KeyVault } from "./vault.ts";
import type { FundingChain } from "./funding.ts";

const TEMPLATE = covenantTemplate as unknown as CovenantTemplate;
const DAA_PER_DAY = 864_000n;
export const DELEGATION_FEE = 2_000_000n;
const DELEGATE_COMPUTE_BUDGET = 24;

export interface SubAgentTerms {
  budget: bigint;
  maxPerSpend: bigint;
  epochLimit?: bigint;
  /** Shorter than the parent's remaining term; omitted, the child ends when the parent does. */
  days?: number;
}

export async function delegate(o: {
  registry: Registry;
  vault: KeyVault;
  chain: FundingChain;
  prefix: NetworkPrefix;
  parent: string;
  child: string;
  terms: SubAgentTerms;
  now: number;
}): Promise<{ txid: string; childAddress: string; parentAddress: string; childManifest: Manifest }> {
  const rec = await o.registry.getGrant(o.parent);
  if (!rec) throw new Error(`${o.parent} has no grant`);
  const m = rec.manifest as Manifest;
  if (!(Number(m.delegation_depth ?? 0) > 0)) {
    throw new Error(
      `${o.parent}'s grant was made without room for sub-agents. Top it up: the new grant allows them, ` +
        `and the agent, its jobs and its payees stay the same.`,
    );
  }
  const g = toGrant(m, rec.recipients, TEMPLATE);
  const address = scriptHashToAddress(scriptHashFor(TEMPLATE, { authority: g.authority, state: g.state }), o.prefix);
  const coin = (await o.chain.utxos(address)).find((u) => u.entry.covenantId);
  if (!coin) {
    throw new Error(`${o.parent}'s grant is not at its recorded address this moment — a payment may be in flight. Try again in a minute.`);
  }
  const childKey = await o.vault.publicKey(o.child) ?? await o.vault.create(o.child);

  const window: { notBefore?: bigint; expiresAt?: bigint } = {};
  if (o.terms.days !== undefined) {
    const daa = await o.chain.daa();
    const end = daa + BigInt(Math.max(1, Math.round(o.terms.days))) * DAA_PER_DAY;
    window.notBefore = g.state.notBefore;
    window.expiresAt = end < g.state.expiresAt ? end : g.state.expiresAt;
  }
  const plan = {
    template: TEMPLATE,
    authority: g.authority,
    state: g.state,
    utxo: {
      outpointTransactionId: coin.outpoint.transactionId,
      outpointIndex: coin.outpoint.index,
      value: coin.entry.value,
      blockDaaScore: coin.entry.blockDaaScore,
      isCoinbase: coin.entry.isCoinbase,
      covenantId: coin.entry.covenantId!,
    },
    child: {
      agentKey: childKey,
      budgetTotal: o.terms.budget,
      maxPerSpend: o.terms.maxPerSpend,
      epochLimit: o.terms.epochLimit ?? (o.terms.maxPerSpend * 5n < g.state.epochLimit ? o.terms.maxPerSpend * 5n : g.state.epochLimit),
      delegationDepth: g.state.delegationDepth - 1n,
      ...window,
    },
    recipients: g.recipients,
    fee: DELEGATION_FEE,
    computeBudget: DELEGATE_COMPUTE_BUDGET,
  };
  const built = buildUnsignedDelegation(plan);
  const sig = await (await o.vault.signer(o.parent))(built.sighash);
  if (!verifyDigest(sig, built.sighash, fromHex(g.state.agentKey))) throw new Error("the parent's signature did not verify; nothing was sent");
  const tx = attachDelegationSignature(plan, built, sig);
  const txid = toWire(tx, built.entry, "@warda_protocol/runner (delegation)").txid;

  const c = built.childState;
  const childAddress = scriptHashToAddress(scriptHashFor(TEMPLATE, { authority: g.authority, state: c }), o.prefix);
  const childManifest: Manifest = {
    covenant: m.covenant,
    covenant_id: m.covenant_id,
    agent: c.agentKey,
    principal: g.authority.principalKey,
    revocation: g.authority.revocationKey,
    parent_agent: g.state.agentKey,
    parent_txid: txid,
    parent_reserve_root_before: g.state.reserveRoot,
    recipients_root: c.recipientsRoot,
    not_before: Number(c.notBefore),
    expires_at: Number(c.expiresAt),
    budget: Number(c.budgetTotal),
    max_per_spend: Number(c.maxPerSpend),
    epoch_limit: Number(c.epochLimit),
    epoch_length: Number(c.epochLength),
    delegation_depth: Number(c.delegationDepth),
    grant_value: Number(o.terms.budget),
    spent_total: 0,
    reserved: 0,
    epoch_index: 0,
    epoch_spent: 0,
    reserve_root: EMPTY_RESERVE,
    funded_by: `delegation from ${o.parent}`,
  };
  const ps = built.parentSuccessorState;
  const parentManifest: Manifest = {
    ...m,
    spent_total: Number(ps.spentTotal),
    reserved: Number(ps.reserved),
    epoch_index: Number(ps.epochIndex),
    epoch_spent: Number(ps.epochSpent),
    reserve_root: ps.reserveRoot,
    grant_value: Number(built.parentChange),
  };
  const parentAddress = scriptHashToAddress(scriptHashFor(TEMPLATE, { authority: g.authority, state: ps }), o.prefix);

  // WRITTEN BEFORE BROADCAST: both grants' addresses derive from these states.
  await o.registry.putGrant({ agent: o.child, manifest: childManifest, recipients: rec.recipients, updatedAt: o.now, parent: o.parent });
  await o.registry.putGrant({ ...rec, manifest: parentManifest, updatedAt: o.now });
  try {
    await o.chain.submit(tx);
  } catch (e) {
    const msg = (e as Error).message;
    if (!/already|in the mempool/i.test(msg)) {
      // Not sent: the parent is where it was, and the child never existed.
      await o.registry.putGrant(rec);
      await o.registry.deleteGrant(o.child);
      throw new Error(`the network did not take the delegation: ${msg}`);
    }
  }
  return { txid, childAddress, parentAddress, childManifest };
}

export { toHex };
