import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, toHex } from "../src/bytes.ts";
import { attachExitSignature, buildUnsignedExit, exitSignatureScript, type ExitPlan } from "../src/exit.ts";
import { parseUtxos } from "../src/node.ts";
import { scriptHashToAddress } from "../src/address.ts";
import { dispatchTag } from "../src/spend.ts";
import { scriptHashFor, type CovenantTemplate, type GrantState } from "../src/template.ts";

/**
 * The exit paths have no golden vector — nothing has ever built one, in either
 * language. So they are checked against the only other authority available:
 * the COMPILED BYTECODE itself, which is in the template. If the tag this
 * package derives is the tag the compiler emitted into a dispatch branch,
 * then the derivation is right, and that is a stronger claim than agreement
 * with a file we also wrote.
 */

const capturePath = new URL("../rpc-capture.json", import.meta.url);
/** Declared here, not at the foot of the file: `skipReason` runs while the
 *  tests are being REGISTERED, which is before a `const` lower down exists. */
function skipReason(): string | false {
  return existsSync(capturePath) ? false : "no rpc-capture.json — run tools/capture_rpc.py";
}

const template: CovenantTemplate = JSON.parse(
  readFileSync(new URL("../covenant-template.json", import.meta.url), "utf8"),
);

const LIVE_MANIFEST = {
  agent: "0393133deefc4c8df644f4512978c675a8a090860770d8de7b2d077f2c2df34f",
  recipients_root: "db0a707b658f29fd8903a7f3815f63f962ec3a4e66528d3e11ba150a5fd4f0b5",
  not_before: 553866058n,
  expires_at: 554730058n,
  budget: 1000000000n,
  max_per_spend: 200000000n,
  epoch_limit: 500000000n,
  epoch_length: 1000n,
  spent_total: 100000000n,
  reserved: 0n,
  epoch_index: 699n,
  epoch_spent: 50000000n,
};

const state: GrantState = {
  agentKey: LIVE_MANIFEST.agent,
  budgetTotal: LIVE_MANIFEST.budget,
  maxPerSpend: LIVE_MANIFEST.max_per_spend,
  epochLimit: LIVE_MANIFEST.epoch_limit,
  epochLength: LIVE_MANIFEST.epoch_length,
  recipientsRoot: LIVE_MANIFEST.recipients_root,
  notBefore: LIVE_MANIFEST.not_before,
  expiresAt: LIVE_MANIFEST.expires_at,
  delegationDepth: 2n,
  spentTotal: LIVE_MANIFEST.spent_total,
  reserved: LIVE_MANIFEST.reserved,
  epochIndex: LIVE_MANIFEST.epoch_index,
  epochSpent: LIVE_MANIFEST.epoch_spent,
};
const authority = { principalKey: LIVE_MANIFEST.agent, revocationKey: LIVE_MANIFEST.agent };

function planFor(kind: "reclaim" | "revoke", lockTime: bigint): ExitPlan {
  return {
    kind,
    template,
    authority,
    state,
    utxo: {
      outpointTransactionId: fromHex("7d".repeat(32)),
      outpointIndex: 0,
      value: 898_000_000n,
      blockDaaScore: 554_573_904n,
      isCoinbase: false,
      covenantId: fromHex("f7".repeat(32)),
    },
    fee: 1_000_000n,
    computeBudget: 12,
    lockTime,
  };
}

test("the exit tags are the ones the compiler put in the bytecode", () => {
  // Every dispatch branch in the compiled contract is `OP_DATA_4 <tag>
  // OP_EQUAL OP_IF` — 0x04 <4 bytes> 0x87 0x63. Finding the derived tag in
  // that exact position proves the derivation, using the deployed artefact as
  // the authority rather than a vector.
  const code = template.baselineHex;
  for (const name of ["reclaim", "revoke"]) {
    const tag = toHex(dispatchTag(name, ["sig"]));
    assert.ok(
      code.includes(`04${tag}8763`),
      `${name}(sig) -> ${tag} appears in no dispatch branch of the compiled contract`,
    );
  }
});

test("`entry` dispatches on the BARE name, unlike `function`", () => {
  // auth_spend and auth_delegate carry the __covenant_entrypoint_ prefix;
  // reclaim and revoke do not. Assuming one convention covers both produces a
  // tag matching no branch, and the engine reports an unhelpful script error
  // rather than "no such entrypoint".
  const code = template.baselineHex;
  const prefixed = toHex(dispatchTag("__covenant_entrypoint_reclaim", ["sig"]));
  assert.ok(!code.includes(`04${prefixed}8763`), "the prefixed spelling should NOT be in the bytecode");
  assert.ok(code.includes(`04${toHex(dispatchTag("reclaim", ["sig"]))}8763`));
  // And the `function` entrypoints keep theirs, so this is a real distinction
  // and not just "the prefix is never used".
  assert.ok(code.includes(`04${toHex(dispatchTag("__covenant_entrypoint_auth_spend", ["State", "int", "byte[32]", "byte[32][]", "bool[]", "int", "sig"]))}8763`));
});

test("an exit pays the PRINCIPAL, even when the revocation key signs it", () => {
  // The right to stop a grant and the right to receive its balance are
  // separate on purpose: a revocation key can be handed to a monitor without
  // handing over the money. A revoke that paid its own signer would quietly
  // turn that monitor into an owner.
  const separate = {
    principalKey: "11".repeat(32),
    revocationKey: "22".repeat(32),
  };
  const plan: ExitPlan = { ...planFor("revoke", 0n), authority: separate };
  const built = buildUnsignedExit(plan);

  assert.equal(built.signingKey, "revocationKey");
  assert.equal(toHex(built.destination), separate.principalKey);
  const spk = built.tx.outputs[0]!.scriptPublicKey.script;
  assert.equal(spk.length, 34, "P2PK is OP_DATA_32 <key> OP_CHECKSIG");
  assert.equal(toHex(spk.slice(1, 33)), separate.principalKey);
});

test("reclaim refuses a lock time the CLTV would reject", () => {
  // The covenant compiles `tx.daa >= expiresAt` to a CLTV. A lower lock time
  // fails inside the script, where the error says nothing about why.
  assert.throws(
    () => buildUnsignedExit(planFor("reclaim", state.expiresAt - 1n)),
    /at least expiresAt/,
  );
  assert.doesNotThrow(() => buildUnsignedExit(planFor("reclaim", state.expiresAt)));
});

test("revoke has no lock time requirement — that is the whole point of it", () => {
  // Revoke is the emergency stop. Gating it on expiry would make it useless
  // exactly when it is needed.
  const built = buildUnsignedExit(planFor("revoke", 0n));
  assert.equal(built.tx.lockTime, 0n);
});

test("an exit carries no covenant binding: the coin leaves the covenant", () => {
  // Nothing in consensus requires a covenant-bound input to produce bound
  // outputs — CovenantsContext::from_tx only reads the bindings present. A
  // binding here would claim a continuation that does not exist.
  const built = buildUnsignedExit(planFor("reclaim", state.expiresAt + 10n));
  assert.equal(built.tx.outputs.length, 1);
  assert.equal(built.tx.outputs[0]!.covenant, undefined);
});

test("the signature script is sig, tag, redeem script — and nothing else", () => {
  // No state, no proof, no successor: an exit ends the covenant rather than
  // continuing it, so there is nothing to carry forward.
  const plan = planFor("reclaim", state.expiresAt + 10n);
  const script = exitSignatureScript(plan, new Uint8Array(65));

  assert.equal(script[0], 0x41, "a 65-byte push is OP_DATA_65");
  assert.equal(script[66], 0x04, "then a 4-byte push: the dispatch tag");
  assert.equal(toHex(script.slice(67, 71)), toHex(dispatchTag("reclaim", ["sig"])));
});

test("splicing a signature moves nothing downstream of it", () => {
  // The push is fixed-width at 65 bytes either way, which is what makes the
  // digest taken over the placeholder the digest of the finished transaction.
  const plan = planFor("reclaim", state.expiresAt + 10n);
  const built = buildUnsignedExit(plan);
  const signature = Uint8Array.from({ length: 65 }, (_, i) => (i % 251) + 1);
  const tx = attachExitSignature(plan, built, signature);

  const before = built.tx.inputs[0]!.signatureScript;
  const after = tx.inputs[0]!.signatureScript;
  assert.equal(after.length, before.length);
  assert.equal(toHex(after.slice(66)), toHex(before.slice(66)), "everything after the signature is identical");
});

test("an exit spends the address the grant actually lives at", { skip: skipReason() }, () => {
  // The redeem script must hash to the address holding the UTXO, or the P2SH
  // does not open at all. Checking it against the LIVE grant means the exit
  // path is aimed at a real coin, not at a plausible-looking one.
  const capture = JSON.parse(readFileSync(capturePath, "utf8"));
  const utxo = parseUtxos(capture.captured.getUtxosByAddresses.reply.params)[0]!;
  const derived = scriptHashToAddress(scriptHashFor(template, { authority, state }), "kaspatest");

  assert.equal(derived, capture.address);
  const built = buildUnsignedExit({
    ...planFor("reclaim", state.expiresAt + 10n),
    utxo: {
      outpointTransactionId: utxo.outpoint.transactionId,
      outpointIndex: utxo.outpoint.index,
      value: utxo.entry.value,
      blockDaaScore: utxo.entry.blockDaaScore,
      isCoinbase: utxo.entry.isCoinbase,
      covenantId: utxo.entry.covenantId!,
    },
  });
  assert.equal(
    toHex(built.entry.scriptPublicKey.script),
    toHex(utxo.entry.scriptPublicKey.script),
    "the exit's input script does not match the UTXO it claims to spend",
  );
  assert.equal(built.tx.outputs[0]!.value, utxo.entry.value - 1_000_000n);
});
