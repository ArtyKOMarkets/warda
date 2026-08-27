/**
 * Builds a spend in JavaScript and writes it out for the Rust verifier.
 *
 * Two modes, because they answer different questions:
 *
 *   --golden   rebuild the reference spend from golden-spend.json. Needs no
 *              node and no key of yours. Hand the result to
 *              `warda-deploy verify` and the consensus engine says whether it
 *              accepts a transaction JavaScript assembled — which is a
 *              stronger claim than "it matches a file we also wrote".
 *
 *   --genesis  rebuild the reference GENESIS — the transaction that creates a
 *              grant in the first place. Same idea, different half of the
 *              protocol: until a second implementation can issue a grant, a
 *              principal still needs the Rust tool.
 *
 *   --live     build the NEXT spend against the LIVE grant, from the
 *              spend-plan.json that `warda-deploy plan` wrote, signed with
 *              WARDA_SK. Hand the result to `warda-deploy submit` and a
 *              transaction assembled in JavaScript goes on testnet-10.
 *
 * Usage:
 *   node --experimental-strip-types tools/build-spend.ts --golden  > js-spend.json
 *   node --experimental-strip-types tools/build-spend.ts --genesis > js-genesis.json
 *   WARDA_SK=... node --experimental-strip-types tools/build-spend.ts --live > js-spend.json
 */

import { readFileSync } from "node:fs";

import { fromHex, toHex } from "../src/bytes.ts";
import { attachGenesisSignature, buildGenesis } from "../src/genesis.ts";
import { spendPlanFrom } from "../src/plan.ts";
import { RecipientSet } from "../src/recipients.ts";
import { agentPublicKey, signDigest, signSpend } from "../src/sign.ts";
import { buildUnsignedSpend, type SpendPlan } from "../src/spend.ts";
import type { CovenantTemplate, GrantState } from "../src/template.ts";
import { toWire } from "../src/wire.ts";

const here = (p: string) => new URL(p, import.meta.url);
const readJson = (p: string) => JSON.parse(readFileSync(here(p), "utf8"));

const template: CovenantTemplate = readJson("../covenant-template.json");
const golden = readJson("../golden-spend.json");

// ---- modes ---------------------------------------------------------------

function goldenPlan(): { plan: SpendPlan; secret: Uint8Array } {
  const p = golden.params;
  const state: GrantState = {
    agentKey: p.agentKey,
    budgetTotal: BigInt(p.budgetTotal),
    maxPerSpend: BigInt(p.maxPerSpend),
    epochLimit: BigInt(p.epochLimit),
    epochLength: BigInt(p.epochLength),
    recipientsRoot: p.recipientsRoot,
    notBefore: BigInt(p.notBefore),
    expiresAt: BigInt(p.expiresAt),
    delegationDepth: BigInt(p.delegationDepth),
    spentTotal: BigInt(p.prevState.spentTotal),
    reserved: BigInt(p.prevState.reserved),
    epochIndex: BigInt(p.prevState.epochIndex),
    epochSpent: BigInt(p.prevState.epochSpent),
  };

  const set = new RecipientSet(golden.recipients.members);
  // Derived, not copied. A copied proof would hide a disagreement between this
  // SDK's tree and the Rust one, and the failure would land on chain instead.
  if (set.rootHex !== p.recipientsRoot) {
    throw new Error(`recomputed root ${set.rootHex} != ${p.recipientsRoot}`);
  }
  const target = fromHex(golden.recipients.target);

  return {
    secret: fromHex(golden.key.secretHex),
    plan: {
      template,
      authority: { principalKey: p.principalKey, revocationKey: p.revocationKey },
      state,
      utxo: {
        outpointTransactionId: fromHex(golden.utxo.outpointTransactionId),
        outpointIndex: golden.utxo.outpointIndex,
        value: BigInt(golden.utxo.value),
        blockDaaScore: BigInt(golden.utxo.blockDaaScore),
        isCoinbase: golden.utxo.isCoinbase,
        covenantId: fromHex(golden.utxo.covenantId),
      },
      amount: BigInt(golden.spend.amount),
      recipient: target,
      proof: set.proof(golden.recipients.target),
      claimedDaa: BigInt(golden.spend.claimedDaa),
      fee: BigInt(golden.spend.fee),
      computeBudget: golden.spend.computeBudget,
    },
  };
}

function genesisMode(): void {
  const golden = readJson("../golden-genesis.json");
  const p = golden.params;
  const secret = fromHex(golden.key.secretHex);

  const built = buildGenesis({
    template,
    grant: {
      authority: { principalKey: p.principalKey, revocationKey: p.revocationKey },
      state: {
        agentKey: p.agentKey,
        budgetTotal: BigInt(p.budgetTotal),
        maxPerSpend: BigInt(p.maxPerSpend),
        epochLimit: BigInt(p.epochLimit),
        epochLength: BigInt(p.epochLength),
        recipientsRoot: p.recipientsRoot,
        notBefore: BigInt(p.notBefore),
        expiresAt: BigInt(p.expiresAt),
        delegationDepth: BigInt(p.delegationDepth),
        spentTotal: BigInt(p.initialState.spentTotal),
        reserved: BigInt(p.initialState.reserved),
        epochIndex: BigInt(p.initialState.epochIndex),
        epochSpent: BigInt(p.initialState.epochSpent),
      },
    },
    funding: {
      outpointTransactionId: fromHex(golden.funding.outpointTransactionId),
      outpointIndex: golden.funding.outpointIndex,
      value: BigInt(golden.funding.value),
      scriptPublicKey: {
        version: golden.funding.scriptPublicKeyVersion,
        script: fromHex(golden.funding.scriptPublicKeyHex),
      },
      blockDaaScore: BigInt(golden.funding.blockDaaScore),
      isCoinbase: golden.funding.isCoinbase,
    },
    grantValue: BigInt(golden.grant.value),
    fee: BigInt(golden.spend.fee),
    computeBudget: golden.spend.computeBudget,
  });

  const signed = attachGenesisSignature(built, signDigest(built.sighash, secret));
  process.stdout.write(JSON.stringify(toWire(signed, built.entry), null, 2) + "\n");
  console.error(
    `built genesis: covenant ${toHex(built.covenantId)}, txid ${toWire(signed, built.entry).txid}`,
  );
}


function liveMode(): void {
  // The plan comes from `warda-deploy plan`, which did the one thing this SDK
  // cannot: found the grant. A grant's address moves after every spend, so a
  // stale plan points at a UTXO that no longer exists — regenerate it each
  // time rather than editing the numbers by hand.
  let plan;
  try {
    plan = readJson("../spend-plan.json");
  } catch {
    console.error("no spend-plan.json — run `warda-deploy plan` first, from covenant/deploy");
    process.exit(2);
  }

  const secretHex = process.env.WARDA_SK;
  if (!secretHex) {
    console.error("set WARDA_SK to the agent's 32 hex bytes (testnet key only)");
    process.exit(2);
  }
  const secret = fromHex(secretHex);

  const state: GrantState = {
    agentKey: plan.state.agentKey,
    budgetTotal: BigInt(plan.state.budgetTotal),
    maxPerSpend: BigInt(plan.state.maxPerSpend),
    epochLimit: BigInt(plan.state.epochLimit),
    epochLength: BigInt(plan.state.epochLength),
    recipientsRoot: plan.state.recipientsRoot,
    notBefore: BigInt(plan.state.notBefore),
    expiresAt: BigInt(plan.state.expiresAt),
    delegationDepth: BigInt(plan.state.delegationDepth),
    spentTotal: BigInt(plan.state.spentTotal),
    reserved: BigInt(plan.state.reserved),
    epochIndex: BigInt(plan.state.epochIndex),
    epochSpent: BigInt(plan.state.epochSpent),
  };

  // The key must be the agent the grant names, checked here rather than
  // discovered as a script failure the node cannot explain.
  const derived = toHex(agentPublicKey(secret));
  if (derived !== state.agentKey) {
    console.error(`WARDA_SK derives ${derived}, but the grant names ${state.agentKey}`);
    process.exit(2);
  }

  const spendPlan: SpendPlan = spendPlanFrom(plan, template);

  // Derived, not copied. If this SDK's address derivation disagreed with the
  // compiler's, a spend against the address the plan reported would still look
  // right here and fail on chain.
  const unsigned = buildUnsignedSpend(spendPlan);
  const signed = signSpend(spendPlan, secret);
  const wire = toWire(signed.tx, unsigned.entry);

  process.stdout.write(JSON.stringify(wire, null, 2) + "\n");
  console.error(`grant address (per plan): ${plan.grantAddress}`);
  console.error(`paying ${plan.spend.amount} sompi to ${plan.recipients.target}`);
  console.error(`successor state: spent ${unsigned.successorState.spentTotal}, epoch ${unsigned.successorState.epochIndex}`);
  console.error(`txid ${wire.txid}`);
}

function main(): void {
  const mode = process.argv[2] ?? "--golden";
  if (mode === "--genesis") {
    genesisMode();
    return;
  }
  if (mode === "--live") {
    liveMode();
    return;
  }
  if (mode !== "--golden") {
    console.error(`unknown mode ${mode}; expected --golden, --genesis or --live`);
    process.exit(2);
  }

  const { plan, secret } = goldenPlan();

  const derived = toHex(agentPublicKey(secret));
  if (derived !== plan.state.agentKey) {
    throw new Error(`key mismatch: derived ${derived}, state names ${plan.state.agentKey}`);
  }

  const unsigned = buildUnsignedSpend(plan);
  const signed = signSpend(plan, secret);

  process.stdout.write(JSON.stringify(toWire(signed.tx, unsigned.entry), null, 2) + "\n");
  console.error(`built ${signed.tx.inputs[0]!.signatureScript.length}-byte sigscript, txid ${toWire(signed.tx, unsigned.entry).txid}`);
}

main();
