/**
 * What has actually happened to the published-key grant.
 *
 *   node --experimental-strip-types tools/demo-state.ts \
 *     ../site/src/demo-grant.json --resolver "$WARDA_RESOLVER" \
 *     > ../site/src/demo-state.json
 *
 * ## Why this does not follow the grant
 *
 * A grant's address moves on every spend, and Kaspa's node RPC answers "what
 * is unspent at this address", never "what spent this outpoint" — so following
 * one means tailing the mempool continuously and never missing a window. That
 * is what `GrantWatcher` is for, and it is the right tool when you must know
 * the grant's current position.
 *
 * This page does not need to know it.
 *
 * The VENDOR's address never moves. It is an ordinary P2PK address, and the
 * covenant permits payment to nobody else — so every coin that has ever left
 * this grant is sitting at exactly one place, in plain sight, and counting it
 * needs no history and no persistence. One query answers the only question the
 * page actually asks:
 *
 *   how much has escaped to somewhere we do not control?
 *
 * The answer is structurally zero, and this measures the other side of it: how
 * much went to the one address that was ever possible.
 *
 * That is a smaller claim than "here is the grant's live state", and it is the
 * one worth making, because it is true between polls as well as during them.
 */
import { readFileSync } from "node:fs";

import { NodeClient, formatHealth } from "../src/node.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const cardPath = process.argv.slice(2).find((a) => !a.startsWith("--") && a.endsWith(".json"));
if (!cardPath) {
  console.error("usage: demo-state.ts <demo-grant.json> [--resolver url] [--rpc url]");
  process.exit(2);
}
const card = JSON.parse(readFileSync(cardPath, "utf8"));

const { client, health } = await NodeClient.open({
  url: flag("rpc"),
  resolver: flag("resolver"),
  networkId: flag("network") ?? process.env.WARDA_NETWORK ?? "testnet-10",
  grantAddress: card.address,
  tolerate: true,
});
if (!health.usable) {
  console.error(`refusing to publish a snapshot read from this node:\n\n${formatHealth(health)}`);
  client.close();
  process.exit(1);
}

const kas = (v: bigint) => {
  const whole = v / 100_000_000n, frac = v % 100_000_000n;
  return frac === 0n
    ? `${whole} KAS`
    : `${whole}.${frac.toString().padStart(8, "0").replace(/0+$/, "")} KAS`;
};

try {
  const [vendorUtxos, grantUtxos] = await Promise.all([
    client.getUtxosByAddresses([card.vendor]),
    client.getUtxosByAddresses([card.address]),
  ]);

  // Every coin the grant has ever released is here, because there is nowhere
  // else it could be. Each UTXO is one payment: the covenant pays exactly one
  // recipient per spend.
  const received = vendorUtxos.reduce((a, u) => a + u.entry.value, 0n);

  /**
   * Whether the grant is still at the address the card names.
   *
   * A spend MOVES it, so an empty address here is the demo working rather than
   * a problem — but it does mean the card is stale, and saying so is better
   * than showing an address with nothing at it and letting a visitor draw
   * their own conclusion.
   */
  const stillThere = grantUtxos.length === 1;

  process.stdout.write(
    JSON.stringify(
      {
        _comment:
          "A snapshot, not a live feed. Written by tools/demo-state.ts, which counts what has " +
          "reached the vendor — the one address this grant was ever able to pay. The claim that " +
          "nothing reached anywhere else is not measured here; it is enforced by the covenant.",
        checkedAt: new Date().toISOString(),
        network: health.network,
        // Which grant this describes. Not decoration: the page and the build
        // both refuse a snapshot that does not name the grant on the card, so
        // a reading left over from a previous demo cannot be rendered beside
        // a newer card's address as though it belonged to it.
        grant: card.address,
        vendor: card.vendor,
        payments: vendorUtxos.length,
        paidToVendor: kas(received),
        paidElsewhere: "0 KAS",
        grantStillAtPublishedAddress: stillThere,
        remainingAtPublishedAddress: stillThere ? kas(grantUtxos[0]!.entry.value) : null,
      },
      null,
      2,
    ) + "\n",
  );

  console.error(`vendor    : ${card.vendor}`);
  console.error(`  received: ${kas(received)} across ${vendorUtxos.length} payment(s)`);
  console.error(`grant     : ${card.address}`);
  console.error(
    stillThere
      ? `  holds   : ${kas(grantUtxos[0]!.entry.value)} — the card is current`
      : `  empty   : the grant has MOVED. Re-run demo-card.ts, or the page names an address ` +
        `nothing is at.`,
  );
} finally {
  client.close();
}
