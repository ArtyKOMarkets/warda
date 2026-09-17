/**
 * Buy a grant with an asset you already hold.
 *
 *     WARDA_SK=$(cat wallet.key) node --experimental-strip-types tools/fund.ts \
 *       --required 300100000 --rate 0.05 --asset USDC --venue Kraken --wait
 *
 * Four steps, and this tool performs exactly one of them. You sell the asset
 * somewhere it has a market and you withdraw the KAS; neither of those happens
 * here, neither is visible from here, and both are printed as instructions
 * rather than reported as progress. Then it waits, and `warda grant` bounds
 * what arrived.
 *
 * ## The rate is yours, not ours
 *
 * `--rate` is required and never fetched. A price this tool went and got would
 * be a number Warda vouches for, and the receipt would say `attested` with our
 * name on it instead of the name of whoever actually traded. That is also the
 * first step toward being in a payment path, which `warda-network-registry.md`
 * already settled against for a service that is not even in one.
 *
 * ## One coin, not one balance
 *
 * `genesis` is funded by a single input, so the largest grant a wallet can
 * issue is bounded by its biggest coin rather than its balance. An exchange
 * that splits a withdrawal into two payments funds nothing, and nobody has any
 * reason to expect that — so this waits for a single sufficient coin, says so
 * when the total is there but the coin is not, and names the command that
 * fixes it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { borshRequested, openChain, type Chain } from "./chain.ts";
import {
  NodeClient,
  agentPublicKey,
  fromHex,
  pubkeyToAddress,
  resolveNode,
  resolverFrom,
} from "@warda_protocol/kaspa";
import { formatKas } from "@warda_protocol/core";
import { planExchangeFunding, quoteForSompi } from "@warda_protocol/router";
import { assertKeyNotPublished, resolveNetwork } from "./network.ts";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const { prefix, network, isMainnet } = resolveNetwork({
  prefix: flag("prefix"),
  network: flag("network", "testnet-10"),
});

const required = BigInt(flag("required") ?? "0");
if (required <= 0n) {
  console.error("--required <sompi> is the total this grant needs, including the genesis fee.");
  process.exit(2);
}

const rate = flag("rate");
if (!rate) {
  console.error(
    "--rate is required: what one KAS costs in your asset, as you actually traded it.\n\n" +
      "  warda fund --budget 3 --rate 0.05 --payees payees.txt\n\n" +
      "Warda does not fetch prices. A rate this tool went and got would be a number Warda\n" +
      "vouches for, and the receipt would carry our name where yours belongs.",
  );
  process.exit(2);
}

const asset = flag("asset", "USD")!;
const venue = flag("venue", "an exchange")!;

const keyFile = flag("key");
const secretHex = (keyFile ? readFileSync(keyFile, "utf8") : process.env.WARDA_SK ?? "").trim();
assertKeyNotPublished(secretHex, isMainnet);
if (!secretHex) {
  console.error(
    "no key. Pass --key <file> or set WARDA_SK.\n" +
      "  This is the FUNDER's ordinary key — the wallet that pays for the grant.\n" +
      "  It is not the agent's key: the agent gets its own, and that separation is the point.",
  );
  process.exit(2);
}

const address = pubkeyToAddress(agentPublicKey(fromHex(secretHex)), prefix);

const quote = quoteForSompi({
  sompi: required,
  rate: { perKas: rate, asset, source: "you, at the rate you traded", observedAt: Date.now() },
  expiresAt: Date.now() + 15 * 60_000,
});

const plan = planExchangeFunding({
  from: { asset, venue },
  /* The fee is already inside `required`; the plan only needs the total. */
  grant: { budgetSompi: required, feeSompi: 0n },
  quote,
  fundingAddress: address,
  expectPrefix: prefix,
});

console.error();
console.error(`to fund a grant needing ${formatKas(required)} KAS:`);
console.error();
for (const step of plan.steps) {
  const who =
    step.action === "off-protocol" ? "you" : step.action === "await-confirmation" ? "…" : "warda";
  console.error(`  [${who}] ${step.describe}`);
}
console.error();
console.error(`  send to      ${address}`);
console.error(`  needs        ${formatKas(required)} KAS, as ONE coin`);
console.error(`  costs about  ${quote.price.amount} ${quote.price.asset} at ${rate} per KAS`);
console.error(`  custody      ${plan.custody} — nothing here holds your key`);
console.error();

if (!has("wait")) {
  console.error("Run again with --wait once it is sent.");
  process.exit(0);
}

const url = flag("rpc") ?? process.env.WARDA_RPC_JSON;
let client: Chain;
if (borshRequested()) {
  ({ client } = await openChain({ borsh: true, networkId: network, tolerate: true }));
} else if (url) {
  client = await NodeClient.connect({ url });
} else if (resolverFrom({ resolver: flag("resolver") })) {
  const found = await resolveNode({ networkId: network });
  ({ client } = await NodeClient.open({ url: found.url, networkId: network }));
} else {
  console.error(
    `no node. Waiting means reading the UTXO set, which cannot be faked from a local file:\n` +
      `  --rpc wss://your-node:18210   or   --borsh   or   WARDA_RESOLVER=<a Kaspa Resolver>`,
  );
  process.exit(1);
}

try {
  process.stderr.write("waiting for a single coin large enough");
  for (let i = 0; i < 360; i++) {
    const utxos = (await client.getUtxosByAddresses([address])).filter((u) => !u.entry.covenantId);
    if (utxos.some((u) => u.entry.value >= required)) {
      console.error(" arrived.");

      /* The rail's half of the receipt, written where the grant's half will
         land beside it. Everything else this project publishes can be
         re-derived from the chain; the rate, the venue and whose word they are
         cannot be, which is exactly why they have to be written down at the
         moment they are still true. */
      try {
        if (!existsSync(".warda")) mkdirSync(".warda");
        writeFileSync(
          ".warda/funding.json",
          JSON.stringify(
            {
              _comment:
                "How the KAS for this grant was obtained. 'assumed' because nobody here " +
                "saw the sale or the withdrawal — see router/DESIGN.md.",
              fundedAt: new Date().toISOString(),
              network,
              fundingAddress: address,
              requiredSompi: String(required),
              asset,
              venue,
              ratePerKas: rate,
              rateSource: "the operator, at the rate they traded",
              costStated: `${quote.price.amount} ${quote.price.asset}`,
              custody: plan.custody,
              zone: "assumed",
              stepsNobodyHereSaw: plan.steps.filter((x) => x.action === "off-protocol").length,
            },
            null,
            2,
          ) + "\n",
        );
        console.error("  rail recorded in .warda/funding.json");
      } catch (e) {
        /* Never fatal. The coin has arrived and the grant is the point; a
           receipt that could not be written is worth one line, not an exit. */
        console.error(`  (could not write .warda/funding.json: ${(e as Error).message})`);
      }

      console.error();
      console.error("Now bound it:  warda grant --payees <file> --budget …");
      process.exit(0);
    }

    /* Enough in total but not in one coin is a DIFFERENT problem from not
       enough, and the difference is the whole of somebody's afternoon. */
    const total = utxos.reduce((a, u) => a + u.entry.value, 0n);
    if (total >= required) {
      console.error("");
      console.error(
        `that address holds ${formatKas(total)} KAS — enough in total, but not in one coin.\n` +
          `A grant is funded by a single input. Merge them first:\n\n` +
          `  warda wallet consolidate\n`,
      );
      process.exit(1);
    }
    process.stderr.write(".");
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.error("");
  console.error("nothing arrived. Nothing is lost — run again when it has.");
  process.exit(1);
} finally {
  client.close?.();
}
