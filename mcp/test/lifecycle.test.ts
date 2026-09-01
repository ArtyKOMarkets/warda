/**
 * The whole life of a grant, driven through the MCP server.
 *
 * Not a smoke test of registration — `server.test.ts` covers that. This walks
 * one grant from delegation through settlement, and then loses it and finds it
 * again, using only what a framework can reach over MCP with no key and no
 * Kaspa integration of its own.
 *
 * The two that matter most are the last two. A monitor with no revocation path
 * can only file a report, and a grant nobody can locate is money that is
 * perfectly valid on chain and out of reach.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/server.ts";

const RECIPIENTS = ["a1".repeat(32), "a2".repeat(32), "a3".repeat(32), "a4".repeat(32)];
const GRANT = {
  agentKey: "22".repeat(32),
  principalKey: "11".repeat(32),
  revocationKey: "44".repeat(32),
  budgetKas: "100",
  maxPerSpendKas: "2",
  epochLimitKas: "10",
  epochLength: "1000",
  recipients: RECIPIENTS,
  notBefore: "1000000",
  expiresAt: "1007000",
  delegationDepth: 2,
  nonce: "01".repeat(32),
};
const UTXO = {
  transactionId: "09".repeat(32),
  index: 0,
  valueSompi: "10000000000",
  blockDaaScore: "1000000",
  isCoinbase: false,
  covenantId: "07".repeat(32),
};

async function connect() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([buildServer().connect(b), client.connect(a)]);
  return client;
}
const call = async (c: Client, name: string, args: Record<string, unknown>) =>
  JSON.parse(((await c.callTool({ name, arguments: args })) as any).content[0].text);

// ---- where is it? --------------------------------------------------------

test("an agent can find out where its own grant lives", async () => {
  const c = await connect();
  const r = await call(c, "warda_grant_address", { grant: GRANT });
  assert.match(r.address, /^kaspatest:p/, "a grant is P2SH, so its address starts with p");
  assert.match(r.note, /stale/);
});

test("spending MOVES the grant, and the address tool says so", async () => {
  const c = await connect();
  const before = await call(c, "warda_grant_address", { grant: GRANT });
  const after = await call(c, "warda_grant_address", {
    grant: { ...GRANT, state: { spentTotalKas: "1", reservedKas: "0", epochIndex: "0", epochSpentKas: "1" } },
  });
  // The address is a hash of the state. This is the single fact that trips up
  // every integration: yesterday's address holds nothing today.
  assert.notEqual(before.address, after.address);
});

// ---- delegation ----------------------------------------------------------

const DELEGATE = {
  parent: GRANT,
  childAgentKey: "99".repeat(32),
  childBudgetKas: "25",
  childMaxPerSpendKas: "1",
  childEpochLimitKas: "5",
  childDelegationDepth: 1,
  utxo: UTXO,
};

test("a delegation is built unsigned, and reports where BOTH grants land", async () => {
  const c = await connect();
  const r = await call(c, "warda_build_delegation", DELEGATE);
  assert.equal(r.built, true, r.error);
  assert.equal(r.sighashHex.length, 64);
  assert.match(r.childAddress, /^kaspatest:p/);
  assert.match(r.parentMovesTo, /^kaspatest:p/);
  // The parent moves too — its reserve root is part of its address. An
  // integration that keeps watching the old one concludes the grant vanished.
  const still = await call(c, "warda_grant_address", { grant: GRANT });
  assert.notEqual(r.parentMovesTo, still.address);
  assert.match(r.successorNote, /PARENT moves too/);
});

test("a delegation hands back the one number settlement cannot derive", async () => {
  const c = await connect();
  const r = await call(c, "warda_build_delegation", DELEGATE);
  // The parent's reserve is a hash chain; popping one means supplying the
  // preimage. Nothing on chain contains it, so if the delegation does not
  // return it the child can never be settled — only left to expire.
  assert.equal(typeof r.parentReserveRootBefore, "string");
  assert.equal(r.parentReserveRootBefore.length, 64);
});

test("the signature slot comes back empty", async () => {
  const c = await connect();
  const r = await call(c, "warda_build_delegation", DELEGATE);
  assert.ok(
    (r.transaction.inputs[0].signatureScriptHex as string).includes("41" + "00".repeat(65)),
    "the 65-byte signature push should be all zeros",
  );
  assert.ok(!/secret|privatekey|"sk"|seed/i.test(JSON.stringify(r)), "no key material");
});

test("narrowing an allowlist without the parent's members is refused, not guessed", async () => {
  const c = await connect();
  const r = await call(c, "warda_build_delegation", {
    ...DELEGATE,
    childRecipients: [RECIPIENTS[0], RECIPIENTS[1]],
  });
  assert.equal(r.built, false);
  assert.match(r.error, /root on its own cannot produce one/);
});

test("narrowing an allowlist with them commits the child to a subset", async () => {
  const c = await connect();
  // A contiguous, power-of-two-aligned run of the canonically sorted members —
  // the alignment is what lets one node stand for the whole subset.
  const r = await call(c, "warda_build_delegation", {
    ...DELEGATE,
    childRecipients: RECIPIENTS.slice(0, 2),
    parentRecipients: RECIPIENTS,
  });
  assert.equal(r.built, true, r.error);
  // The attenuation with teeth: a shorter window ends by itself and a smaller
  // budget bounds the damage, but neither stops a sub-agent paying somebody
  // the parent never would.
  assert.equal(r.childRecipientsNarrowed, true);
});

// ---- settlement ----------------------------------------------------------

test("settling returns the child's UNSPENT remainder to the agent's budget", async () => {
  const c = await connect();
  const del = await call(c, "warda_build_delegation", DELEGATE);
  assert.equal(del.built, true, del.error);

  // The parent AFTER the delegation. Its reserve root is part of its address,
  // so describing it without one describes the grant as it was before it
  // delegated — and finds nothing there.
  const parentAfter = {
    ...GRANT,
    state: {
      spentTotalKas: "0",
      reservedKas: "25",
      epochIndex: "0",
      epochSpentKas: "0",
      reserveRoot: del.parentReserveRootAfter,
    },
  };
  const at = await call(c, "warda_grant_address", { grant: parentAfter });
  assert.equal(at.address, del.parentMovesTo, "the delegation and the address tool must agree");

  const child = {
    ...GRANT,
    agentKey: DELEGATE.childAgentKey,
    budgetKas: "25",
    maxPerSpendKas: "1",
    epochLimitKas: "5",
    delegationDepth: 1,
    state: { spentTotalKas: "8", reservedKas: "0", epochIndex: "0", epochSpentKas: "8" },
  };
  const r = await call(c, "warda_build_settlement", {
    parent: parentAfter,
    child,
    prevRoot: del.parentReserveRootBefore,
    parentUtxo: UTXO,
    childUtxo: { ...UTXO, index: 1, valueSompi: "2500000000" },
  });
  assert.equal(r.built, true, r.error);
  assert.equal(r.chargedSompi, "800000000", "the parent is charged what the child SPENT");
  // The rest comes home to the AGENT's budget. Letting the child expire
  // instead returns it to the principal, which is no use mid-task.
  assert.equal(r.returnedToBudgetSompi, "1700000000");
  // Two digests, unmerged: different parties are agreeing to different things.
  assert.equal(r.parentSighashHex.length, 64);
  assert.equal(r.childSighashHex.length, 64);
  assert.notEqual(r.parentSighashHex, r.childSighashHex);
  assert.match(r.childSignedBy, /REVOCATION/);
});

test("a child settled out of LIFO order is refused before anything is built", async () => {
  const c = await connect();
  const del = await call(c, "warda_build_delegation", DELEGATE);
  const parentAfter = {
    ...GRANT,
    state: { spentTotalKas: "0", reservedKas: "25", epochIndex: "0", epochSpentKas: "0", reserveRoot: del.parentReserveRootAfter },
  };
  const wrongChild = {
    ...GRANT,
    agentKey: "cc".repeat(32),
    budgetKas: "25",
    maxPerSpendKas: "1",
    epochLimitKas: "5",
    delegationDepth: 1,
  };
  const r = await call(c, "warda_build_settlement", {
    parent: parentAfter,
    child: wrongChild,
    prevRoot: del.parentReserveRootBefore,
    parentUtxo: UTXO,
    childUtxo: { ...UTXO, index: 1 },
  });
  assert.equal(r.built, false);
  assert.match(r.error, /not on top of the parent's reserve stack/);
});

test("a child of a different authority cannot be settled into this parent", async () => {
  const c = await connect();
  const r = await call(c, "warda_build_settlement", {
    parent: GRANT,
    child: { ...GRANT, principalKey: "ab".repeat(32), budgetKas: "25", maxPerSpendKas: "1", epochLimitKas: "5", delegationDepth: 1 },
    prevRoot: "00".repeat(32),
    parentUtxo: UTXO,
    childUtxo: { ...UTXO, index: 1 },
  });
  assert.equal(r.built, false);
  // Authority is compiled into the covenant rather than carried in its state,
  // so it is part of the template id — a parent can only reabsorb its own.
  assert.match(r.error, /do not share an authority/);
});

// ---- ending it -----------------------------------------------------------

test("a revocation is buildable by whoever holds the revocation key", async () => {
  const c = await connect();
  const r = await call(c, "warda_build_exit", { grant: GRANT, kind: "revoke", utxo: UTXO });
  assert.equal(r.built, true, r.error);
  assert.match(r.signedBy, /REVOCATION/);
  assert.match(r.signedBy, /agent cannot stop it/);
  assert.equal(r.destination, GRANT.principalKey, "a sweep goes to the principal, never to whoever asked");
});

test("a reclaim built before expiry is refused by the builder, as the chain would", async () => {
  const c = await connect();
  const r = await call(c, "warda_build_exit", { grant: GRANT, kind: "reclaim", utxo: UTXO, lockTime: "1000500" });
  assert.equal(r.built, false);
  // The covenant checks tx.daa >= expiresAt with a CLTV. Saying so here beats
  // a script failure somewhere inside 6912 bytes.
  assert.match(r.error, /at least expiresAt/);
});

// ---- losing it and finding it again --------------------------------------

test("a spend publishes the grant it spent, and recovery reads it back", async () => {
  const c = await connect();
  const spend = await call(c, "warda_build_spend", {
    grant: GRANT, amountKas: "1", recipient: RECIPIENTS[0], daaScore: "1000700", utxo: UTXO,
  });
  assert.equal(spend.built, true);

  const r = await call(c, "warda_recover_grant", { transaction: spend.transaction });
  assert.equal(r.recovered, true, r.error);
  assert.equal(r.kind, "spend");
  // Everything needed to rebuild a record: the terms, the state, and where it
  // went — none of which the address itself reveals, because it is a hash.
  assert.equal(r.authority.principalKey, GRANT.principalKey);
  assert.equal(r.state.agentKey, GRANT.agentKey);
  const where = await call(c, "warda_grant_address", { grant: GRANT });
  assert.equal(r.address, where.address, "recovered the address the grant was at");
  assert.match(r.movedTo, /^kaspatest:p/);
  assert.match(r.note, /actually paid/);
});

test("recovery walks to the address the spend actually paid", async () => {
  const c = await connect();
  const spend = await call(c, "warda_build_spend", {
    grant: GRANT, amountKas: "1", recipient: RECIPIENTS[0], daaScore: "1000700", utxo: UTXO,
  });
  const r = await call(c, "warda_recover_grant", { transaction: spend.transaction });
  // The successor recovery derives must be the one the builder committed to.
  // If it were not, recovery would send someone to an empty address and let
  // them conclude the grant had been drained.
  const spentTo = await call(c, "warda_grant_address", {
    grant: { ...GRANT, state: { spentTotalKas: "1", reservedKas: "0", epochIndex: "0", epochSpentKas: "1" } },
  });
  assert.equal(r.movedTo, spentTo.address);
});

test("recovery from a delegation is honest about what it cannot finish", async () => {
  const c = await connect();
  const del = await call(c, "warda_build_delegation", DELEGATE);
  const r = await call(c, "warda_recover_grant", { transaction: del.transaction });
  assert.equal(r.recovered, true, r.error);
  assert.equal(r.kind, "delegation");
  assert.equal(r.movedTo, undefined);
  // Only the HASH of the child's script is in the parent's transaction.
  assert.match(r.note, /child.*birth state|hash of the child/i);
});

test("recovery with nothing to work from says so rather than guessing", async () => {
  const c = await connect();
  const r = await call(c, "warda_recover_grant", {});
  assert.equal(r.recovered, false);
  assert.match(r.error, /the address is a hash/);
});
