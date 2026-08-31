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
 *   --principal <hex>   x-only key that may reclaim
 *   --revocation <hex>  x-only key that may revoke
 *   --depth <n>         delegation depth
 *   --prefix <name>     kaspatest | kaspa | kaspasim | kaspadev
 *   --rpc <url>         defaults to $WARDA_RPC_JSON, else ws://127.0.0.1:18210
 *
 * A manifest written by `build-delegation` records principal, revocation and
 * delegation_depth outright, and those are used. A genesis manifest predates
 * all three, so they fall back to what `warda-deploy genesis` actually sets:
 * principal = revocation = agent, depth 2.
 *
 * All three are part of the ADDRESS. A wrong guess derives a different address
 * and reports an empty one, rather than reporting a wrong answer about a real
 * grant — which is the right direction to fail in, but it does mean "NOTHING"
 * can mean "wrong authority" as easily as "already spent".
 */

import { readFileSync } from "node:fs";

import { NodeClient } from "../src/node.ts";
import { templateFingerprint, type CovenantTemplate, type Grant } from "../src/template.ts";
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
/**
 * Which covenant a grant was issued under.
 *
 * A covenant upgrade changes the bytecode, so the SAME state derives a
 * DIFFERENT address. Grants issued under the old one are still on chain, still
 * spendable, and completely invisible to a tool holding only the new template.
 * An upgrade that stranded every outstanding grant would not be an upgrade.
 *
 * So: --template points at the template a grant was issued under, and a
 * manifest may name its own. New grants record it; older manifests predate the
 * field and fall back to the current template, which is what they were issued
 * under anyway.
 */
function loadTemplate(m: { covenant?: string } = {}): CovenantTemplate {
  const named = flag("template");
  const url = named
    ? new URL(named, `file://${process.cwd()}/`)
    : new URL("../covenant-template.json", import.meta.url);
  const tpl: CovenantTemplate = JSON.parse(readFileSync(url, "utf8"));
  const have = templateFingerprint(tpl);
  if (m.covenant && m.covenant !== have) {
    console.error(
      `this manifest was issued under covenant ${m.covenant}, and the template ` +
        `loaded is ${have}.\n` +
        `Deriving an address from the wrong covenant does not fail loudly: it ` +
        `produces a plausible address, finds nothing there, and reports the grant ` +
        `missing. Pass --template <path to that covenant's template>.`,
    );
    process.exit(1);
  }
  return tpl;
}

const template: CovenantTemplate = loadTemplate(m);

// A child grant records its authority explicitly; the genesis manifest
// predates the fields, where principal == revocation == agent held.
const principalKey = flag("principal", m.principal ?? m.agent)!;
const revocationKey = flag("revocation", m.revocation ?? principalKey)!;
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
    expect: m.closed
      ? {}
      : { covenantId: m.covenant_id, value: BigInt(m.grant_value) },
  });

  // A CLOSED grant is supposed to be empty. Reporting that as "nothing here,
  // the grant has probably moved" is the message for a LOST grant, and it
  // would say it forever about one that was deliberately swept.
  if (m.closed) {
    console.log(`address        : ${r.address}`);
    console.log(`status         : CLOSED by ${m.closed.kind}`);
    console.log(`swept          : ${m.closed.value} sompi to P2PK ${m.closed.swept_to}`);
    console.log(`closing txid   : ${m.closed.txid}`);
    console.log(`on chain       : ${r.found ? `${r.value} sompi — UNEXPECTED` : "nothing, as expected"}`);
    console.log("");
    console.log(
      r.found
        ? "this grant was recorded as closed but still holds coin. Something is wrong."
        : "the chain agrees: this grant is closed.",
    );
    process.exitCode = r.found ? 1 : 0;
    process.exit();
  }

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
