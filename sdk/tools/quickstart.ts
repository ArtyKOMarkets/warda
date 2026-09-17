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
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

import { pubkeyToAddress, type NetworkPrefix } from "../src/address.ts";
import { fromHex } from "../src/bytes.ts";
import { formatHealth } from "../src/node.ts";
import { borshRequested, openChain, type Chain } from "./chain.ts";
import { resolverFrom } from "../src/resolver.ts";
import { agentPublicKey } from "../src/sign.ts";

import { membersFrom } from "./members.ts";
import { assertKeyNotPublished, resolveNetwork, rpcFrom } from "./network.ts";
import { fileURLToPath } from "node:url";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/* Resolved and CHECKED together: a prefix and a network that disagree
   derive a well-formed address on the wrong chain, which holds nothing and
   is indistinguishable from a grant that was drained. See network.ts. */
const { prefix, network, isMainnet } = resolveNetwork({
  prefix: flag("prefix"),
  network: flag("network", "testnet-10"),
  action: "create a grant",
});
const budget = flag("budget", "1000000000")!;         // 10 KAS
const maxPerSpend = flag("max-per-spend", "100000000")!; // 0.1 KAS
const epochLimit = flag("epoch-limit", "500000000")!;    // 0.5 KAS
const recipients = flag("recipients");
/**
 * `--relay`: let this agent pay ITSELF, so it can reach an x402 `exact` vendor.
 *
 * x402's `exact` scheme requires the payer's input to be a bare P2PK unlocked
 * by one signature, which a covenant spend can never be. So a bounded payer
 * reaches such a vendor in two transactions — the grant pays a key the agent
 * holds, and an ordinary payment goes from there to the merchant. That key has
 * to be on the allowlist, or the covenant refuses to build the first half.
 *
 * The cost is real and is the allowlist, for that hop: once a coin sits at a
 * key the agent holds, the agent chooses where it goes. Budget, per-payment
 * cap, epoch limit and window all still bind, so the exposure is one invoice
 * rather than the grant — but the sentence "may pay only the addresses you
 * listed" stops being true, and this flag is the only way to make it stop.
 *
 * Which is why it is a flag, why it writes the agent's own address into the
 * allowlist file in plain sight, and why `x402/RELAY.md` spells out the trade.
 */
const relay = process.argv.includes("--relay");
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

/**
 * The same refusal for the manifest, and it has to be HERE rather than only in
 * genesis.
 *
 * genesis refuses too, and that refusal is the rule — but it is spawned at the
 * very end, after an agent key has been generated and written and after the
 * node has been interrogated. Leaving the check only there means a re-run in a
 * directory that already has a grant costs a stray key file on disk, and on a
 * machine with no node it never gets far enough to say the useful thing at
 * all: "you already have a grant here" is worth more than "you have no node"
 * when both are true. So it is checked first, before anything is read, asked
 * or created.
 */
if (existsSync(out) && !process.argv.includes("--force")) {
  console.error();
  console.error(`${out} already exists.`);
  console.error();
  console.error(
    `A grant's address is derived from the numbers in that file and nowhere else.\n` +
      `Overwriting it leaves the grant it describes funded and unnameable — not\n` +
      `revocable, not reclaimable. Nothing has been created yet.\n\n` +
      `  --out <another.json>   a new grant, beside the old one\n` +
      `  --force                replace it anyway\n`,
  );
  process.exit(2);
}

const problems: string[] = [];
const say = (s = "") => console.error(s);

say();
say("Warda quickstart");
say("────────────────");

// ---- 1. a key that funds it ----------------------------------------------
const secretHex = process.env.WARDA_SK;
if (secretHex) assertKeyNotPublished(secretHex, isMainnet);
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
const borsh = borshRequested();
let client: Chain | undefined;
if (!borsh && !rpcFrom(flag("rpc")) && !resolverFrom({ resolver: flag("resolver") })) {
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
      "                                   node', and it belongs to you.\n" +
      "      --borsh                      the public resolvers, over the encoding they\n" +
      "                                   actually serve. Needs no node of your own —\n" +
      "                                   and still asks that one a resolver picks the\n" +
      "                                   same four questions.",
  );
} else {
  try {
    const opened = await openChain({
      borsh,
      url: borsh ? undefined : rpcFrom(flag("rpc")),
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

/* This tool runs two of its siblings as child processes, and where it runs
   decides how. In the repo it is TypeScript beside TypeScript, so the child
   needs --experimental-strip-types. Bundled into the published CLI it is
   plain JS beside plain JS, where that flag is unnecessary and, from Node 24,
   deprecated. The extension of THIS module is the only honest tell — a build
   constant would be a second thing to keep in step with the truth. */
const sibling = (name: string): string[] => {
  const bundled = import.meta.url.endsWith(".js");
  const path = fileURLToPath(new URL(name + (bundled ? ".js" : ".ts"), import.meta.url));
  return bundled ? [path] : ["--experimental-strip-types", path];
};

const keygen = spawnSync(
  process.execPath,
  [...sibling("new-key"), "--label", "agent"],
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
  /**
   * Refuse to overwrite an agent key, for the same reason new-key.ts does and
   * with more at stake.
   *
   * A funder key that is replaced strands a coin. An AGENT key that is
   * replaced strands a funded grant: the covenant names the old agent, so the
   * new key cannot spend it, and the grant can then only be revoked or
   * reclaimed — never used for the thing it was created to do. Running
   * `warda grant` twice in one directory is an ordinary mistake and it should
   * not be able to do that silently.
   *
   * Checked BEFORE genesis, not after, so the refusal costs nothing: no
   * transaction has been built and no coin has moved.
   */
  if (existsSync(agentOut) && !process.argv.includes("--force")) {
    say();
    say(`${agentOut} already exists.`);
    say();
    say(
      `That file is an agent's whole authority. If a grant already names the key in it,\n` +
        `replacing it leaves that grant spendable by nobody — revocable and reclaimable,\n` +
        `but never usable. Nothing has been built or submitted yet, so nothing is lost.\n\n` +
        `  --agent-out <another.key>   a new agent, beside the old one\n` +
        `  --force                     replace it anyway\n`,
    );
    process.exit(2);
  }
  writeFileSync(agentOut, agentSecret + "\n", { mode: 0o600 });
  say(`Agent key written to ${agentOut} (0600).`);
}

/**
 * The relay key goes into the allowlist FILE, not just into this run.
 *
 * A grant commits to the Merkle root of its payees, and every tool that spends
 * rebuilds that list from the file to produce an inclusion proof. An extra
 * member known only to this process would commit a root nothing downstream can
 * reproduce — the grant would be spendable by nobody, which is the worst
 * failure this list has.
 *
 * So the file gains a line, and the line says what it is. Anyone reading the
 * allowlist later sees the agent's own address in it, which is the honest
 * record of what was enabled.
 */
if (relay) {
  const relayAddress = pubkeyToAddress(fromHex(agentPublic), prefix);
  /* A FILE, or nothing. An inline list would work for this one run and strand
     the grant afterwards: the relay key would be in the committed root and in
     nobody's records, so the next spend rebuilds the list from what the caller
     kept, gets a different root, and the covenant refuses a proof of membership
     in a set it never committed to. There is no warning that fixes that, so it
     is refused here instead. */
  if (!existsSync(recipients!)) {
    console.error(
      `--relay needs --recipients to be a FILE, and ${recipients} is an inline list.\n\n` +
        `The relay key becomes part of the allowlist the grant commits to, and every spend\n` +
        `rebuilds that list to prove a payee is in it. Written only into this command line,\n` +
        `it would be committed and then lost — leaving a grant that can be revoked and\n` +
        `never spent.\n\n` +
        `  printf '%s\\n' ${recipients} > payees.txt\n` +
        `  ... --recipients payees.txt --relay\n\n` +
        `Nothing has been created.`,
    );
    process.exit(1);
  }
  try {
    appendFileSync(recipients!, `\n# --relay: this agent may pay itself, to reach x402 exact vendors\n${relayAddress}\n`);
  } catch (e) {
    console.error(
      `--relay could not write to ${recipients}: ${(e as Error).message}\n\n` +
        `The allowlist file has to carry the relay key, because every spend rebuilds the\n` +
        `member list from it to prove inclusion. Nothing has been created.`,
    );
    process.exit(1);
  }
  say();
  say(`--relay  the agent's own address is now on the allowlist:`);
  say(`         ${relayAddress}`);
  say(`         written into ${recipients}`);
  say(`         This agent can move up to its per-payment cap to a key it holds, and`);
  say(`         then send it anywhere. The budget, cap, epoch limit and window still`);
  say(`         bind; the allowlist does not, for that hop. See x402/RELAY.md.`);
}

say();
say("Creating the grant on chain…");
const genesis = spawnSync(
  process.execPath,
  [
    ...sibling("genesis"),
    "--agent", agentPublic,
    "--recipients", recipients!,
    "--budget", budget,
    "--max-per-spend", maxPerSpend,
    "--epoch-limit", epochLimit,
    "--out", out,
    "--prefix", prefix,
    /* The emergency stop, separable from the funder. Defaulting it to the
       principal is right for a first grant — one key to keep, and an
       emergency stop you cannot lose separately from the money — but it
       means a compromised funder key loses the stop at the same moment it is
       most needed. Anything left running unattended wants its own. */
    ...(flag("revocation") ? ["--revocation", flag("revocation")!] : []),
    ...(rpcFrom(flag("rpc")) ? ["--rpc", rpcFrom(flag("rpc"))!] : []),
    /* One --force, one meaning: replace what is already there. Without this,
       genesis's own refusal to overwrite a manifest could not be overridden
       from the verb people actually type, and the only way past it would have
       been to run genesis by hand — which is the opposite of what an escape
       hatch is for. */
    ...(process.argv.includes("--force") ? ["--force"] : []),
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
  const { client: watcher } = await openChain({
    borsh,
    url: borsh ? undefined : rpcFrom(flag("rpc")),
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
/**
 * Two forms, because there are two ways to be standing here and the wrong one
 * is unusable.
 *
 * This printed `node --experimental-strip-types tools/build-live-spend.ts`
 * unconditionally. That path resolves only with `sdk/` as the working
 * directory — not from the repository root, and not at all for the majority of
 * people who now arrive through `npm install -g @warda_protocol/cli` and have
 * no clone. The last thing this tool prints is the line most likely to be
 * pasted, and for a CLI user it named a file that does not exist on their
 * disk.
 *
 * `--via` says which. The CLI passes it; a direct invocation does not.
 */
if (flag("via") === "warda") {
  say(`  warda pay <url>`);
  say(`                 ^ any endpoint that answers 402. It settles out of this grant,`);
  say(`                   and needs no flags — the config below remembers all of them.`);
  say();
  say(`  There is no CLI verb for a raw payment to a bare address; that is a repository`);
  say(`  tool. From a clone, with the agent key above:`);
  say();
  say(`    node --experimental-strip-types sdk/tools/build-live-spend.ts ${out} \\`);
  say(`      --recipients ${recipients} --to ${firstPayee} \\`);
  say(`      --amount ${maxPerSpend} ${rpcFrom(flag("rpc")) ? `--rpc ${rpcFrom(flag("rpc"))} ` : ""}--submit`);
} else {
  say(`  WARDA_SK=${agentSecret} \\`);
  say(`    node --experimental-strip-types sdk/tools/build-live-spend.ts ${out} \\`);
  say(`      --recipients ${recipients} --to ${firstPayee} \\`);
  say(`      --amount ${maxPerSpend} ${rpcFrom(flag("rpc")) ? `--rpc ${rpcFrom(flag("rpc"))} ` : ""}--submit`);
}
say();
