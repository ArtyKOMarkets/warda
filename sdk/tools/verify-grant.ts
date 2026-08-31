/**
 * Ask the chain whether a grant is what its manifest says.
 *
 *   node --experimental-strip-types tools/verify-grant.ts ../covenant/deploy/grant.json
 *
 * No Rust toolchain, no Silverscript compiler, no trust in the tool that wrote
 * the manifest. It derives the address from the manifest's own numbers, asks a
 * node what lives there, and reports where the two disagree.
 *
 * Options:
 *   --principal <hex>   x-only key that may reclaim   (default: the agent key)
 *   --revocation <hex>  x-only key that may revoke    (default: the principal)
 *   --depth <n>         delegation depth              (default: 2)
 *   --prefix <name>     kaspatest | kaspa | kaspasim | kaspadev
 *   --rpc <url>         defaults to $WARDA_RPC_JSON, else ws://127.0.0.1:18210
 *
 * The three defaults exist because `warda-deploy genesis` does not record
 * those fields — it sets principal = revocation = agent and depth = 2 for the
 * demo grant. They are part of the ADDRESS, so a wrong guess produces a
 * different address and an empty result rather than a wrong answer.
 */

import { readFileSync } from "node:fs";

import { NodeClient } from "../src/node.ts";
import type { CovenantTemplate, Grant } from "../src/template.ts";
import { verifyGrant } from "../src/verify.ts";
import type { NetworkPrefix } from "../src/address.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const manifestPath = process.argv[2];
if (!manifestPath || manifestPath.startsWith("--")) {
  console.error("usage: verify-grant.ts <grant.json> [--principal hex] [--depth n] [--prefix p]");
  process.exit(2);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

const principalKey = flag("principal", m.agent)!;
const revocationKey = flag("revocation", principalKey)!;
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;

const grant: Grant = {
  authority: { principalKey, revocationKey },
  state: {
    agentKey: m.agent,
    budgetTotal: BigInt(m.budget),
    maxPerSpend: BigInt(m.max_per_spend),
    epochLimit: BigInt(m.epoch_limit),
    epochLength: BigInt(m.epoch_length),
    recipientsRoot: m.recipients_root,
    notBefore: BigInt(m.not_before),
    expiresAt: BigInt(m.expires_at),
    // A child grant records its own depth; the genesis manifest predates the
    // field and gets the default. Guessing wrong here is not subtle — depth
    // is part of the state, so it derives a different address and the grant
    // appears to be missing.
    delegationDepth: BigInt(flag("depth", (m.delegation_depth ?? 2).toString())!),
    spentTotal: BigInt(m.spent_total),
    reserved: BigInt(m.reserved),
    epochIndex: BigInt(m.epoch_index),
    epochSpent: BigInt(m.epoch_spent),
  },
};

const client = await NodeClient.connect({ url: flag("rpc") });
try {
  const info = await client.getInfo();
  if (!info.isUtxoIndexed) {
    console.error("this node runs without --utxoindex; it cannot answer address queries.");
    process.exit(1);
  }
  if (!info.isSynced) {
    console.error("warning: the node is not synced. What follows may be behind the tip.\n");
  }

  const r = await verifyGrant(client, {
    grant,
    template,
    prefix,
    expect: { covenantId: m.covenant_id, value: BigInt(m.grant_value) },
  });

  console.log(`address        : ${r.address}`);
  console.log(`script hash    : ${r.scriptHash}`);
  console.log(`node           : kaspad ${info.serverVersion}`);
  console.log(`on chain       : ${r.found ? `${r.value} sompi` : "NOTHING"}`);
  console.log(`covenant id    : ${r.covenantId ?? "-"}`);
  console.log(`budget left    : ${r.remaining} sompi of ${grant.state.budgetTotal}`);
  console.log(`this epoch     : ${r.epochRemaining} sompi of ${grant.state.epochLimit}`);
  console.log(`per spend      : up to ${grant.state.maxPerSpend} sompi`);
  // The number an agent should actually act on. `budget left` is accounting;
  // this is the tightest limit that binds, and it includes the coin.
  console.log(`max next spend : ${r.maxNextSpend} sompi (bound by ${r.boundBy})`);
  console.log(`reclaimable    : ${r.reclaimable ? "yes — past expiry" : "no"}`);
  console.log("");
  for (const f of r.findings) {
    console.log(`${f.level === "ok" ? "  ok  " : f.level === "warn" ? " warn " : " FAIL "} ${f.text}`);
  }
  console.log("");
  console.log(
    r.agrees
      ? "the chain agrees with this manifest."
      : "the chain DISAGREES with this manifest — see the FAIL lines above.",
  );
  process.exitCode = r.agrees ? 0 : 1;
} finally {
  client.close();
}
