/**
 * An agent buying from a kaspa-x402 v2 vendor, out of a Warda grant.
 *
 *   WARDA_SK=$(cat agent.key) node --experimental-strip-types demo/buy-v2.ts \
 *     https://demo.kaspa-x402.org/exact \
 *     --grant grant.json --recipients recipients.txt --rpc wss://your-node
 *
 * ## What is different from buy.ts, and why it needs its own file
 *
 * In v1 the payer broadcasts and hands the vendor a txid. In v2 the payer
 * hands over the whole signed transaction and the VENDOR broadcasts it. That
 * single inversion changes what "success" means and therefore when the
 * manifest may be written.
 *
 * A grant's address is a hash of its state, so a spend moves it and the
 * manifest has to follow. buy.ts writes the new state as soon as the payment
 * is broadcast, because it did the broadcasting and knows. Here nothing is
 * known until the vendor answers: the transaction may be on the chain, or in
 * their queue, or discarded. So the manifest is written only after a 2xx, and
 * a failure leaves the payer deliberately stuck rather than guessing —
 * `follow-grant.ts --subsets` resolves it against the chain, which is exactly
 * what it is for.
 *
 * ## What this run proves, if it works
 *
 * That a bounded agent can buy from a vendor nobody here controls. Every
 * previous payment in this repository has been to an endpoint we also wrote,
 * which makes the money real and the market imaginary. This one pays a service
 * built by the people who wrote the protocol, using their own published
 * packages to encode it, with a limit the network enforces rather than one our
 * process promises.
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  EMPTY_RESERVE,
  NodeClient,
  RecipientSet,
  decodeAddress,
  fromHex,
  pubkeyToAddress,
  resolveSigner,
  templateIdFor,
  toHex,
  type CovenantTemplate,
} from "@warda_protocol/kaspa";

import { WardaPayer } from "../src/payer.ts";
import { wardaFetchV2 } from "../src/fetch-v2.ts";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

const url = process.argv.slice(2).find((a) => a.startsWith("http"));
const manifestPath = flag("grant");
const recipientsSpec = flag("recipients");
if (!url || !manifestPath || !recipientsSpec) {
  console.error(
    "usage: buy-v2.ts <url> --grant <manifest.json> --recipients <file> [--rpc url]\n\n" +
      "--recipients is not optional: a grant commits to the allowlist's ROOT, and a proof\n" +
      "cannot be built from a root. Keep the member list with the grant.",
  );
  process.exit(2);
}

const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error("WARDA_SK must be a key that can sign for this grant's agent.");
  process.exit(1);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../../sdk/covenant-template.json", import.meta.url), "utf8"),
);

const members = readFileSync(recipientsSpec, "utf8")
  .split(/\r?\n/)
  .map((l) => l.replace(/#.*$/, "").trim())
  .filter(Boolean)
  .map((t) => (t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase()));
const recipients = new RecipientSet(members);
if (recipients.rootHex !== m.recipients_root) {
  console.error(
    `these recipients hash to ${recipients.rootHex}, but the grant commits to ` +
      `${m.recipients_root}. This is the wrong list for this grant.`,
  );
  process.exit(1);
}

const authority = { principalKey: m.principal, revocationKey: m.revocation ?? m.principal };
const state = {
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

/**
 * The agent key is usually DERIVED from the funder's, not equal to it.
 *
 * `genesis.ts` derives it by default and records the derivation in the
 * manifest, so the obvious thing — hand the tool the key you have — signs with
 * the funder's key and produces a transaction the covenant refuses. On chain
 * that arrives as "script ran, verification failed", which says nothing about
 * keys at all. It is the first way the live x402 demo failed, and it took a
 * node round trip to find out.
 *
 * So the key is resolved against the agent the grant actually names, before
 * anything is built.
 */
const resolved = resolveSigner(fromHex(secretHex.trim()), m.agent, m.agent_key_derived);
if (!resolved) {
  console.error(
    `the key in WARDA_SK is not this grant's agent (${String(m.agent).slice(0, 16)}…), and no
` +
      `derivation of it is either. The grant can only be spent by the agent it names.`,
  );
  process.exit(1);
}
console.error(`agent    : ${m.agent} — signing with ${resolved.how}`);

const node = await NodeClient.connect({ url: flag("rpc") ?? process.env.WARDA_RPC_JSON });
const payer = new WardaPayer({
  grant: { template, authority, state, recipients },
  node,
  sign: resolved.secret,
});

try {
  console.error(`buying   : ${url}`);
  const res = await wardaFetchV2(url, { method: "GET" }, {
    payer,
    onEvent: (e) => {
      if (e.type === "quote") console.error(`  quoted : ${e.amountSompi} sompi to ${e.payTo}`);
      if (e.type === "signed") {
        console.error(`  signed : ${e.pending.txid}`);
        console.error(`           authorization expires ${e.pending.expiresAt}`);
      }
      if (e.type === "broadcast") {
        console.error(`  onchain: ${e.txid} — ${e.accepted ? "accepted" : "NOT YET ACCEPTED"}`);
      }
      if (e.type === "settled") console.error(`  settled: grant now at ${e.result.address}`);
      if (e.type === "unresolved") {
        console.error(`  REFUSED: ${e.status}`);
        if (e.vendorSaid) console.error(`  vendor : ${e.vendorSaid}`);
      }
      if (e.type === "done") console.error(`  status : ${e.status}`);
    },
  });

  process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");

  // Only now. The vendor answered, so the spend is theirs to broadcast and the
  // grant has moved; a manifest written any earlier would describe a state
  // that might never exist.
  const after = payer.state;
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        ...m,
        spent_total: Number(after.spentTotal),
        epoch_index: Number(after.epochIndex),
        epoch_spent: Number(after.epochSpent),
      },
      null,
      2,
    ) + "\n",
  );
  console.error(`\ngrant advanced in ${manifestPath}: spent ${after.spentTotal}, epoch ${after.epochIndex}`);
} catch (e) {
  console.error(`\n${(e as Error).message}`);
  if (payer.outstanding.status === "unresolved") {
    console.error(
      `\nThe manifest was NOT advanced, and it may now be wrong: a signed spend is in\n` +
        `someone else's hands and whether they broadcast it cannot be told from here.\n` +
        `Resolve it against the chain before using this grant again:\n\n` +
        `  node --experimental-strip-types ../sdk/tools/follow-grant.ts ${manifestPath} \\\n` +
        `    --vendor ${members.map((k) => pubkeyToAddress(fromHex(k), "kaspatest")).join(" ")} ` +
        `--subsets --write`,
    );
  }
  process.exitCode = 1;
} finally {
  node.close();
}
