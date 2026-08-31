/**
 * Moves a manifest to the state a submitted transaction produced.
 *
 * This is not bookkeeping. A grant's ADDRESS is derived from its state, so a
 * manifest left behind points at an address the grant has already left, and
 * the next tool reports "no UTXO at the grant address" for a grant that is
 * perfectly healthy. That reads as a lost grant and is merely a stale file.
 *
 *   node --experimental-strip-types tools/advance-manifest.ts \
 *     ../covenant/deploy/grant-child-8fefa35b.json js-child-spend.json
 *
 * `warda-deploy submit` does this for `grant.json` and only for `grant.json`,
 * which was fine while there was one grant. Delegation makes trees, and a
 * child's manifest is a separate file that nothing was advancing.
 *
 * ## Why this cannot quietly write the wrong thing
 *
 * The new state is not what we intended to do. It is derived from the
 * transaction's OWN numbers, and then the successor ADDRESS implied by that
 * state is required to equal the address the transaction actually pays. If
 * they disagree, nothing is written — a confidently wrong manifest is worse
 * than a stale one, because a stale one announces itself.
 */

import { readFileSync, writeFileSync } from "node:fs";

import { scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { parentSuccessorState } from "../src/delegate.ts";
import { successorState } from "../src/spend.ts";
import { scriptHashFor, type CovenantTemplate, type GrantState } from "../src/template.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const [manifestPath, txPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!manifestPath || !txPath) {
  console.error("usage: advance-manifest.ts <manifest.json> <wire-tx.json>");
  process.exit(2);
}

const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const wire = JSON.parse(readFileSync(txPath, "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

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

if (wire.outputs.length !== 2) {
  console.error(`this transaction has ${wire.outputs.length} outputs; a spend and a delegation both have 2.`);
  process.exit(1);
}

/** P2SH is OP_BLAKE2B <32-byte hash> OP_EQUAL. */
const p2sh = (scriptHashHex: string) => "aa20" + scriptHashHex + "87";

// Is this a transaction of THIS grant, or of a relative?
//
// The covenant id is NOT unique per grant: a delegated child inherits its
// parent's, so every grant in a tree answers to the same id. The only honest
// gate is the INPUT — a transaction moves the grant this manifest describes
// only if the UTXO it consumes sits at the address this manifest's CURRENT
// state derives. Without it, pointing at the wrong manifest produces a
// successor-address disagreement, which reads as "these numbers are wrong"
// when the truth is "this is not your transaction".
const currentScript = p2sh(scriptHashFor(template, { authority, state }));
if (wire.utxo.scriptPublicKeyHex !== currentScript) {
  console.error(
    `this transaction does not spend the grant ${manifestPath} describes.\n` +
      `  it consumes a UTXO at : ${wire.utxo.scriptPublicKeyHex}\n` +
      `  this manifest is at   : ${currentScript}\n` +
      `Nothing changed. A sibling grant in the same tree shares this covenant id, ` +
      `so the id alone cannot tell them apart.`,
  );
  process.exit(1);
}

// A SPEND and a DELEGATION are both "two outputs, output 0 continuing the
// covenant", and they move the state in opposite directions. The discriminator
// is output 1: a spend pays a recipient's plain P2PK, a delegation pays a
// CHILD GRANT, which carries a covenant binding of its own.
const delegating = wire.outputs[1].covenant !== null && wire.outputs[1].covenant !== undefined;

const next = delegating
  ? // Nothing is spent — the coin has not left the grant, it has been
    // subdivided — and no epoch allowance is consumed, which is why a
    // delegation carries no lock time to read one from.
    parentSuccessorState(state, BigInt(wire.outputs[1].value))
  : successorState(state, BigInt(wire.outputs[1].value), BigInt(wire.lockTime));

const expectedScript = p2sh(scriptHashFor(template, { authority, state: next }));
const paid = wire.outputs[0].scriptPublicKeyHex;

if (expectedScript !== paid) {
  console.error(`\nREFUSING to advance ${manifestPath}.`);
  console.error(`  read as a ${delegating ? "DELEGATION" : "SPEND"}`);
  console.error(`  the state derived from this transaction:`);
  console.error(
    `    spent ${next.spentTotal}, reserved ${next.reserved}, epoch ${next.epochIndex}, epochSpent ${next.epochSpent}`,
  );
  console.error(`  implies a successor at:\n    ${expectedScript}`);
  console.error(`  but the transaction pays:\n    ${paid}`);
  console.error(
    `\nEither this manifest describes a different state than the transaction was\n` +
      `built from, or this is not the transaction it appears to be. Unchanged.`,
  );
  process.exit(1);
}

const updated = { ...m };
updated.grant_value = Number(wire.outputs[0].value);
updated.spent_total = Number(next.spentTotal);
updated.reserved = Number(next.reserved);
updated.epoch_index = Number(next.epochIndex);
updated.epoch_spent = Number(next.epochSpent);
writeFileSync(manifestPath, JSON.stringify(updated, null, 2) + "\n");

console.log(`advanced ${manifestPath} (read as a ${delegating ? "delegation" : "spend"})`);
console.log(`  now at : ${scriptHashToAddress(scriptHashFor(template, { authority, state: next }), prefix)}`);
console.log(`  holds  : ${wire.outputs[0].value} sompi`);
console.log(
  `  state  : spent ${next.spentTotal}, reserved ${next.reserved}, epoch ${next.epochIndex}, epochSpent ${next.epochSpent}`,
);
