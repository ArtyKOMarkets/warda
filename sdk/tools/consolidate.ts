/**
 * Many coins at one ordinary key, into one.
 *
 *     WARDA_SK=$(cat wallet.key) node --experimental-strip-types tools/consolidate.ts --rpc wss://…
 *     …                                                                              --submit
 *
 * ## Why this had to exist
 *
 * `genesis.ts` takes ONE input, so the largest grant a key can create is
 * bounded by its largest single coin. It says so, and it says what to do:
 *
 *     the largest coin at kaspatest:… is 300000000 sompi; a budget of
 *     1000000000 plus 1000000 fee needs 1001000000.
 *     Genesis takes ONE input, so consolidate or lower --budget.
 *
 * There was nothing in this repository that consolidated. Someone who used a
 * faucet three times reached an instruction with no implementation behind it,
 * which is worse than no instruction: it reads like the user's mistake.
 *
 * ## Nothing here is bounded, and that is correct
 *
 * This spends an ORDINARY key — a funder before any grant exists, or the
 * address an agent's earnings arrive at. There is no covenant on it, no cap,
 * no allowlist, and this tool applies none: a limit enforced by the program
 * that builds the transaction is not a limit, and pretending otherwise here
 * would teach exactly the habit the rest of this project exists to break.
 *
 * If you want the money bounded, put it in a grant. That is what the output of
 * this is for.
 *
 * ## The fee, and why it is measured rather than trusted
 *
 * This SDK does not compute mass. Kaspa's minimum relay fee is proportional to
 * it, and getting that wrong is how `build-exit.ts` shipped a default that the
 * node refused — a real revoke at 1,437,200 sompi for a mass of 14,372, against
 * a hardcoded 1,000,000.
 *
 * So the estimate below is empirical and the node is the authority: on a
 * rejection that names a required fee, this rebuilds at that figure and
 * submits once more, and prints what it learned. An estimate that has to be
 * right is a bug waiting; an estimate that gets corrected is a starting point.
 *
 * Consolidation is the cheap direction under KIP-9 — storage mass punishes
 * splitting one coin into many, not merging many into one — so compute mass
 * dominates here, and compute mass is roughly linear in the input count.
 */
import { readFileSync } from "node:fs";

import {
  NodeClient,
  ScriptBuilder,
  SUBNETWORK_ID_NATIVE,
  agentPublicKey,
  fromHex,
  pubkeyToAddress,
  resolveNode,
  resolverFrom,
  sighash,
  signDigest,

  toWireMulti,
  type NetworkPrefix,
  type Transaction,
  type UtxoEntry,
} from "@warda_protocol/kaspa";
import { formatKas, kas } from "@warda_protocol/core";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : d;
};
const has = (n: string) => process.argv.includes(`--${n}`);

const prefix = (flag("prefix", "kaspatest") as NetworkPrefix)!;
const network = flag("network", "testnet-10")!;

/**
 * How many inputs to take at once.
 *
 * Not unbounded: a transaction has a size limit, every input adds mass, and a
 * consolidation that is refused for being too large teaches nothing. Fifty
 * coins in one pass, run it again for the rest — the tool says when there are
 * more, rather than silently doing part of the job.
 */
const MAX_INPUTS = Number(flag("max-inputs", "50"));
const COINBASE_MATURITY = 100n;
const COMPUTE_BUDGET = 12;

/* Empirical, from the one measurement this project has: the node required
   1,437,200 sompi for a transaction of mass 14,372 — a hundred sompi per unit
   of mass. Kaspa's compute mass counts each byte once, each script-pubkey byte
   ten times, and each signature operation a thousand times, so an ordinary
   P2PK input (about 110 bytes, one sigop) is roughly 1,110 and the single
   output roughly 400. The node corrects all of this on rejection; these
   numbers only have to be close enough that the first attempt usually lands. */
const SOMPI_PER_MASS = 100n;
const MASS_PER_INPUT = 1_110n;
const MASS_BASE = 450n;
const estimateFee = (inputs: number) =>
  (MASS_BASE + MASS_PER_INPUT * BigInt(inputs)) * SOMPI_PER_MASS;

const keyFile = flag("key");
const secretHex = (keyFile ? readFileSync(keyFile, "utf8") : process.env.WARDA_SK ?? "").trim();
if (!secretHex) {
  console.error("no key. Pass --key <file> or set WARDA_SK.");
  process.exit(2);
}
const secret = fromHex(secretHex);
const address = pubkeyToAddress(agentPublicKey(secret), prefix);

const url = flag("rpc") ?? process.env.WARDA_RPC_JSON;
let client: NodeClient;
if (url) {
  client = await NodeClient.connect({ url });
} else if (resolverFrom({ resolver: flag("resolver") })) {
  const found = await resolveNode({ networkId: network });
  ({ client } = await NodeClient.open({ url: found.url, networkId: network }));
} else {
  console.error("no node. --rpc wss://your-node:18210, or set WARDA_RESOLVER.");
  process.exit(1);
}

try {
  const [dag, utxos] = await Promise.all([
    client.getBlockDagInfo(),
    client.getUtxosByAddresses([address]),
  ]);

  const spendable = utxos
    .filter((u) => !u.entry.covenantId)
    .filter(
      (u) => !u.entry.isCoinbase || dag.virtualDaaScore - u.entry.blockDaaScore >= COINBASE_MATURITY,
    )
    .sort((a, b) => (b.entry.value > a.entry.value ? 1 : b.entry.value < a.entry.value ? -1 : 0));

  console.error(`\nwallet    ${address}`);
  console.error(`coins     ${spendable.length} spendable`);

  if (spendable.length < 2) {
    console.error(
      `\nNothing to do — consolidation needs at least two coins.` +
        (spendable.length === 1
          ? `\nThe one coin here holds ${formatKas(spendable[0]!.entry.value)} KAS.\n`
          : `\nFund ${address} from a testnet-10 faucet first.\n`),
    );
    process.exit(0);
  }

  const chosen = spendable.slice(0, MAX_INPUTS);
  const left = spendable.length - chosen.length;
  const gross = chosen.reduce((a, u) => a + u.entry.value, 0n);

  /* All inputs are at ONE address, so the output script is the entry's own —
     constructed from nothing, derived from what the chain already holds. A
     consolidation that built its own destination script would be one typo away
     from sending the whole balance somewhere unspendable. */
  const scriptPublicKey = chosen[0]!.entry.scriptPublicKey;

  const build = (fee: bigint): { tx: Transaction; entries: UtxoEntry[]; net: bigint } => {
    const net = gross - fee;
    if (net <= 0n) {
      throw new Error(
        `these ${chosen.length} coins hold ${formatKas(gross)} KAS and the fee is ` +
          `${formatKas(fee)} KAS. There is nothing left to consolidate.`,
      );
    }
    const entries: UtxoEntry[] = chosen.map((u) => ({
      value: u.entry.value,
      scriptPublicKey: u.entry.scriptPublicKey,
      blockDaaScore: u.entry.blockDaaScore,
      isCoinbase: u.entry.isCoinbase,
    }));
    const tx: Transaction = {
      version: 1,
      inputs: chosen.map((u) => ({
        previousOutpoint: {
          transactionId: u.outpoint.transactionId,
          index: u.outpoint.index,
        },
        signatureScript: new Uint8Array(0),
        sequence: 0n,
        computeBudget: COMPUTE_BUDGET,
      })),
      outputs: [{ value: net, scriptPublicKey }],
      lockTime: 0n,
      subnetworkId: SUBNETWORK_ID_NATIVE,
      gas: 0n,
      payload: new Uint8Array(0),
    };
    /* Every input's digest commits to its OWN entry's script and value, so
       each is computed and signed separately. Signing input 0's digest for all
       of them would produce a transaction that looks complete and is rejected
       by the script engine on input 1. */
    const signed: Transaction = {
      ...tx,
      inputs: tx.inputs.map((input, i) => ({
        ...input,
        signatureScript: new ScriptBuilder()
          .addData(signDigest(sighash(tx, i, entries[i]!), secret))
          .drain(),
      })),
    };
    return { tx: signed, entries, net };
  };

  let fee = flag("fee") ? kas(flag("fee")!) : estimateFee(chosen.length);
  let built = build(fee);

  console.error(`merging   ${chosen.length} coins, ${formatKas(gross)} KAS`);
  console.error(`fee       ${formatKas(fee)} KAS${flag("fee") ? "" : " (estimated)"}`);
  console.error(`into      ${formatKas(built.net)} KAS at the same address`);
  if (left > 0) {
    console.error(
      `\n${left} coin${left === 1 ? "" : "s"} left over — --max-inputs is ${MAX_INPUTS}. Run this again for the rest.`,
    );
  }

  if (!has("submit")) {
    console.error(
      `\nBuilt, not submitted. Add --submit to broadcast.\n` +
        `Nothing about this key is bounded: this moves the whole balance, and the only\n` +
        `thing stopping it going elsewhere is that the output script came from the coins\n` +
        `themselves rather than from an argument.\n`,
    );
    if (has("json")) console.log(JSON.stringify(toWireMulti(built.tx, built.entries), null, 2));
    process.exit(0);
  }

  const submit = async () => client.submitTransaction(built.tx);
  let txid: string;
  try {
    txid = await submit();
  } catch (e) {
    const message = (e as Error).message;
    /* The node states the fee it wanted. Reading it back is the difference
       between a tool that is wrong until someone edits a constant and one that
       is wrong once, out loud, and then right. */
    const wanted = message.match(/(\d{4,})/g)?.map(BigInt).filter((n) => n > fee).sort((a, b) => (a > b ? 1 : -1))[0];
    if (!wanted) throw e;
    console.error(`\nthe node refused that fee and named ${formatKas(wanted)} KAS. Rebuilding.`);
    console.error(`  (${message.split("\n")[0]})`);
    fee = wanted;
    built = build(fee);
    txid = await submit();
    console.error(
      `\nNote: the estimate in this file was low. ${chosen.length} inputs actually cost ` +
        `${formatKas(fee)} KAS.`,
    );
  }

  console.error(
    `\n✔ ${txid}\n` +
      `  ${chosen.length} coins → 1 · ${formatKas(built.net)} KAS · fee ${formatKas(fee)} KAS\n\n` +
      `  This key can now fund a grant of up to ${formatKas(built.net > 1_000_000n ? built.net - 1_000_000n : 0n)} KAS.\n` +
      `  Until it is in a grant, nothing limits it.\n`,
  );
} finally {
  client.close();
}
