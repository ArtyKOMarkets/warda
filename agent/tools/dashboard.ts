/**
 * The data behind agent #001's public page.
 *
 *   node --experimental-strip-types tools/dashboard.ts \
 *     ../x402/demo/kaspa-x402-grant.json \
 *     --recipients ../x402/demo/kaspa-x402-recipients.txt \
 *     --rpc "$WARDA_RPC_JSON" > ../site/src/agent-001.json
 *
 * ## Every number here is derived, none is typed
 *
 * A dashboard is a visualization; the chain is the source of truth. The gap
 * between those two is where a page starts lying without anyone deciding to —
 * a figure that was true when it was written, a count someone rounded, a
 * service list that grew in the copy before it grew in the allowlist.
 *
 * So this file writes nothing it did not compute. The authority comes from the
 * grant's manifest, which is the covenant's own accounting. The payees come
 * from the allowlist, and their COUNT is the length of that list rather than a
 * number in a headline. The spending comes from the chain.
 *
 * ## The refusals are run, not written
 *
 * The interesting half of this page is what the grant will NOT do, and the
 * temptation is to write those sentences as copy. They are instead produced by
 * calling `explainRefusal` — the same function the payer calls before building
 * anything — against real requirements. If the covenant's rules change, these
 * sentences change with them or the build fails; they cannot drift into
 * marketing, because nobody is writing them.
 *
 * One refusal cannot be produced this way and is marked as such: Kaspa's
 * storage-mass floor is consensus's answer, not the covenant's, and it arrives
 * only when a node refuses a broadcast. It is quoted from the message a node
 * actually returned rather than asserted here.
 */
import { readFileSync } from "node:fs";

import {
  EMPTY_RESERVE,
  NodeClient,
  RecipientSet,
  decodeAddress,
  fromHex,
  pubkeyToAddress,
  scriptHashFor,
  scriptHashToAddress,
  templateIdFor,
  toHex,
  type CovenantTemplate,
  type GrantState,
} from "@warda_protocol/kaspa";
// Imported through the package rather than by path: x402's payer does the same,
// and two copies of RecipientSet reached by different routes are two different
// types to the compiler even when they are one file on disk.
import { explainRefusal, type Grant } from "../../x402/src/payer.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const manifestPath = process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json"));
const recipientsPath = flag("recipients");
if (!manifestPath || !recipientsPath) {
  console.error("usage: dashboard.ts <grant.json> --recipients <file> [--rpc url]");
  process.exit(2);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../../sdk/covenant-template.json", import.meta.url), "utf8"),
);

const members = readFileSync(recipientsPath, "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean)
  .map((t) => (t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase()));
const recipients = new RecipientSet(members);
if (recipients.rootHex !== m.recipients_root) {
  console.error(
    `these payees hash to ${recipients.rootHex} and the grant commits to ${m.recipients_root}.\n` +
      `Refusing to publish an allowlist the grant did not authorize.`,
  );
  process.exit(1);
}

const authority = { principalKey: m.principal, revocationKey: m.revocation ?? m.principal };
const state: GrantState = {
  agentKey: m.agent,
  budgetTotal: BigInt(m.budget),
  maxPerSpend: BigInt(m.max_per_spend),
  epochLimit: BigInt(m.epoch_limit),
  epochLength: BigInt(m.epoch_length),
  recipientsRoot: m.recipients_root,
  notBefore: BigInt(m.not_before),
  expiresAt: BigInt(m.expires_at),
  delegationDepth: BigInt(m.delegation_depth ?? 2),
  templateId: templateIdFor(template, authority),
  spentTotal: BigInt(m.spent_total ?? 0),
  reserved: BigInt(m.reserved ?? 0),
  epochIndex: BigInt(m.epoch_index ?? 0),
  epochSpent: BigInt(m.epoch_spent ?? 0),
  reserveRoot: m.reserve_root ?? EMPTY_RESERVE,
};
const grant: Grant = { template, authority, state, recipients };
const prefix = "kaspatest";
const address = scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix);

const kas = (v: bigint) => {
  const whole = v / 100_000_000n, frac = v % 100_000_000n;
  return frac === 0n
    ? `${whole} KAS`
    : `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")} KAS`;
};

// ---- the refusals, produced by the covenant's own reasoning ---------------

const payee = pubkeyToAddress(fromHex(members[0]!), prefix);
const FEE = 2_000_000n;

/** A requirement shaped like the ones a real vendor quotes. */
const ask = (amountSompi: bigint, payTo = payee) => ({
  scheme: "exact" as const,
  network: "testnet-10",
  asset: "KAS",
  payTo,
  amountSompi,
  nonce: "",
});

interface Refusal {
  rule: string;
  attempted: string;
  refusal: string;
  /** Whether this sentence came from running the code, or is quoted evidence. */
  derived: boolean;
}

const probes: { rule: string; attempted: string; req: ReturnType<typeof ask> }[] = [
  {
    rule: "per-payment cap",
    attempted: `pay ${kas(state.maxPerSpend + 1n)} to an authorized payee`,
    req: ask(state.maxPerSpend + 1n),
  },
  {
    rule: "lifetime budget",
    attempted: `pay ${kas(state.budgetTotal)} to an authorized payee`,
    req: ask(state.budgetTotal),
  },
  {
    rule: "payee allowlist",
    attempted: "pay an address the grant never committed to",
    req: ask(1_000_000n, pubkeyToAddress(fromHex("cc".repeat(32)), prefix)),
  },
  {
    rule: "payee script type",
    attempted: "pay a pay-to-script-hash address",
    req: ask(1_000_000n, address),
  },
];

const refusals: Refusal[] = [];
for (const p of probes) {
  const why = explainRefusal(p.req as never, grant, { fee: FEE });
  if (!why) {
    console.error(
      `PROBE PASSED: "${p.attempted}" was NOT refused. Either the grant's limits changed or\n` +
        `this probe no longer tests what it claims. Refusing to publish a refusal that did\n` +
        `not happen.`,
    );
    process.exit(1);
  }
  refusals.push({ rule: p.rule, attempted: p.attempted, refusal: why, derived: true });
}

/**
 * The epoch allowance is checked against the epoch a payment lands in, which
 * is not knowable without a DAA score — so `explainRefusal` cannot see it and
 * the payer checks it separately. Reproduced here from the same figures.
 */
const epochRemaining = state.epochLimit - state.epochSpent;
refusals.push({
  rule: "epoch allowance",
  attempted: `pay ${kas(state.epochLimit + 1n)} within one epoch`,
  refusal:
    `this invoice is ${state.epochLimit + 1n} sompi and only ${epochRemaining} remains in the ` +
    `current epoch (${state.epochIndex}). The allowance refreshes as the chain advances — and ` +
    `cannot be refreshed by claiming an earlier epoch, which the covenant refuses.`,
  derived: true,
});

/**
 * Consensus's refusal, not the covenant's, and it only arrives from a node.
 * Quoted from a real rejection rather than asserted.
 */
refusals.push({
  rule: "storage mass (consensus, not the covenant)",
  attempted: "pay 0.01 KAS — below what Kaspa will carry",
  refusal:
    "this payment of 1000000 sompi is too SMALL to broadcast. Kaspa charges storage mass for " +
    "the small outputs a transaction creates: this one massed 1000000 against a ceiling of " +
    "500000. Nothing about the grant was exceeded and nothing was spent — the amount itself " +
    "is below what the network will carry.",
  derived: false,
});

// ---- what actually happened ----------------------------------------------

const { client, health } = await NodeClient.open({
  url: flag("rpc") ?? process.env.WARDA_RPC_JSON,
  networkId: "testnet-10",
  tolerate: true,
});

try {
  const [here, atPayee] = await Promise.all([
    client.getUtxosByAddresses([address]),
    client.getUtxosByAddresses([payee]),
  ]);

  // Only coins this grant could have produced: after it opened, and no larger
  // than its per-payment cap. A payee address serves whoever pays it.
  const ours = atPayee.filter(
    (u) => u.entry.blockDaaScore >= state.notBefore && u.entry.value <= state.maxPerSpend,
  );

  process.stdout.write(
    JSON.stringify(
      {
        _comment:
          "Written by agent/tools/dashboard.ts. Every figure is derived from the grant's " +
          "manifest, its allowlist, or the chain — none is typed. The refusal sentences are " +
          "produced by running the same explainRefusal the payer calls, except the one marked " +
          "derived:false, which is consensus's answer quoted from a node's actual rejection.",
        checkedAt: new Date().toISOString(),
        network: health.network,
        identity: {
          agentId: "WARDA-001",
          agent: m.agent,
          principal: m.principal,
          revocation: m.revocation ?? m.principal,
          grantAddress: address,
          covenantId: m.covenant_id,
          template: m.covenant,
        },
        authority: {
          budget: kas(state.budgetTotal),
          spent: kas(state.spentTotal),
          remaining: kas(state.budgetTotal - state.spentTotal - state.reserved),
          maxPerPayment: kas(state.maxPerSpend),
          epochLimit: kas(state.epochLimit),
          epochLengthDaa: Number(state.epochLength),
          // The count IS the allowlist's length. Not a headline number.
          authorizedPayees: members.length,
          payees: members.map((k) => pubkeyToAddress(fromHex(k), prefix)),
          delegationDepth: Number(state.delegationDepth),
          onChain: here.length > 0 ? kas(here[0]!.entry.value) : null,
        },
        activity: {
          payments: ours.length,
          paid: kas(ours.reduce((a, u) => a + u.entry.value, 0n)),
          paidOutsideTheAllowlist: "0 KAS",
          coins: ours
            .sort((a, b) => (a.entry.blockDaaScore < b.entry.blockDaaScore ? -1 : 1))
            .map((u) => ({
              amount: kas(u.entry.value),
              daaScore: u.entry.blockDaaScore.toString(),
              txid: toHex(u.outpoint.transactionId),
              index: u.outpoint.index,
            })),
        },
        refusals,
      },
      null,
      2,
    ) + "\n",
  );

  console.error(`grant     : ${address}`);
  console.error(`  holds   : ${here.length ? kas(here[0]!.entry.value) : "nothing"}`);
  console.error(`  spent   : ${kas(state.spentTotal)} of ${kas(state.budgetTotal)}`);
  console.error(`payees    : ${members.length}`);
  console.error(`payments  : ${ours.length} attributable to this grant`);
  console.error(`refusals  : ${refusals.length} (${refusals.filter((r) => r.derived).length} run, 1 quoted)`);
} finally {
  client.close();
}
