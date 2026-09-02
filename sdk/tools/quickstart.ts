/**
 * Nothing to a funded, bounded agent — in one command.
 *
 *   WARDA_SK=$(cat wallet.key) node --experimental-strip-types tools/quickstart.ts
 *   … --rpc ws://127.0.0.1:18210
 *   … --resolver https://your-resolver
 *
 * ## Why this exists
 *
 * Every piece of this already worked, and the path between them was still a
 * half day. A newcomer had to: find a node, discover that the JSON wRPC port
 * is separate from the Borsh one and only listens with an `=` in the flag,
 * find testnet coin, discover which of three keys genesis wants, and get an
 * allowlist file into the right shape — with each of those failing separately,
 * late, and with an error written for somebody who already knew the system.
 *
 * So this checks all of it FIRST and reports everything that is missing at
 * once. A quickstart that fails five times in a row, each time revealing one
 * more prerequisite, is not a quickstart; it is a maze with a progress bar.
 *
 * It creates nothing until every precondition passes, and it never invents a
 * value: no default resolver, no guessed faucet, no fabricated allowlist.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { pubkeyToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex } from "../src/bytes.ts";
import { NodeClient, formatHealth } from "../src/node.ts";
import { resolverFrom } from "../src/resolver.ts";
import { agentPublicKey } from "../src/sign.ts";

import { membersFrom } from "./members.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;
const network = flag("network", "testnet-10")!;
const budget = flag("budget", "1000000000")!;         // 10 KAS
const maxPerSpend = flag("max-per-spend", "100000000")!; // 0.1 KAS
const epochLimit = flag("epoch-limit", "500000000")!;    // 0.5 KAS
const recipients = flag("recipients");
const out = flag("out", "grant.json")!;
/**
 * Where to write the agent's secret.
 *
 * Without this the key is printed and nothing else — fine for a human reading
 * the terminal, impossible for anything automating the next step. The showcase
 * hit exactly that: it created a grant, then had no way to hand the agent's
 * key to the delegation it wanted to make next, and failed with "WARDA_SK does
 * not control this grant's agent" — which is true, and says nothing about the
 * actual problem.
 */
const agentOut = flag("agent-out");

const problems: string[] = [];
const say = (s = "") => console.error(s);

say();
say("Warda quickstart");
say("────────────────");

// ---- 1. a key that funds it ----------------------------------------------
const secretHex = process.env.WARDA_SK;
let walletAddress: string | undefined;
if (!secretHex) {
  problems.push(
    "WARDA_SK is not set.\n" +
      "    This is your FUNDER key — the wallet that pays for the grant. It is not the\n" +
      "    agent's key; the agent gets its own, generated below.\n" +
      "      node --experimental-strip-types tools/new-key.ts > wallet.key\n" +
      "      export WARDA_SK=$(cat wallet.key)",
  );
} else {
  try {
    walletAddress = pubkeyToAddress(agentPublicKey(fromHex(secretHex.trim())), prefix);
    say(`wallet     ${walletAddress}`);
  } catch (e) {
    problems.push(`WARDA_SK is not a 32-byte hex secret: ${(e as Error).message}`);
  }
}

// ---- 2. who the agent may pay --------------------------------------------
if (!recipients) {
  problems.push(
    "--recipients is not set.\n" +
      "    The allowlist is fixed at genesis and cannot be changed afterwards, so there is\n" +
      "    no safe default. Pass the addresses this agent may pay:\n" +
      "      --recipients kaspatest:qq…            (one, inline)\n" +
      "      --recipients vendors.txt              (one per line)",
  );
} else if (/[/\\]|\.(txt|json|list)$/i.test(recipients) && !existsSync(recipients)) {
  problems.push(`--recipients points at ${recipients}, which does not exist.`);
}

// ---- 3. a node that can be believed --------------------------------------
let client: NodeClient | undefined;
if (!flag("rpc") && !resolverFrom({ resolver: flag("resolver") })) {
  problems.push(
    "No node. Warda builds transactions locally but must read the UTXO set to do it.\n" +
      "    Either:\n" +
      "      --rpc ws://127.0.0.1:18210   a kaspad you run. The JSON port is SEPARATE from\n" +
      "                                   the Borsh one and only listens if it was started\n" +
      "                                   with --utxoindex --rpclisten-json=<host:port>\n" +
      "                                   (note the '='; a space is rejected)\n" +
      "      --resolver <url>             a Kaspa Resolver, which picks a public node for\n" +
      "                                   you. No host is compiled in: naming one is a\n" +
      "                                   decision about who you trust to answer 'which\n" +
      "                                   node', and it belongs to you.",
  );
} else {
  try {
    const opened = await NodeClient.open({
      url: flag("rpc"),
      resolver: flag("resolver"),
      networkId: network,
      tolerate: true,
    });
    client = opened.client;
    if (!opened.health.usable) {
      problems.push(`The node cannot be believed:\n${formatHealth(opened.health)}`);
    } else {
      say(`node       ${opened.health.network}, synced, utxo index present`);
    }
  } catch (e) {
    problems.push(`Could not reach a node: ${(e as Error).message}`);
  }
}

// ---- 4. coin to fund it with ---------------------------------------------
if (client && walletAddress && problems.length === 0) {
  const utxos = await client.getUtxosByAddresses([walletAddress]);
  const have = utxos.reduce((a, u) => a + u.entry.value, 0n);
  const need = BigInt(budget) + 3_000_000n;
  say(`balance    ${have} sompi`);
  if (have < need) {
    problems.push(
      `The wallet holds ${have} sompi and this grant needs ${need} (budget + fee).\n` +
        `    Fund it from a testnet faucet, then run this again:\n` +
        `      ${walletAddress}\n` +
        `    Testnet coin has no market value. This tool does not name a faucet because\n` +
        `    faucets move, and a dead link here reads as a broken product.`,
    );
  }
}
client?.close();

if (problems.length > 0) {
  say();
  say(`Not ready — ${problems.length} thing${problems.length > 1 ? "s" : ""} to sort out:`);
  problems.forEach((p, i) => say(`\n  ${i + 1}. ${p}`));
  say();
  process.exit(1);
}

// ---- everything is in place; make the agent ------------------------------
say();
say("Generating the agent's key. It is independent of your wallet key: the agent");
say("holds this and nothing else, and losing control of it costs you at most the");
say("grant's limits.");

const keygen = spawnSync(
  process.execPath,
  ["--experimental-strip-types", new URL("new-key.ts", import.meta.url).pathname, "--label", "agent"],
  { encoding: "utf8" },
);
if (keygen.status !== 0) {
  console.error(keygen.stderr || "key generation failed");
  process.exit(1);
}
const agentSecret = keygen.stdout.trim();
const agentPublic = /([0-9a-f]{64})/.exec(keygen.stderr)?.[1];
if (!agentSecret || !agentPublic) {
  console.error("could not read the generated key; not proceeding");
  process.exit(1);
}

if (agentOut) {
  writeFileSync(agentOut, agentSecret + "\n", { mode: 0o600 });
  say(`Agent key written to ${agentOut} (0600).`);
}

say();
say("Creating the grant on chain…");
const genesis = spawnSync(
  process.execPath,
  [
    "--experimental-strip-types",
    new URL("genesis.ts", import.meta.url).pathname,
    "--agent", agentPublic,
    "--recipients", recipients!,
    "--budget", budget,
    "--max-per-spend", maxPerSpend,
    "--epoch-limit", epochLimit,
    "--out", out,
    "--prefix", prefix,
    ...(flag("rpc") ? ["--rpc", flag("rpc")!] : []),
    "--submit",
  ],
  { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], env: process.env },
);
// Passed through rather than swallowed: genesis says useful things here, and
// this is also where it prints the grant's address — which the manifest does
// not carry and which nothing downstream can derive without rebuilding the
// script hash.
if (genesis.stderr) process.stderr.write(genesis.stderr);
if (genesis.status !== 0) process.exit(genesis.status ?? 1);

const manifest = JSON.parse(readFileSync(out, "utf8"));

/**
 * Wait until the grant is actually there.
 *
 * Submitting is not accepting. This printed "Done. The agent can now spend"
 * the instant the node took the transaction, and the spend command it printed
 * alongside failed with "no UTXO at <address>" — which lists three plausible
 * causes, none of them "you were faster than the network".
 *
 * A quickstart that hands somebody a command that does not work yet has not
 * finished. So it waits, says it is waiting, and gives up loudly rather than
 * claiming success it cannot see.
 */
{
  const { client: watcher } = await NodeClient.open({
    url: flag("rpc"),
    resolver: flag("resolver"),
    networkId: network,
    tolerate: true,
  });
  try {
    const target = /grant address\s*:\s*(\S+)/.exec(genesis.stderr ?? "")?.[1];
    if (target) {
      say();
      process.stderr.write("Waiting for the network to accept it");
      let seen = false;
      for (let i = 0; i < 40 && !seen; i++) {
        const u = await watcher.getUtxosByAddresses([target]);
        if (u.length > 0) { seen = true; break; }
        process.stderr.write(".");
        await new Promise((r) => setTimeout(r, 1500));
      }
      say(seen ? " accepted." : "");
      if (!seen) {
        say();
        say(`The grant was submitted but has not appeared at ${target} after a minute.`);
        say("The manifest is written and nothing is lost — look again in a moment.");
        process.exit(1);
      }
    }
  } finally {
    watcher.close();
  }
}

say();
say("Done. The agent can now spend, within these limits and no others:");
say();
say(`  grant          ${out}`);
say(`  budget         ${budget} sompi, for the life of the grant`);
say(`  per payment    ${maxPerSpend} sompi`);
say(`  per epoch      ${epochLimit} sompi every ${manifest.epoch_length} blocks`);
say(`  may pay        only the addresses you listed. The set is fixed.`);
say();
say(`  agent secret   ${agentSecret}`);
say(`                 ^ give this to the agent. It is the whole authority, and the`);
say(`                   authority is bounded by the four lines above.`);
say();
/* The command below names a real payee rather than a placeholder. Someone who
   has just watched this succeed should be able to paste the next line, not go
   and look up how to turn an address into an x-only key. */
const firstPayee = membersFrom(recipients!)[0]!;

say("Spend from it:");
say();
say(`  WARDA_SK=${agentSecret} \\`);
say(`    node --experimental-strip-types tools/build-live-spend.ts ${out} \\`);
say(`      --recipients ${recipients} --to ${firstPayee} \\`);
say(`      --amount ${maxPerSpend} ${flag("rpc") ? `--rpc ${flag("rpc")} ` : ""}--submit`);
say();
