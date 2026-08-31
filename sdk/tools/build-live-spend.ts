/**
 * Spends from a live grant — parent or child — with no Rust in the loop.
 *
 * `build-spend.ts --live` needed `warda-deploy plan` to find the grant,
 * because the SDK had no node client. It has one now, so this does the whole
 * thing: read the UTXO, rebuild the allowlist, prove the payee is in it, sign,
 * and write a transaction ready for `submit`.
 *
 *   WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key) \
 *     node --experimental-strip-types tools/build-live-spend.ts \
 *     ../covenant/deploy/grant-child-8fefa35b.json --amount 30000000 > js-spend.json
 *
 * ## Which key signs
 *
 * A grant is spent by ITS agent, and a child's agent is not its parent's. If
 * WARDA_SK is not the grant's agent, this looks for a derived child key at the
 * index the manifest records — which is how the demo's sub-agent stays
 * reachable without a secret ever being written down. A real sub-agent holds
 * its own key and runs this itself; nothing about the transaction changes.
 *
 * ## The allowlist
 *
 * A grant commits to a Merkle ROOT, not to a list, so the payee list has to be
 * reconstructed to build a proof. The demo set is four keys, one of them
 * derived from "warda-demo-api-v1". The root is recomputed and checked against
 * the manifest before anything else happens: a mismatch means this is the
 * wrong list, and the proof it produced would fail inside the covenant with an
 * error that names nothing useful.
 *
 * Options:
 *   --amount <sompi>   default 30000000
 *   --to <hex>         payee, x-only. Default: the demo API key.
 *   --fee <sompi>      default 1000000
 *   --prefix, --rpc, --principal, --revocation, --depth as elsewhere
 */

import { readFileSync } from "node:fs";

import { scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { blake2b256 } from "../src/hashers.ts";
import { resolveSigner } from "../src/keys.ts";
import { NodeClient } from "../src/node.ts";
import { RecipientSet } from "../src/recipients.ts";
import { agentPublicKey, signSpend } from "../src/sign.ts";
import type { SpendPlan } from "../src/spend.ts";
import { scriptHashFor, templateFingerprint, type CovenantTemplate, type GrantState } from "../src/template.ts";
import { toWire } from "../src/wire.ts";

/** A lock time at or above the current DAA score is not yet final. */
const DAA_BACKOFF = 100n;
/** checksig is 100,000 units on its own; 16 covers that plus a depth-4 proof. */
const SPEND_COMPUTE_BUDGET = 16;

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const manifestPath = process.argv.find((a, i) => i >= 2 && !a.startsWith("--") && a.endsWith(".json"));
if (!manifestPath) {
  console.error("usage: build-live-spend.ts <grant.json> [--amount n] [--to hex]");
  process.exit(2);
}
const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error("WARDA_SK is required to sign a spend.");
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

const principalKey = flag("principal", m.principal ?? m.agent)!;
const authority = { principalKey, revocationKey: flag("revocation", m.revocation ?? principalKey)! };
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;

const state: GrantState = {
  agentKey: m.agent,
  budgetTotal: BigInt(m.budget),
  maxPerSpend: BigInt(m.max_per_spend),
  epochLimit: BigInt(m.epoch_limit),
  epochLength: BigInt(m.epoch_length),
  recipientsRoot: m.recipients_root,
  notBefore: BigInt(m.not_before),
  expiresAt: BigInt(m.expires_at),
  delegationDepth: BigInt(flag("depth", (m.delegation_depth ?? 2).toString())!),
  spentTotal: BigInt(m.spent_total),
  reserved: BigInt(m.reserved),
  epochIndex: BigInt(m.epoch_index),
  epochSpent: BigInt(m.epoch_spent),
};

// ---- which key signs -----------------------------------------------------

/**
 * A grant is spent by ITS agent, and with the roles separated that is nobody
 * else: not the principal, not the parent, not the funder. The manifest
 * records where a derived key came from; a key that was never derived cannot
 * be found here at all, which is the correct answer for a real deployment
 * where the agent holds its own secret and runs its own tooling.
 */
const provided = fromHex(secretHex.trim());
const found = resolveSigner(provided, state.agentKey, m.agent_key_derived ?? null);
if (!found) {
  console.error(
    `the key in WARDA_SK does not control this grant's agent (${state.agentKey}), ` +
      `and the manifest gives no derivation that reaches it.\n` +
      `If the roles are properly separated this is expected: the agent holds its ` +
      `own secret and signs its own spends. Run this with that key.`,
  );
  process.exit(1);
}
const secret = found.secret;
const whose = found.how;

// ---- the allowlist -------------------------------------------------------

const demoApiKey = agentPublicKey(blake2b256(new TextEncoder().encode("warda-demo-api-v1")));
const recipients = new RecipientSet([
  demoApiKey,
  new Uint8Array(32).fill(0xa2),
  new Uint8Array(32).fill(0xa3),
  new Uint8Array(32).fill(0xa4),
]);
if (toHex(recipients.root) !== state.recipientsRoot) {
  // Checked before anything is built. A proof from the wrong list fails inside
  // the covenant, where the error names a hash mismatch and nothing else.
  console.error(
    `the reconstructed allowlist hashes to ${toHex(recipients.root)}, but this grant ` +
      `commits to ${state.recipientsRoot}. This is the wrong recipient list.`,
  );
  process.exit(1);
}

const recipient = fromHex(flag("to", toHex(demoApiKey))!);
if (!recipients.has(recipient)) {
  // No proof exists that places a non-member in the tree. Saying so here beats
  // building a transaction whose only defect is that it cannot succeed.
  console.error(`${toHex(recipient)} is not in this grant's allowlist; no proof can place it there.`);
  process.exit(1);
}
const proof = recipients.proof(recipient);

// ---- build ---------------------------------------------------------------

const address = scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix);
const client = await NodeClient.connect({ url: flag("rpc") });
let plan: SpendPlan;
try {
  const [dag, utxos] = await Promise.all([
    client.getBlockDagInfo(),
    client.getUtxosByAddresses([address]),
  ]);
  const found = utxos[0];
  if (!found) {
    console.error(
      `no UTXO at ${address}.\n` +
        `Three things produce this, in the order worth checking:\n` +
        `  - the genesis was built but never submitted, so the grant does not exist yet\n` +
        `  - the manifest is stale: a grant's address derives from its state, so\n` +
        `    spending or delegating MOVES it, and the old address goes empty\n` +
        `  - the authority is wrong: principal, revocation and depth are all part\n` +
        `    of the address, so a wrong guess derives a different one`,
    );
    process.exit(1);
  }

  plan = {
    template,
    authority,
    state,
    utxo: {
      outpointTransactionId: found.outpoint.transactionId,
      outpointIndex: found.outpoint.index,
      value: found.entry.value,
      blockDaaScore: found.entry.blockDaaScore,
      isCoinbase: found.entry.isCoinbase,
      covenantId: found.entry.covenantId!,
    },
    amount: BigInt(flag("amount", "30000000")!),
    recipient,
    proof,
    claimedDaa: dag.virtualDaaScore - DAA_BACKOFF,
    fee: BigInt(flag("fee", "1000000")!),
    computeBudget: SPEND_COMPUTE_BUDGET,
  };
} finally {
  client.close();
}

const { unsigned, tx } = signSpend(plan, secret);
const successorAddress = scriptHashToAddress(
  scriptHashFor(template, { authority, state: unsigned.successorState }),
  prefix,
);

console.error(`grant       : ${address}`);
console.error(`  signed by : ${whose}`);
console.error(`  pays      : ${plan.amount} sompi to ${toHex(recipient)}`);
console.error(`  moves to  : ${successorAddress}`);
console.error(
  `  successor : spent ${unsigned.successorState.spentTotal}, epoch ${unsigned.successorState.epochIndex}, ` +
    `epochSpent ${unsigned.successorState.epochSpent}`,
);
console.error(`  claimedDaa: ${plan.claimedDaa}`);

process.stdout.write(
  JSON.stringify(toWire(tx, unsigned.entry, "@warda/kaspa (live spend)"), null, 2) + "\n",
);
