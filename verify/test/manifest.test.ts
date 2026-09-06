/**
 * The manifest translation, checked against the covenant template's own
 * recorded address vectors.
 *
 * These vectors are not fixtures this file invented. They ship with the
 * template, they were produced by the compiler that produced the bytecode, and
 * two of the addresses in them have held real coins on testnet-10. A
 * translation that agrees with them agrees with the thing the network
 * validated — which is the only agreement worth asserting, because every other
 * kind of wrong here produces a valid address with nothing at it.
 */
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RecipientSet,
  scriptHashFor,
  scriptHashToAddress,
  type CovenantTemplate,
} from "@warda_protocol/kaspa";
import { ManifestError, materialise } from "../src/manifest.ts";
import { loadTemplate } from "../src/template.ts";

const template: CovenantTemplate = loadTemplate();

interface Vector {
  label: string;
  authority: { principalKey: string; revocationKey: string };
  state: Record<string, string | number>;
  scriptHash: string;
  address: string;
}

const vectors: Vector[] = (
  JSON.parse(readFileSync(new URL("../../sdk/covenant-template.json", import.meta.url), "utf8")) as {
    addressVectors: Vector[];
  }
).addressVectors;

/** A vector, expressed the way a deploy manifest expresses it. */
function manifestFor(v: Vector): Record<string, unknown> {
  const s = v.state;
  return {
    agent: s.agentKey,
    principal: v.authority.principalKey,
    revocation: v.authority.revocationKey,
    recipients_root: s.recipientsRoot,
    not_before: String(s.notBefore),
    expires_at: String(s.expiresAt),
    budget: String(s.budgetTotal),
    max_per_spend: String(s.maxPerSpend),
    epoch_limit: String(s.epochLimit),
    epoch_length: String(s.epochLength),
    delegation_depth: String(s.delegationDepth),
    spent_total: String(s.spentTotal),
    reserved: String(s.reserved),
    epoch_index: String(s.epochIndex),
    epoch_spent: String(s.epochSpent),
    reserve_root: s.reserveRoot,
  };
}

test("every recorded address vector derives its recorded address", () => {
  assert.ok(vectors.length >= 8, "the template should carry the full vector table");
  for (const v of vectors) {
    const m = materialise({ manifest: manifestFor(v), network: "testnet-10" }, template);
    const hash = scriptHashFor(template, { authority: m.authority, state: m.state });
    assert.equal(hash, v.scriptHash, `${v.label}: script hash`);
    assert.equal(scriptHashToAddress(hash, m.prefix), v.address, `${v.label}: address`);
    assert.deepEqual(m.assumptions, [], `${v.label}: a complete manifest should assume nothing`);
  }
});

test("the templateId is derived, not taken from the manifest", () => {
  const v = vectors[0]!;
  const claimed = { ...manifestFor(v), template_id: "ff".repeat(32) };
  const m = materialise({ manifest: claimed, network: "testnet-10" }, template);
  assert.equal(m.state.templateId, v.state.templateId);
});

test("a JSON number too large to survive parsing is refused, not rounded", () => {
  const v = vectors[0]!;
  const bad = { ...manifestFor(v), budget: 2 ** 53 + 1 };
  assert.throws(
    () => materialise({ manifest: bad, network: "testnet-10" }, template),
    (e: unknown) => e instanceof ManifestError && e.field === "budget",
  );
});

test("a safe JSON number is accepted, because refusing it would be pedantry", () => {
  const v = vectors[0]!;
  const m = materialise(
    { manifest: { ...manifestFor(v), budget: 1_000_000_000 }, network: "testnet-10" },
    template,
  );
  assert.equal(m.state.budgetTotal, 1_000_000_000n);
});

test("a key of the wrong length is refused rather than hashed", () => {
  const v = vectors[0]!;
  assert.throws(
    () => materialise({ manifest: { ...manifestFor(v), agent: "ab" }, network: "testnet-10" }, template),
    (e: unknown) => e instanceof ManifestError && e.field === "agent",
  );
});

test("fields that move the address are recorded as assumptions when absent", () => {
  const v = vectors[0]!;
  const partial = manifestFor(v);
  delete partial.delegation_depth;
  delete partial.reserve_root;
  delete partial.revocation;
  const m = materialise({ manifest: partial, network: "testnet-10" }, template);
  const fields = m.assumptions.map((a) => a.field).sort();
  assert.deepEqual(fields, ["delegation_depth", "reserve_root", "revocation"]);
  for (const a of m.assumptions) {
    assert.ok(a.why.length > 30, `${a.field}: an assumption without a reason is not a warning`);
  }
});

test("a payee list that does not hash to the committed root is refused", () => {
  const v = vectors[0]!;
  const others = new RecipientSet(["aa".repeat(32), "bb".repeat(32)]);
  assert.notEqual(others.rootHex, v.state.recipientsRoot);
  assert.throws(
    () =>
      materialise(
        { manifest: manifestFor(v), recipients: ["aa".repeat(32), "bb".repeat(32)], network: "testnet-10" },
        template,
      ),
    (e: unknown) => e instanceof ManifestError && e.field === "recipients",
  );
});

test("a payee list that does hash to the committed root is accepted", () => {
  const members = ["aa".repeat(32), "bb".repeat(32)];
  const set = new RecipientSet(members);
  const v = vectors[0]!;
  const m = materialise(
    {
      manifest: { ...manifestFor(v), recipients_root: set.rootHex },
      recipients: members,
      network: "testnet-10",
    },
    template,
  );
  assert.equal(m.recipients?.rootHex, set.rootHex);
});

test("a state no sequence of spends could reach is refused", () => {
  const v = vectors[0]!;
  const impossible = { ...manifestFor(v), spent_total: String(Number(v.state.budgetTotal) + 1) };
  assert.throws(
    () => materialise({ manifest: impossible, network: "testnet-10" }, template),
    (e: unknown) => e instanceof ManifestError && e.field === "spent_total",
  );
});

test("an empty spending window is refused", () => {
  const v = vectors[0]!;
  const inverted = { ...manifestFor(v), expires_at: v.state.notBefore };
  assert.throws(
    () => materialise({ manifest: inverted, network: "testnet-10" }, template),
    (e: unknown) => e instanceof ManifestError && e.field === "expires_at",
  );
});

test("an unknown network is refused by name, because the failure is silent", () => {
  const v = vectors[0]!;
  assert.throws(
    () => materialise({ manifest: manifestFor(v), network: "base" }, template),
    (e: unknown) => e instanceof ManifestError && /unknown network/.test((e as Error).message),
  );
});

test("mainnet and testnet derive different addresses from the same manifest", () => {
  const v = vectors[0]!;
  const t = materialise({ manifest: manifestFor(v), network: "testnet-10" }, template);
  const main = materialise({ manifest: manifestFor(v), network: "mainnet" }, template);
  const hash = scriptHashFor(template, { authority: t.authority, state: t.state });
  assert.notEqual(scriptHashToAddress(hash, t.prefix), scriptHashToAddress(hash, main.prefix));
});
