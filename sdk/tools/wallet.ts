/**
 * What an ordinary key holds, and what it can therefore fund.
 *
 *     WARDA_SK=$(cat wallet.key) node --experimental-strip-types tools/wallet.ts --rpc wss://…
 *     node --experimental-strip-types tools/wallet.ts --key wallet.key --json
 *
 * ## Why a wallet view exists in a project that argues against wallets
 *
 * A grant is not a wallet and this file does not make it one. But two things a
 * developer has to do here happen at a PLAIN key, before any covenant exists
 * and after one ends, and both were unserved:
 *
 *   - **Funding.** `genesis.ts` takes ONE input, so the largest grant you can
 *     create is bounded by the largest single coin at your key — not by the
 *     total. Someone who used a faucet three times has three coins and gets
 *     "the largest coin is X; a budget of Y needs Z", which reads like a
 *     balance problem and is a shape problem. The number that decides is
 *     `largest`, and nothing printed it.
 *   - **Earnings.** An agent that SELLS is paid to an ordinary address. Agent
 *     #001's digest income lands at a plain key with no bounds on it at all,
 *     which is the honest position: money coming in has no covenant, because
 *     nobody agreed to one. It still has to be countable before it can be put
 *     back inside a grant.
 *
 * So: spending authority is a grant, and this is the other side of the wall.
 * Nothing here is bounded by anything, and it says so.
 *
 * ## It holds nothing
 *
 * The key is read from the file or the environment, used to derive an address,
 * and — in `consolidate.ts` — to sign. It is not stored, not sent anywhere and
 * not held between runs. There is no account here.
 */
import { readFileSync } from "node:fs";

import {
  NodeClient,
  agentPublicKey,
  fromHex,
  pubkeyToAddress,
  resolveNode,
  resolverFrom,

  type NetworkPrefix,
} from "@warda_protocol/kaspa";
import { formatKas } from "@warda_protocol/core";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;
const network = flag("network", "testnet-10")!;

const keyFile = flag("key");
/* Read through a named helper rather than inline, so a path that is wrong —
   almost always because the command was run from a subdirectory — reports the
   path it tried and where it tried it from, instead of an ENOENT stack trace
   with the relative path in it and no cwd to make sense of it. */
const readKey = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      console.error(
        `no key file at ${path}\n` +
          `  looked in ${process.cwd()}\n` +
          `  Paths are relative to where you ran this. If you meant a file in the repo\n` +
          `  root, run it from there — or give an absolute path.`,
      );
      process.exit(2);
    }
    throw e;
  }
};

const secretHex = (keyFile ? readKey(keyFile) : process.env.WARDA_SK ?? "").trim();
if (!secretHex) {
  console.error(
    "no key. Pass --key <file> or set WARDA_SK.\n" +
      "  This is an ordinary key — a funder, or wherever an agent's earnings land.\n" +
      "  It is not a grant, and nothing about it is bounded.",
  );
  process.exit(2);
}

const address = pubkeyToAddress(agentPublicKey(fromHex(secretHex)), prefix);

/**
 * The fee `genesis.ts` reserves, so `fundable` is a number you can pass
 * straight to --budget rather than one you have to subtract from yourself.
 * Kept in step with genesis's own default; if that moves, this is wrong in the
 * safe direction (it under-reports what you can fund) rather than the
 * direction that fails at submit.
 */
const GENESIS_FEE = 1_000_000n;

/** Coinbase outputs are unspendable until they mature. Kaspa's window is 100. */
const COINBASE_MATURITY = 100n;

const url = flag("rpc") ?? process.env.WARDA_RPC_JSON;
let client: NodeClient;
if (url) {
  client = await NodeClient.connect({ url });
} else if (resolverFrom({ resolver: flag("resolver") })) {
  const found = await resolveNode({ networkId: network });
  ({ client } = await NodeClient.open({ url: found.url, networkId: network }));
} else {
  console.error(
    `no node. This reads the UTXO set, which cannot be faked from a local file:\n` +
      `  --rpc wss://your-node:18210   or   WARDA_RESOLVER=<a Kaspa Resolver>\n\n` +
      `address ${address}`,
  );
  process.exit(1);
}

try {
  const [dag, utxos] = await Promise.all([
    client.getBlockDagInfo(),
    client.getUtxosByAddresses([address]),
  ]);

  /* A covenant output at this address would not be spendable by an ordinary
     signature, and counting it here would inflate a balance that is not
     yours to move. There should never be one — but "should never" is how the
     other miscounts in this project started. */
  const plain = utxos.filter((u) => !u.entry.covenantId);
  const mature = plain.filter(
    (u) => !u.entry.isCoinbase || dag.virtualDaaScore - u.entry.blockDaaScore >= COINBASE_MATURITY,
  );
  const immature = plain.length - mature.length;

  const values = mature.map((u) => u.entry.value).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));
  const total = values.reduce((a, b) => a + b, 0n);
  const largest = values[0] ?? 0n;
  const fundable = largest > GENESIS_FEE ? largest - GENESIS_FEE : 0n;

  if (has("json")) {
    console.log(
      JSON.stringify(
        {
          address,
          network,
          checkedAt: new Date().toISOString(),
          virtualDaaScore: dag.virtualDaaScore.toString(),
          coins: mature.length,
          immatureCoinbaseCoins: immature,
          totalSompi: total.toString(),
          largestSompi: largest.toString(),
          fundableSompi: fundable.toString(),
          note:
            "largest, not total: genesis takes ONE input, so the biggest grant this key " +
            "can create is bounded by its biggest single coin.",
        },
        null,
        2,
      ),
    );
  } else {
    const line = (k: string, v: string) => console.log(`  ${k.padEnd(12)}${v}`);
    console.log(`\nwallet\n`);
    line("address", address);
    line("holds", `${formatKas(total)} KAS across ${mature.length} coin${mature.length === 1 ? "" : "s"}`);
    line("largest", `${formatKas(largest)} KAS`);
    console.log();
    if (immature > 0) {
      line(
        "immature",
        `${immature} coinbase coin${immature === 1 ? "" : "s"} not yet spendable ` +
          `(${COINBASE_MATURITY} blocks). Not counted above.`,
      );
      console.log();
    }
    if (mature.length === 0) {
      console.log(`  Nothing here yet. Fund the address above from a testnet-10 faucet.\n`);
    } else if (mature.length === 1) {
      console.log(
        `  You can fund a grant of up to ${formatKas(fundable)} KAS.\n` +
          `  One coin, so nothing to consolidate.\n`,
      );
    } else {
      console.log(
        `  You can fund a grant of up to ${formatKas(fundable)} KAS — the LARGEST coin\n` +
          `  less the fee, not the total. Genesis takes one input, so ${mature.length} coins of\n` +
          `  ${formatKas(total)} KAS still only reach ${formatKas(fundable)} KAS.\n\n` +
          `  To use all of it:  warda wallet consolidate\n`,
      );
    }
    console.log(
      `  Nothing about this key is bounded. It is an ordinary wallet — the funder\n` +
        `  before a grant exists, or where an agent's earnings arrive afterwards.\n` +
        `  The limits live in the grant, and the grant is elsewhere.\n`,
    );
  }
} finally {
  client.close();
}
