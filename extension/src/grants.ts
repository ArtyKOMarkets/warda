/**
 * Issuing a grant, listing what was issued, and ending one.
 *
 * This mirrors `sdk/tools/genesis.ts` and `sdk/tools/build-exit.ts` rather
 * than reimplementing them: every rule that decides what a grant permits is
 * computed once, in `@warda_protocol/core` and the SDK, and a second copy of
 * one here would be a second thing to get wrong. What is genuinely different
 * is only the environment — no files, no flags, no stdout.
 *
 * ## The ordering that is not a preference
 *
 * The manifest is written BEFORE the broadcast, always. A grant's address is
 * derived from its parameters, so a submit that succeeds while the record is
 * lost strands the coin at an address nobody can reconstruct. Writing first can
 * only ever leave a record for a grant that does not exist, and that is
 * recoverable by noticing.
 *
 * ## The agent key is generated, shown once, and not kept
 *
 * It could be DERIVED from the principal key, which would make it recoverable.
 * That is what the repo's demo tooling does, and it is wrong here: a principal
 * who can re-derive the agent key can spend the grant themselves, which
 * collapses the separation the whole protocol is about. So it is random, it
 * crosses to the screen exactly once, and the console says plainly that losing
 * it leaves a grant that can still be revoked but never spent.
 */
import {
  attachExitSignature,
  attachGenesisSignature,
  agentPublicKey,
  buildGenesis,
  buildUnsignedExit,
  decodeAddress,
  fromHex,
  pubkeyToAddress,
  RecipientSet,
  assertRecipientsFitTemplate,
  candidateStates,
  scriptHashFor,
  scriptHashToAddress,
  signDigest,
  templateFingerprint,
  templateIdFor,
  toHex,
  verifyDigest,
  EMPTY_RESERVE,
  type CovenantTemplate,
  type GrantAuthority,
  type GrantState,
  type NetworkPrefix,
  type NodeClient,
  type Payment,
} from "@warda_protocol/kaspa";
import { schnorr } from "@noble/curves/secp256k1.js";
import rawTemplate from "@warda_protocol/kaspa/covenant-template.json";
import { withNode } from "./chain.ts";
import { settings } from "./store.ts";
import * as vault from "./vault.ts";

/* `as unknown as`: the JSON import's numbers infer as `number`, and a
   CovenantTemplate's state fields are bigint because sompi are u64. The two
   types do not overlap, so the direct assertion is an error. Values are parsed
   into bigints downstream; only the static type is being corrected. */
const TEMPLATE = rawTemplate as unknown as CovenantTemplate;

/** Genesis is a plain P2PK spend that happens to pay into a covenant. */
const GENESIS_COMPUTE_BUDGET = 12;
const EXIT_COMPUTE_BUDGET = 12;
const GRANTS = "grants";

/** bigints do not survive `chrome.storage`, so they are stored as strings. */
export interface StoredState {
  agentKey: string;
  budgetTotal: string;
  maxPerSpend: string;
  epochLimit: string;
  epochLength: string;
  recipientsRoot: string;
  notBefore: string;
  expiresAt: string;
  delegationDepth: string;
  templateId: string;
  spentTotal: string;
  reserved: string;
  epochIndex: string;
  epochSpent: string;
  reserveRoot: string;
}

export interface GrantRecord {
  id: string;
  label: string;
  covenant: string;
  network: string;
  authority: GrantAuthority;
  state: StoredState;
  recipients: string[];
  grantValue: string;
  createdAt: string;
  genesisTxid: string | null;
  /** Set when this console ended it. A revoked grant is history, not permission. */
  endedBy: string | null;
}

export interface IssueTerms {
  label: string;
  /** Kaspa addresses or bare x-only keys; commas or newlines. */
  recipients: string;
  budgetSompi: string;
  maxPerSpendSompi: string;
  epochLimitSompi: string;
  epochLengthDaa: string;
  windowDaa: string;
  feeSompi: string;
}

export interface LiveGrant {
  record: GrantRecord;
  address: string;
  /** null when nothing is at the current address — see `detail`. */
  balanceSompi: string | null;
  /** What the covenant has counted as spent. Real only once a grant is placed. */
  spentSompi: string;
  detail: string;
  /** Payments folded in to place it this read, if it had moved. */
  caughtUp: number;
}

function toState(s: StoredState): GrantState {
  return {
    agentKey: s.agentKey,
    budgetTotal: BigInt(s.budgetTotal),
    maxPerSpend: BigInt(s.maxPerSpend),
    epochLimit: BigInt(s.epochLimit),
    epochLength: BigInt(s.epochLength),
    recipientsRoot: s.recipientsRoot,
    notBefore: BigInt(s.notBefore),
    expiresAt: BigInt(s.expiresAt),
    delegationDepth: BigInt(s.delegationDepth),
    templateId: s.templateId,
    spentTotal: BigInt(s.spentTotal),
    reserved: BigInt(s.reserved),
    epochIndex: BigInt(s.epochIndex),
    epochSpent: BigInt(s.epochSpent),
    reserveRoot: s.reserveRoot,
  };
}

function fromState(s: GrantState): StoredState {
  const n = (v: bigint) => v.toString();
  return {
    agentKey: s.agentKey,
    budgetTotal: n(s.budgetTotal),
    maxPerSpend: n(s.maxPerSpend),
    epochLimit: n(s.epochLimit),
    epochLength: n(s.epochLength),
    recipientsRoot: s.recipientsRoot,
    notBefore: n(s.notBefore),
    expiresAt: n(s.expiresAt),
    delegationDepth: n(s.delegationDepth),
    templateId: s.templateId,
    spentTotal: n(s.spentTotal),
    reserved: n(s.reserved),
    epochIndex: n(s.epochIndex),
    epochSpent: n(s.epochSpent),
    reserveRoot: s.reserveRoot,
  };
}

/**
 * An allowlist from what someone typed.
 *
 * Addresses or bare x-only keys, commas or newlines, `#` comments stripped per
 * line. Deliberately identical in behaviour to `sdk/tools/members.ts` minus
 * its file handling: a grant commits to a Merkle ROOT and a spend rebuilds the
 * list to prove against it, so two readers that disagree produce a root the
 * covenant never committed to.
 */
export function membersFrom(text: string): string[] {
  const members = text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase()));
  if (members.length === 0) throw new Error("a grant needs at least one payee");
  for (const m of members) {
    if (!/^[0-9a-f]{64}$/.test(m)) {
      throw new Error(`not a kaspa address or an x-only key: ${m.slice(0, 24)}…`);
    }
  }
  return members;
}

function prefixFor(network: string): NetworkPrefix {
  return (network === "mainnet" ? "kaspa" : "kaspatest") as NetworkPrefix;
}

export function addressOf(record: GrantRecord, network: string): string {
  const hash = scriptHashFor(TEMPLATE, { authority: record.authority, state: toState(record.state) });
  return scriptHashToAddress(hash, prefixFor(network));
}

export async function all(): Promise<GrantRecord[]> {
  const got = await chrome.storage.local.get(GRANTS);
  return (got[GRANTS] as GrantRecord[] | undefined) ?? [];
}

async function put(record: GrantRecord): Promise<void> {
  const list = await all();
  const i = list.findIndex((g) => g.id === record.id);
  if (i >= 0) list[i] = record;
  else list.unshift(record);
  await chrome.storage.local.set({ [GRANTS]: list });
}

async function principal(): Promise<{ secret: Uint8Array; key: string }> {
  const secret = await vault.secret();
  if (!secret) throw new Error("the console is locked");
  return { secret, key: toHex(agentPublicKey(secret)) };
}

/**
 * Live state, and the one thing that must not be guessed.
 *
 * A grant's address is a hash of its state, so every spend MOVES it. An empty
 * address therefore means one of: it moved and this record is behind, it was
 * drained, it was revoked, or it was never funded — and nothing observable
 * here separates them. Reporting "0 KAS" would pick one of those four and
 * present it as fact. So this reports what it saw.
 */
export async function live(): Promise<LiveGrant[]> {
  const s = await settings();
  const records = await all();
  if (records.length === 0) return [];
  const mine = records.filter((r) => r.network === s.network);

  return withNode(async (client) => {
    const addresses = mine.map((r) => addressOf(r, s.network));
    const utxos = await client.getUtxosByAddresses(addresses);
    const out: LiveGrant[] = [];

    for (let i = 0; i < mine.length; i++) {
      let record = mine[i]!;
      const address = addresses[i]!;
      const spent = () => record.state.spentTotal;

      if (record.endedBy) {
        out.push({
          record, address, balanceSompi: null, spentSompi: spent(), caughtUp: 0,
          detail: `ended by ${record.endedBy.slice(0, 12)}…`,
        });
        continue;
      }

      const here = utxos.filter((u) => u.address === address);
      if (here.length > 0) {
        out.push({
          record, address, caughtUp: 0, spentSompi: spent(),
          balanceSompi: here.reduce((acc, u) => acc + u.entry.value, 0n).toString(),
          detail: "at the address this state derives",
        });
        continue;
      }

      /* Nothing here, which is where this console used to stop and say it
         could not tell. It can now look: the coins at the PAYEES are one UTXO
         per payment, and three numbers decide where a grant lands. */
      const found = await follow(record, client, s.network).catch(() => null);
      if (found) {
        record = await advance(record, found);
        out.push({
          record,
          address: found.address,
          balanceSompi: found.balanceSompi.toString(),
          spentSompi: record.state.spentTotal,
          caughtUp: found.applied,
          detail:
            `followed ${found.applied} payment${found.applied === 1 ? "" : "s"}` +
            (found.viaSubsets ? ", through a payee shared with another grant" : ""),
        });
        continue;
      }

      out.push({
        record, address, balanceSompi: null, spentSompi: spent(), caughtUp: 0,
        detail:
          "nothing here, and the coins at its payees do not place it either. It was drained, " +
          "revoked, never funded — or it paid someone this record does not list.",
      });
    }
    return out;
  });
}

export interface Issued {
  record: GrantRecord;
  /** Crosses to the screen once and is stored nowhere. */
  agentSecretHex: string;
  address: string;
  txid: string;
}

export async function issue(terms: IssueTerms): Promise<Issued> {
  const { secret, key } = await principal();
  const s = await settings();
  const prefix = prefixFor(s.network);

  const recipients = new RecipientSet(membersFrom(terms.recipients).map(fromHex));
  // Before anything is funded: a set deeper than the template can prove makes
  // a grant that accepts money and can never pay anyone on it.
  assertRecipientsFitTemplate(TEMPLATE, recipients);

  const budget = BigInt(terms.budgetSompi);
  const fee = BigInt(terms.feeSompi);
  const authority: GrantAuthority = { principalKey: key, revocationKey: key };

  const agentSecret = schnorr.utils.randomSecretKey();
  const agentKey = toHex(agentPublicKey(agentSecret));

  const result = await withNode(async (client) => {
    const fundingAddress = pubkeyToAddress(agentPublicKey(secret), prefix);
    const [dag, utxos] = await Promise.all([
      client.getBlockDagInfo(),
      client.getUtxosByAddresses([fundingAddress]),
    ]);

    /* Largest single coin. Genesis takes ONE input, so the grant is bounded by
       the biggest coin the key holds and not by its total — a distinction that
       is invisible until it appears as an arithmetic failure. */
    const funding = utxos
      .filter((u) => !u.entry.covenantId)
      .sort((a, b) => (b.entry.value > a.entry.value ? 1 : -1))[0];
    if (!funding) throw new Error(`no spendable coin at ${fundingAddress}. Fund it from the faucet first.`);
    if (funding.entry.value < budget + fee) {
      throw new Error(
        `the largest single coin here is ${funding.entry.value} sompi, and this grant needs ` +
          `${budget + fee}. Genesis takes one input, so consolidate first or lower the budget.`,
      );
    }

    const notBefore = dag.virtualDaaScore;
    const state: GrantState = {
      agentKey,
      budgetTotal: budget,
      maxPerSpend: BigInt(terms.maxPerSpendSompi),
      epochLimit: BigInt(terms.epochLimitSompi),
      epochLength: BigInt(terms.epochLengthDaa),
      recipientsRoot: toHex(recipients.root),
      notBefore,
      expiresAt: notBefore + BigInt(terms.windowDaa),
      delegationDepth: 2n,
      templateId: templateIdFor(TEMPLATE, authority),
      // The covenant requires all four to be zero at genesis. A nonzero one
      // here is a grant born already spent.
      spentTotal: 0n,
      reserved: 0n,
      epochIndex: 0n,
      epochSpent: 0n,
      reserveRoot: EMPTY_RESERVE,
    };

    const built = buildGenesis({
      template: TEMPLATE,
      grant: { authority, state },
      funding: {
        outpointTransactionId: funding.outpoint.transactionId,
        outpointIndex: funding.outpoint.index,
        value: funding.entry.value,
        scriptPublicKey: funding.entry.scriptPublicKey,
        blockDaaScore: funding.entry.blockDaaScore,
        isCoinbase: funding.entry.isCoinbase,
      },
      grantValue: budget,
      fee,
      computeBudget: GENESIS_COMPUTE_BUDGET,
    });

    const signature = signDigest(built.sighash, secret);
    if (!verifyDigest(signature, built.sighash, agentPublicKey(secret))) {
      throw new Error("the signature does not verify against the digest it was made over");
    }
    const tx = attachGenesisSignature(built, signature);
    const address = scriptHashToAddress(toHex(built.grantScriptHash), prefix);

    const record: GrantRecord = {
      id: toHex(built.grantScriptHash),
      label: terms.label.trim() || "untitled grant",
      covenant: templateFingerprint(TEMPLATE),
      network: s.network,
      authority,
      state: fromState(state),
      recipients: membersFrom(terms.recipients),
      grantValue: budget.toString(),
      createdAt: new Date().toISOString(),
      genesisTxid: null,
      endedBy: null,
    };
    // WRITTEN BEFORE BROADCAST. See the header.
    await put(record);

    /* The SDK's own submitTransaction, which wires the transaction itself.
       `toWire` produces the DOCUMENT shape — what a verifier reads, entry
       included — and handing that to the node instead would send an envelope
       kaspad has no field for. */
    const txid = await client.submitTransaction(tx);
    record.genesisTxid = txid;
    await put(record);
    return { record, address, txid };
  });

  return { ...result, agentSecretHex: toHex(agentSecret) };
}

/**
 * End a grant and take the balance back.
 *
 * Revoke, not reclaim: reclaim compiles `tx.daa >= expiresAt` to a CLTV and is
 * only available after expiry. Revoke is the principal's right at any moment,
 * and it is the feature that most justifies this key living in a browser at
 * all.
 */
export async function revoke(id: string, feeSompi: string): Promise<{ txid: string; returned: string }> {
  const { secret, key } = await principal();
  const s = await settings();
  const record = (await all()).find((g) => g.id === id);
  if (!record) throw new Error("no such grant in this console");
  if (record.endedBy) throw new Error(`this grant was already ended by ${record.endedBy}`);
  if (record.authority.revocationKey !== key) {
    throw new Error(
      `this console's key cannot revoke that grant: it names ${record.authority.revocationKey.slice(0, 16)}… ` +
        `as revocation and this key is ${key.slice(0, 16)}…`,
    );
  }

  const state = toState(record.state);
  const address = addressOf(record, s.network);
  const fee = BigInt(feeSompi);

  return withNode(async (client) => {
    const utxos = await client.getUtxosByAddresses([address]);
    const utxo = utxos[0];
    if (!utxo) {
      throw new Error(
        `there is no coin at ${address}. A grant's address moves with every spend, so this record may ` +
          `simply be behind — it is not proof the grant is gone.`,
      );
    }

    const plan = {
      kind: "revoke" as const,
      template: TEMPLATE,
      authority: record.authority,
      state,
      utxo: {
        outpointTransactionId: utxo.outpoint.transactionId,
        outpointIndex: utxo.outpoint.index,
        value: utxo.entry.value,
        blockDaaScore: utxo.entry.blockDaaScore,
        isCoinbase: utxo.entry.isCoinbase,
        covenantId: utxo.entry.covenantId ?? new Uint8Array(32),
      },
      fee,
      computeBudget: EXIT_COMPUTE_BUDGET,
      // Revoke carries no timelock. Only reclaim does.
      lockTime: 0n,
    };

    const unsigned = buildUnsignedExit(plan);
    const signature = signDigest(unsigned.sighash, secret);
    if (!verifyDigest(signature, unsigned.sighash, agentPublicKey(secret))) {
      throw new Error("the signature does not verify against the digest it was made over");
    }
    const tx = attachExitSignature(plan, unsigned, signature);
    const txid = await client.submitTransaction(tx);

    record.endedBy = txid;
    await put(record);
    return { txid, returned: (utxo.entry.value - fee).toString() };
  });
}

// ---- following a grant that moved -----------------------------------------
//
// A grant's address is a hash of its state, so every spend RELOCATES it and a
// record one payment stale points at an empty address. Kaspa's node RPC
// answers "what is unspent here" and never "what spent this", so catching up
// means guessing states and asking.
//
// `candidateStates` in the SDK does the guessing, and the reason it is cheap
// is worth knowing before changing anything here: a spend moves exactly three
// fields — spentTotal, epochIndex, epochSpent — so where a grant LANDS after
// any number of payments depends on three numbers and not at all on the order
// they happened in. That turns a combinatorial walk into an enumeration of
// endpoints, and an endpoint is the one thing actually observable.
//
// The evidence is the coins at the PAYEES: one UTXO per payment, each carrying
// the DAA score of the block that accepted it. Which is why the recipients are
// kept in the record — a lost payee list is a grant that can still be revoked
// but never followed.

/** How many addresses to ask about in one call. */
const PROBE_BATCH = 40;

/**
 * Escalate to subsets when the suffix search finds nothing and the list is
 * short. Suffixes assume the payee serves this grant alone; a SHARED payee
 * interleaves two grants' payments and no suffix describes them. Subsets are
 * 2^n, so this is a small number on purpose.
 */
const SUBSET_CEILING = 12;

export interface Followed {
  state: GrantState;
  address: string;
  balanceSompi: bigint;
  /** How many payments had to be folded in to get here. */
  applied: number;
  /** True when the suffix search failed and subsets found it. */
  viaSubsets: boolean;
}

/**
 * Find where a grant went, or return null and say nothing false.
 *
 * Null does not mean "gone". It means this console could not place it from the
 * coins it can see — which is also what an ended, drained or never-funded
 * grant looks like, and the caller must keep saying so rather than picking one.
 */
export async function follow(record: GrantRecord, client: NodeClient, network: string): Promise<Followed | null> {
  const prefix = prefixFor(network);
  const state = toState(record.state);
  const payees = record.recipients.map((k) => pubkeyToAddress(fromHex(k), prefix));
  const coins = await client.getUtxosByAddresses(payees);

  const payments: Payment[] = coins.map((u) => ({
    value: u.entry.value,
    blockDaaScore: u.entry.blockDaaScore,
    id: `${toHex(u.outpoint.transactionId)}:${u.outpoint.index}`,
  }));
  if (payments.length === 0) return null;

  for (const subsets of [false, true]) {
    if (subsets && payments.length > SUBSET_CEILING) break;
    const candidates = candidateStates(state, payments, { subsets });
    // Fewest payments first, so a manifest stale by one spend costs one round
    // trip rather than a full sweep.
    for (let i = 0; i < candidates.length; i += PROBE_BATCH) {
      const batch = candidates.slice(i, i + PROBE_BATCH);
      const addresses = batch.map((c) =>
        scriptHashToAddress(scriptHashFor(TEMPLATE, { authority: record.authority, state: c.state }), prefix),
      );
      const found = await client.getUtxosByAddresses(addresses);
      if (found.length === 0) continue;
      /* Match by ADDRESS rather than taking found[0]: one call asks about
         forty, and the node's reply is not ordered by the question. */
      for (let j = 0; j < batch.length; j++) {
        const here = found.filter((u) => u.address === addresses[j]);
        if (here.length === 0) continue;
        return {
          state: batch[j]!.state,
          address: addresses[j]!,
          balanceSompi: here.reduce((acc, u) => acc + u.entry.value, 0n),
          applied: batch[j]!.applied.length,
          viaSubsets: subsets,
        };
      }
    }
  }
  return null;
}

/** Write a followed state back, so the next read starts from where it is. */
export async function advance(record: GrantRecord, found: Followed): Promise<GrantRecord> {
  const next = { ...record, state: fromState(found.state) };
  await put(next);
  return next;
}
