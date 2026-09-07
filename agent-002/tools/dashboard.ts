/**
 * The data behind agent #002's public page.
 *
 *   source ../ops/node.env
 *   node --experimental-strip-types tools/dashboard.ts \
 *     ../x402/demo/agent-002-grant.json \
 *     --recipients ../x402/demo/agent-002-recipients.txt \
 *     --seller ../x402/demo/kaspa-x402-grant.json \
 *     > ../site/src/agent-002.json
 *
 * ## The claim this page has to survive
 *
 * #001's page says an agent spent money within limits the network enforced.
 * #002's says something a reader has more reason to doubt: that one agent paid
 * ANOTHER agent. Both ends are ours, so "agent #002 paid agent #001" is worth
 * exactly as much as the evidence that the address it paid belongs to #001 —
 * and an address we simply assert is #001's is not evidence at all.
 *
 * So the link is derived, and derived here, every time this runs: #001's
 * published manifest names its agent key, and the only address #002 may pay is
 * the pay-to-public-key address of that key. If those two stop matching, this
 * tool exits rather than publishing the sentence.
 *
 * ## Two limits, one of which is new
 *
 * #002 has a payee allowlist of exactly one, which is #001's answer as well.
 * What is new is `not_before`: authority that exists on chain and cannot be
 * used yet. That is the honest answer to "who can change what this agent may
 * spend, and how fast" — nobody, and not before a DAA score the covenant
 * checks on every spend, including the party that issued the grant.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
import { explainRefusal, type Grant } from "../../x402/src/payer.ts";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};
const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const manifestPath =
  process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json")) ??
  here("../../x402/demo/agent-002-grant.json");
const recipientsPath = flag("recipients", here("../../x402/demo/agent-002-recipients.txt"))!;
const sellerManifest = flag("seller", here("../../x402/demo/kaspa-x402-grant.json"))!;
const purchasesDir = flag("purchases", here("../purchases"))!;
const endpoint = flag("endpoint", "https://warda-demo-api.vercel.app/digest")!;

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(here("../../sdk/covenant-template.json"), "utf8"),
);
const prefix = "kaspatest";

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

/**
 * The identity check, run rather than asserted.
 *
 * Fatal on mismatch. The alternative — publishing the page with a softer
 * sentence — is how a claim survives the evidence that supported it.
 */
const seller = JSON.parse(readFileSync(sellerManifest, "utf8"));
const sellerAddress = pubkeyToAddress(fromHex(seller.agent), prefix);
const payee = pubkeyToAddress(fromHex(members[0]!), prefix);
if (members.length !== 1 || payee !== sellerAddress) {
  console.error(
    `agent #002's allowlist is ${members.length} address(es), the first being\n` +
      `  ${payee}\n` +
      `and agent #001's published agent key ${seller.agent}\n` +
      `is the address\n  ${sellerAddress}\n` +
      `These must be the same address, or the page's central claim — that #002 paid #001 —\n` +
      `is not supported by anything. Refusing to publish it.`,
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
const address = scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix);

const kas = (v: bigint) => {
  const whole = v / 100_000_000n, frac = v % 100_000_000n;
  return frac === 0n
    ? `${whole} KAS`
    : `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")} KAS`;
};

/** DAA scores are seconds at ten blocks per second. Said in words, once. */
function daaDuration(daa: bigint): string {
  const s = Number(daa) / 10;
  if (s < 90) return `${Math.round(s)} second${Math.round(s) === 1 ? "" : "s"}`;
  const mins = Math.round(s / 60);
  if (mins < 90) return `${mins} minute${mins === 1 ? "" : "s"}`;
  const hours = Math.round(s / 3600);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(s / 86400);
  return `${days} day${days === 1 ? "" : "s"}`;
}

// ---- the refusals, produced by the covenant's own reasoning ---------------

const ask = (amountSompi: bigint, payTo = payee) => ({
  scheme: "exact" as const,
  network: "testnet-10",
  asset: "KAS",
  payTo,
  amountSompi,
  nonce: "",
});

interface Refusal { rule: string; attempted: string; refusal: string; derived: boolean }
const refusals: Refusal[] = [];

const probes: { rule: string; attempted: string; req: ReturnType<typeof ask> }[] = [
  {
    rule: "payee allowlist",
    attempted: "pay any address other than agent #001",
    req: ask(1_000_000n, pubkeyToAddress(fromHex("cc".repeat(32)), prefix)),
  },
  {
    rule: "per-payment cap",
    attempted: `pay ${kas(state.maxPerSpend + 1n)} to agent #001`,
    req: ask(state.maxPerSpend + 1n),
  },
  {
    rule: "lifetime budget",
    attempted: `pay ${kas(state.budgetTotal)} to agent #001`,
    req: ask(state.budgetTotal),
  },
];
for (const p of probes) {
  const why = explainRefusal(p.req as never, grant, { fee: 2_000_000n });
  if (!why) {
    console.error(
      `PROBE PASSED: "${p.attempted}" was NOT refused. Either the grant's limits changed or\n` +
        `this probe no longer tests what it claims. Refusing to publish a refusal that did not happen.`,
    );
    process.exit(1);
  }
  refusals.push({ rule: p.rule, attempted: p.attempted, refusal: why, derived: true });
}

// ---- the chain -----------------------------------------------------------

const { client, health } = await NodeClient.open({
  url: flag("rpc") ?? process.env.WARDA_RPC_JSON,
  networkId: "testnet-10",
  tolerate: true,
});

try {
  const [atGrant, atPayee, dag] = await Promise.all([
    client.getUtxosByAddresses([address]),
    client.getUtxosByAddresses([payee]),
    client.getBlockDagInfo(),
  ]);

  /* Only coins THIS grant could have produced: created after it opened, and no
     larger than its per-payment cap. #001's address serves whoever pays it,
     and #001 was funded by other means before #002 existed. */
  const ours = atPayee.filter(
    (u) => u.entry.blockDaaScore >= state.notBefore && u.entry.value <= state.maxPerSpend,
  );

  /* The manifest's claim about the coin, checked against the coin. Fatal: a
     page arguing that its numbers can be checked must not publish one that
     disagrees with the chain. */
  if (m.grant_value !== undefined && m.grant_value !== null) {
    const claimed = BigInt(m.grant_value);
    const actual = atGrant.length ? atGrant[0]!.entry.value : null;
    if (actual === null) {
      console.error(
        `the manifest says this grant holds ${kas(claimed)}, and there is nothing at\n` +
          `${address}. It has moved to a successor address: recover it with\n` +
          `sdk/tools/follow-grant.ts before publishing a page about where it used to be.`,
      );
      process.exit(1);
    }
    if (actual !== claimed) {
      console.error(
        `the manifest says this grant holds ${kas(claimed)}; the chain says ${kas(actual)}.\n` +
          `Refusing to publish a balance the node disagrees with.`,
      );
      process.exit(1);
    }
  }

  const daa = dag.virtualDaaScore;
  const open = daa >= state.notBefore;

  refusals.unshift({
    rule: "start time (not_before)",
    attempted: "spend before the grant opens",
    refusal: open
      ? `this grant could not spend anything until DAA ${state.notBefore}. The covenant checks ` +
        `the claimed DAA score against that number on every spend, so the delay was not a ` +
        `policy in the agent's process and could not be brought forward by whoever issued it. ` +
        `It opened ${daaDuration(daa - state.notBefore)} ago.`
      : `this grant may not spend until DAA ${state.notBefore} and the network is at ${daa} — ` +
        `${daaDuration(state.notBefore - daa)} away. The covenant checks the claimed DAA score ` +
        `on every spend, so nobody can bring it forward, including whoever issued the grant.`,
    derived: true,
  });

  /* Every attempt, refusals included, exactly as buy.ts wrote them. */
  const purchases = existsSync(purchasesDir)
    ? readdirSync(purchasesDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => {
          const p = JSON.parse(readFileSync(`${purchasesDir}/${f}`, "utf8"));
          return {
            at: p.at,
            outcome: p.outcome,
            url: p.url,
            reason: p.reason ?? null,
            txid: p.txid ?? null,
            paid: p.quoted?.amountSompi ? kas(BigInt(p.quoted.amountSompi)) : null,
            payTo: p.quoted?.payTo ?? null,
            refusal: p.refusal ?? p.error ?? null,
            /* What the seller called itself. Recorded, not believed — the
               checkable half is payTo above. */
            sellerClaimed: p.sellerClaimed ?? null,
          };
        })
    : [];

  /**
   * The agent's account of itself, checked against the chain's.
   *
   * Two sections of this page report the same money from two directions, and
   * publishing both without comparing them leaves the reader to count. The
   * first time this ran they disagreed: two coins at the payee, one txid in the
   * log. The missing one was a payment that settled and then got an HTML error
   * page from a vendor whose node had gone unreachable — `res.json()` threw,
   * the catch recorded a parser complaint, and the transaction id of money
   * already spent went with it.
   *
   * That is fixed, and it will happen again in some other shape. An agent that
   * spends money can always lose the record of a spend, and the chain is the
   * half that cannot be lost. So the gap is computed and named rather than left
   * as an arithmetic exercise for whoever notices.
   */
  const logged = new Set(purchases.map((p) => p.txid).filter(Boolean) as string[]);
  const unaccounted = ours
    .filter((u) => !logged.has(toHex(u.outpoint.transactionId)))
    .map((u) => ({
      amount: kas(u.entry.value),
      txid: toHex(u.outpoint.transactionId),
      daaScore: u.entry.blockDaaScore.toString(),
    }));

  process.stdout.write(
    JSON.stringify(
      {
        _comment:
          "Written by agent-002/tools/dashboard.ts. Every figure is derived from the grant's " +
          "manifest, its allowlist, the purchase log or the chain — none is typed. The claim " +
          "that #002's payee IS agent #001 is re-derived from #001's published manifest on " +
          "every run, and this tool exits rather than publish it if the derivation fails.",
        checkedAt: new Date().toISOString(),
        network: health.network,
        identity: {
          agentId: "WARDA-002",
          agent: m.agent,
          principal: m.principal,
          revocation: m.revocation ?? m.principal,
          grantAddress: address,
          covenantId: m.covenant_id,
          template: m.covenant,
        },
        buysFrom: {
          agentId: "WARDA-001",
          endpoint,
          address: payee,
          agentKey: seller.agent,
          derivation:
            "the pay-to-public-key address of the agent key named in agent #001's published " +
            "manifest, x402/demo/kaspa-x402-grant.json. Rebuild it and compare: this page is " +
            "not asking to be taken at its word about whose address this is.",
          bothEndsAreOurs: true,
          disclosure:
            "Agent #001 and agent #002 were both built here. What is demonstrated is therefore " +
            "not a market — it is a payment: two independent grants, two keys, one address each " +
            "may pay, and a settlement anyone can look up. The digest #002 buys is published " +
            "free at wardaprotocol.com/agent-001.json, because pretending it was scarce would " +
            "have traded the checkable claim for a flattering one.",
        },
        timelock: {
          notBefore: state.notBefore.toString(),
          virtualDaaScore: daa.toString(),
          open,
          lockedFor: daaDuration(state.notBefore - BigInt(m.created_at_daa ?? m.not_before)),
          openedAgo: open ? daaDuration(daa - state.notBefore) : null,
          enforcedBy:
            "the covenant, on every spend: claimedDaa >= notBefore. Not a scheduler, not this " +
            "process, and not revocable by whoever issued the grant.",
        },
        authority: {
          budget: kas(state.budgetTotal),
          spent: kas(state.spentTotal),
          remaining: kas(state.budgetTotal - state.spentTotal - state.reserved),
          maxPerPayment: kas(state.maxPerSpend),
          epochLimit: kas(state.epochLimit),
          epochLengthDaa: Number(state.epochLength),
          authorizedPayees: members.length,
          payees: members.map((k) => pubkeyToAddress(fromHex(k), prefix)),
          delegationDepth: Number(state.delegationDepth),
          onChain: atGrant.length > 0 ? kas(atGrant[0]!.entry.value) : null,
          sompi: {
            budget: state.budgetTotal.toString(),
            spent: state.spentTotal.toString(),
            reserved: state.reserved.toString(),
            maxPerPayment: state.maxPerSpend.toString(),
            epochLimit: state.epochLimit.toString(),
            onChain: atGrant.length > 0 ? atGrant[0]!.entry.value.toString() : null,
          },
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
        purchases,
        reconciliation: {
          paymentsOnChain: ours.length,
          accountedForInTheLog: ours.length - unaccounted.length,
          unaccountedFor: unaccounted,
          note:
            unaccounted.length === 0
              ? "Every coin at the payee is named by a purchase this agent recorded. The two " +
                "halves of this page agree."
              : `${unaccounted.length} payment(s) reached the payee that this agent's own log ` +
                `does not name. The chain is the half that cannot be lost, so it is the one to ` +
                `believe. Money left this grant and the record of why did not survive — which ` +
                `is the failure this page reports rather than the one it hides.`,
        },
        refusals,
        mission:
          "Buy agent #001's network digest over HTTP 402, out of a grant that may pay one " +
          "address and could not pay it at all until a DAA score the covenant enforces.",
      },
      null,
      2,
    ) + "\n",
  );

  console.error(`grant     : ${address}`);
  console.error(`  holds   : ${atGrant.length ? kas(atGrant[0]!.entry.value) : "nothing"}`);
  console.error(`  spent   : ${kas(state.spentTotal)} of ${kas(state.budgetTotal)}`);
  console.error(`buys from : ${payee} (agent #001, derived)`);
  console.error(`timelock  : ${open ? "open" : "closed"} — notBefore ${state.notBefore}, now ${daa}`);
  console.error(`purchases : ${purchases.length} recorded, ${purchases.filter((p) => p.outcome === "bought").length} served`);
  console.error(`payments  : ${ours.length} attributable to this grant`);
  if (unaccounted.length) {
    console.error(
      `UNACCOUNTED: ${unaccounted.length} payment(s) on chain that the purchase log does not name:`,
    );
    for (const u of unaccounted) console.error(`  ${u.amount}  ${u.txid}`);
  }
} finally {
  client.close();
}
