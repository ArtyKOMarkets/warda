/**
 * An agent buying from a paid API. The whole thing.
 *
 *   WARDA_SK=$(cat agent.key) node --experimental-strip-types demo/buy.ts \
 *     https://warda-demo-api.vercel.app/fact \
 *     --grant ../site/src/demo-manifest.json \
 *     --recipients ../site/src/demo-recipients.txt \
 *     --rpc wss://your-node
 *
 * ## Why this file is short
 *
 * Everything above `wardaFetch` is loading a grant from disk. The payment
 * itself is one call: it gets a 402, reads the price, checks the grant can
 * cover it, builds and signs a covenant spend, broadcasts it, re-presents the
 * same proof while the payment settles, and returns the response.
 *
 * Nothing here calls a Warda service to ask permission, because there is none
 * to call. The limits are in the script that unlocks the coin, so the only
 * party whose opinion matters has already been consulted by the time the
 * transaction exists.
 *
 * ## The one thing it must not skip
 *
 * A spend MOVES the grant — its address is a hash of its state. This writes
 * the new state back to the manifest when the payment succeeds, so the next
 * run does not look for the grant where it used to be. Forgetting that is the
 * single most common way to end up with a healthy grant that every tool
 * reports as missing.
 */
import { readFileSync, writeFileSync } from "node:fs";

import {
  NodeClient,
  RecipientSet,
  EMPTY_RESERVE,
  decodeAddress,
  fromHex,
  toHex,
  templateIdFor,
  type CovenantTemplate,
} from "@warda_protocol/kaspa";
import { WardaPayer, wardaFetch } from "@warda_protocol/x402";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d;
};

const url = process.argv.slice(2).find((a) => a.startsWith("http"));
const manifestPath = flag("grant");
const recipientsSpec = flag("recipients");
if (!url || !manifestPath || !recipientsSpec) {
  console.error(
    "usage: buy.ts <url> --grant <manifest.json> --recipients <file|list> [--rpc url]\n\n" +
      "--recipients is not optional: a grant commits to the allowlist's ROOT, and a proof\n" +
      "cannot be built from a root. Keep the member list with the grant.",
  );
  process.exit(2);
}

const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error("WARDA_SK must be the AGENT's key — the one the grant names, not the funder's.");
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

const node = await NodeClient.connect({ url: flag("rpc") });
try {
  const payer = new WardaPayer({
    grant: { template, authority, state, recipients },
    node,
    sign: fromHex(secretHex.trim()),
  });

  console.error(`buying   : ${url}`);
  const res = await wardaFetch(url, undefined, {
    payer,
    onEvent: (e) => {
      if (e.type === "quote") console.error(`  quoted : ${e.requirement.amountSompi} sompi to ${e.requirement.payTo}`);
      if (e.type === "paid") console.error(`  paid   : ${e.result.txid}`);
      if (e.type === "settling") console.error(`  settling, retrying in ${e.delayMs}ms with the SAME proof`);
      if (e.type === "done") console.error(`  status : ${e.status}`);
    },
  });

  const body = await res.json();
  console.error();
  process.stdout.write(JSON.stringify(body, null, 2) + "\n");

  /* The grant has moved. Write it back, or the next run looks for it where it
     was — which every tool reports as "no UTXO at <address>", a message that
     describes the symptom and names three causes, none of them this one. */
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
} finally {
  node.close();
}
