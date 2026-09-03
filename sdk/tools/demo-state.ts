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
 *
 * ## What this used to get wrong
 *
 * It counted EVERY coin at the vendor as this grant's spending. That reads as
 * obviously true — the covenant permits exactly one payee — and it is false
 * for a reason outside the covenant entirely: a vendor address outlives the
 * grants that pay it. The demo vendor was also the address the hosted demo API
 * received at, so every CLI run, showcase and test buy landed in the same
 * place, and the page reported 2.43 KAS "paid by this grant" from a grant
 * whose per-payment cap made 1.2 KAS its ceiling.
 *
 * So the spending figure now comes from the MANIFEST, which `follow-grant.ts`
 * keeps current and which is the covenant's own accounting rather than an
 * inference from what happens to be lying at an address. What is at the vendor
 * is still reported, as context, labelled as what it is.
 */
import { readFileSync } from "node:fs";

import { NodeClient, formatHealth } from "../src/node.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const positional = process.argv.slice(2).filter((a, i, all) => {
  if (a.startsWith("--") || !a.endsWith(".json")) return false;
  return !all[i - 1]?.startsWith("--");
});
const cardPath = positional[0];
if (!cardPath) {
  console.error(
    "usage: demo-state.ts <demo-grant.json> [--manifest <grant.json>] [--resolver url] [--rpc url]",
  );
  process.exit(2);
}
const card = JSON.parse(readFileSync(cardPath, "utf8"));

/**
 * The manifest, if we were given one.
 *
 * Optional so a card alone still produces a snapshot, but strongly preferred:
 * without it the only spending figure available is inferred from the vendor's
 * balance, and that inference is exactly the one that was wrong.
 */
const manifest = flag("manifest") ? JSON.parse(readFileSync(flag("manifest")!, "utf8")) : null;

/**
 * The health check runs WITHOUT `grantAddress`, and that is the point.
 *
 * Passing it makes `open` probe the UTXO at the grant address for a covenant
 * id, to catch a node too old to report one. That probe cannot distinguish a
 * pre-covenant node from an address with nothing at it — and an address with
 * nothing at it is precisely what this tool exists to notice, because it is
 * what a spend produces.
 *
 * With the probe enabled, the first successful attack made this tool refuse to
 * run, citing the node. The refresh that depends on it then never reached the
 * branch that follows the grant, so the demo's one self-healing path was
 * unreachable by construction from the moment it was needed.
 *
 * The three checks that decide whether a reading can be believed — synced, utxo
 * index present, right network — do not need the grant to exist. Whether it
 * exists is the answer, not a precondition.
 */
const { client, health } = await NodeClient.open({
  url: flag("rpc"),
  resolver: flag("resolver"),
  networkId: flag("network") ?? process.env.WARDA_NETWORK ?? "testnet-10",
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

  // What is sitting at the vendor. NOT this grant's spending: the address may
  // receive from anything, and on this demo it did.
  const atVendor = vendorUtxos.reduce((a, u) => a + u.entry.value, 0n);

  // What this grant actually spent, per the covenant's own accounting.
  const spentTotal = manifest ? BigInt(manifest.spent_total ?? 0) : null;

  // Coins the vendor holds that this grant could not possibly have produced,
  // because they predate it. Cheap, and it is what makes a shared vendor
  // address visible on the page rather than a silent overstatement.
  const beforeGrant = manifest
    ? vendorUtxos.filter((u) => u.entry.blockDaaScore < BigInt(manifest.not_before ?? 0)).length
    : null;

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
        // The number that matters, and the only one this grant is the source
        // of truth for. Null when no manifest was supplied — better absent
        // than inferred, because the inference was the bug.
        spentByThisGrant: spentTotal === null ? null : kas(spentTotal),
        paidElsewhere: "0 KAS",
        // Context, not accounting. A vendor address can receive from any
        // number of grants; these figures describe the ADDRESS.
        vendorHolds: kas(atVendor),
        vendorCoins: vendorUtxos.length,
        vendorCoinsPredatingThisGrant: beforeGrant,
        grantStillAtPublishedAddress: stillThere,
        remainingAtPublishedAddress: stillThere ? kas(grantUtxos[0]!.entry.value) : null,
      },
      null,
      2,
    ) + "\n",
  );

  console.error(`vendor    : ${card.vendor}`);
  console.error(`  holds   : ${kas(atVendor)} across ${vendorUtxos.length} coin(s)`);
  if (spentTotal !== null) console.error(`  this grant spent: ${kas(spentTotal)} (per the manifest)`);
  if (beforeGrant) {
    console.error(
      `  NOTE    : ${beforeGrant} of those coins predate this grant. This vendor address is ` +
        `shared, so its balance is not this grant's spending.`,
    );
  }
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
