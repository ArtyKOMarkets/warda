/**
 * The data behind an agent's public page.
 *
 *   source ops/node.env
 *   node --experimental-strip-types agents/tools/dashboard.ts \
 *     x402/demo/agent-003-grant.json \
 *     --id WARDA-003 \
 *     --recipients x402/demo/agent-003-recipients.txt \
 *     --purchases agent-003/purchases \
 *     --succeeds x402/demo/agent-002-grant.json \
 *     > site/src/agent-003.json
 *
 * One tool for every agent, because they are not three different dashboards —
 * they are one grant, reported, with a few optional facts. `--succeeds` adds
 * the grant this one replaced; `--parent` adds the grant that delegated it.
 * Neither is inferred: an agent whose page claims a lineage has to be handed
 * the manifest that proves it.
 *
 * ## What is derived and what is refused
 *
 * Nothing here is typed. The authority comes from the grant's manifest, which
 * is the covenant's own accounting; the payees come from the allowlist and
 * their COUNT is that list's length; the spending comes from the chain; and the
 * refusal sentences are produced by running the same `explainRefusal` the payer
 * calls, against real requirements.
 *
 * The one thing a page like this can assert without evidence is WHOSE address
 * it is allowed to pay. "Agent #002 paid agent #001" is a claim about identity,
 * and an ordinary address makes it unfalsifiable — it is whoever we say it is.
 * So every label comes from agents/known-payees.json, which carries the public
 * key and where to check it, and every label is re-derived on each run. A label
 * that stops matching is dropped rather than published, and an address nobody
 * has identified is rendered as an address.
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

const manifestPath = process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json"));
const agentId = flag("id");
const recipientsPath = flag("recipients");
const purchasesDir = flag("purchases");
if (!manifestPath || !agentId || !recipientsPath || !purchasesDir) {
  console.error(
    "usage: dashboard.ts <grant.json> --id WARDA-00N --recipients <file> --purchases <dir>\n" +
      "       [--mission text]\n" +
      "       [--succeeds <manifest> --succeeds-id WARDA-00N]   the grant this one replaced\n" +
      "       [--ended <txid>]                                  this grant has been revoked\n" +
      "       [--parent <manifest> --parent-id WARDA-00N]       the grant that delegated it\n" +
      "       [--endpoint url] [--rpc url]\n\n" +
      "Shared by every agent, so nothing defaults: a page built from the wrong grant\n" +
      "renders perfectly and is entirely false.",
  );
  process.exit(2);
}
const endpoint = flag("endpoint", "https://warda-demo-api.vercel.app/digest")!;
const mission = flag("mission", "");
/** The grant this one replaced, if any. Not inferred — handed over. */
const succeedsPath = flag("succeeds");
/** The grant that delegated this one, if this is a child. */
const parentPath = flag("parent");
/**
 * This grant has been revoked or reclaimed, and the txid that did it.
 *
 * An empty grant address means one of two things — the grant ENDED, or it
 * MOVED and this manifest has fallen behind — and the chain cannot tell them
 * apart: Kaspa's RPC answers "what is unspent here", never "what spent this".
 * The balance guard below is fatal precisely because guessing wrong publishes
 * a page about an agent that is quietly still running, or an obituary for one
 * that is.
 *
 * So it is not guessed. The operator says which, and hands over the exit's
 * transaction id — an assertion, but a checkable one: anyone can look it up
 * and watch the coin leave the covenant.
 */
const endedBy = flag("ended");

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
 * Who each allowed payee actually is, re-derived.
 *
 * A label is a claim about identity, and this is the one place a page like
 * this could assert something with nothing behind it. So the labels live in
 * agents/known-payees.json beside the public key they describe, and each is
 * checked here against the artefact it says it comes from. A label that no
 * longer matches is DROPPED — the address still renders, unlabelled, which is
 * the honest fallback. Publishing "agent #001" over an address that is no
 * longer agent #001's would be worse than publishing no name at all.
 */
interface KnownPayee { key: string; label: string; derivation: string; checkAgainst: string }
const known: KnownPayee[] = JSON.parse(
  readFileSync(here("../known-payees.json"), "utf8"),
).payees;

const payees = members.map((key) => {
  const address = pubkeyToAddress(fromHex(key), prefix);
  const entry = known.find((k) => k.key.toLowerCase() === key.toLowerCase());
  if (!entry) return { address, key, label: null, derivation: null };
  /* Re-derive from the named artefact. `#field` reads that field of a JSON
     manifest; anything else is a file whose whole contents are the key. */
  const [file, field] = entry.checkAgainst.split("#");
  let actual: string | null = null;
  try {
    const raw = readFileSync(here(`../../${file}`), "utf8");
    actual = field ? String(JSON.parse(raw)[field]).toLowerCase() : raw.trim().toLowerCase();
  } catch {
    actual = null;
  }
  if (actual !== key.toLowerCase()) {
    console.error(
      `dropping the label "${entry.label}" for ${address}:\n` +
        `  ${entry.checkAgainst} says ${actual ?? "nothing readable"}\n` +
        `  the allowlist commits to ${key}\n` +
        `  The address is published without a name rather than with the wrong one.`,
    );
    return { address, key, label: null, derivation: null };
  }
  return { address, key, label: entry.label, derivation: entry.derivation };
});
const payee = payees[0]!.address;

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
  const [atGrant, atPayees, dag] = await Promise.all([
    client.getUtxosByAddresses([address]),
    /* EVERY payee, not the first.
       It asked only about payees[0], which was right while every agent here had
       a one-address allowlist and silently wrong the moment one did not: agent
       #003 paid the demo vendor 0.03 KAS and its page reported one payment
       instead of two. A page whose whole argument is that its figures can be
       checked must not undercount the money it spent — and undercounting is the
       flattering direction, which makes it the one to be careful about. */
    client.getUtxosByAddresses(payees.map((p) => p.address)),
    client.getBlockDagInfo(),
  ]);

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
   * Which coins at the payees are THIS grant's, and the answer is: only the
   * ones it has a receipt for.
   *
   * This used to be "created after this grant opened and no larger than its
   * per-payment cap", which is a heuristic and was fine while one grant paid
   * each address. It is not fine now. Agent #002 and agent #003 both pay agent
   * #001, both in 0.04 KAS, and #003's grant opened after #002's — so #002's
   * page counted #003's payment as its own and reported three payments where it
   * had made two. Overcounting an agent's spending is a smaller sin than
   * undercounting it and it is still a false figure on a page whose argument is
   * that its figures can be checked.
   *
   * A transaction id is not a heuristic. `ours` is now the coins the purchase
   * log names; everything else in range is reported separately as what it is —
   * money at a shared address that cannot be attributed by looking at the
   * address.
   */
  const loggedTxids = new Set(
    purchases.map((p) => p.txid).filter(Boolean) as string[],
  );
  const inRange = atPayees.filter(
    (u) => u.entry.blockDaaScore >= state.notBefore && u.entry.value <= state.maxPerSpend,
  );
  const ours = inRange.filter((u) => loggedTxids.has(toHex(u.outpoint.transactionId)));
  const unattributed = inRange.filter((u) => !loggedTxids.has(toHex(u.outpoint.transactionId)));

  /* The manifest's claim about the coin, checked against the coin. Fatal: a
     page arguing that its numbers can be checked must not publish one that
     disagrees with the chain. */
  if (m.grant_value !== undefined && m.grant_value !== null) {
    const claimed = BigInt(m.grant_value);
    const actual = atGrant.length ? atGrant[0]!.entry.value : null;
    if (actual === null && endedBy) {
      /* Expected. An ended grant holds nothing — that is what ending one does,
         and the operator has named the transaction that did it. */
    } else if (actual === null) {
      console.error(
        `the manifest says this grant holds ${kas(claimed)}, and there is nothing at\n` +
          `${address}. Either it MOVED — recover it with sdk/tools/follow-grant.ts before\n` +
          `publishing a page about where it used to be — or it ENDED, in which case pass\n` +
          `--ended <txid> naming the exit and this reports a retired agent instead of\n` +
          `refusing. The chain cannot tell those apart and neither can this tool.`,
      );
      process.exit(1);
    }
    if (actual !== null && actual !== claimed) {
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

  /**
   * The grant this one replaced, and whether it is actually gone.
   *
   * A succession page's whole claim is that one authority ENDED and another
   * began. The predecessor's manifest says what it was; only the chain says
   * whether it still exists. So the old grant's address is derived from its
   * own manifest and asked about directly, and `stillHoldsCoin` is the answer
   * rather than a sentence.
   *
   * There is a window in this that most systems would hide: the successor is
   * created timelocked and the predecessor is revoked while the lock is still
   * on, so for a few minutes NEITHER grant can spend. That gap is real, it is
   * the honest shape of a handover between two authorities that never share a
   * key, and pretending it is atomic would be the one lie available here.
   */
  let succession: Record<string, unknown> | undefined;
  if (succeedsPath) {
    const pm = JSON.parse(readFileSync(succeedsPath, "utf8"));
    const pAuthority = { principalKey: pm.principal, revocationKey: pm.revocation ?? pm.principal };
    const pState: GrantState = {
      agentKey: pm.agent,
      budgetTotal: BigInt(pm.budget),
      maxPerSpend: BigInt(pm.max_per_spend),
      epochLimit: BigInt(pm.epoch_limit),
      epochLength: BigInt(pm.epoch_length),
      recipientsRoot: pm.recipients_root,
      notBefore: BigInt(pm.not_before),
      expiresAt: BigInt(pm.expires_at),
      delegationDepth: BigInt(pm.delegation_depth ?? 2),
      templateId: templateIdFor(template, pAuthority),
      spentTotal: BigInt(pm.spent_total ?? 0),
      reserved: BigInt(pm.reserved ?? 0),
      epochIndex: BigInt(pm.epoch_index ?? 0),
      epochSpent: BigInt(pm.epoch_spent ?? 0),
      reserveRoot: pm.reserve_root ?? EMPTY_RESERVE,
    };
    const pAddress = scriptHashToAddress(
      scriptHashFor(template, { authority: pAuthority, state: pState }),
      prefix,
    );
    const still = await client.getUtxosByAddresses([pAddress]);
    succession = {
      replaced: flag("succeeds-id", "the previous agent"),
      grantAddress: pAddress,
      agentKey: pm.agent,
      /* Neither agent ever held the other's key: two different agent keys on
         two grants, which is a fact about the manifests and checkable here. */
      differentKey: pm.agent !== m.agent,
      itSpent: kas(BigInt(pm.spent_total ?? 0)),
      stillHoldsCoin: still.length > 0 ? kas(still[0]!.entry.value) : null,
      ended: still.length === 0,
      endedBy:
        "the revocation key, which is not the agent's. A grant's terms cannot be edited, so " +
        "replacing an agent's authority means ending one grant and starting another — and the " +
        "one that ends does not get a say in it.",
      handoverGap:
        still.length === 0 && !open
          ? "right now: the old grant is ended and the new one has not opened. Neither can spend."
          : "the successor was published timelocked and the predecessor revoked during the lock, " +
            "so there was a window in which neither grant could spend. A handover between two " +
            "authorities that never share a key is not atomic, and this page does not pretend it is.",
    };
  }

  /**
   * The grant that delegated this one, for a child.
   *
   * A child's authority is not merely smaller by convention — the covenant
   * refuses a delegation that widens anything, and the child commits to a NODE
   * of the parent's recipients tree rather than to a list of its own. So the
   * interesting numbers are the comparisons, and they are computed from the two
   * manifests rather than described.
   */
  let delegatedBy: Record<string, unknown> | undefined;
  if (parentPath) {
    const gm = JSON.parse(readFileSync(parentPath, "utf8"));
    delegatedBy = {
      parent: flag("parent-id", "its parent"),
      parentAgentKey: gm.agent,
      differentKey: gm.agent !== m.agent,
      narrower: {
        budget: `${kas(BigInt(gm.budget))} → ${kas(state.budgetTotal)}`,
        maxPerPayment: `${kas(BigInt(gm.max_per_spend))} → ${kas(state.maxPerSpend)}`,
        epochLimit: `${kas(BigInt(gm.epoch_limit))} → ${kas(state.epochLimit)}`,
        delegationDepth: `${Number(gm.delegation_depth ?? 2)} → ${Number(state.delegationDepth)}`,
        payees: `${Number(gm.recipients_count ?? 0) || "the parent's list"} → ${members.length}`,
      },
      /* The reserve is the parent's accounting of what it has lent out: budget
         it may no longer spend itself until the child settles back. */
      heldInReserveByTheParent: kas(BigInt(gm.reserved ?? 0)),
      enforcedBy:
        "the covenant, at delegation time. Every one of these may only ever shrink, and the " +
        "child's allowlist is a node of the parent's recipients tree with the path proved on " +
        "every spend — so a sub-agent cannot pay someone its parent could not.",
    };
  }

  /**
   * The agent's account of itself, checked against the covenant's.
   *
   * The authority on what a grant has spent is `spentTotal`, and it is not an
   * opinion: it is part of the state the grant's address is derived from, so a
   * wrong one produces a different address and the grant simply is not there.
   * The purchase log is the agent's own record and can be lost — it was, this
   * morning, when a vendor answered a settled payment with an HTML error page
   * and the parser threw before the txid was written down.
   *
   * So the two are compared. Coins at the payees are NOT the comparison: a
   * payee address serves whoever pays it, and two of the agents here pay the
   * same one.
   */
  const loggedSompi = purchases.reduce((a, p) => {
    const inLog = ours.find((u) => toHex(u.outpoint.transactionId) === p.txid);
    return inLog ? a + inLog.entry.value : a;
  }, 0n);
  const missingFromLog = state.spentTotal - loggedSompi;

  process.stdout.write(
    JSON.stringify(
      {
        _comment:
          "Written by agents/tools/dashboard.ts. Every figure is derived from the grant's " +
          "manifest, its allowlist, the purchase log or the chain — none is typed. Each payee's " +
          "LABEL is re-derived on every run from the artefact agents/known-payees.json names, " +
          "and a label that stops matching is dropped rather than published: an address with no " +
          "name is honest, an address with the wrong name is not.",
        checkedAt: new Date().toISOString(),
        network: health.network,
        identity: {
          agentId,
          agent: m.agent,
          principal: m.principal,
          revocation: m.revocation ?? m.principal,
          grantAddress: address,
          covenantId: m.covenant_id,
          template: m.covenant,
        },
        buysFrom: {
          endpoint,
          /* Every address this grant may pay, with a name only where the name
             was re-derived from something published. */
          payees,
          address: payee,
          bothEndsAreOurs: true,
          disclosure:
            "Every agent on this site was built here, and the vendors they buy from are ours " +
            "too. What is demonstrated is therefore not a market — it is a payment: separate " +
            "grants, separate keys, a fixed list of addresses each may pay, and settlements " +
            "anyone can look up. Agent #001's digest is published free at " +
            "wardaprotocol.com/agent-001.json, because pretending it was scarce would have " +
            "traded the checkable claim for a flattering one.",
        },
        ...(endedBy
          ? {
              retired: {
                endedBy,
                grantAddress: address,
                holdsNothing: atGrant.length === 0,
                itSpent: kas(state.spentTotal),
                ofBudget: kas(state.budgetTotal),
                note:
                  "This agent's authority is over. Its grant was ended by a transaction the " +
                  "revocation key signed, and the address above holds nothing — which anyone " +
                  "can check. What it did while it ran is below and does not change.",
              },
            }
          : {}),
        ...(succession ? { succession } : {}),
        ...(delegatedBy ? { delegatedBy } : {}),
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
          payees: payees.map((p) => p.address),
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
          spentPerTheCovenant: kas(state.spentTotal),
          namedByTheLog: kas(loggedSompi),
          unrecorded: kas(missingFromLog > 0n ? missingFromLog : 0n),
          /* In range at a payee and not named by any receipt. NOT claimed as
             this grant's: a payee address serves whoever pays it, and two
             agents here pay the same one. */
          atThePayeesWithNoReceipt: unattributed.map((u) => ({
            amount: kas(u.entry.value),
            txid: toHex(u.outpoint.transactionId),
            daaScore: u.entry.blockDaaScore.toString(),
          })),
          note:
            missingFromLog <= 0n
              ? "Every sompi the covenant says this grant spent is named by a purchase it " +
                "recorded. The two halves of this page agree."
              : `The covenant's own accounting says this grant spent ${kas(state.spentTotal)} ` +
                `and its purchase log names ${kas(loggedSompi)} of that. ${kas(missingFromLog)} ` +
                `left this grant without a surviving record of why. spentTotal is part of the ` +
                `state the grant's address is derived from, so it cannot be quietly wrong — the ` +
                `log can, and was. That is the failure this page reports rather than the one it ` +
                `hides.`,
        },
        refusals,
        mission,
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
  if (missingFromLog > 0n) {
    console.error(
      `UNRECORDED: the covenant says ${kas(state.spentTotal)} was spent and the log names ` +
        `${kas(loggedSompi)}. ${kas(missingFromLog)} left this grant with no surviving receipt.`,
    );
  }
  if (unattributed.length) {
    console.error(
      `at the payees with no receipt from this grant (may be another agent's — a payee ` +
        `address serves whoever pays it):`,
    );
    for (const u of unattributed) {
      console.error(`  ${kas(u.entry.value)}  ${toHex(u.outpoint.transactionId)}`);
    }
  }
} finally {
  client.close();
}
