/**
 * Finds where a grant went, without the transaction that moved it.
 *
 *   node --experimental-strip-types tools/follow-grant.ts \
 *     ../covenant/deploy/grant-demo.json \
 *     --vendor kaspatest:qq… --rpc ws://127.0.0.1:18210 [--write]
 *
 * ## The problem this solves
 *
 * A grant's address is blake2b of its state, so every spend moves it. Following
 * one is normally done by tailing the mempool (`GrantWatcher`) and catching each
 * spend as it happens — which needs a process that never misses a window. Miss
 * one and the grant is somewhere you cannot name: Kaspa's node RPC answers
 * "what is unspent at this address" and never "what spent this outpoint", and
 * without a transaction index you cannot fetch the spending transaction by id
 * once it has left the mempool.
 *
 * That was the whole argument for needing a daemon. It is wrong.
 *
 * ## Why the successor is computable
 *
 * `GrantState` has no value field. The address is derived from the state alone,
 * so the FEE and the coin amount do not affect where the grant lands — only the
 * counters do:
 *
 *     spentTotal' = spentTotal + amount
 *     epochIndex' = (claimedDaa - notBefore) / epochLength
 *     epochSpent' = (epochIndex' === epochIndex ? epochSpent : 0) + amount
 *
 * `amount` is not a mystery either: the covenant permits exactly one payee, so
 * every coin this grant has released is sitting at the vendor's address, one
 * UTXO per payment, each carrying the DAA score of the block that accepted it.
 *
 * That leaves `claimedDaa`, which the spender chose — but it enters only
 * through `epochIndex`, and the epoch index is bounded: at least the grant's
 * recorded epoch (the covenant ratchets it forward and refuses to go back), at
 * most the epoch of the block that mined the payment. For a grant polled every
 * twenty minutes that is a handful of candidates.
 *
 * So: enumerate the candidate states, derive each address, and ask the node
 * which one holds coin. One batched call, no history, no daemon.
 *
 * ## What it does not do
 *
 * It does not identify WHO spent, or recover the transaction. It answers only
 * "where is the grant now, and what are its counters" — which is what anything
 * downstream actually needs.
 *
 * With --write the manifest is advanced in place, and only when a candidate is
 * confirmed by a real UTXO at the derived address. A guess is never written.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { scriptHashToAddress, decodeAddress, type NetworkPrefix } from "../src/address.ts";
import { EMPTY_RESERVE } from "../src/keys.ts";
import { NodeClient } from "../src/node.ts";
import { successorState } from "../src/spend.ts";
import {
  scriptHashFor,
  templateIdFor,
  type CovenantTemplate,
  type GrantAuthority,
  type GrantState,
} from "../src/template.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const manifestPath = process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!manifestPath) {
  console.error(
    "usage: follow-grant.ts <grant.json> --vendor <address> [--rpc url] [--resolver url] [--write]",
  );
  process.exit(2);
}
const m = JSON.parse(readFileSync(manifestPath, "utf8"));
const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);
const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;

const vendor = flag("vendor");
if (!vendor) {
  console.error("--vendor is required: it is the only address this grant can pay, and the");
  console.error("UTXOs sitting there are what make the amounts knowable.");
  process.exit(2);
}
const vendorScriptKey = toHexKey(decodeAddress(vendor).payload);

function toHexKey(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

const authority: GrantAuthority = {
  principalKey: m.principal,
  revocationKey: m.revocation ?? m.principal,
};

function stateFrom(raw: typeof m): GrantState {
  return {
    agentKey: raw.agent,
    budgetTotal: BigInt(raw.budget),
    maxPerSpend: BigInt(raw.max_per_spend),
    epochLimit: BigInt(raw.epoch_limit),
    epochLength: BigInt(raw.epoch_length),
    recipientsRoot: raw.recipients_root,
    notBefore: BigInt(raw.not_before),
    expiresAt: BigInt(raw.expires_at),
    delegationDepth: BigInt(raw.delegation_depth),
    templateId: templateIdFor(template, authority),
    spentTotal: BigInt(raw.spent_total),
    reserved: BigInt(raw.reserved),
    epochIndex: BigInt(raw.epoch_index),
    epochSpent: BigInt(raw.epoch_spent),
    reserveRoot: raw.reserve_root ?? EMPTY_RESERVE,
  };
}

const addressOf = (state: GrantState) =>
  scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix);

const client = await NodeClient.connect({ url: flag("rpc") });
try {
  let state = stateFrom(m);
  let address = addressOf(state);

  const here = await client.getUtxosByAddresses([address]);
  if (here.length > 0) {
    console.error(`the grant has not moved: ${address}`);
    console.error(`  holds ${here[0]!.entry.value} sompi`);
    process.exit(0);
  }

  // Every payment this grant ever made, oldest first. One UTXO per payment,
  // because the covenant pays exactly one recipient per spend.
  const paid = (await client.getUtxosByAddresses([vendor])).sort((a, b) =>
    a.entry.blockDaaScore < b.entry.blockDaaScore ? -1 : 1,
  );
  console.error(`grant is not at ${address}`);
  console.error(`vendor holds ${paid.length} payment(s); walking forward from epoch ${state.epochIndex}`);

  const applied: string[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    const found = await client.getUtxosByAddresses([addressOf(state)]);
    if (found.length > 0) break;

    for (const utxo of paid) {
      const id = `${utxo.outpoint.transactionId}:${utxo.outpoint.index}`;
      if (applied.includes(id)) continue;

      // Candidate epochs: at least the grant's own (the covenant ratchets and
      // refuses to move backwards), at most the epoch of the block that mined
      // this payment. claimedDaa cannot exceed the DAA the network had.
      const maxEpoch = (utxo.entry.blockDaaScore - state.notBefore) / state.epochLength;
      const candidates: { state: GrantState; epoch: bigint }[] = [];
      for (let e = state.epochIndex; e <= maxEpoch; e++) {
        const claimedDaa = state.notBefore + e * state.epochLength;
        try {
          candidates.push({ state: successorState(state, utxo.entry.value, claimedDaa), epoch: e });
        } catch {
          // successorState refuses an epoch behind the recorded one. Not a
          // candidate, and not an error worth stopping for.
        }
      }
      if (candidates.length === 0) continue;

      /* Asked one address at a time, deliberately.
       *
       * Batching them into a single getUtxosByAddresses is one call instead of
       * a dozen, but the reply does not say which address each UTXO came from
       * — you get entries, and matching them back means picking the script
       * hash out of a P2SH scriptPublicKey at an offset this code would have
       * to assume. A wrong assumption there does not fail; it identifies the
       * wrong state and writes it to the manifest as fact.
       *
       * A handful of round trips to a local node, once every poll, is not
       * worth that. */
      let chosen: { state: GrantState; epoch: bigint } | undefined;
      for (const c of candidates) {
        const at = await client.getUtxosByAddresses([addressOf(c.state)]);
        if (at.length > 0) {
          chosen = c;
          break;
        }
      }
      if (!chosen) continue;

      state = chosen.state;
      applied.push(id);
      progress = true;
      console.error(
        `  +${utxo.entry.value} sompi in epoch ${chosen.epoch} -> ${addressOf(state)}`,
      );
      break;
    }
  }

  const finalAddress = addressOf(state);
  const settled = await client.getUtxosByAddresses([finalAddress]);
  if (settled.length === 0) {
    console.error(
      `\nCOULD NOT FOLLOW IT. The grant is not at any state reachable from the manifest by\n` +
        `the payments sitting at the vendor. That means something happened this cannot\n` +
        `model — a delegation, a settlement, a revocation, or a spend to a payee whose\n` +
        `coin has since been moved on.\n\n` +
        `Nothing was written. The manifest still describes the last state known to be real.`,
    );
    process.exit(1);
  }

  console.error(`\nFOUND IT: ${finalAddress}`);
  console.error(`  holds  : ${settled[0]!.entry.value} sompi`);
  console.error(`  state  : spent ${state.spentTotal}, epoch ${state.epochIndex}, epochSpent ${state.epochSpent}`);

  if (process.argv.includes("--write")) {
    const updated = {
      ...m,
      grant_value: settled[0]!.entry.value.toString(),
      spent_total: state.spentTotal.toString(),
      epoch_index: state.epochIndex.toString(),
      epoch_spent: state.epochSpent.toString(),
    };
    // Numbers, not strings, to match what genesis and advance-manifest write.
    for (const k of ["grant_value", "spent_total", "epoch_index", "epoch_spent"] as const) {
      (updated as Record<string, unknown>)[k] = Number(updated[k]);
    }
    writeFileSync(manifestPath, JSON.stringify(updated, null, 2) + "\n");
    console.error(`  wrote  : ${manifestPath}`);
  } else {
    console.error(`\n(not written — add --write)`);
  }
} finally {
  client.close();
}
