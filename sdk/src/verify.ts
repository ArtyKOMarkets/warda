/**
 * Reading a grant off the chain and saying whether it is what it claims to be.
 *
 * This is the question a counterparty actually has. Not "did the SDK build a
 * valid transaction" — "is there really a grant at this address, does it hold
 * what the manifest says, and how much of it is left". Answering it needs the
 * UTXO set, which is why it lives here and not in `spend.ts`.
 *
 * The check is one-directional by design. It can prove the chain AGREES with a
 * manifest: the derived address holds a coin, of the stated size, carrying the
 * stated covenant id. It cannot prove a manifest describes the only grant an
 * agent holds, or that the state has not moved on since — a spend relocates a
 * grant, so a manifest is a claim about a moment.
 */

import { equal, fromHex, toHex } from "./bytes.ts";
import { scriptHashToAddress, type NetworkPrefix } from "./address.ts";
import type { NodeClient, AddressUtxo, DagInfo } from "./node.ts";
import { scriptHashFor, type CovenantTemplate, type Grant } from "./template.ts";
import { payToScriptHashScript } from "./tx.ts";

export interface GrantExpectation {
  /** The covenant id recorded when the grant was created. */
  covenantId?: string;
  /** The value the manifest says the grant holds. */
  value?: bigint;
  /**
   * The fee the next spend will pay. Only `maxNextSpend` depends on it.
   * Defaults to the template's baked `maxFee` — the covenant's own ceiling,
   * and the only bound available without asking the caller. That default is
   * deliberately pessimistic: it understates the headroom rather than
   * promising a spend the coin cannot cover.
   */
  fee?: bigint;
}

export interface Finding {
  level: "ok" | "warn" | "error";
  text: string;
}

export interface GrantReport {
  address: string;
  scriptHash: string;
  found: boolean;
  value: bigint | null;
  covenantId: string | null;
  /** budgetTotal - spentTotal - reserved: what the agent may still spend. */
  remaining: bigint;
  /** What is left in the CURRENT epoch, given where the chain is now. */
  epochRemaining: bigint;
  /**
   * The most a single next spend may pay out: the tightest of the four limits
   * that actually bind, including the coin itself. This is the number an agent
   * needs. `remaining` is an accounting figure the coin may not cover.
   */
  maxNextSpend: bigint;
  /** Which of the four limits is the binding one, for saying so out loud. */
  boundBy: "maxPerSpend" | "epoch" | "budget" | "coin";
  /** True once the principal's reclaim right has opened. */
  reclaimable: boolean;
  findings: Finding[];
  /** No `error` findings: the chain agrees with everything that was claimed. */
  agrees: boolean;
}

/**
 * The whole check, with the chain's answers passed in. Separated from I/O so
 * a report can be produced from a recorded capture, or from a UTXO obtained
 * some other way, using exactly the code a live connection runs.
 */
export function describeGrant(
  grant: Grant,
  template: CovenantTemplate,
  prefix: NetworkPrefix,
  utxo: AddressUtxo | null,
  dag: DagInfo,
  expect: GrantExpectation = {},
): GrantReport {
  const hash = scriptHashFor(template, grant); // hex
  const address = scriptHashToAddress(hash, prefix);
  const s = grant.state;
  const findings: Finding[] = [];

  const remaining = s.budgetTotal - s.spentTotal - s.reserved;

  // The epoch resets on its own as the chain advances: an agent that spent its
  // whole allowance last epoch has the full allowance again this one, without
  // anybody doing anything. Reporting the stored `epochSpent` as if it still
  // applied would understate the headroom, sometimes to zero.
  const currentEpoch = (dag.virtualDaaScore - s.notBefore) / s.epochLength;
  const spentThisEpoch = currentEpoch === s.epochIndex ? s.epochSpent : 0n;
  const epochRemaining = s.epochLimit - spentThisEpoch;

  // The fee comes out of the GRANT'S COIN but is not charged against
  // spentTotal, so the coin and the budget diverge by exactly the fees paid so
  // far. An agent that trusts `remaining` will eventually build a spend the
  // covenant's value-conservation check refuses, and that failure reads as a
  // covenant bug rather than as arithmetic.
  const fee = expect.fee ?? BigInt(template.baked.maxFee);
  const coinAvailable = utxo && utxo.entry.value > fee ? utxo.entry.value - fee : 0n;

  const limits: [GrantReport["boundBy"], bigint][] = [
    ["maxPerSpend", s.maxPerSpend],
    ["epoch", epochRemaining],
    ["budget", remaining],
  ];
  if (utxo) limits.push(["coin", coinAvailable]);
  let boundBy = limits[0]![0];
  let maxNextSpend = limits[0]![1];
  for (const [name, value] of limits) {
    if (value < maxNextSpend) {
      maxNextSpend = value;
      boundBy = name;
    }
  }
  if (maxNextSpend < 0n) maxNextSpend = 0n;

  if (!utxo) {
    findings.push({
      level: "error",
      text:
        `nothing at ${address}. A grant's address is derived from its state, ` +
        `and spending changes that state — so this usually means the grant has ` +
        `moved to a successor address and the manifest is stale, not that the ` +
        `grant is gone.`,
    });
    return {
      address,
      scriptHash: hash,
      found: false,
      value: null,
      covenantId: null,
      remaining,
      epochRemaining,
      maxNextSpend,
      boundBy,
      reclaimable: dag.virtualDaaScore >= s.expiresAt,
      findings,
      agrees: false,
    };
  }

  const entry = utxo.entry;
  findings.push({ level: "ok", text: `${entry.value} sompi at ${address}` });

  // Belt and braces: the node found this by address, so a mismatch would mean
  // the address encoding and the script hash disagree — worth catching once
  // rather than trusting the round trip.
  const expectedSpk = payToScriptHashScript(fromHex(hash));
  if (!equal(expectedSpk.script, entry.scriptPublicKey.script)) {
    findings.push({
      level: "error",
      text: `the UTXO's script is not P2SH of this state's bytecode`,
    });
  }

  if (!entry.covenantId) {
    findings.push({
      level: "error",
      text:
        `the node reports no covenant id for this UTXO. Either it predates ` +
        `covenants, or the field was dropped in transit — and a spend built ` +
        `from this entry would carry no binding.`,
    });
  } else if (expect.covenantId && toHex(entry.covenantId) !== expect.covenantId) {
    findings.push({
      level: "error",
      text: `covenant id is ${toHex(entry.covenantId)}, the manifest says ${expect.covenantId}`,
    });
  } else {
    findings.push({ level: "ok", text: `covenant id ${toHex(entry.covenantId)}` });
  }

  if (expect.value !== undefined && entry.value !== expect.value) {
    findings.push({
      level: "error",
      text: `holds ${entry.value} sompi, the manifest says ${expect.value}`,
    });
  }

  // A grant can hold more coin than the agent may spend — the surplus is the
  // principal's, recoverable on reclaim. Less is the interesting direction,
  // and it is the NORMAL state of any grant that has been spent from: every
  // spend pays a fee out of the coin, and the covenant charges only the
  // recipient amount against spentTotal. So the coin runs out before the
  // budget does, by exactly the fees paid so far, and the last spend an agent
  // believes it can afford is the one that gets refused.
  if (entry.value < remaining) {
    findings.push({
      level: "warn",
      text:
        `budget says ${remaining} sompi left, the grant holds ${entry.value}: ` +
        `${remaining - entry.value} short. Fees come out of the coin but are ` +
        `not charged against spentTotal, so the two diverge by the fees paid ` +
        `so far. The coin is what binds — see maxNextSpend.`,
    });
  }

  if (dag.virtualDaaScore < s.notBefore) {
    findings.push({
      level: "warn",
      text: `the spending window has not opened yet (notBefore ${s.notBefore})`,
    });
  }

  // What expiry does, stated exactly, because the loose version has been
  // wrong twice in this file's history.
  //
  // The spend path requires claimedDaa < expiresAt AND a non-decreasing epoch
  // index. Together those cap total spending at one epochLimit per epoch of
  // the window, consumed in order and once each. They do NOT stop an agent
  // dead at expiry: claimedDaa is agent-supplied and bounded above only by the
  // real chain time, so allowance from epochs the grant never used stays
  // consumable after the chain has passed expiresAt. No covenant can prevent
  // that — proving the chain is BEFORE a time is not expressible with CLTV.
  //
  // A grant that has been spending steadily carries about one epoch of
  // residual. A grant idle since epoch E carries the unused allowance of every
  // epoch from E to the end of the window. budgetTotal caps it regardless.
  if (dag.virtualDaaScore >= s.expiresAt) {
    const finalEpoch = (s.expiresAt - s.notBefore) / s.epochLength;
    const unusedEpochs = finalEpoch > s.epochIndex ? finalEpoch - s.epochIndex : 0n;
    const residual = unusedEpochs * s.epochLimit + (s.epochLimit - spentThisEpoch);
    const bounded = residual < remaining ? residual : remaining;
    findings.push({
      level: "warn",
      text:
        `past expiresAt (${s.expiresAt}); the principal may reclaim. The agent is ` +
        `not stopped dead: deferred epoch allowance stays spendable, up to about ` +
        `${bounded} sompi here. Reclaim to end it.`,
    });
  }

  return {
    address,
    scriptHash: hash,
    found: true,
    value: entry.value,
    covenantId: entry.covenantId ? toHex(entry.covenantId) : null,
    remaining,
    epochRemaining,
    maxNextSpend,
    boundBy,
    reclaimable: dag.virtualDaaScore >= s.expiresAt,
    findings,
    agrees: !findings.some((f) => f.level === "error"),
  };
}

/** The same check, against a live node. */
export async function verifyGrant(
  client: NodeClient,
  args: {
    grant: Grant;
    template: CovenantTemplate;
    prefix: NetworkPrefix;
    expect?: GrantExpectation;
  },
): Promise<GrantReport> {
  const address = scriptHashToAddress(scriptHashFor(args.template, args.grant), args.prefix);
  const [dag, utxos] = await Promise.all([
    client.getBlockDagInfo(),
    client.getUtxosByAddresses([address]),
  ]);
  return describeGrant(
    args.grant,
    args.template,
    args.prefix,
    utxos[0] ?? null,
    dag,
    args.expect ?? {},
  );
}
