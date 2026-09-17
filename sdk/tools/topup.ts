/**
 * Decide whether a grant needs its successor, and whether one can be paid for.
 *
 *     WARDA_SK=$(cat funder.key) node --experimental-strip-types tools/topup.ts \
 *       --grant grant.json --budget 300000000 --fee 1000000 --below 25000000
 *
 * ## What this automates, and what it deliberately does not
 *
 * Funding an agent has two steps with very different shapes. The rare one is
 * getting KAS at all — a sale on an exchange, a withdrawal — and `warda fund`
 * prints it rather than performing it, because an API key with withdrawal
 * permission sitting in a cron job is a worse thing to own than the problem it
 * solves. The frequent one is the other end: a grant is a fixed budget, the
 * agent spends it, and somebody has to notice and issue the next one from KAS
 * the funder already holds.
 *
 * That second step is the one that runs out at 3am, and it needs no price, no
 * venue and nobody's word for anything. It is the one worth automating, and it
 * is all this does: read where the grant actually is, compare what is left
 * against a threshold, and say whether the funder's own coins can pay for the
 * next one. Creating it is `warda grant`, unchanged, one process later.
 *
 * ## It will not top up on a manifest it cannot confirm
 *
 * A grant's address is a hash of its state, so it moves on every spend and a
 * manifest goes stale the moment the agent does its job. A top-up computed
 * from a stale manifest is the failure that matters here: it reads a budget as
 * untouched, decides nothing is due, and the agent stops — or reads it as
 * spent, and issues a second grant while the first is still live and funded.
 *
 * So the reading is only believed when the chain holds a coin at the address
 * the manifest derives. When it does not, this refuses and names the command
 * that advances it. `warda topup` runs that command first, which is why the
 * refusal is rarer than it sounds — but the refusal is what makes the rest of
 * the output worth acting on.
 *
 * ## What "left" means
 *
 * Two different numbers can end an agent, and the smaller one is the answer:
 * the authority left in the covenant (`budget - spent - reserved`, which the
 * network enforces) and the coin left at the grant (which no rule can conjure
 * more of). The default threshold is the grant's own `max_per_spend` — below
 * that, it can no longer make a payment of the size it was authorised to make,
 * which is the point at which it has effectively stopped whatever the counters
 * say.
 *
 * ## Exit codes
 *
 *   0   nothing is due. The grant is above the threshold.
 *   70  a top-up is due and the funder can pay for it — `warda topup` goes on
 *       to `warda grant`. Chosen outside the CLI's documented 1-4 range so it
 *       can never be mistaken for one of the covenant's refusals.
 *   1   cannot proceed: the manifest could not be confirmed, or the funder is
 *       short. Nothing was built and no coin moved either way.
 */
import { readFileSync } from "node:fs";

import {
  EMPTY_RESERVE,
  NodeClient,
  agentPublicKey,
  fromHex,
  pubkeyToAddress,
  resolveNode,
  resolverFrom,
  scriptHashFor,
  scriptHashToAddress,
  templateIdFor,
  type CovenantTemplate,
  type GrantAuthority,
  type GrantState,
} from "@warda_protocol/kaspa";
import { formatKas } from "@warda_protocol/core";
import { authorityLeft, renewVerdict } from "@warda_protocol/router";
import covenantTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };

import { borshRequested, openChain, type Chain } from "./chain.ts";
import { assertKeyNotPublished, resolveNetwork } from "./network.ts";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const DUE = 70;

/* A coinbase output is not spendable yet and counting it as funding is how a
   top-up decides the funder is covered and then cannot build the genesis. */
const COINBASE_MATURITY = 100n;

const { prefix, network, isMainnet } = resolveNetwork({
  prefix: flag("prefix"),
  network: flag("network", "testnet-10"),
  action: "read a grant",
});

const manifestPath =
  flag("grant") ?? process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!manifestPath) {
  console.error("usage: topup.ts --grant <grant.json> --budget <sompi> [--below <sompi>]");
  process.exit(2);
}
const m = JSON.parse(readFileSync(manifestPath, "utf8"));

const budget = BigInt(flag("budget") ?? m.budget ?? "0");
if (budget <= 0n) {
  console.error("--budget <sompi> is what the SUCCESSOR grant should carry.");
  process.exit(2);
}
const fee = BigInt(flag("fee") ?? "1000000");

/* The default is derived from the grant rather than picked: below its own
   per-payment cap it can no longer make a payment of the size it was
   authorised for, whatever the counters say. */
const below = BigInt(flag("below") ?? m.max_per_spend ?? "0");

const keyFile = flag("key");
const secretHex = (keyFile ? readFileSync(keyFile, "utf8") : process.env.WARDA_SK ?? "").trim();
assertKeyNotPublished(secretHex, isMainnet);
if (!secretHex) {
  console.error(
    "no key. Pass --key <file> or set WARDA_SK.\n" +
      "  The FUNDER's key — the wallet that would pay for the next grant. A top-up\n" +
      "  that could not say whether it can be paid for is not a decision, it is a guess.",
  );
  process.exit(2);
}
const funder = pubkeyToAddress(agentPublicKey(fromHex(secretHex)), prefix);

const template = covenantTemplate as unknown as CovenantTemplate;
const authority: GrantAuthority = {
  principalKey: m.principal,
  revocationKey: m.revocation ?? m.principal,
};
const state: GrantState = {
  agentKey: m.agent,
  budgetTotal: BigInt(m.budget),
  maxPerSpend: BigInt(m.max_per_spend),
  epochLimit: BigInt(m.epoch_limit),
  epochLength: BigInt(m.epoch_length),
  recipientsRoot: m.recipients_root,
  notBefore: BigInt(m.not_before),
  expiresAt: BigInt(m.expires_at),
  delegationDepth: BigInt(m.delegation_depth),
  templateId: templateIdFor(template, authority),
  spentTotal: BigInt(m.spent_total),
  reserved: BigInt(m.reserved),
  epochIndex: BigInt(m.epoch_index),
  epochSpent: BigInt(m.epoch_spent),
  reserveRoot: m.reserve_root ?? EMPTY_RESERVE,
};
const grantAddress = scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix);

const url = flag("rpc") ?? process.env.WARDA_RPC_JSON;
let client: Chain;
if (borshRequested()) {
  ({ client } = await openChain({ borsh: true, networkId: network, tolerate: true }));
} else if (url) {
  client = await NodeClient.connect({ url });
} else if (resolverFrom({ resolver: flag("resolver") })) {
  const found = await resolveNode({ networkId: network });
  ({ client } = await NodeClient.open({ url: found.url, networkId: network }));
} else {
  console.error(
    `no node. Deciding this reads the UTXO set, which cannot be faked from a local file:\n` +
      `  --rpc wss://your-node:18210   or   --borsh   or   WARDA_RESOLVER=<a Kaspa Resolver>`,
  );
  process.exit(1);
}

try {
  const [dag, atGrant, atFunder] = await Promise.all([
    client.getBlockDagInfo(),
    client.getUtxosByAddresses([grantAddress]),
    client.getUtxosByAddresses([funder]),
  ]);

  if (atGrant.length === 0) {
    console.error(
      `\nthe chain holds nothing at ${grantAddress}, which is where ${manifestPath} says\n` +
        `this grant is. That address is a hash of the grant's state, so it moves on every\n` +
        `spend — the manifest is behind the agent, or the grant has ended.\n\n` +
        `  warda find --write        follow it to where it actually is\n\n` +
        `Nothing was decided. A top-up computed from a manifest the chain does not confirm\n` +
        `either starves an agent that has budget left or funds a second grant beside a live\n` +
        `one, and both look exactly like this command working.`,
    );
    process.exit(1);
  }

  const held = atGrant[0]!.entry.value;

  const needed = budget + fee;
  /* Coinbase coins that are not yet mature cannot fund a genesis, and counting
     them is how a top-up decides the funder is covered and then cannot build
     the transaction. A covenant output at this address is not this key's to
     move at all. */
  const plain = atFunder.filter(
    (u) =>
      !u.entry.covenantId &&
      (!u.entry.isCoinbase || dag.virtualDaaScore - u.entry.blockDaaScore >= COINBASE_MATURITY),
  );
  const values = plain.map((u) => u.entry.value);

  const reading = {
    budgetTotal: state.budgetTotal,
    spentTotal: state.spentTotal,
    reserved: state.reserved,
    held,
    expiresAt: state.expiresAt,
  };
  /* The decision itself is in @warda_protocol/router, where it can be wrong in
     a test rather than at 3am. This process does the reading and the printing
     and makes no judgement of its own. */
  const verdict = renewVerdict({
    grant: reading,
    funder: {
      largest: values.reduce((a, b) => (b > a ? b : a), 0n),
      total: values.reduce((a, b) => a + b, 0n),
    },
    below,
    needed,
    now: dag.virtualDaaScore,
  });
  const expiresIn = state.expiresAt - dag.virtualDaaScore;

  const line = (k: string, v: string) => console.error(`  ${k.padEnd(14)}${v}`);
  console.error(`\n${manifestPath}\n`);
  line("at", grantAddress);
  line("holds", `${formatKas(held)} KAS`);
  line(
    "authority",
    `${formatKas(authorityLeft(reading))} KAS of ${formatKas(state.budgetTotal)} unspent`,
  );
  line("left", `${formatKas(verdict.left)} KAS — the smaller of the two`);
  line("threshold", `${formatKas(below)} KAS`);
  line(
    "expires",
    verdict.expired
      ? "expired — the balance is the principal's to reclaim"
      : `in ${expiresIn} blocks (~${expiresIn / 10n / 60n} min)`,
  );
  console.error();

  if (!verdict.due) {
    console.error(`nothing to do: ${formatKas(verdict.left)} KAS is above the threshold.\n`);
    process.exit(0);
  }

  console.error(
    verdict.expired
      ? "a successor is due: the term is over."
      : `a successor is due: ${formatKas(verdict.left)} KAS is at or below ${formatKas(below)} KAS.`,
  );

  /* The predecessor is NOT ended here, and that is a decision rather than an
     omission. Revocation is the emergency stop, signed by a key whose whole
     value is that it is not online; a schedule that fires it every time a
     budget runs low is that key online, on a schedule, for the most routine
     event in an agent's life. So this says what is stranded and what ends it,
     and leaves both to a person. */
  if (verdict.stranded > 0n) {
    console.error(
      `\n${formatKas(verdict.stranded)} KAS stays at the old grant. It returns to the principal ` +
        (verdict.expired
          ? `as soon as you ask for it:\n\n  warda reclaim ${manifestPath}\n`
          : `in ${expiresIn} blocks, or now:\n\n  warda revoke ${manifestPath}\n`),
    );
  }

  console.error(`\nfunder ${funder}`);
  line("holds", `${formatKas(values.reduce((a, b) => a + b, 0n))} KAS across ${plain.length} coin${plain.length === 1 ? "" : "s"}`);
  line("largest", `${formatKas(values.reduce((a, b) => (b > a ? b : a), 0n))} KAS`);
  line("next grant", `${formatKas(needed)} KAS, as ONE coin`);
  console.error();

  if (verdict.fundable) {
    if (has("dry-run")) {
      console.error("--dry-run: the funder can pay for it. Nothing was created.\n");
      process.exit(0);
    }
    process.exit(DUE);
  }

  /* Enough in total but not in one coin is a different problem from not enough,
     and at 3am the difference is whether anybody has to sell anything. */
  if (verdict.obstacle === "not-in-one-coin") {
    console.error(
      `enough in total, but not in one coin — a grant is funded by a single input:\n\n` +
        `  warda wallet consolidate\n`,
    );
    process.exit(1);
  }

  console.error(
    `short by ${formatKas(verdict.shortBy)} KAS. This is the step nothing here can do for\n` +
      `you: the KAS has to come from somewhere, and Warda does not hold an asset, a price\n` +
      `or an exchange key.\n\n` +
      `  warda fund --payees <file> --budget ${formatKas(budget)} --rate <price of one KAS> --wait\n`,
  );
  process.exit(1);
} finally {
  client.close?.();
}
