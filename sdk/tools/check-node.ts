/**
 * Ask a node whether it can be believed, before you build anything against it.
 *
 *   node --experimental-strip-types tools/check-node.ts
 *   node --experimental-strip-types tools/check-node.ts --grant kaspatest:p...
 *   WARDA_RESOLVER=https://... node --experimental-strip-types tools/check-node.ts
 *
 * Every check this runs fails by returning a plausible answer rather than an
 * error, and the plausible answer always reads as a problem with the grant
 * rather than with the node. A node without a UTXO index reports your grant as
 * spent. A node on the wrong network reports it as never having existed. A
 * node from before covenants hands you an entry with the binding missing, and
 * the spend you build from it is refused for reasons that point at the
 * covenant. Two round trips buy you the difference.
 *
 * `--grant` is worth supplying. Covenant-awareness is the one check that needs
 * an address holding a covenant, and it is the only one whose failure produces
 * a signed transaction rather than an error message.
 */

import { NodeClient, formatHealth } from "../src/node.ts";
import { resolverFrom } from "../src/resolver.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const options = {
  url: flag("rpc"),
  urls: flag("rpcs")?.split(",").map((u) => u.trim()).filter(Boolean),
  resolver: flag("resolver"),
  networkId: flag("network") ?? process.env.WARDA_NETWORK ?? "testnet-10",
  grantAddress: flag("grant"),
  // Report rather than throw: the whole job of this tool is to print the
  // findings, and a thrown error would hide the checks that passed.
  tolerate: true,
};

const via = resolverFrom(options);
if (via && !options.url && !options.urls?.length && !process.env.WARDA_RPC_JSON) {
  console.log(`asking ${via} for a ${options.networkId} node…\n`);
}

let client: NodeClient;
let health;
try {
  ({ client, health } = await NodeClient.open(options));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

console.log(formatHealth(health));
client.close();

if (!health.usable) {
  console.error(`\nThis node would give you wrong answers rather than errors. Find another.`);
  process.exit(1);
}
if (!options.grantAddress) {
  console.log(
    `\nUsable — but covenant support was not checked. Re-run with --grant <address>\n` +
      `of a grant you know exists: it is the only check whose failure produces a\n` +
      `signed transaction instead of an error.`,
  );
} else {
  console.log(`\nUsable.`);
}
