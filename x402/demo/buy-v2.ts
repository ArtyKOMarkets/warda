/**
 * An agent buying from a kaspa-x402 v2 vendor, out of a Warda grant.
 *
 *   WARDA_SK=$(cat agent.key) node --experimental-strip-types demo/buy-v2.ts \
 *     https://demo.kaspa-x402.org/exact \
 *     --grant grant.json --recipients recipients.txt --rpc wss://your-node
 *
 * ## Two transactions, not one
 *
 * x402 `exact` requires the payer's input to be a bare pay-to-pubkey coin
 * unlocked by a single signature, and no output to carry a covenant. A grant
 * spend is neither, under any version — output 0 IS the successor grant. That
 * rule was unreadable until kaspa-x402 v1.0.0-rc.1 published the verifier, and
 * it is why eight payments from this repository settled on chain and were
 * refused off it.
 *
 * So this pays in two: the covenant spend pays the agent's own key, and an
 * ordinary version-0 transaction goes from there to the vendor. Both are built
 * before either is broadcast — a transaction id excludes signature scripts, so
 * the second can name an outpoint that does not exist yet — and both go out
 * back to back, leaving no window in which the invoice is funded and unpaid.
 *
 * The grant must have been created with `--relay`, because the relay key has
 * to be on an allowlist that is fixed at genesis. The cost is that allowlist,
 * for that one hop. `x402/RELAY.md` is the whole argument.
 *
 * ## The fee is fixed in advance and cannot be corrected
 *
 * Whatever the covenant spend puts in above the invoice IS the relayed
 * transaction's fee, and by the time a node could price it the funding
 * transaction is already broadcast. Measure it first:
 *
 *   warda fee relay --key wallet.key --borsh
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

const relayFee = ((): string | undefined => {
  const i = process.argv.indexOf("--relay-fee");
  return i >= 0 ? process.argv[i + 1] : undefined;
})();

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
/**
 * The manifest, advanced to the state the payer is now in.
 *
 * `grant_value` is advanced too, and that is the part this file used to get
 * wrong. It is not part of the address, so a stale one still derives the right
 * grant and nothing fails — it just publishes a balance the chain disagrees
 * with. That drifted 0.44 KAS across three commits before anything noticed,
 * and the fix then was to correct the number by hand, which lasted exactly
 * until the next purchase. Every spend costs the coin the payment AND the fee,
 * while only the payment is charged against spentTotal, so the two diverge by
 * exactly the fees paid.
 */
function advanced(
  manifest: Record<string, unknown>,
  after: { spentTotal: bigint; epochIndex: bigint; epochSpent: bigint },
  paid: bigint,
  fee: bigint,
): string {
  const coin = BigInt(String(manifest.grant_value ?? 0)) - paid - fee;
  return (
    JSON.stringify(
      {
        ...manifest,
        grant_value: Number(coin > 0n ? coin : 0n),
        spent_total: Number(after.spentTotal),
        epoch_index: Number(after.epochIndex),
        epoch_spent: Number(after.epochSpent),
      },
      null,
      2,
    ) + "\n"
  );
}

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
    /* Required, not optional, and the tool says so above if it is missing.
       Their `exact` scheme takes only a version-0 transaction with a
       key-controlled input and no covenant. */
    relay: true,
    ...(relayFee ? { relayFeeSompi: BigInt(relayFee) } : {}),
    omitPayerAddress: process.argv.includes("--no-payer-address"),
    payerIsSuccessor: process.argv.includes("--payer-successor"),
    onEvent: (e) => {
      if (e.type === "quote") console.error(`  quoted : ${e.amountSompi} sompi to ${e.payTo}`);
      if (e.type === "signed") {
        console.error(`  signed : ${e.pending.txid}   (the transaction THEY verify)`);
        if (e.pending.relay) {
          console.error(`  funding: ${e.pending.relay.fundingTxid}   (the covenant spend)`);
          console.error(`  relay  : ${e.pending.relay.relayAddress}, fee ${e.pending.relay.feeSompi}`);
        }
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
    advanced(m, after, after.spentTotal - BigInt(m.spent_total ?? 0), payer.fee),
  );
  console.error(`\ngrant advanced in ${manifestPath}: spent ${after.spentTotal}, epoch ${after.epochIndex}`);
} catch (e) {
  console.error(`\n${(e as Error).message}`);

  // The spend may have landed even though the request failed. If the payer
  // advanced, the manifest must too — otherwise the next run looks for the
  // grant where it used to be.
  if (payer.outstanding.status === "none" && payer.state.spentTotal > BigInt(m.spent_total ?? 0)) {
    const after = payer.state;
    writeFileSync(
      manifestPath,
      advanced(m, after, after.spentTotal - BigInt(m.spent_total ?? 0), payer.fee),
    );
    console.error(`\ngrant advanced anyway in ${manifestPath}: the coin moved even though the`);
    console.error(`request was refused. spent ${after.spentTotal}, epoch ${after.epochIndex}`);
  }

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
