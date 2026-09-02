/**
 * The facts the attack page publishes, derived rather than typed.
 *
 *   node --experimental-strip-types tools/demo-card.ts \
 *     ../covenant/deploy/grant-demo.json \
 *     --key ../covenant/deploy/demo-agent.key \
 *     --recipients ../covenant/deploy/demo-recipients.txt \
 *     --resolver "$WARDA_RESOLVER" \
 *     > ../site/src/demo-grant.json
 *
 * The page tells strangers "this key controls exactly this much, and can pay
 * exactly these people". Every one of those claims has to come from the grant
 * itself. A hand-written card that drifts from the manifest is worse than no
 * card: it invites people to test a claim that was never true, and the first
 * one who notices is right to conclude the whole thing is theatre.
 *
 * So this refuses rather than guesses:
 *
 *   - the recipient list must hash to the root the grant committed to
 *   - the published secret must control the grant's agent key
 *   - the vendor must be a member of the list
 *   - and the grant must ACTUALLY EXIST, funded, on chain
 *
 * That last one was missing and is the most basic of the four. A genesis run
 * without `--submit` writes a perfectly good manifest for a grant that was
 * never broadcast; every other check here passes against it, and the page goes
 * live inviting strangers to attack an address holding nothing. The first
 * person to look up the balance concludes the whole thing is theatre, and they
 * are not wrong to.
 *
 * Each of those is a way the page could state something false, and each is
 * checked here rather than trusted.
 */
import { existsSync, readFileSync } from "node:fs";

import { decodeAddress, pubkeyToAddress, scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { EMPTY_RESERVE } from "../src/keys.ts";
import { NodeClient } from "../src/node.ts";
import { RecipientSet } from "../src/recipients.ts";
import { agentPublicKey } from "../src/sign.ts";
import {
  scriptHashFor,
  templateFingerprint,
  templateIdFor,
  type CovenantTemplate,
  type GrantState,
} from "../src/template.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const manifestPath = process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!manifestPath) {
  console.error("usage: demo-card.ts <grant.json> --key <file|hex> --recipients <file|csv>");
  process.exit(2);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(
    flag("template")
      ? new URL(flag("template")!, `file://${process.cwd()}/`)
      : new URL("../covenant-template.json", import.meta.url),
    "utf8",
  ),
);
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;

// ---- the published secret must actually control this grant ---------------
const keySpec = flag("key");
if (!keySpec) {
  console.error("--key is required: the page publishes it, so this must be the real one.");
  process.exit(2);
}
const secretHex = (existsSync(keySpec) ? readFileSync(keySpec, "utf8") : keySpec).trim();
const derivedAgent = toHex(agentPublicKey(fromHex(secretHex)));
if (derivedAgent !== m.agent) {
  console.error(
    `the key given does not control this grant.\n` +
      `  it derives the agent : ${derivedAgent}\n` +
      `  the grant's agent is : ${m.agent}\n` +
      `Publishing it would invite people to test a claim that is not true.`,
  );
  process.exit(1);
}

// ---- the allowlist must be the one the grant committed to ----------------
const spec = flag("recipients");
if (!spec) {
  console.error("--recipients is required: the page checks membership in the browser and needs the members.");
  process.exit(2);
}
if (/[\/\\]|\.(txt|json|list)$/.test(spec) && !existsSync(spec)) {
  console.error(
    `no such file: ${spec}\nThis looks like a path. Treating a missing one as a one-member ` +
      `list would fail deep inside hex decoding, naming neither the file nor the flag.`,
  );
  process.exit(1);
}
const raw = existsSync(spec) ? readFileSync(spec, "utf8") : spec;
const members = raw
  .split(/[\s,]+/)
  .map((t) => t.trim())
  .filter(Boolean)
  .map((t) => (t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase()));

const set = new RecipientSet(members);
if (set.rootHex !== String(m.recipients_root).toLowerCase()) {
  console.error(
    `this recipient list is not the one this grant committed to.\n` +
      `  the list hashes to : ${set.rootHex}\n` +
      `  the grant commits  : ${m.recipients_root}\n` +
      `The page would tell visitors they can check membership against the real tree, and they ` +
      `could not. Find the list this grant was created with.`,
  );
  process.exit(1);
}

// ---- where the grant lives right now -------------------------------------
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
  spentTotal: BigInt(m.spent_total),
  reserved: BigInt(m.reserved),
  epochIndex: BigInt(m.epoch_index),
  epochSpent: BigInt(m.epoch_spent),
  reserveRoot: m.reserve_root ?? EMPTY_RESERVE,
};
const address = scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix);

/** The one payee worth naming: whoever the money can actually reach. */
const vendorHex = flag("vendor", members[0])!.includes(":")
  ? toHex(decodeAddress(flag("vendor")!).payload)
  : (flag("vendor", members[0])!).toLowerCase();
if (!set.has(vendorHex)) {
  console.error(`--vendor ${vendorHex} is not in the allowlist, so naming it on the page would be wrong.`);
  process.exit(1);
}

// ---- and it must exist -----------------------------------------------------
const offline = process.argv.includes("--allow-unfunded");
let onChain: bigint | null = null;
if (!offline) {
  let client: NodeClient;
  try {
    // open(), not connect(): a node with no UTXO index answers an address
    // query with an empty list rather than an error, which here would read as
    // "the grant does not exist" and refuse a card for a perfectly good grant.
    ({ client } = await NodeClient.open({
      url: flag("rpc"),
      resolver: flag("resolver"),
      networkId: flag("network") ?? process.env.WARDA_NETWORK ?? "testnet-10",
      grantAddress: address,
    }));
  } catch (e) {
    console.error(
      `cannot reach a node to confirm this grant exists: ${(e as Error).message}\n` +
        `The page tells strangers to attack a funded grant, so "probably funded" is not good ` +
        `enough. Point --rpc or --resolver at a node, or pass --allow-unfunded if you are ` +
        `deliberately building the page before broadcasting.`,
    );
    process.exit(1);
  }
  try {
    const utxos = await client.getUtxosByAddresses([address]);
    if (utxos.length === 0) {
      console.error(
        `nothing at ${address}.\n\n` +
          `This manifest describes a grant that has not been broadcast, or has already moved. ` +
          `Genesis without --submit writes the manifest and keeps the transaction — re-run it ` +
          `with --submit, then run this again.\n\n` +
          `Refusing to write a card: the page would invite people to attack an empty address, ` +
          `and the first one to check the balance would be right to call it theatre.`,
      );
      process.exit(1);
    }
    onChain = utxos[0]!.entry.value;
  } finally {
    client.close();
  }
}

/** Sompi reads as noise at this size; KAS is what a visitor can hold in mind. */
const kas = (v: bigint) => {
  const whole = v / 100_000_000n, frac = v % 100_000_000n;
  const s = frac === 0n ? `${whole}` : `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
  return `${s} KAS`;
};

process.stdout.write(
  JSON.stringify(
    {
      _comment:
        "Published by tools/demo-card.ts. The secret here is DELIBERATELY public: it is an " +
        "independently generated agent key for a testnet grant whose limits are enforced by " +
        "the covenant, not by us. Every field is derived from the grant and checked against it.",
      secret: secretHex,
      agent: m.agent,
      address,
      covenant: m.covenant ?? templateFingerprint(template),
      vendor: pubkeyToAddress(fromHex(vendorHex), prefix),
      recipients: set.members.map(toHex),
      root: set.rootHex,
      budget: kas(state.budgetTotal),
      // What the address actually holds right now, read from the chain rather
      // than from the manifest's intention.
      funded: onChain === null ? "unverified" : kas(onChain),
      maxPerSpend: kas(state.maxPerSpend),
      epochLimit: kas(state.epochLimit),
      epochLength: state.epochLength.toString(),
    },
    null,
    2,
  ) + "\n",
);
console.error(`grant   : ${address}`);
console.error(`agent   : ${m.agent} (key verified)`);
console.error(`root    : ${set.rootHex} (${set.members.length} members, verified)`);
console.error(`vendor  : ${pubkeyToAddress(fromHex(vendorHex), prefix)}`);
console.error(`funded  : ${onChain === null ? "NOT CHECKED (--allow-unfunded)" : kas(onChain) + " on chain"}`);
