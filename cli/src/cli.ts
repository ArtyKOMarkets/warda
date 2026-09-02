#!/usr/bin/env node
/**
 * warda — give an agent a budget the network enforces.
 *
 *   warda init                       make an agent key
 *   warda grant create …             fund a bounded grant for it
 *   warda buy <url>                  pay an x402 endpoint out of that grant
 *   warda status                     what the grant permits, and what is left
 *   warda check                      is this node worth believing
 *
 * ## What this wraps, and what it refuses to hide
 *
 * The SDK is the product; this is ergonomics. Three things it does that a thin
 * wrapper would not, each of them a bug found by running the whole path
 * against a live chain rather than by reading the code:
 *
 *   - it WAITS for the network to accept a grant before saying it exists.
 *     Submitting is not accepting, and a command that returns early hands you
 *     a grant whose address holds nothing yet.
 *   - it ADVANCES the manifest after every payment, because a spend moves the
 *     grant. The tool that forgets reports a healthy grant as missing.
 *   - it keeps the RECIPIENT LIST, because a grant commits to the root and a
 *     root cannot produce an inclusion proof. Lose the list and the grant can
 *     be revoked and reclaimed but never spent.
 *
 * What it does not hide is the node. Warda builds and signs locally, and
 * building means reading the UTXO set. There is no hosted default, because
 * naming one is a decision about who you trust with your view of the chain.
 */
import { randomBytes } from "node:crypto";

import {
  EMPTY_RESERVE,
  NodeClient,
  RecipientSet,
  agentPublicKey,
  attachGenesisSignature,
  buildGenesis,
  decodeAddress,
  formatHealth,
  fromHex,
  pubkeyToAddress,
  scriptHashFor,
  scriptHashToAddress,
  signDigest,
  templateIdFor,
  toHex,
  type CovenantTemplate,
  type NetworkPrefix,
} from "@warda_protocol/kaspa";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

import * as store from "./store.js";

const require_ = createRequire(import.meta.url);
const template: CovenantTemplate = JSON.parse(
  readFileSync(require_.resolve("@warda_protocol/kaspa/covenant-template.json"), "utf8"),
);

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d;
};
const say = (s = "") => console.error(s);
const PREFIX = () => (flag("prefix", "kaspatest") as NetworkPrefix);

function die(message: string, code = 1): never {
  say(message);
  process.exit(code);
}

async function connect(cfg?: { node?: string }): Promise<NodeClient> {
  const url = flag("rpc") ?? cfg?.node ?? process.env.WARDA_RPC_JSON;
  if (!url) {
    die(
      "no node. Warda builds and signs locally but must read the UTXO set to do it.\n" +
        "  --rpc ws://127.0.0.1:18210   a kaspad started with --utxoindex --rpclisten-json=\n" +
        "  or set it once with `warda init --rpc <url>`\n\n" +
        "There is no hosted default: which node you believe is your decision, not ours.",
    );
  }
  return NodeClient.connect({ url });
}

/** The grant's state, from a manifest. Every field here is part of the address. */
function stateOf(m: Record<string, any>, authority: { principalKey: string; revocationKey: string }) {
  return {
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
}
const authorityOf = (m: Record<string, any>) => ({
  principalKey: m.principal,
  revocationKey: m.revocation ?? m.principal,
});
const addressOf = (m: Record<string, any>) =>
  scriptHashToAddress(
    scriptHashFor(template, { authority: authorityOf(m), state: stateOf(m, authorityOf(m)) }),
    PREFIX(),
  );

const membersOf = (list: string[]) =>
  list.map((t) => (t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase()));

// ---- init ----------------------------------------------------------------

async function init(): Promise<void> {
  if (store.initialised() && !argv.includes("--force")) {
    die(`${store.DIR} already exists. Use --force to replace the agent key — the old grant\nwill still be spendable only by the old key, so keep it if it holds anything.`);
  }
  const secret = randomBytes(32);
  store.saveKey(toHex(secret));
  store.saveConfig({ node: flag("rpc"), recipients: [], network: flag("network", "testnet-10")! });

  const pub = agentPublicKey(secret);
  say();
  say("✓ agent created");
  say();
  say(`  key      ${store.paths.key} (0600)`);
  say(`  public   ${toHex(pub)}`);
  say(`  address  ${pubkeyToAddress(pub, PREFIX())}`);
  say();
  say("This key is the agent's entire authority. What it can do is bounded by the");
  say("grant you create next, not by trusting whatever holds it.");
  say();
  say("Next:");
  say("  warda grant create --budget 10 --max-spend 0.1 --payee <address you will pay>");
}

// ---- grant create --------------------------------------------------------

async function grantCreate(): Promise<void> {
  const cfg = store.readConfig();
  const agentSecret = fromHex(store.readKey());
  const agentKey = toHex(agentPublicKey(agentSecret));

  const payees = (flag("payee") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (payees.length === 0) {
    die(
      "--payee is required, and it cannot be changed later.\n" +
        "The allowlist is fixed when the grant is created: a payee outside it has no inclusion\n" +
        "proof, so there is no transaction that pays them — not one the network refuses, none\n" +
        "at all. Name every address this agent may ever pay.",
    );
  }

  const funderHex = process.env.WARDA_SK;
  if (!funderHex) {
    die(
      "WARDA_SK must be the FUNDER's key — the wallet paying for this grant.\n" +
        "It is not the agent's key: the agent has its own, and that separation is the point.",
    );
  }
  const funder = fromHex(funderHex.trim());
  const funderAddress = pubkeyToAddress(agentPublicKey(funder), PREFIX());

  const budget = store.sompi(flag("budget", "10")!);
  const maxPerSpend = store.sompi(flag("max-spend", "0.1")!);
  const epochLimit = store.sompi(flag("epoch-limit", store.kas(budget / 2n))!);
  const fee = store.sompi(flag("fee", "0.03")!);

  const recipients = new RecipientSet(membersOf(payees));
  const client = await connect(cfg);
  try {
    const [dag, utxos] = await Promise.all([
      client.getBlockDagInfo(),
      client.getUtxosByAddresses([funderAddress]),
    ]);
    const funding = utxos.sort((a, b) => (a.entry.value > b.entry.value ? -1 : 1))[0];
    if (!funding || funding.entry.value < budget + fee) {
      die(
        `the funding wallet holds ${funding ? store.kas(funding.entry.value) : "0"} KAS and this ` +
          `grant needs ${store.kas(budget + fee)}.\n\n  ${funderAddress}\n\n` +
          `Fund that address, then run this again. Testnet coin has no market value.`,
      );
    }

    const notBefore = dag.virtualDaaScore;
    const manifest: Record<string, any> = {
      covenant_id: "",
      agent: agentKey,
      principal: toHex(agentPublicKey(funder)),
      revocation: toHex(agentPublicKey(funder)),
      recipients_root: recipients.rootHex,
      not_before: Number(notBefore),
      expires_at: Number(notBefore + BigInt(flag("window", "25920000")!)),
      budget: Number(budget),
      max_per_spend: Number(maxPerSpend),
      epoch_limit: Number(epochLimit),
      epoch_length: Number(flag("epoch-length", "1000")!),
      delegation_depth: Number(flag("depth", "2")!),
      spent_total: 0,
      reserved: 0,
      epoch_index: 0,
      epoch_spent: 0,
      reserve_root: EMPTY_RESERVE,
    };

    const authority = authorityOf(manifest);
    const grant = { authority, state: stateOf(manifest, authority) };
    const unsigned = buildGenesis({
      template,
      grant,
      funding: {
        outpointTransactionId: funding.outpoint.transactionId,
        outpointIndex: funding.outpoint.index,
        value: funding.entry.value,
        scriptPublicKey: funding.entry.scriptPublicKey,
        blockDaaScore: funding.entry.blockDaaScore,
        isCoinbase: funding.entry.isCoinbase,
      },
      grantValue: budget,
      fee,
      computeBudget: 12,
    });
    const sig = new Uint8Array(65);
    sig.set(signDigest(unsigned.sighash, funder), 0);
    sig[64] = 0x01;
    const tx = attachGenesisSignature(unsigned, sig);

    manifest.covenant_id = toHex(unsigned.covenantId);
    const address = addressOf(manifest);

    say();
    say(`creating a grant at ${address}`);
    const txid = await client.submitTransaction(tx);
    say(`  submitted ${txid}`);

    /* Submitting is not accepting. Returning here would hand back a grant whose
       address holds nothing yet, and the next command would report it missing. */
    process.stderr.write("  waiting for the network to accept it");
    let seen = false;
    for (let i = 0; i < 40 && !seen; i++) {
      if ((await client.getUtxosByAddresses([address])).length > 0) { seen = true; break; }
      process.stderr.write(".");
      await new Promise((r) => setTimeout(r, 1500));
    }
    say(seen ? " accepted." : "");
    if (!seen) die("\nsubmitted, but not visible yet. Nothing is lost — look again in a moment.");

    store.saveGrant(manifest);
    store.saveConfig({ ...cfg, recipients: payees });

    say();
    say("✓ grant created");
    say();
    say(`  address       ${address}`);
    say(`  budget        ${store.kas(budget)} KAS, for the life of the grant`);
    say(`  per payment   ${store.kas(maxPerSpend)} KAS`);
    say(`  per epoch     ${store.kas(epochLimit)} KAS every ${manifest.epoch_length} blocks`);
    say(`  may pay       ${payees.length} address(es), fixed`);
    say();
    say("Next:  warda buy <url of an x402 endpoint>");
  } finally {
    client.close();
  }
}

// ---- status --------------------------------------------------------------

async function status(): Promise<void> {
  const cfg = store.readConfig();
  const m = store.readGrant();
  const address = addressOf(m);
  const client = await connect(cfg);
  try {
    const utxos = await client.getUtxosByAddresses([address]);
    const budget = BigInt((m as any).budget);
    const spent = BigInt((m as any).spent_total ?? 0);
    say();
    say(`  address       ${address}`);
    say(`  holds         ${utxos[0] ? store.kas(utxos[0].entry.value) + " KAS" : "nothing at this address"}`);
    say(`  budget        ${store.kas(budget)} KAS`);
    say(`  spent         ${store.kas(spent)} KAS`);
    say(`  remaining     ${store.kas(budget - spent)} KAS  (authority left to pay out)`);
    if (utxos[0]) {
      const heldMinusRemaining = BigInt(utxos[0].entry.value) - (budget - spent);
      if (heldMinusRemaining !== 0n) {
        say(
          `                the coin held differs by ${store.kas(heldMinusRemaining < 0n ? -heldMinusRemaining : heldMinusRemaining)} KAS: ` +
            `network fees come out of\n                the grant but do not count against what the agent may pay out`,
        );
      }
    }
    say(`  per payment   ${store.kas(BigInt((m as any).max_per_spend))} KAS`);
    say(`  may pay       ${cfg.recipients.join(", ") || "(list missing from config)"}`);
    if (!utxos[0]) {
      say();
      say("  Nothing at that address usually means the grant MOVED: a spend rewrites its");
      say("  state, and the address is a hash of the state. It rarely means the grant is gone.");
    }
  } finally {
    client.close();
  }
}

// ---- check ---------------------------------------------------------------

async function check(): Promise<void> {
  const cfg = (() => { try { return store.readConfig(); } catch { return undefined; } })();
  let grantAddress: string | undefined;
  try { grantAddress = addressOf(store.readGrant()); } catch { /* none yet */ }
  const url = flag("rpc") ?? cfg?.node ?? process.env.WARDA_RPC_JSON;
  if (!url) die("no node to check. Pass --rpc, or run `warda init --rpc <url>`.");
  const { client, health } = await NodeClient.open({ url, networkId: cfg?.network ?? "testnet-10", grantAddress, tolerate: true });
  client.close();
  say(formatHealth(health));
  if (!health.usable) process.exit(1);
}

// ---- buy -----------------------------------------------------------------

async function buy(url: string): Promise<void> {
  const cfg = store.readConfig();
  const m = store.readGrant();
  const recipients = new RecipientSet(membersOf(cfg.recipients));
  if (recipients.rootHex !== (m as any).recipients_root) {
    die(
      `the payee list in ${store.paths.config} hashes to ${recipients.rootHex}, but the grant\n` +
        `commits to ${(m as any).recipients_root}. One of the two has been edited.`,
    );
  }

  /* x402 is a peer dependency in spirit: buying is optional, and a user who
     only creates grants should not be made to install a payment adapter. */
  let x402: typeof import("@warda_protocol/x402");
  try {
    x402 = await import("@warda_protocol/x402");
  } catch {
    die("`warda buy` needs @warda_protocol/x402:\n  npm install @warda_protocol/x402");
  }

  const authority = authorityOf(m);
  const client = await connect(cfg);
  try {
    const payer = new x402.WardaPayer({
      grant: { template, authority, state: stateOf(m, authority), recipients },
      node: client,
      sign: fromHex(store.readKey()),
    });
    say(`buying ${url}`);
    const res = await x402.wardaFetch(url, undefined, {
      payer,
      onEvent: (e) => {
        if (e.type === "quote") say(`  quoted   ${e.requirement.amountSompi} sompi to ${e.requirement.payTo}`);
        if (e.type === "paid") say(`  paid     ${e.result.txid}`);
        if (e.type === "settling") say(`  settling, retrying with the same proof`);
      },
    });
    process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");

    /* The grant has moved. Write it back or the next command looks for it
       where it was, and reports a healthy grant as missing. */
    const after = payer.state;
    store.saveGrant({
      ...m,
      spent_total: Number(after.spentTotal),
      epoch_index: Number(after.epochIndex),
      epoch_spent: Number(after.epochSpent),
    });
    say();
    say(`  grant advanced: spent ${store.kas(after.spentTotal)} KAS of ${store.kas(BigInt((m as any).budget))}`);
  } finally {
    client.close();
  }
}

// ---- dispatch ------------------------------------------------------------

const [cmd, sub] = argv;
try {
  if (cmd === "init") await init();
  else if (cmd === "grant" && sub === "create") await grantCreate();
  else if (cmd === "status") await status();
  else if (cmd === "check") await check();
  else if (cmd === "buy" && sub) await buy(sub);
  else {
    say("warda — give an agent a budget the network enforces\n");
    say("  warda init [--rpc <url>]");
    say("  warda grant create --budget 10 --max-spend 0.1 --payee <address>");
    say("  warda buy <url>");
    say("  warda status");
    say("  warda check\n");
    say("WARDA_SK is the FUNDER's key for `grant create`. The agent's key lives in .warda.");
    process.exit(cmd ? 2 : 0);
  }
} catch (e) {
  die((e as Error).message);
}
