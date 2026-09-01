/**
 * Watch a grant, and optionally act when it misbehaves.
 *
 *   node --experimental-strip-types tools/watch-grant.ts ../covenant/deploy/grant.json
 *   ... --max-spend 10000000 --rate 5/60 --revoke-on-breach
 *
 * Nothing was watching a grant, and the reason nothing was is that the obvious
 * approach does not work: a grant's address is a hash of its state, so the
 * first spend moves it and the address you were watching goes empty. Empty is
 * also what a drained grant looks like, and a revoked one, and one that was
 * never funded — so a naive watcher raises an alarm every time the agent does
 * its job, and cannot raise a different one when the agent does not.
 *
 * This follows instead. A spend of the grant appears in the mempool carrying
 * the covenant's redeem script in the clear, so the state that was spent and
 * the successor implied by the outputs are both readable BEFORE it confirms;
 * the watcher moves its own cursor and keeps going.
 *
 * Options:
 *   --interval <ms>        default 2000. Kaspa confirms fast; a slow poll
 *                          misses transitions, and this says so rather than
 *                          guessing.
 *   --max-spend <sompi>    a payment above this is a breach even though the
 *                          covenant permits it
 *   --rate <n>/<seconds>   more than n spends in that window is a breach
 *   --min-remaining <n>    notice when authority left falls below this
 *   --no-delegation        treat any delegation as a breach
 *   --expiry-warning <daa> notice when the window is closing
 *   --once                 one pass, then exit. Exit code 1 on a breach, so
 *                          cron and CI can use it.
 *   --revoke-on-breach     build, sign and SUBMIT a revocation. Requires
 *                          WARDA_REVOCATION_SK. Read the note below first.
 *   --arm                  build the revocation for the current position and
 *                          report it, without signing or submitting
 *   --rpc <url> --resolver <url> --prefix <p> --template <path>
 *
 * ## On --revoke-on-breach
 *
 * A revocation's signature commits to the grant's CURRENT UTXO — outpoint,
 * value and script — and the grant MOVES on every spend. So a revocation
 * signed now is valid exactly until the agent next spends. There is no
 * pre-signed transaction you can put in a drawer.
 *
 * That leaves a choice with no free option. Either this process holds the
 * revocation key and can re-sign after every move, which makes THIS PROCESS
 * worth attacking — a key that can end the grant is a key that can end the
 * grant — or it alerts a human, nothing sensitive is online, and the reaction
 * time is however long it takes somebody to read the message.
 *
 * The default is the second. `--revoke-on-breach` is the first, and it is
 * opt-in because it should be a decision rather than a default.
 */

import { readFileSync } from "node:fs";

import { scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex } from "../src/bytes.ts";
import { attachExitSignature } from "../src/exit.ts";
import { EMPTY_RESERVE, resolveSigner } from "../src/keys.ts";
import { NodeClient, formatHealth } from "../src/node.ts";
import { signDigest, verifyDigest } from "../src/sign.ts";
import {
  scriptHashFor,
  templateFingerprint,
  templateIdFor,
  type CovenantTemplate,
  type Grant,
  type GrantState,
} from "../src/template.ts";
import { GrantWatcher, type Alert, type WatchRules } from "../src/watch.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const manifestPath = process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!manifestPath) {
  console.error("usage: watch-grant.ts <grant.json> [--max-spend n] [--rate 5/60] [--once]");
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
if (m.covenant && m.covenant !== templateFingerprint(template)) {
  console.error(
    `this manifest was issued under covenant ${m.covenant}; the template loaded is ` +
      `${templateFingerprint(template)}. Watching the wrong address would report a healthy ` +
      `grant as missing. Pass --template.`,
  );
  process.exit(1);
}

const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;
const principalKey = flag("principal", m.principal ?? m.agent)!;
const authority = { principalKey, revocationKey: flag("revocation", m.revocation ?? principalKey)! };
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
const grant: Grant = { authority, state };

const rules: WatchRules = {};
if (flag("max-spend")) rules.maxSpendSompi = BigInt(flag("max-spend")!);
if (flag("min-remaining")) rules.minRemainingSompi = BigInt(flag("min-remaining")!);
if (flag("expiry-warning")) rules.expiryWarningDaa = BigInt(flag("expiry-warning")!);
if (has("no-delegation")) rules.forbidDelegation = true;
if (flag("rate")) {
  const [count, seconds] = flag("rate")!.split("/").map(Number);
  if (!count || !seconds) {
    console.error(`--rate wants <count>/<seconds>, for example 5/60. Got "${flag("rate")}".`);
    process.exit(2);
  }
  rules.rateLimit = { count, windowMs: seconds * 1000 };
}

const revokeOnBreach = has("revoke-on-breach");
let revocationSecret: Uint8Array | null = null;
if (revokeOnBreach) {
  const sk = process.env.WARDA_REVOCATION_SK ?? process.env.WARDA_SK;
  if (!sk) {
    console.error(
      `--revoke-on-breach needs WARDA_REVOCATION_SK. Understand what it means before you set\n` +
        `it: this process will hold a key that can END the grant, and a revocation cannot be\n` +
        `pre-signed and left in a drawer — its signature commits to the grant's current UTXO,\n` +
        `and the grant moves on every spend. Without the flag this watcher alerts and does\n` +
        `not act, which is slower and holds nothing worth stealing.`,
    );
    process.exit(2);
  }
  const found = resolveSigner(fromHex(sk.trim()), authority.revocationKey, null);
  if (!found) {
    console.error(`the key given does not control this grant's revocation key (${authority.revocationKey}).`);
    process.exit(1);
  }
  revocationSecret = found.secret;
}

// The node is checked before it is believed. A node with no UTXO index answers
// an address query with an empty list rather than an error — which this
// watcher would read as the grant being gone, and act on.
let client: NodeClient, health;
try {
  ({ client, health } = await NodeClient.open({
    url: flag("rpc"),
    resolver: flag("resolver"),
    networkId: flag("network") ?? process.env.WARDA_NETWORK ?? "testnet-10",
    grantAddress: scriptHashToAddress(scriptHashFor(template, grant), prefix),
    tolerate: true,
  }));
} catch (e) {
  // A watcher that cannot reach a node has not found a problem with the
  // grant, and must not look like it has.
  console.error(`cannot watch: ${(e as Error).message}`);
  process.exit(2);
}
if (!health.usable) {
  console.error(`refusing to watch through this node:\n\n${formatHealth(health)}`);
  client.close();
  process.exit(1);
}

const watcher = new GrantWatcher(client, { template, grant, prefix, rules });
const interval = Number(flag("interval", "2000")!);

console.error(`watching ${watcher.address}`);
console.error(`  node     : ${health.url} (${health.network})`);
console.error(`  agent    : ${state.agentKey}`);
console.error(`  budget   : ${state.budgetTotal}, spent ${state.spentTotal}, reserved ${state.reserved}`);
console.error(`  rules    : ${Object.keys(rules).length ? Object.keys(rules).join(", ") : "none — reporting only"}`);
console.error(`  on breach: ${revokeOnBreach ? "REVOKE, sign and submit" : "report only"}\n`);

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (s: string) => console.log(`${stamp()} ${s}`);

function report(a: Alert): void {
  say(`${a.severity === "breach" ? "BREACH" : "notice"} [${a.rule}] ${a.detail}`);
}

let breached = false;

async function pass(): Promise<void> {
  const r = await watcher.poll();

  for (const t of r.transitions) {
    if (t.kind === "spend") {
      say(`spend ${t.amount} sompi (${t.txid.slice(0, 16)}…) — now at ${t.toAddress}`);
      say(`  budget: spent ${t.to!.state.spentTotal} of ${t.to!.state.budgetTotal}, epoch ${t.to!.state.epochIndex} used ${t.to!.state.epochSpent}`);
    } else {
      say(`${t.kind} (${t.txid.slice(0, 16)}…)${t.toAddress ? ` — now at ${t.toAddress}` : ""}`);
    }
  }
  for (const a of r.alerts) report(a);

  const breaches = r.alerts.filter((a) => a.severity === "breach");
  if (breaches.length) breached = true;

  if (breaches.length && revokeOnBreach && r.live) {
    try {
      const { plan, unsigned } = watcher.armRevocation(r.live);
      const signature = signDigest(unsigned.sighash, revocationSecret!);
      if (!verifyDigest(signature, unsigned.sighash, fromHex(authority.revocationKey))) {
        throw new Error("the revocation signature does not verify against its own digest");
      }
      const txid = await client.submitTransaction(attachExitSignature(plan, unsigned, signature));
      say(`REVOKED. ${txid}`);
      say(`  the balance sweeps to the principal. The agent cannot stop it and cannot outrun it.`);
      client.close();
      process.exit(1);
    } catch (e) {
      say(`could not revoke: ${(e as Error).message}`);
      say(`  the breach stands and nothing was submitted.`);
    }
  }

  if (has("arm") && r.live) {
    try {
      const { unsigned } = watcher.armRevocation(r.live);
      say(`armed: a revocation for this position needs a signature over`);
      say(`  ${Buffer.from(unsigned.sighash).toString("hex")}`);
      say(`  valid only while the grant sits still — the next spend moves it and invalidates this.`);
    } catch (e) {
      say(`could not arm: ${(e as Error).message}`);
    }
  }
}

if (has("once")) {
  await pass();
  client.close();
  process.exit(breached ? 1 : 0);
}

process.on("SIGINT", () => {
  console.error(`\nstopped watching ${watcher.address}`);
  client.close();
  process.exit(breached ? 1 : 0);
});

for (;;) {
  try {
    await pass();
  } catch (e) {
    say(`poll failed: ${(e as Error).message}`);
  }
  await new Promise((r) => setTimeout(r, interval));
}
