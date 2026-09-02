/**
 * A manifest, as the MCP server wants to be told about it.
 *
 *   node --experimental-strip-types tools/mcp-descriptor.ts grant.json \
 *     --recipients vendors.txt
 *
 *   … --call warda_grant_authority        # a ready-to-POST JSON-RPC body
 *   … --call warda_build_spend --to <addr> --amount-kas 0.1
 *
 * ## Why this is needed
 *
 * The MCP server speaks a different shape from a manifest: amounts in KAS
 * rather than sompi, the allowlist as MEMBERS rather than the root it commits
 * to, and a nonce the manifest has no field for. An agent holding a grant file
 * therefore could not talk to the server about it without hand-translating
 * eleven fields, which is the kind of task that looks trivial and produces a
 * grant descriptor that derives some other address.
 *
 * ## The nonce
 *
 * It identifies the grant to the rules engine and is NOT part of the covenant
 * state, so it does not affect the address — `stateOf` never reads it. Any
 * stable value works; this derives one from the agent key so two runs describe
 * the same grant.
 */
import { readFileSync } from "node:fs";

import { decodeAddress, scriptHashToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex, toHex } from "../src/bytes.ts";
import { EMPTY_RESERVE } from "../src/keys.ts";
import { NodeClient } from "../src/node.ts";
import { RecipientSet } from "../src/recipients.ts";
import { scriptHashFor, templateIdFor, type CovenantTemplate } from "../src/template.ts";

import { membersFrom } from "./members.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const path = process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json"));
const recipientsSpec = flag("recipients");
if (!path || !recipientsSpec) {
  console.error(
    "usage: mcp-descriptor.ts <grant.json> --recipients <file|list> [--call <tool> …]\n\n" +
      "--recipients is required: the manifest commits to the allowlist's ROOT, and the\n" +
      "server needs the members themselves. A root cannot be turned back into a list.",
  );
  process.exit(2);
}
const m = JSON.parse(readFileSync(path, "utf8"));
const members = membersFrom(recipientsSpec);

// Checked, not trusted: a list that hashes to a different root describes a
// different grant, and the server would derive an address nothing is at.
const set = new RecipientSet(members);
if (set.rootHex !== m.recipients_root) {
  console.error(
    `these recipients hash to ${set.rootHex}, but the grant commits to ${m.recipients_root}.\n` +
      `This is the wrong list for this grant.`,
  );
  process.exit(1);
}

const kas = (sompi: unknown) => {
  const v = BigInt(sompi as string | number);
  const whole = v / 100_000_000n, frac = v % 100_000_000n;
  return frac === 0n ? whole.toString() : `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")}`;
};

const grant = {
  agentKey: m.agent,
  principalKey: m.principal,
  revocationKey: m.revocation ?? m.principal,
  budgetKas: kas(m.budget),
  maxPerSpendKas: kas(m.max_per_spend),
  epochLimitKas: kas(m.epoch_limit),
  epochLength: String(m.epoch_length),
  recipients: members,
  notBefore: String(m.not_before),
  expiresAt: String(m.expires_at),
  delegationDepth: m.delegation_depth ?? 2,
  nonce: m.agent.slice(0, 16),
  state: {
    spentTotalKas: kas(m.spent_total ?? 0),
    reservedKas: kas(m.reserved ?? 0),
    epochIndex: String(m.epoch_index ?? 0),
    epochSpentKas: kas(m.epoch_spent ?? 0),
    // Only when it has delegated. Sending EMPTY_RESERVE explicitly is the same
    // thing, but omitting it is what the schema documents as "never delegated".
    ...(m.reserve_root && m.reserve_root !== EMPTY_RESERVE ? { reserveRoot: m.reserve_root } : {}),
  },
};

const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);
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

const call = flag("call");
const needsUtxo = call === "warda_build_spend";
if (!call) {
  process.stdout.write(JSON.stringify({ grant }, null, 2) + "\n");
} else {
  const args: Record<string, unknown> = { grant };
  const to = flag("to");
  if (to) args.recipient = to.includes(":") ? toHex(decodeAddress(to).payload) : to;
  if (flag("amount-kas")) args.amountKas = flag("amount-kas");
  /**
   * The grant's live UTXO, which warda_build_spend requires.
   *
   * The server builds a transaction and therefore needs the outpoint it
   * spends, its value, and its covenant id. It cannot look any of that up: it
   * holds no chain state. So the caller reads it, which means deriving the
   * grant's address first — the manifest does not record it, because the
   * address is a function of the state and would go stale the moment it moved.
   */
  if (needsUtxo && !flag("no-utxo")) {
    const client = await NodeClient.connect({ url: flag("rpc") });
    try {
      const address = scriptHashToAddress(
        scriptHashFor(template, { authority, state }),
        (flag("prefix", "kaspatest") as NetworkPrefix)!,
      );
      const found = (await client.getUtxosByAddresses([address]))[0];
      if (!found) {
        console.error(
          `\nno UTXO at ${address}.\n` +
            `That address is derived from the manifest, so either the manifest is stale — a\n` +
            `spend MOVES a grant — or the grant does not exist yet. tools/follow-grant.ts\n` +
            `finds where it went.`,
        );
        process.exit(1);
      }
      args.utxo = {
        transactionId: toHex(found.outpoint.transactionId),
        index: found.outpoint.index,
        valueSompi: found.entry.value.toString(),
        blockDaaScore: found.entry.blockDaaScore.toString(),
        isCoinbase: found.entry.isCoinbase,
        covenantId: found.entry.covenantId ? toHex(found.entry.covenantId) : "",
      };
      console.error(`utxo    : ${found.entry.value} sompi at ${address.slice(0, 24)}…`);
    } finally {
      client.close();
    }
  }

  /* The server's default fee is 1,000,000 — an ordinary transfer's. A covenant
     spend carries the whole redeem script and needs roughly 1.5x that, so it
     is set here rather than left to a default that will be rejected. */
  args.feeSompi = flag("fee", "3000000");
  /**
   * The DAA score, which the caller must supply.
   *
   * The server never contacts a chain — that is what makes it safe to host and
   * stateless — so every tool that reasons about epochs takes the current
   * score as an argument. An agent with no node cannot fill this in, which is
   * the same node dependency that runs through everything else here.
   *
   * `--rpc` fetches it; `--daa` states it.
   */
  let daa = flag("daa");
  if (!daa && flag("rpc")) {
    const client = await NodeClient.connect({ url: flag("rpc") });
    try {
      daa = (await client.getBlockDagInfo()).virtualDaaScore.toString();
      console.error(`daa     : ${daa} (read from the node)`);
    } finally {
      client.close();
    }
  }
  if (!daa) {
    console.error(
      "\nthis tool call needs --daa <score> or --rpc <url>.\n" +
        "The MCP server holds no chain state and asks the caller what the score is; every\n" +
        "tool that reasons about epoch limits requires it.",
    );
    process.exit(2);
  }
  args.daaScore = daa;
  process.stdout.write(
    JSON.stringify(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: call, arguments: args } },
      null,
      2,
    ) + "\n",
  );
}

console.error(`grant   : ${m.agent.slice(0, 16)}… , ${members.length} permitted payee(s)`);
console.error(`root    : ${set.rootHex} (matches the manifest)`);
console.error(`budget  : ${kas(m.budget)} KAS, ${kas(m.max_per_spend)} per payment`);
if (call) console.error(`body    : a tools/call for ${call}, ready to POST`);
