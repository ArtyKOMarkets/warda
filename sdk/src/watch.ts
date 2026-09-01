/**
 * Watching a grant.
 *
 * The obvious approach does not work, and it is worth saying why before the
 * code: you cannot watch a grant's address. A grant's address is a hash of its
 * state, so the FIRST spend moves it, and from then on the address you were
 * watching is empty forever. Worse, empty is exactly what a drained grant
 * looks like, and exactly what a revoked one looks like, and exactly what a
 * grant that never existed looks like. A naive watcher reports a catastrophe
 * every time the agent does its job.
 *
 * So a watcher has to FOLLOW. Two things make that possible:
 *
 *   The mempool carries whole transactions. `getMempoolEntriesByAddresses`
 *   returns the transactions sending from an address, and a transaction
 *   spending a grant carries the covenant's redeem script in the clear —
 *   P2SH requires it. So the state of the grant that was spent, and the
 *   successor implied by the outputs, are both readable the moment the spend
 *   hits the mempool, BEFORE it confirms.
 *
 *   The successor is deterministic. Given the state and what the transaction
 *   did, there is exactly one address the covenant permits the grant to
 *   continue at, so the watcher can move its own cursor and keep watching.
 *
 * Confirmed spends that were never seen in the mempool are the gap, and this
 * says so rather than papering over it: the grant is reported LOST, with the
 * last address it was known at, which is what `recover-grant` needs.
 *
 * ## What this is not
 *
 * It is not enforcement. The covenant enforces; this observes, and the only
 * thing it can do about a breach is END the grant — which is a real power,
 * and the reason `armRevocation` exists. A rule here can be as strict as you
 * like and the chain will not consult it.
 */

import { scriptHashToAddress, type NetworkPrefix } from "./address.ts";
import { fromHex, toHex } from "./bytes.ts";
import { buildUnsignedExit, type ExitPlan, type UnsignedExit } from "./exit.ts";
import { pushChild } from "./delegate.ts";
import { EMPTY_RESERVE } from "./keys.ts";
import { NodeClient, type AddressUtxo } from "./node.ts";
import { reabsorbSuccessorState } from "./reabsorb.ts";
import { successorState } from "./spend.ts";
import {
  grantFromSignatureScript,
  scriptHashFor,
  type CovenantTemplate,
  type Grant,
} from "./template.ts";

export type TransitionKind = "spend" | "delegation" | "exit" | "settlement";

export interface Transition {
  kind: TransitionKind;
  txid: string;
  /** Where the grant was. Decoded from the transaction, not assumed. */
  fromAddress: string;
  /** Where it went. Null for an exit, and for a delegation whose child terms
   *  this watcher cannot see. */
  toAddress: string | null;
  from: Grant;
  to: Grant | null;
  /** For a spend: what was paid, and to whom. */
  amount?: bigint;
  recipientScript?: string;
  seenIn: "mempool" | "chain";
  /** Present when the grant moved somewhere this watcher cannot follow. */
  followable: boolean;
}

export interface Alert {
  severity: "notice" | "breach";
  rule: string;
  detail: string;
  txid?: string;
}

/**
 * Rules a watcher applies, on top of the covenant's.
 *
 * These are not a second enforcement layer — they cannot be, since the chain
 * never consults them. They are for the things a covenant deliberately does
 * not encode: rate, pattern, and "that was allowed but I did not expect it".
 * The covenant says what is POSSIBLE; these say what is normal.
 */
export interface WatchRules {
  /** A single payment larger than this is a breach even if the cap allows it. */
  maxSpendSompi?: bigint;
  /** More than `count` spends inside `windowMs` is a breach. Rate is the
   *  signal a per-spend cap cannot give you: a compromised agent draining a
   *  budget in permitted increments looks perfectly legal one spend at a time. */
  rateLimit?: { count: number; windowMs: number };
  /** Alert when the remaining budget falls below this. */
  minRemainingSompi?: bigint;
  /** Treat any delegation as a breach. Useful for an agent that should never
   *  be subdividing its authority in the first place. */
  forbidDelegation?: boolean;
  /** Notice when the grant is within this many DAA of expiring. */
  expiryWarningDaa?: bigint;
}

export interface WatchOptions {
  template: CovenantTemplate;
  grant: Grant;
  prefix?: NetworkPrefix;
  rules?: WatchRules;
}

export interface PollResult {
  address: string;
  transitions: Transition[];
  alerts: Alert[];
  /** The grant's UTXO, when it is sitting still at the watched address. */
  live: AddressUtxo | null;
  /** True when the address is empty and no transition explained it. */
  lost: boolean;
}

/** A transaction as the node's mempool reports it, which is not our wire shape. */
interface NodeTx {
  inputs: { signatureScript?: string; previousOutpoint?: unknown }[];
  outputs: { amount?: string | number; value?: string | number; scriptPublicKey?: unknown }[];
  lockTime?: string | number;
  verboseData?: { transactionId?: string };
  id?: string;
}

function spkHex(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object") {
    const o = v as { version?: number; scriptPublicKey?: string; script?: string };
    const body = o.scriptPublicKey ?? o.script ?? "";
    return (o.version ?? 0).toString(16).padStart(4, "0") + body;
  }
  return "";
}

const p2sh = (scriptHash: string) => "aa20" + scriptHash + "87";

/** A revocation ready to sign, with the plan needed to attach the signature. */
export interface ArmedRevocation {
  plan: ExitPlan;
  unsigned: UnsignedExit;
}

export class GrantWatcher {
  private readonly client: NodeClient;
  private readonly template: CovenantTemplate;
  private readonly prefix: NetworkPrefix;
  private readonly rules: WatchRules;
  /** The cursor. Moves as the grant moves; this is the whole trick. */
  private grant: Grant;
  private readonly seen = new Set<string>();
  private readonly spendTimes: number[] = [];

  constructor(client: NodeClient, o: WatchOptions) {
    this.client = client;
    this.template = o.template;
    this.grant = o.grant;
    this.prefix = o.prefix ?? "kaspatest";
    this.rules = o.rules ?? {};
  }

  get current(): Grant {
    return this.grant;
  }

  get address(): string {
    return scriptHashToAddress(scriptHashFor(this.template, this.grant), this.prefix);
  }

  private addressOf(g: Grant): string {
    return scriptHashToAddress(scriptHashFor(this.template, g), this.prefix);
  }

  /**
   * One pass. Call it on whatever cadence suits you — a spend is visible in
   * the mempool for as long as it takes to confirm, which on Kaspa is fast,
   * so a slow poll will miss transitions and say so rather than inventing
   * them.
   */
  async poll(): Promise<PollResult> {
    const alerts: Alert[] = [];
    const transitions: Transition[] = [];
    const address = this.address;

    for (const tx of await this.pendingSpends(address)) {
      const t = this.classify(tx, "mempool");
      if (!t) continue;
      transitions.push(t);
      alerts.push(...this.judge(t));
      if (t.to) this.grant = t.to;
      // A grant can move more than once inside one poll interval; re-derive
      // and keep going rather than reporting the second move as a loss.
    }

    const utxos = await this.client.getUtxosByAddresses([this.address]);
    const live = utxos[0] ?? null;

    if (live) alerts.push(...this.judgeStanding(live));

    const lost = !live && transitions.length === 0;
    if (lost) {
      alerts.push({
        severity: "breach",
        rule: "lost",
        detail:
          `nothing at ${this.address}, and no transaction in the mempool explains it. ` +
          `The grant moved and this watcher did not see it — either it confirmed between ` +
          `polls, or it was never in this node's mempool. It is not necessarily gone: feed ` +
          `the transaction to recover-grant, or lower the poll interval.`,
      });
    }

    return { address, transitions, alerts, live, lost };
  }

  /** Transactions in the mempool spending FROM the watched address. */
  private async pendingSpends(address: string): Promise<NodeTx[]> {
    let reply: unknown;
    try {
      reply = await this.client.connection.call("getMempoolEntriesByAddresses", {
        addresses: [address],
        includeOrphanPool: false,
        filterTransactionPool: false,
      });
    } catch {
      // A node that will not answer this leaves the watcher in chain-only
      // mode: it still notices the grant moving, it just cannot say where to.
      return [];
    }
    const entries = (reply as { entries?: { sending?: { transaction?: NodeTx }[] }[] }).entries ?? [];
    const out: NodeTx[] = [];
    for (const e of entries) {
      for (const s of e.sending ?? []) {
        const tx = s.transaction;
        if (!tx) continue;
        const id = tx.verboseData?.transactionId ?? tx.id ?? "";
        if (id && this.seen.has(id)) continue;
        if (id) this.seen.add(id);
        out.push(tx);
      }
    }
    return out;
  }

  /**
   * What did this transaction do?
   *
   * Read from the SHAPE rather than from any label, and from the redeem script
   * the transaction itself carries rather than from what this watcher believed
   * the grant's state to be. A watcher that trusted its own cursor would
   * happily follow a transaction belonging to a sibling grant.
   */
  private classify(tx: NodeTx, seenIn: "mempool" | "chain"): Transition | null {
    const txid = tx.verboseData?.transactionId ?? tx.id ?? "";
    let from: Grant;
    try {
      from = grantFromSignatureScript(fromHex(tx.inputs[0]?.signatureScript ?? ""), this.template);
    } catch {
      // Not a spend of a grant of this covenant. Some other transaction of
      // this address, which for a P2SH covenant address should not happen,
      // but reporting it as a grant transition would be worse.
      return null;
    }
    const fromAddress = this.addressOf(from);
    const ins = tx.inputs.length, outs = tx.outputs.length;
    const value = (i: number) => BigInt(tx.outputs[i]?.amount ?? tx.outputs[i]?.value ?? 0);
    const base = { txid, fromAddress, from, seenIn };

    if (ins === 1 && outs === 2) {
      const secondIsCovenant = spkHex(tx.outputs[1]?.scriptPublicKey).startsWith("0000aa20");
      if (!secondIsCovenant) {
        const to = {
          authority: from.authority,
          state: successorState(from.state, value(1), BigInt(tx.lockTime ?? 0)),
        };
        return {
          ...base,
          kind: "spend",
          to,
          toAddress: this.addressOf(to),
          amount: value(1),
          recipientScript: spkHex(tx.outputs[1]?.scriptPublicKey),
          followable: true,
        };
      }
      // A delegation. The parent's successor commits to the CHILD's whole
      // birth state, and only the hash of the child's script is here.
      return { ...base, kind: "delegation", to: null, toAddress: null, followable: false };
    }
    if (ins === 1 && outs === 1) {
      return { ...base, kind: "exit", to: null, toAddress: null, followable: true };
    }
    if (ins === 2 && outs === 1) {
      // Both redeem scripts travel, so a settlement is fully readable.
      let parent = from, child = from;
      try {
        const a = grantFromSignatureScript(fromHex(tx.inputs[0]?.signatureScript ?? ""), this.template);
        const b = grantFromSignatureScript(fromHex(tx.inputs[1]?.signatureScript ?? ""), this.template);
        [parent, child] = a.state.reserved >= b.state.reserved ? [a, b] : [b, a];
      } catch {
        return { ...base, kind: "settlement", to: null, toAddress: null, followable: false };
      }
      const prior = pushChild(EMPTY_RESERVE, child.state) === parent.state.reserveRoot ? EMPTY_RESERVE : null;
      const to = prior === null
        ? null
        : { authority: parent.authority, state: reabsorbSuccessorState(parent.state, child.state, prior) };
      return {
        ...base,
        kind: "settlement",
        from: parent,
        fromAddress: this.addressOf(parent),
        to,
        toAddress: to ? this.addressOf(to) : null,
        followable: to !== null,
      };
    }
    return null;
  }

  /** Rules that judge a MOVE. */
  private judge(t: Transition): Alert[] {
    const out: Alert[] = [];
    const r = this.rules;

    if (t.kind === "exit") {
      out.push({
        severity: "notice",
        rule: "ended",
        txid: t.txid,
        detail: `the grant was revoked or reclaimed at ${t.fromAddress}. There is no successor.`,
      });
    }
    if (t.kind === "delegation") {
      out.push({
        severity: r.forbidDelegation ? "breach" : "notice",
        rule: "delegation",
        txid: t.txid,
        detail: r.forbidDelegation
          ? `this agent subdivided its authority, which these rules forbid.`
          : `this grant delegated. This watcher cannot follow the parent without the ` +
            `child's terms — the parent's successor commits to the child's whole birth state.`,
      });
    }
    if (t.kind === "spend" && t.amount !== undefined) {
      if (r.maxSpendSompi !== undefined && t.amount > r.maxSpendSompi) {
        // Permitted by the covenant, unexpected by you. That gap is the only
        // thing a watcher can usefully police.
        out.push({
          severity: "breach",
          rule: "maxSpend",
          txid: t.txid,
          detail: `paid ${t.amount} sompi, above the ${r.maxSpendSompi} this watcher expects. ` +
            `The covenant allowed it — its cap is ${t.from.state.maxPerSpend}.`,
        });
      }
      if (r.rateLimit) {
        const now = Date.now();
        this.spendTimes.push(now);
        const live = this.spendTimes.filter((s) => now - s <= r.rateLimit!.windowMs);
        this.spendTimes.length = 0;
        this.spendTimes.push(...live);
        if (live.length > r.rateLimit.count) {
          // The signal a per-spend cap cannot give you: a compromised agent
          // draining a budget in permitted increments is legal every time.
          out.push({
            severity: "breach",
            rule: "rate",
            txid: t.txid,
            detail: `${live.length} spends in the last ${r.rateLimit.windowMs}ms, above ${r.rateLimit.count}. ` +
              `Every one of them was within the per-spend cap, which is exactly what a drain looks like.`,
          });
        }
      }
    }
    if (!t.followable && t.kind !== "exit") {
      out.push({
        severity: "notice",
        rule: "unfollowable",
        txid: t.txid,
        detail: `this watcher cannot derive where the grant went. Point it at the new address, ` +
          `or run recover-grant against this transaction.`,
      });
    }
    return out;
  }

  /** Rules that judge the grant STANDING STILL. */
  private judgeStanding(live: AddressUtxo): Alert[] {
    const out: Alert[] = [];
    const r = this.rules;
    const s = this.grant.state;
    if (r.minRemainingSompi !== undefined) {
      const remaining = s.budgetTotal - s.spentTotal - s.reserved;
      if (remaining < r.minRemainingSompi) {
        out.push({
          severity: "notice",
          rule: "lowBudget",
          detail: `${remaining} sompi of authority left, below the ${r.minRemainingSompi} watched for.`,
        });
      }
    }
    if (r.expiryWarningDaa !== undefined && live.entry.blockDaaScore > 0n) {
      const left = s.expiresAt - live.entry.blockDaaScore;
      if (left <= r.expiryWarningDaa) {
        out.push({
          severity: "notice",
          rule: "expiring",
          detail: left <= 0n
            ? `the window has closed; the principal may reclaim the balance.`
            : `about ${left} DAA of window left.`,
        });
      }
    }
    return out;
  }

  /**
   * A revocation, built for exactly where the grant is right now.
   *
   * The catch is worth stating plainly, because it is the reason a watcher
   * cannot simply hold one pre-signed transaction and forget about it: the
   * signature commits to the grant's CURRENT UTXO — its outpoint, its value
   * and its script — and the grant MOVES on every spend. So a revocation
   * signed now is valid exactly until the agent next spends, and no longer.
   *
   * Which leaves a real choice, with no free option:
   *
   *   Re-arm after every move. The watcher needs the revocation key online,
   *   which makes the watcher a target worth attacking.
   *
   *   Alert a human instead. Nothing is online that shouldn't be, and the
   *   reaction time is however long it takes somebody to read a message.
   *
   * This function does the building. It never signs, so which of those you
   * are running is still your decision.
   */
  armRevocation(live: AddressUtxo, fee = 1_000_000n, computeBudget = 16): ArmedRevocation {
    if (live.entry.scriptPublicKey.script.length === 0 || !live.entry.covenantId) {
      throw new Error(
        `this UTXO reports no covenant id, so a revocation built from it would carry no ` +
          `binding — well-formed, signed, and refused by every node that knows about covenants.`,
      );
    }
    const expected = p2sh(scriptHashFor(this.template, this.grant));
    const actual = "0000" + toHex(live.entry.scriptPublicKey.script);
    if (!actual.endsWith(expected)) {
      throw new Error(
        `this UTXO is not the grant this watcher is following. Arming a revocation against ` +
          `it would sign over somebody else's coin.`,
      );
    }
    // The PLAN travels with the unsigned transaction, because attaching the
    // signature needs it — the signature script is rebuilt from the plan
    // rather than patched into the bytes. Returning only the unsigned half
    // would leave the caller casting something plan-shaped into place, which
    // typechecks and produces a transaction that fails at the input.
    const plan: ExitPlan = {
      kind: "revoke",
      template: this.template,
      authority: this.grant.authority,
      state: this.grant.state,
      utxo: {
        outpointTransactionId: live.outpoint.transactionId,
        outpointIndex: live.outpoint.index,
        value: live.entry.value,
        blockDaaScore: live.entry.blockDaaScore,
        isCoinbase: live.entry.isCoinbase,
        covenantId: live.entry.covenantId,
      },
      fee,
      computeBudget,
      // Revoke makes no claim about the chain's height; only reclaim does.
      lockTime: 0n,
    };
    return { plan, unsigned: buildUnsignedExit(plan) };
  }
}
