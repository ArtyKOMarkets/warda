/**
 * Does the WASM build you installed agree with this SDK about a Warda spend?
 *
 *   node --experimental-strip-types tools/agree.ts <tx.json>...
 *
 * Run with no arguments it checks the three reference transactions shipped in
 * `@warda_protocol/kaspa` — a spend, a genesis, and a delegation — which is
 * the interesting set because they exercise one bound output, one bound output
 * beside an ordinary one, and two bound outputs in the same transaction.
 *
 * ## Why this is a tool and not a test
 *
 * The package's tests run against object literals and never load a binary, on
 * purpose: a test that pulls a multi-megabyte wasm module is a test nobody
 * runs, and it would pin the behaviour of whatever build happened to be
 * installed in CI rather than the behaviour of the build in YOUR node_modules.
 * That is the version of this question that matters, and only you can ask it.
 *
 * ## What a disagreement means
 *
 * Not "the transaction is malformed". The covenant binding is part of the
 * sighash, so any difference in serialization — a moved field, a changed
 * encoding, a build from a revision where the struct grew — produces a
 * different transaction id, which means the signature does not cover what
 * would have been sent. Every `submitTransaction` in this package runs exactly
 * this comparison before it broadcasts, so a disagreement here is a refusal
 * later rather than a loss. This tool just lets you see it before you fund
 * anything.
 */

import { readFileSync } from "node:fs";
import { fromWire, toHex, transactionId, type Transaction } from "@warda_protocol/kaspa";
import { encodeForSubmit, loadWasm, supportsCovenants } from "../src/index.ts";

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const { module: wasm, name } = await loadWasm();
console.log(`build      ${name}`);
console.log(`covenants  ${supportsCovenants(wasm) ? "yes" : "NO — this build must not sign a Warda spend"}\n`);
if (!supportsCovenants(wasm)) process.exit(1);

/**
 * The transactions to check, which have to be built rather than loaded.
 *
 * `golden-spend.json` and its siblings hold the PARAMS of the reference
 * transactions, not their wire form — the wire form is what the rules produce
 * from those params, and shipping it as a file would be a second copy of the
 * answer. So this tool takes transactions somebody built, and says how to
 * build the reference ones rather than rebuilding them here: duplicating the
 * spend construction to test the encoder would put the thing under test on
 * both sides of the comparison.
 */
if (!files.length) {
  console.log(
    "Pass one or more transactions in wire form.\n\n" +
      "The three worth checking are the reference ones — a spend, a genesis, and a\n" +
      "delegation, which between them cover one bound output, one beside an ordinary\n" +
      "output, and two in the same transaction. From a checkout of the protocol repo:\n\n" +
      "  cd sdk\n" +
      "  node --experimental-strip-types tools/build-spend.ts --golden   > /tmp/spend.json\n" +
      "  node --experimental-strip-types tools/build-spend.ts --genesis  > /tmp/genesis.json\n" +
      "  node --experimental-strip-types tools/build-spend.ts --delegate > /tmp/delegate.json\n\n" +
      "  node --experimental-strip-types ../borsh/tools/agree.ts /tmp/*.json\n\n" +
      "Any transaction of your own works too, and one that carries a covenant is the\n" +
      "only kind that tests anything here.",
  );
  process.exit(2);
}

const cases = files.map((f) => ({
  label: f.slice(f.lastIndexOf("/") + 1),
  tx: fromWire(JSON.parse(readFileSync(f, "utf8"))) as Transaction,
}));

let disagreed = 0;
for (const { label, tx } of cases) {
  const ours = toHex(transactionId(tx));
  const bound = tx.outputs.filter((o) => o.covenant).length;
  let theirs: string;
  try {
    theirs = String((encodeForSubmit(tx, wasm as never, name) as { id: unknown }).id);
  } catch (e) {
    console.log(`${label}\n  REFUSED  ${(e as Error).message.split("\n")[0]}\n`);
    disagreed++;
    continue;
  }
  const ok = ours === theirs;
  if (!ok) disagreed++;
  console.log(`${label}`);
  console.log(`  outputs  ${tx.outputs.length}, ${bound} carrying a covenant`);
  console.log(`  warda    ${ours}`);
  console.log(`  wasm     ${theirs}`);
  console.log(`  ${ok ? "agree" : "DISAGREE — this build must not sign a Warda spend"}\n`);
}

if (disagreed) {
  console.error(
    `${disagreed} of ${cases.length} disagreed.\n\n` +
      `The covenant binding is part of the sighash, so a difference here means the ` +
      `signature would not cover what was sent. Nothing in this package will broadcast ` +
      `such a transaction — it checks the same thing on every submit — but this build ` +
      `cannot be used to spend a grant.`,
  );
  process.exit(1);
}
console.log(`All ${cases.length} agree byte for byte.`);
