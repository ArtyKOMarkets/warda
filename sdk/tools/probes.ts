/**
 * Adversarial probes: transactions the covenant MUST refuse, and the nearest
 * legitimate ones it must still accept.
 *
 * Three holes were found in this covenant in one afternoon, and none of them
 * was found by reading the code. Each was found by asking "what does an
 * attacker supply here?" and handing the answer to the real script engine.
 * The pattern in all three is the same: the covenant checked the SHAPE of
 * something and not its MAGNITUDE.
 *
 *   the epoch index      compared for equality where it needed an inequality,
 *                        so claiming an EARLIER epoch reset the allowance
 *   expiry               absent from the spend path entirely
 *   the exit paths       constrained WHERE the coin went, never HOW MUCH, so
 *                        a revoke could burn the balance to fees
 *
 * A golden vector cannot catch any of these: it proves two implementations
 * agree about a transaction that is supposed to work. These prove the engine
 * REFUSES transactions that are supposed to fail, which is the other half and
 * the half that was missing.
 *
 * Every probe carries its nearest legitimate twin, because a covenant that
 * refuses everything passes a suite of refusals.
 *
 *   node --experimental-strip-types tools/probes.ts            # write them
 *   cd ../covenant/deploy && cargo run -q -- probe             # judge them
 *
 * Or one at a time: `cargo run -q -- verify probes/<name>.json`.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { blake2b } from "@noble/hashes/blake2.js";

import { concat, fromHex, toHex } from "../src/bytes.ts";
import { ScriptBuilder } from "../src/script.ts";
import { pushState } from "../src/state.ts";
import { dispatchTag } from "../src/spend.ts";
import { bytecodeFor } from "../src/template.ts";
import { payToPubkeyScript, payToScriptHashScript, sighash, SUBNETWORK_ID_NATIVE } from "../src/tx.ts";
import { attachExitSignature, buildUnsignedExit, type ExitPlan } from "../src/exit.ts";
import { RecipientSet } from "../src/recipients.ts";
import { agentPublicKey, signDigest, signSpend } from "../src/sign.ts";
import type { SpendPlan } from "../src/spend.ts";
import type { CovenantTemplate, GrantState } from "../src/template.ts";
import { toWire } from "../src/wire.ts";

const here = (p: string) => new URL(p, import.meta.url);
const template: CovenantTemplate = JSON.parse(readFileSync(here("../covenant-template.json"), "utf8"));
const golden = JSON.parse(readFileSync(here("../golden-spend.json"), "utf8"));

const secret = fromHex(golden.key.secretHex);
const key = toHex(agentPublicKey(secret));
const recipients = new RecipientSet(golden.recipients.members.map((m: string) => fromHex(m)));
const target = fromHex(golden.recipients.target);
const authority = { principalKey: key, revocationKey: key };

const VALUE = 1_000_000_000n;
const EPOCH_LIMIT = 500_000_000n;

const base: GrantState = {
  agentKey: key,
  budgetTotal: VALUE,
  maxPerSpend: 200_000_000n,
  epochLimit: EPOCH_LIMIT,
  epochLength: 1000n,
  recipientsRoot: toHex(recipients.root),
  notBefore: 1_000_000n,
  expiresAt: 1_864_000n,
  delegationDepth: 2n,
  spentTotal: 0n,
  reserved: 0n,
  epochIndex: 0n,
  epochSpent: 0n,
};

/** Epoch 5's allowance is entirely spent. */
const exhausted: GrantState = { ...base, epochIndex: 5n, epochSpent: EPOCH_LIMIT };
/** Epoch 5 with room left, so a same-epoch spend is legitimate. */
const headroom: GrantState = { ...base, epochIndex: 5n, epochSpent: 100_000_000n };

const utxo = {
  outpointTransactionId: fromHex("7d".repeat(32)),
  outpointIndex: 0,
  value: VALUE,
  blockDaaScore: 1_000_100n,
  isCoinbase: false,
  covenantId: fromHex(golden.utxo.covenantId),
};

function spend(state: GrantState, claimedDaa: bigint): SpendPlan {
  return {
    template,
    authority,
    state,
    utxo,
    amount: 200_000_000n,
    recipient: target,
    proof: recipients.proof(target),
    claimedDaa,
    fee: 1_000_000n,
    computeBudget: 16,
  };
}

function exit(fee: bigint): ExitPlan {
  return { kind: "revoke", template, authority, state: base, utxo, fee, computeBudget: 12, lockTime: 0n };
}


/**
 * Assembling a spend WITHOUT the SDK's guards.
 *
 * `buildUnsignedSpend` now refuses an epoch rewind and a past-expiry claim, so
 * asking it to build those probes gets a helpful error and no transaction —
 * and the engine, which is the thing under test, never sees them. An attacker
 * does not use our SDK. Neither should a probe.
 *
 * This duplicates a little of buildUnsignedSpend deliberately: the point is to
 * reach the covenant with bytes the SDK would not produce. Everything below
 * the guards is shared, so a change to the signature-script layout still
 * moves both.
 */
function unguardedSpend(state: GrantState, claimedDaa: bigint, amount: bigint) {
  const epochIndex = (claimedDaa - state.notBefore) / state.epochLength;
  const carried = epochIndex === state.epochIndex ? state.epochSpent : 0n;
  const next: GrantState = {
    ...state,
    spentTotal: state.spentTotal + amount,
    epochIndex,
    epochSpent: carried + amount,
  };

  const scriptHash = (code: Uint8Array) => blake2b.create({ dkLen: 32 }).update(code).digest();
  const spk = (st: GrantState) =>
    payToScriptHashScript(scriptHash(bytecodeFor(template, { authority, state: st })));

  const entry = {
    value: utxo.value,
    scriptPublicKey: spk(state),
    blockDaaScore: utxo.blockDaaScore,
    isCoinbase: utxo.isCoinbase,
    covenantId: utxo.covenantId,
  };

  const sigScript = (signature: Uint8Array) => {
    const b = new ScriptBuilder();
    pushState(b, next);
    b.addI64(amount);
    b.addData(target);
    b.addData(concat(...recipients.proof(target).siblings));
    b.addData(Uint8Array.from(recipients.proof(target).left, (x) => (x ? 1 : 0)));
    b.addI64(claimedDaa);
    b.addData(signature);
    b.addData(dispatchTag("__covenant_entrypoint_auth_spend", SPEND_ARG_TYPES));
    b.addData(bytecodeFor(template, { authority, state }));
    return b.drain();
  };

  const tx = {
    version: 1,
    inputs: [
      {
        previousOutpoint: { transactionId: utxo.outpointTransactionId, index: utxo.outpointIndex },
        signatureScript: sigScript(new Uint8Array(65)),
        sequence: 0n,
        computeBudget: 16,
      },
    ],
    outputs: [
      {
        value: utxo.value - amount - 1_000_000n,
        scriptPublicKey: spk(next),
        covenant: { authorizingInput: 0, covenantId: utxo.covenantId },
      },
      { value: amount, scriptPublicKey: payToPubkeyScript(target) },
    ],
    lockTime: claimedDaa,
    subnetworkId: SUBNETWORK_ID_NATIVE,
    gas: 0n,
    payload: new Uint8Array(0),
  };

  const digest = sighash(tx, 0, entry);
  const signed = { ...tx, inputs: [{ ...tx.inputs[0]!, signatureScript: sigScript(signDigest(digest, secret)) }] };
  return { wire: toWire(signed, entry, "probe (unguarded)") };
}

const SPEND_ARG_TYPES = ["State", "int", "byte[32]", "byte[32][]", "bool[]", "int", "sig"];

/** `expect` is what the SCRIPT ENGINE must say, not what the SDK does. */
interface Probe {
  name: string;
  expect: "accept" | "refuse";
  why: string;
  build: () => { wire: unknown } | null;
}

const probes: Probe[] = [
  {
    name: "epoch-exhausted",
    expect: "refuse",
    why: "the recorded epoch's allowance is spent; the control for the rewind below",
    build: () => wireOf(spend(exhausted, 1_005_500n)),
  },
  {
    name: "epoch-rewind",
    expect: "refuse",
    why:
      "THE EXPLOIT. claimedDaa is agent-supplied and bounded below only, so an " +
      "earlier epoch used to reset spentThisEpoch to zero and hand back the whole " +
      "allowance, repeatably. The per-epoch cap limited nothing.",
    build: () => unguardedSpend(exhausted, 1_004_500n, 200_000_000n),
  },
  {
    name: "epoch-forward",
    expect: "accept",
    why: "a LATER epoch legitimately carries a fresh allowance; the ratchet must not block it",
    build: () => wireOf(spend(exhausted, 1_007_500n)),
  },
  {
    name: "epoch-same-headroom",
    expect: "accept",
    why: "the recorded epoch with room left is an ordinary spend",
    build: () => wireOf(spend(headroom, 1_005_500n)),
  },
  {
    name: "past-expiry",
    expect: "refuse",
    why: "a claimedDaa at or beyond expiresAt. The spend path had no expiry check at all.",
    build: () => unguardedSpend(base, 1_900_000n, 200_000_000n),
  },
  {
    name: "revoke-honest",
    expect: "accept",
    why: "an ordinary revoke, paying the principal and a normal fee",
    build: () => exitWire(exit(1_000_000n)),
  },
  {
    name: "revoke-burn",
    expect: "refuse",
    why:
      "1 sompi to the principal, the rest burned as fee. The exit paths checked " +
      "the output's scriptPubKey and never its value, which made the revocation " +
      "key a DESTROY capability rather than a STOP one.",
    build: () => exitWire(exit(VALUE - 1n)),
  },
];

function wireOf(plan: SpendPlan) {
  // The SDK refuses some of these itself now — that is the point of the guards
  // in spend.ts — so a probe it will not build is still written when possible
  // and reported when not.
  try {
    const { unsigned, tx } = signSpend(plan, secret);
    return { wire: toWire(tx, unsigned.entry, "probe") };
  } catch {
    return null;
  }
}

function exitWire(plan: ExitPlan) {
  try {
    const u = buildUnsignedExit(plan);
    const tx = attachExitSignature(plan, u, signDigest(u.sighash, secret));
    return { wire: toWire(tx, u.entry, "probe") };
  } catch {
    return null;
  }
}

const dir = new URL("../probes/", import.meta.url);
mkdirSync(dir, { recursive: true });

const manifest: { name: string; expect: string; why: string; sdkRefused: boolean }[] = [];
for (const p of probes) {
  const built = p.build();
  if (built) writeFileSync(new URL(`${p.name}.json`, dir), JSON.stringify(built.wire, null, 2) + "\n");
  manifest.push({ name: p.name, expect: p.expect, why: p.why, sdkRefused: !built });
  console.log(
    `${p.name.padEnd(22)} engine must ${p.expect.toUpperCase().padEnd(6)}` +
      `${built ? "" : "  (the SDK refuses to build it — checked in JS too)"}`,
  );
}
writeFileSync(new URL("probes.json", dir), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\nwrote ${manifest.filter((m) => !m.sdkRefused).length} probes to probes/`);
console.log("judge them: cd ../covenant/deploy && cargo run -q -- probe");
