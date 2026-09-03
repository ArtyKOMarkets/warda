/**
 * Take one reading of the network and write it down.
 *
 *   node --experimental-strip-types tools/read.ts --resolver "$WARDA_RESOLVER"
 *   node --experimental-strip-types tools/read.ts --rpc ws://127.0.0.1:18210
 *
 * This is the half of Agent #001 that runs on a schedule. It is deliberately
 * the most boring program in the repository: connect, ask six questions, write
 * a file, exit. Nothing it does depends on the previous run, so a missed slot
 * costs one data point and never leaves state to repair.
 *
 * It refuses an unsynced node. A digest built from one is not slightly wrong,
 * it is wrong in a way that reads as the network having slowed down — and the
 * whole argument for publishing these numbers is that nobody has to take the
 * agent's word for them.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { NodeClient, formatHealth } from "../../sdk/src/node.ts";
import { encodeReading, readChain } from "../src/chain.ts";
import { readingFilename } from "../src/readings.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const dir = flag("dir", fileURLToPath(new URL("../readings", import.meta.url)))!;

const { client, health } = await NodeClient.open({
  url: flag("rpc"),
  resolver: flag("resolver"),
  networkId: flag("network") ?? process.env.WARDA_NETWORK ?? "testnet-10",
  tolerate: true,
});

try {
  if (!health.checks.synced.ok && !has("allow-unsynced")) {
    console.error(
      `refusing to record a reading from a node that is behind:\n\n${formatHealth(health)}\n\n` +
        `Its counters are real but stale, and the difference between two stale ` +
        `readings is not the network's activity, it is the node's catch-up rate.\n` +
        `Pass --allow-unsynced if you are recording deliberately.`,
    );
    process.exit(1);
  }

  const reading = await readChain(client, health);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, readingFilename(reading));
  writeFileSync(path, encodeReading(reading));

  console.error(`${reading.network} @ DAA ${reading.daaScore}`);
  console.error(`  wrote ${path}`);
  for (const m of reading.missing) {
    console.error(`  not read: ${m.method} — ${m.why.split("\n")[0]}`);
  }
} finally {
  client.close();
}
