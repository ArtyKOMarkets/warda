/**
 * Funding a hosted agent from any wallet: a deposit address, then genesis.
 *
 * A covenant grant cannot be created by an ordinary wallet — genesis binds
 * its output to a covenant id, and no phone wallet builds that transaction.
 * Every wallet, and every exchange, can do one thing: send KAS to an address.
 * So the runner makes a single-use DEPOSIT key for the agent, the owner sends
 * the amount there from wherever they hold KAS, and the runner turns the coin
 * into the grant in one transaction.
 *
 * What the deposit key can and cannot do is the whole trust question, so it
 * is narrow on purpose:
 *
 * - It is used for exactly one transaction: this genesis. The whole coin goes
 *   into the grant (no change comes back to the deposit key), so after genesis
 *   the key holds nothing and is never used again.
 * - The grant's principal and revocation keys are the OWNER's, supplied by
 *   their wallet. The runner never holds either, so after genesis it cannot
 *   reclaim, revoke or redirect a single sompi.
 * - The exposure is the deposit, for the minutes between it arriving and the
 *   genesis confirming. That is the one window in which the runner (through
 *   Turnkey) controls the owner's coin outright, and every page that offers
 *   this must say so.
 *
 * Idempotent across ticks and restarts: a plan records the exact inputs its
 * genesis was built from, so a retry rebuilds the SAME transaction (same txid;
 * a BIP340 signature differs but the txid excludes it) rather than a second
 * grant. Two genesis transactions from one deposit would spend one outpoint,
 * so at most one could ever confirm — and the manifest on record would be the
 * right one only by luck. It never gets that far.
 */
import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };
import {
  EMPTY_RESERVE,
  RecipientSet,
  ScriptBuilder,
  SUBNETWORK_ID_NATIVE,
  sighash,
  assertRecipientsFitTemplate,
  attachGenesisSignature,
  buildGenesis,
  fromHex,
  payToPubkeyScript,
  pubkeyToAddress,
  scriptHashToAddress,
  templateFingerprint,
  templateIdFor,
  toHex,
  toWire,
  type CovenantTemplate,
  type GrantState,
  type NetworkPrefix,
  type ScriptPublicKey,
  type Transaction,
} from "@warda_protocol/kaspa";
import type { Manifest } from "@warda_protocol/agent";
import { memberKey } from "./grant.ts";
import type { Registry } from "./registry.ts";
import type { KeyVault } from "./vault.ts";

const TEMPLATE = covenantTemplate as unknown as CovenantTemplate;
export const GENESIS_FEE = 1_000_000n;
const GENESIS_COMPUTE_BUDGET = 12;
const DAA_PER_DAY = 864_000n;
/** New hosted grants allow one level of sub-agents; a sub-agent cannot delegate further. */
export const SUB_AGENT_DEPTH = 1;

export interface Limits {
  budget: bigint;
  maxPerSpend: bigint;
  epochLimit: bigint;
  epochLength: bigint;
  days: number;
}

export interface FundingCoin {
  transactionId: string;
  index: number;
  value: string;
  scriptPublicKeyVersion: number;
  scriptPublicKeyHex: string;
  blockDaaScore: string;
  isCoinbase: boolean;
}

export interface Plan {
  agent: string;
  agentKey: string;
  principal: string;
  revocation: string;
  limits: { budget: string; maxPerSpend: string; epochLimit: string; epochLength: string; days: number };
  recipients: string[];
  depositKey: string;
  depositAddress: string;
  /** Budget, genesis fee, and a buffer the grant's own spends pay fees from. */
  required: string;
  status: "awaiting-deposit" | "submitting" | "funded" | "failed" | "refunded";
  /** Refunds of deposit coins that never became (or were left over from) the grant. */
  refunds?: { txid: string; value: string; at: number }[];
  seen?: string;
  /** Everything genesis was built from, so a retry is the same transaction. */
  built?: { daa: string; coin: FundingCoin; grantAddress: string; txid: string };
  genesisTxid?: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  /** How many levels of sub-agents the grant allows. Absent on plans made before sub-agents: 0. */
  depth?: number;
  /** 1 for the agent's first grant; each top-up is the next round, with its own deposit key. */
  round?: number;
  /** A top-up: the grant this one replaces once it is funded. Its leftover is the owner's to reclaim. */
  replaces?: { manifest: Manifest; recipients: string[]; genesisTxid?: string };
}

export interface FundingChain {
  daa(): Promise<bigint>;
  utxos(address: string): Promise<{
    outpoint: { transactionId: Uint8Array; index: number };
    entry: { value: bigint; scriptPublicKey: ScriptPublicKey; blockDaaScore: bigint; isCoinbase: boolean; covenantId?: Uint8Array };
  }[]>;
  submit(tx: Transaction): Promise<string>;
}

/** The deposit key's vault id. Round 1 keeps the original name; a top-up gets its own key. */
export const depositId = (agent: string, round?: number) => (round && round > 1 ? `${agent}--deposit-${round}` : `${agent}--deposit`);

/**
 * The most the runner will ever ask somebody to send it at once.
 *
 * `runner/DESIGN.md` is honest about the funding window: no phone wallet can
 * build a covenant genesis, so the owner sends coin to a single-use deposit
 * address and the runner turns it into the grant. Between the deposit landing
 * and the genesis confirming — usually under a minute — the runner controls
 * that coin outright, and every page offering the flow says so.
 *
 * What none of them said is HOW MUCH. The window cannot be closed without
 * deleting the product, but its size was unbounded: quote a grant of any
 * budget and somebody sends that much to a key the runner holds alone.
 * "Usually under a minute, and we tell you" is a disclosure. It is not a
 * bound, and DESIGN.md's real bound — that a breach loses at most what the
 * grants could still spend — is about grants that EXIST, which a deposit in
 * flight is not yet one of.
 *
 * So there is a number, and it is small enough to be a decision rather than a
 * ceiling nobody reaches. 100 KAS on testnet, where it costs nothing and its
 * only job is to exist and be argued with. Raising it before mainnet is a
 * deliberate act; there is no value that disables it.
 */
export const MAX_DEPOSIT_DEFAULT = 10_000_000_000n; // 100 KAS

export function maxDeposit(): bigint {
  const raw = process.env.RUNNER_MAX_DEPOSIT;
  if (raw === undefined || raw.trim() === "") return MAX_DEPOSIT_DEFAULT;
  let v: bigint;
  try {
    v = BigInt(raw.trim());
  } catch {
    throw new Error(
      `RUNNER_MAX_DEPOSIT is "${raw}", which is not a number of sompi. ` +
        `Unset it for the default of ${MAX_DEPOSIT_DEFAULT}, or set a figure somebody chose.`,
    );
  }
  /* No "unlimited". A zero or a negative here reads as "turn the cap off",
     and a control with an off switch is a control that is off on the day it
     matters — the same reasoning the genesis guards use for having no
     override flag. */
  if (v <= 0n) {
    throw new Error(
      `RUNNER_MAX_DEPOSIT is ${v}. There is no value that disables this cap: it bounds what ` +
        `the runner holds alone during the funding window, and a bound with an off switch is ` +
        `off on the day it matters. Set a positive number of sompi.`,
    );
  }
  return v;
}

/** The coin covers the budget AND the network fee of every spend it makes. */
export function requiredDeposit(l: Limits): bigint {
  const tenth = l.budget / 10n;
  const buffer = tenth > 10_000_000n ? tenth : 10_000_000n;
  return l.budget + GENESIS_FEE + buffer;
}

export function checkLimits(l: Limits): string | null {
  if (l.budget <= 0n) return "the budget must be positive";
  if (l.maxPerSpend <= 0n || l.maxPerSpend > l.budget) return "the per-payment cap must be positive and at most the budget";
  if (l.epochLimit < l.maxPerSpend) return "the epoch limit must be at least the per-payment cap";
  if (!(l.days > 0 && l.days <= 365)) return "a grant lasts between 1 and 365 days";
  /* Checked on the DEPOSIT, not on the budget: the deposit is what somebody
     actually sends and what the runner actually holds for that minute. It is
     the budget plus the genesis fee plus a spend buffer, so a budget just
     under the cap can still ask for a deposit over it. */
  const deposit = requiredDeposit(l);
  const cap = maxDeposit();
  if (deposit > cap) {
    return (
      `this grant needs a deposit of ${deposit} sompi and the runner will not quote above ` +
      `${cap}. Between the deposit landing and the genesis confirming, the runner holds that ` +
      `coin alone — see runner/DESIGN.md — so the amount is capped rather than merely disclosed. ` +
      `Fund a smaller grant and top it up, or raise RUNNER_MAX_DEPOSIT deliberately.`
    );
  }
  return null;
}

export async function createPlan(o: {
  vault: KeyVault;
  registry: Registry;
  agent: string;
  agentKey: string;
  principal: string;
  revocation: string;
  limits: Limits;
  recipients: string[];
  prefix: NetworkPrefix;
  now: number;
}): Promise<Plan> {
  const why = checkLimits(o.limits);
  if (why) throw new Error(why);
  for (const k of [o.principal, o.revocation]) {
    if (!/^[0-9a-f]{64}$/.test(k)) throw new Error("owner keys are 32-byte x-only public keys, as hex");
  }
  if (o.principal === o.agentKey || o.revocation === o.agentKey) {
    throw new Error("the owner's key cannot be the agent's key; the agent could then reclaim its own grant");
  }
  const set = new RecipientSet(o.recipients.map(memberKey));
  assertRecipientsFitTemplate(TEMPLATE, set);
  const depositKey = await o.vault.create(depositId(o.agent));
  const plan: Plan = {
    agent: o.agent,
    agentKey: o.agentKey,
    principal: o.principal,
    revocation: o.revocation,
    limits: {
      budget: o.limits.budget.toString(),
      maxPerSpend: o.limits.maxPerSpend.toString(),
      epochLimit: o.limits.epochLimit.toString(),
      epochLength: o.limits.epochLength.toString(),
      days: o.limits.days,
    },
    recipients: o.recipients,
    depositKey,
    depositAddress: pubkeyToAddress(fromHex(depositKey), o.prefix),
    required: requiredDeposit(o.limits).toString(),
    status: "awaiting-deposit",
    createdAt: o.now,
    updatedAt: o.now,
    depth: SUB_AGENT_DEPTH,
  };
  await o.registry.putPlan(plan);
  return plan;
}

/**
 * Top up, or renew: a NEW grant for the same agent key, from a new deposit.
 *
 * A grant's budget and term are fixed when it is created, so "more money" or
 * "more time" is always a successor. Same agent (so the same Turnkey key, the
 * same jobs, the same MCP token), same owner keys, same payees — except that
 * the runner's fee address is brought up to date. When the deposit arrives,
 * the funder builds the successor and the runner switches to it; until then
 * the current grant keeps working. What is left in the old grant stays there,
 * under the owner's revocation key, which the runner never holds.
 */
export async function createTopUp(o: {
  vault: KeyVault;
  registry: Registry;
  agent: string;
  record: { manifest: Manifest; recipients: string[] };
  previous: Plan | null;
  limits?: Partial<Limits>;
  /** The runner's fee addresses: the current one goes on the allowlist, earlier ones come off. */
  feePayee: string;
  oldFeePayees?: string[];
  prefix: NetworkPrefix;
  now: number;
}): Promise<Plan> {
  const prev = o.previous;
  if (prev && (prev.status === "awaiting-deposit" || prev.status === "submitting")) {
    throw new Error(prev.round && prev.round > 1
      ? "a top-up for this agent is already waiting for its deposit; send to that address, or refund it first"
      : "this agent's first grant is still being funded");
  }
  const m = o.record.manifest as Manifest & Record<string, unknown>;
  const n = (v: unknown) => BigInt(String(v ?? 0));
  const days = o.limits?.days ?? prev?.limits.days ??
    Math.max(1, Math.round(Number(n(m.expires_at) - n(m.not_before)) / Number(DAA_PER_DAY)));
  const limits: Limits = {
    budget: o.limits?.budget ?? n(prev?.limits.budget ?? m.budget),
    maxPerSpend: o.limits?.maxPerSpend ?? n(prev?.limits.maxPerSpend ?? m.max_per_spend),
    epochLimit: o.limits?.epochLimit ?? n(prev?.limits.epochLimit ?? m.epoch_limit),
    epochLength: o.limits?.epochLength ?? n(prev?.limits.epochLength ?? m.epoch_length),
    days: Math.min(365, days),
  };
  if (limits.epochLimit < limits.maxPerSpend) limits.epochLimit = limits.maxPerSpend * 5n;
  const why = checkLimits(limits);
  if (why) throw new Error(why);
  const fees = new Set([o.feePayee, ...(o.oldFeePayees ?? [])].map(memberKey));
  const payees = o.record.recipients.filter((r) => !fees.has(memberKey(r)));
  const recipients = [...payees, o.feePayee];
  const set = new RecipientSet(recipients.map(memberKey));
  assertRecipientsFitTemplate(TEMPLATE, set);
  const round = (prev?.round ?? 1) + 1;
  const depositKey = await o.vault.create(depositId(o.agent, round));
  const plan: Plan = {
    agent: o.agent,
    agentKey: String(m.agent),
    principal: String(m.principal),
    revocation: String(m.revocation),
    limits: {
      budget: limits.budget.toString(),
      maxPerSpend: limits.maxPerSpend.toString(),
      epochLimit: limits.epochLimit.toString(),
      epochLength: limits.epochLength.toString(),
      days: limits.days,
    },
    recipients,
    depositKey,
    depositAddress: pubkeyToAddress(fromHex(depositKey), o.prefix),
    required: requiredDeposit(limits).toString(),
    status: "awaiting-deposit",
    createdAt: o.now,
    updatedAt: o.now,
    round,
    depth: SUB_AGENT_DEPTH,
    replaces: { manifest: o.record.manifest, recipients: o.record.recipients, ...(prev?.genesisTxid ? { genesisTxid: prev.genesisTxid } : {}) },
  };
  await o.registry.putPlan(plan);
  return plan;
}

function genesisFor(p: Plan, coin: FundingCoin, daa: bigint) {
  const recipients = new RecipientSet(p.recipients.map(memberKey));
  const authority = { principalKey: p.principal, revocationKey: p.revocation };
  const state: GrantState = {
    agentKey: p.agentKey,
    budgetTotal: BigInt(p.limits.budget),
    maxPerSpend: BigInt(p.limits.maxPerSpend),
    epochLimit: BigInt(p.limits.epochLimit),
    epochLength: BigInt(p.limits.epochLength),
    recipientsRoot: toHex(recipients.root),
    notBefore: daa,
    expiresAt: daa + BigInt(p.limits.days) * DAA_PER_DAY,
    delegationDepth: BigInt(p.depth ?? 0),
    templateId: templateIdFor(TEMPLATE, authority),
    spentTotal: 0n,
    reserved: 0n,
    epochIndex: 0n,
    epochSpent: 0n,
    reserveRoot: EMPTY_RESERVE,
  };
  const value = BigInt(coin.value);
  const built = buildGenesis({
    template: TEMPLATE,
    grant: { authority, state },
    funding: {
      outpointTransactionId: fromHex(coin.transactionId),
      outpointIndex: coin.index,
      value,
      scriptPublicKey: { version: coin.scriptPublicKeyVersion, script: fromHex(coin.scriptPublicKeyHex) },
      blockDaaScore: BigInt(coin.blockDaaScore),
      isCoinbase: coin.isCoinbase,
    },
    // The whole coin: the grant pays its spends' network fees from it, and
    // the deposit key is left holding nothing.
    grantValue: value - GENESIS_FEE,
    fee: GENESIS_FEE,
    computeBudget: GENESIS_COMPUTE_BUDGET,
  });
  const manifest: Manifest = {
    covenant: templateFingerprint(TEMPLATE),
    covenant_id: toHex(built.covenantId),
    agent: p.agentKey,
    agent_key_derived: null,
    principal: p.principal,
    revocation: p.revocation,
    recipients_root: state.recipientsRoot,
    created_at_daa: Number(daa),
    not_before: Number(state.notBefore),
    expires_at: Number(state.expiresAt),
    budget: Number(state.budgetTotal),
    max_per_spend: Number(state.maxPerSpend),
    epoch_limit: Number(state.epochLimit),
    epoch_length: Number(state.epochLength),
    delegation_depth: p.depth ?? 0,
    grant_value: Number(value - GENESIS_FEE),
    spent_total: 0,
    reserved: 0,
    epoch_index: 0,
    epoch_spent: 0,
    reserve_root: EMPTY_RESERVE,
    funded_by: "runner deposit",
  };
  return { built, manifest };
}

export interface FunderOptions {
  registry: Registry;
  vault: KeyVault;
  chain: FundingChain;
  prefix: NetworkPrefix;
  now?: () => number;
  /** Told when a step of a plan throws (the operator's alerts). */
  onError?: (plan: Plan, message: string) => Promise<void> | void;
}

export class Funder {
  private readonly o: Required<FunderOptions>;
  constructor(o: FunderOptions) {
    this.o = { now: Date.now, onError: () => {}, ...o };
  }

  /** One pass over every plan still waiting. Returns the agents funded. */
  async tick(): Promise<string[]> {
    const funded: string[] = [];
    for (const p of await this.o.registry.pendingPlans()) {
      try {
        if (await this.step(p)) funded.push(p.agent);
      } catch (e) {
        p.note = (e as Error).message;
        p.updatedAt = this.o.now();
        await this.o.registry.putPlan(p);
        try { await this.o.onError(p, p.note); } catch { /* never breaks a tick */ }
      }
    }
    return funded;
  }

  private async step(p: Plan): Promise<boolean> {
    const { chain, registry, prefix } = this.o;
    if (p.status === "submitting" && p.built) {
      const landed = await chain.utxos(p.built.grantAddress);
      if (landed.length > 0) return this.done(p, p.built.txid);
    }
    let coin: FundingCoin;
    let daa: bigint;
    if (p.built) {
      coin = p.built.coin;
      daa = BigInt(p.built.daa);
    } else {
      const utxos = (await chain.utxos(p.depositAddress)).filter((u) => !u.entry.covenantId);
      const total = utxos.reduce((t, u) => t + u.entry.value, 0n);
      const big = utxos.sort((a, b) => (b.entry.value > a.entry.value ? 1 : -1))[0];
      p.seen = total.toString();
      p.updatedAt = this.o.now();
      if (!big || big.entry.value < BigInt(p.required)) {
        if (big && total >= BigInt(p.required)) {
          p.note = "the deposit arrived in more than one payment; send the full amount in one transaction";
        }
        await registry.putPlan(p);
        return false;
      }
      coin = {
        transactionId: toHex(big.outpoint.transactionId),
        index: big.outpoint.index,
        value: big.entry.value.toString(),
        scriptPublicKeyVersion: big.entry.scriptPublicKey.version,
        scriptPublicKeyHex: toHex(big.entry.scriptPublicKey.script),
        blockDaaScore: big.entry.blockDaaScore.toString(),
        isCoinbase: big.entry.isCoinbase,
      };
      daa = await chain.daa();
    }
    const { built, manifest } = genesisFor(p, coin, daa);
    const sign = await this.o.vault.signer(depositId(p.agent, p.round));
    const tx = attachGenesisSignature(built, await sign(built.sighash));
    const txid = toWire(tx, built.entry, "@warda_protocol/runner (genesis)").txid;
    const grantAddress = scriptHashToAddress(toHex(built.grantScriptHash), prefix);
    if (p.built && p.built.txid !== txid) {
      throw new Error(`a rebuilt genesis came out as ${txid}, not ${p.built.txid}; refusing to broadcast a second grant`);
    }
    // WRITTEN BEFORE BROADCAST: a grant's address derives from these numbers.
    await registry.putGrant({ agent: p.agent, manifest, recipients: p.recipients, updatedAt: this.o.now() });
    p.built = { daa: daa.toString(), coin, grantAddress, txid };
    p.status = "submitting";
    p.updatedAt = this.o.now();
    await registry.putPlan(p);
    try {
      await chain.submit(tx);
    } catch (e) {
      const m = (e as Error).message;
      if (!/already|orphan|in the mempool/i.test(m)) throw e;
    }
    return this.done(p, txid);
  }

  private async done(p: Plan, txid: string): Promise<boolean> {
    p.status = "funded";
    p.genesisTxid = txid;
    delete p.note;
    p.updatedAt = this.o.now();
    await this.o.registry.putPlan(p);
    return true;
  }
}

/**
 * Give a deposit back.
 *
 * The one thing the deposit key may do besides genesis, and it may do it to
 * exactly one place: the OWNER's principal key, which the owner supplied and
 * the runner does not hold. Each coin at the deposit address is returned as
 * its own transaction, less the network fee. Allowed while the plan is still
 * waiting (the owner changed their mind, or paid in pieces) — which cancels
 * it — and after funding, for anything left at the deposit address.
 */
export async function refundDeposit(o: {
  plan: Plan;
  registry: Registry;
  vault: KeyVault;
  chain: FundingChain;
  prefix: NetworkPrefix;
  now: number;
}): Promise<{ txid: string; value: bigint }[]> {
  const p = o.plan;
  if (p.status === "submitting") {
    throw new Error("the grant is being created from this deposit right now; wait for it, then refund anything left over");
  }
  const coins = (await o.chain.utxos(p.depositAddress)).filter((u) => !u.entry.covenantId && u.entry.value > GENESIS_FEE);
  if (coins.length === 0) throw new Error(`nothing to refund: ${p.depositAddress} holds no coin worth more than the fee`);
  const to = payToPubkeyScript(fromHex(p.principal));
  const sign = await o.vault.signer(depositId(p.agent, p.round));
  const out: { txid: string; value: bigint }[] = [];
  for (const c of coins) {
    const value = c.entry.value - GENESIS_FEE;
    const tx: Transaction = {
      version: 1,
      inputs: [{ previousOutpoint: c.outpoint, signatureScript: new Uint8Array(0), sequence: 0n, computeBudget: GENESIS_COMPUTE_BUDGET }],
      outputs: [{ value, scriptPublicKey: to }],
      lockTime: 0n,
      subnetworkId: SUBNETWORK_ID_NATIVE,
      gas: 0n,
      payload: new Uint8Array(0),
    };
    const entry = { value: c.entry.value, scriptPublicKey: c.entry.scriptPublicKey, blockDaaScore: c.entry.blockDaaScore, isCoinbase: c.entry.isCoinbase };
    const sig = await sign(sighash(tx, 0, entry));
    tx.inputs[0]!.signatureScript = new ScriptBuilder().addData(sig).drain();
    const txid = toWire(tx, entry, "@warda_protocol/runner (refund)").txid;
    await o.chain.submit(tx);
    out.push({ txid, value });
    (p.refunds ??= []).push({ txid, value: value.toString(), at: o.now });
  }
  if (p.status === "awaiting-deposit") p.status = "refunded";
  p.updatedAt = o.now;
  await o.registry.putPlan(p);
  return out;
}

/** The deposit as a payment URI a wallet or a camera can open. */
export function depositUri(p: Plan): string {
  const kas = (Number(BigInt(p.required)) / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
  return `${p.depositAddress}?amount=${kas}`;
}

export { payToPubkeyScript };
