/**
 * The routes, against a chain this file controls.
 *
 * The point of a recorded chain is that the interesting cases are the ones a
 * live node will not produce on demand: a grant that has moved, an epoch
 * boundary, a coin smaller than the budget. Those are exactly the cases where
 * a verifier can be confidently wrong, so they are the ones worth a test.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RecipientSet,
  fromHex,
  payToScriptHashScript,
  pubkeyToAddress,
  scriptHashFor,
  scriptHashToAddress,
  successorState,
  type AddressUtxo,
  type CovenantTemplate,
  type DagInfo,
  type GrantState,
  type NodeHealth,
} from "@warda_protocol/kaspa";
import { materialise } from "../src/manifest.ts";
import { NodeUnusable, type ChainSource, type Live } from "../src/node.ts";
import { authority, grantAt, health, locate, verify } from "../src/routes.ts";
import { loadTemplate } from "../src/template.ts";

const template: CovenantTemplate = loadTemplate();
const PREFIX = "kaspatest";

const PAYEE_A = "1a".repeat(32);
const PAYEE_B = "2b".repeat(32);
const STRANGER = "cc".repeat(32);
const payees = new RecipientSet([PAYEE_A, PAYEE_B]);

const NOT_BEFORE = 1_000_000n;
const EPOCH_LENGTH = 1_000n;

const manifest = {
  agent: "22".repeat(32),
  principal: "21".repeat(32),
  revocation: "23".repeat(32),
  recipients_root: payees.rootHex,
  not_before: String(NOT_BEFORE),
  expires_at: String(NOT_BEFORE + 100n * EPOCH_LENGTH),
  budget: "1000000000",
  max_per_spend: "200000000",
  epoch_limit: "500000000",
  epoch_length: String(EPOCH_LENGTH),
  delegation_depth: "2",
  spent_total: "0",
  reserved: "0",
  epoch_index: "0",
  epoch_spent: "0",
};

const recipients = [PAYEE_A, PAYEE_B];
const payeeAddress = pubkeyToAddress(fromHex(PAYEE_A), PREFIX);
const strangerAddress = pubkeyToAddress(fromHex(STRANGER), PREFIX);

/** The DAA score the fake chain sits at: a few epochs in, and inside the window. */
const NOW = NOT_BEFORE + 5n * EPOCH_LENGTH + 10n;

function addressFor(state: GrantState): string {
  const m = materialise({ manifest, network: "testnet-10" }, template);
  return scriptHashToAddress(scriptHashFor(template, { authority: m.authority, state }), PREFIX);
}

function stateOf(): GrantState {
  return materialise({ manifest, network: "testnet-10" }, template).state;
}

function utxo(address: string, value: bigint, withCovenant = true): AddressUtxo {
  const m = materialise({ manifest, network: "testnet-10" }, template);
  // The script has to be the real P2SH of the state whose address this is, or
  // describeGrant reports a mismatch — which is a finding worth having, and
  // one a lazy fixture would trip constantly.
  const hash = scriptHashFor(template, { authority: m.authority, state: stateAt(address) });
  return {
    address,
    outpoint: { transactionId: fromHex("ab".repeat(32)), index: 0 },
    entry: {
      value,
      scriptPublicKey: payToScriptHashScript(fromHex(hash)),
      blockDaaScore: NOW - 100n,
      isCoinbase: false,
      ...(withCovenant ? { covenantId: fromHex("cf".repeat(32)) } : {}),
    },
  };
}

/** Which state a given address belongs to, among the ones these tests use. */
const knownStates = new Map<string, GrantState>();
function remember(state: GrantState): string {
  const a = addressFor(state);
  knownStates.set(a, state);
  return a;
}
function stateAt(address: string): GrantState {
  const s = knownStates.get(address);
  assert.ok(s, `test asked for a UTXO at ${address}, which no test state derives`);
  return s;
}

const HEALTH: NodeHealth = {
  url: "ws://recorded",
  serverVersion: "1.0.0-test",
  network: "kaspa-testnet-10",
  virtualDaaScore: NOW,
  checks: {
    synced: { ok: true, detail: "synced" },
    utxoIndexed: { ok: true, detail: "indexed" },
    network: { ok: true, detail: "kaspa-testnet-10" },
    covenants: { ok: true, detail: "covenant ids present" },
  },
  usable: true,
};

const DAG: DagInfo = {
  network: "kaspa-testnet-10",
  virtualDaaScore: NOW,
  blockCount: 1n,
  sink: "00".repeat(32),
  pruningPointHash: "00".repeat(32),
  tipHashes: [],
};

function chain(entries: AddressUtxo[]): ChainSource {
  const byAddress = new Map<string, AddressUtxo[]>();
  for (const e of entries) {
    const list = byAddress.get(e.address!) ?? [];
    list.push(e);
    byAddress.set(e.address!, list);
  }
  const live: Live = {
    health: HEALTH,
    checkedAt: Date.now(),
    client: {
      async getUtxosByAddresses(addresses: string[]) {
        return addresses.flatMap((a) => byAddress.get(a) ?? []);
      },
      async getBlockDagInfo() {
        return DAG;
      },
    },
  };
  return { acquire: async () => live };
}

function result<T = Record<string, unknown>>(reply: { body: unknown }): T {
  return (reply.body as { result: T }).result;
}

// ---------------------------------------------------------------------------

test("verify finds a grant the chain agrees with", async () => {
  const state = stateOf();
  const address = remember(state);
  const reply = await verify(chain([utxo(address, 1_000_000_000n)]), {
    manifest,
    network: "testnet-10",
    feeSompi: "2000000",
  });
  assert.equal(reply.status, 200);
  const r = result<{ found: boolean; agrees: boolean; address: string; maxNextSpend: { sompi: string } }>(reply);
  assert.equal(r.address, address);
  assert.equal(r.found, true);
  assert.equal(r.agrees, true);
  // Bound by the per-payment cap, which is the smallest of the four here.
  assert.equal(r.maxNextSpend.sompi, "200000000");
});

test("every amount leaves as a string, in both units", async () => {
  const address = remember(stateOf());
  const reply = await verify(chain([utxo(address, 1_000_000_000n)]), { manifest, network: "testnet-10" });
  const r = result<{ value: { sompi: string; kas: string } }>(reply);
  assert.equal(r.value.sompi, "1000000000");
  assert.equal(r.value.kas, "10");
  assert.equal(typeof r.value.sompi, "string");
});

test("verify reports an empty address as moved, not as gone", async () => {
  const address = remember(stateOf());
  const reply = await verify(chain([]), { manifest, network: "testnet-10" });
  const r = result<{ found: boolean; agrees: boolean; findings: { level: string; text: string }[] }>(reply);
  assert.equal(r.found, false);
  assert.equal(r.agrees, false);
  assert.match(r.findings[0]!.text, /moved to a successor address/);
  assert.ok(address.length > 0);
});

test("the node that answered is named on every reply", async () => {
  const address = remember(stateOf());
  const reply = await verify(chain([utxo(address, 1_000_000_000n)]), { manifest, network: "testnet-10" });
  const body = reply.body as { readFrom: { url: string; synced: boolean; virtualDaaScore: string } };
  assert.equal(body.readFrom.url, "ws://recorded");
  assert.equal(body.readFrom.synced, true);
  assert.equal(body.readFrom.virtualDaaScore, NOW.toString());
});

test("every reply says it enforces nothing", async () => {
  const address = remember(stateOf());
  const reply = await verify(chain([utxo(address, 1_000_000_000n)]), { manifest, network: "testnet-10" });
  assert.match((reply.body as { enforcement: string }).enforcement, /covenant enforces/);
});

// ---------------------------------------------------------------- authority --

test("authority permits a payment inside every limit", async () => {
  const address = remember(stateOf());
  const reply = await authority(chain([utxo(address, 1_000_000_000n)]), {
    manifest,
    recipients,
    network: "testnet-10",
    payment: { amountSompi: "10000000", payTo: payeeAddress },
  });
  const r = result<{ wouldBeRefused: boolean; refusal: string | null }>(reply);
  assert.equal(r.wouldBeRefused, false);
  assert.equal(r.refusal, null);
});

test("authority refuses over the per-payment cap, and says which rule bound", async () => {
  const address = remember(stateOf());
  const reply = await authority(chain([utxo(address, 1_000_000_000n)]), {
    manifest,
    recipients,
    network: "testnet-10",
    payment: { amountSompi: "200000001", payTo: payeeAddress },
  });
  const r = result<{ wouldBeRefused: boolean; refusal: string }>(reply);
  assert.equal(r.wouldBeRefused, true);
  assert.match(r.refusal, /per-payment cap/);
});

test("authority refuses a payee the grant never committed to", async () => {
  const address = remember(stateOf());
  const reply = await authority(chain([utxo(address, 1_000_000_000n)]), {
    manifest,
    recipients,
    network: "testnet-10",
    payment: { amountSompi: "1000000", payTo: strangerAddress },
  });
  const r = result<{ wouldBeRefused: boolean; refusal: string }>(reply);
  assert.equal(r.wouldBeRefused, true);
  assert.match(r.refusal, /allowlist/);
});

test("authority will not answer from a root alone, and explains why", async () => {
  const address = remember(stateOf());
  await assert.rejects(
    () =>
      authority(chain([utxo(address, 1_000_000_000n)]), {
        manifest,
        network: "testnet-10",
        payment: { amountSompi: "1000000", payTo: payeeAddress },
      }),
    (e: unknown) => /Merkle root/.test((e as Error).message),
  );
});

test("a missing coin is recorded as an assumption, not hidden", async () => {
  remember(stateOf());
  const reply = await authority(chain([]), {
    manifest,
    recipients,
    network: "testnet-10",
    payment: { amountSompi: "1000000", payTo: payeeAddress },
  });
  const body = reply.body as { assumptions: { field: string; why: string }[] };
  const coin = body.assumptions.find((a) => a.field === "coin");
  assert.ok(coin, "an answer derived without the coin should say so");
  assert.match(coin.why, /more permissive than the chain/);
});

// -------------------------------------------------------------- grant/:addr --

test("an address alone yields the coin and an explicit refusal to guess the terms", async () => {
  const address = remember(stateOf());
  const reply = await grantAt(chain([utxo(address, 1_000_000_000n)]), address);
  const r = result<{ found: boolean; termsKnowable: boolean; whyNot: string; covenantId: string }>(reply);
  assert.equal(r.found, true);
  assert.equal(r.termsKnowable, false);
  assert.match(r.whyNot, /not derivable from its address/);
  assert.equal(r.covenantId, "cf".repeat(32));
});

test("an address holding many coins reports all of them, not the first", async () => {
  // The bug this pins: a funding wallet was reported as holding 1.68 KAS
  // because that was its first coin. It held 9,798, across six — and genesis
  // takes ONE input, so the largest is the figure that decides what can be
  // built, not the total and certainly not the first.
  const a = remember(stateOf());
  const many = [utxo(a, 168_000_000n), utxo(a, 977_974_000_000n), utxo(a, 1_000_000n)];
  const reply = await grantAt(chain(many), a);
  const r = result<{
    value: { sompi: string };
    coins: number;
    total: { sompi: string };
    largest: { sompi: string };
    note: string;
  }>(reply);
  assert.equal(r.coins, 3);
  assert.equal(r.value.sompi, "168000000");
  assert.equal(r.total.sompi, "978143000000");
  assert.equal(r.largest.sompi, "977974000000");
  assert.match(r.note, /holds 3 coins/);
  assert.match(r.note, /genesis takes a single input/);
});

test("a grant holds exactly one coin, and says nothing about counts", async () => {
  const a = remember(stateOf());
  const reply = await grantAt(chain([utxo(a, 1_000_000_000n)]), a);
  const r = result<{ coins: number; note: string }>(reply);
  assert.equal(r.coins, 1);
  assert.doesNotMatch(r.note, /coins\./);
});

test("an address with no coin still refuses to guess the terms", async () => {
  const address = remember(stateOf());
  const reply = await grantAt(chain([]), address);
  const r = result<{ found: boolean; termsKnowable: boolean }>(reply);
  assert.equal(r.found, false);
  assert.equal(r.termsKnowable, false);
});

// ------------------------------------------------------------------- locate --

test("locate finds the grant one spend after a stale manifest", async () => {
  const start = stateOf();
  remember(start);
  const paid = 30_000_000n;
  const daa = NOT_BEFORE + 3n * EPOCH_LENGTH;
  const moved = successorState(start, paid, daa);
  const movedAddress = remember(moved);

  const reply = await locate(chain([utxo(movedAddress, 960_000_000n)]), {
    manifest,
    network: "testnet-10",
    payments: [{ valueSompi: String(paid), blockDaaScore: String(daa) }],
  });
  const r = result<{ found: boolean; address: string; state: { spentTotal: { sompi: string } } }>(reply);
  assert.equal(r.found, true);
  assert.equal(r.address, movedAddress);
  assert.equal(r.state.spentTotal.sompi, paid.toString());
});

test("locate that finds nothing says what that usually means", async () => {
  remember(stateOf());
  const reply = await locate(chain([]), {
    manifest,
    network: "testnet-10",
    payments: [{ valueSompi: "30000000", blockDaaScore: String(NOT_BEFORE + 3n * EPOCH_LENGTH) }],
  });
  const r = result<{ found: boolean; candidatesTried: number; note: string }>(reply);
  assert.equal(r.found, false);
  assert.ok(r.candidatesTried > 0);
  assert.match(r.note, /subsets: true/);
});

// ------------------------------------------------------------------- health --

test("health refuses to serve from a node that cannot be believed", async () => {
  const bad: ChainSource = {
    acquire: async () => {
      throw new NodeUnusable("the node at ws://bad cannot be trusted with a grant:\n  synced: NOT SYNCED", {
        ...HEALTH,
        usable: false,
        checks: { ...HEALTH.checks, synced: { ok: false, detail: "NOT SYNCED" } },
      });
    },
  };
  const reply = await health(bad);
  assert.equal(reply.status, 503);
  const body = reply.body as { error: string; readFrom: { synced: boolean } };
  assert.equal(body.error, "node_unusable");
  assert.equal(body.readFrom.synced, false);
});
