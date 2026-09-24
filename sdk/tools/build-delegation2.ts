/**
 * An ATOMIC delegation: one transaction, two children.
 *
 *   WARDA_SK=$(cat ../v5-demo/coord.key) \
 *     node --experimental-strip-types tools/build-delegation2.ts \
 *     ../v5-demo/grant.json --template ../covenant/deploy/covenant-template-v5.json \
 *     --a-key <hex> --b-key <hex> --submit
 *
 * Covenant v5 only. `delegate2` is an additional entrypoint; `delegate` is
 * untouched and still makes one child, because #[covenant.fanout(to = N)]
 * fixes the authorised output count exactly — a covenant with only delegate2
 * could not hire one worker.
 *
 * Two children and not N: KIP-9 storage mass. An atomic 1:2 of two ordinary
 * workers masses 420,435 against a ceiling of 500,000, and 1:3 masses 770,994
 * and is refused by the network. See covenant/FANOUT.md.
 *
 * ## The one thing this does that build-delegation.ts cannot
 *
 * The children are created TOGETHER. Hiring two with `delegate` is two
 * transactions, and the second one's input is the first one's output, so it
 * does not exist until the first confirms. Here they are one input, three
 * outputs, one signature — and from the moment it lands, each child is its own
 * UTXO and they are genuinely parallel.
 *
 * ## What each child's manifest has to remember, and why it differs
 *
 * `parent_reserve_root_before` is the preimage `reabsorb` needs to pop the
 * chain, and it CANNOT be derived from any state or any transaction. With two
 * children pushed in one go the two values are different:
 *
 *   A was pushed onto the parent's existing root
 *   B was pushed onto the root that already had A
 *
 * So B settles first — the chain pops from the end — and A settles against the
 * parent's original root afterwards. Writing the same value into both
 * manifests produces two children, one of which can never come home.
 *
 * Options:
 *   --a-key <hex> --b-key <hex>       the sub-agents' x-only keys
 *   --index-a <n> --index-b <n>       derive them instead (default 0 and 1)
 *   --a-budget --b-budget <sompi>     defaults 25000000
 *   --a-max-per-spend --b-max-per-spend
 *   --a-epoch-limit --b-epoch-limit
 *   --a-recipients --b-recipients     each child's own subset (needs --recipients)
 *   --recipients <file|csv>           the PARENT's full member set
 *   --depth <n>                       both children (default: parent - 1)
 *   --window <daa>                    both children's term, from the chain's tip
 *   --fee <sompi>  --template <path>  --prefix  --rpc  --submit
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { scriptHashToAddress } from "../src/address.ts";
import { fromHex } from "../src/bytes.ts";
import {
  attachDelegation2Signature,
  buildUnsignedDelegation2,
  pushChild,
  type Delegation2Plan,
} from "../src/delegate.ts";
import { derivePublic, EMPTY_RESERVE, KEY_DOMAIN, resolveSigner } from "../src/keys.ts";
import { NodeClient } from "../src/node.ts";
import { RecipientSet } from "../src/recipients.ts";
import { membersFrom } from "./members.ts";
import { signDigest, verifyDigest } from "../src/sign.ts";
import {
  scriptHashFor, templateFingerprint, templateIdFor,
  type CovenantTemplate, type GrantState,
} from "../src/template.ts";
import { toWire } from "../src/wire.ts";
import { resolveNetwork, rpcFrom } from "./network.ts";
import { submitCorrectingFee } from "./fee.ts";

/* Both measured for `delegate`, and delegate2 does strictly more: it builds
   THREE successor scripts and hashes all of them. The compute budget is raised
   in proportion and the ceiling is 65,535, so the headroom costs nothing;
   submitCorrectingFee covers the fee if this is short and says so out loud. */
const DEFAULT_FEE = 2_400_000n;
const DELEGATE2_COMPUTE_BUDGET = 32;

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const manifestPath = process.argv.find((a, i) => i >= 2 && !a.startsWith("--") && a.endsWith(".json"));
if (!manifestPath) {
  console.error("usage: build-delegation2.ts <grant.json> --template <v5 template> [--a-key hex] [--b-key hex]");
  process.exit(2);
}
const secretHex = process.env.WARDA_SK;
if (!secretHex) {
  console.error("WARDA_SK is required: only the parent agent can delegate.");
  process.exit(2);
}
const secret = fromHex(secretHex.trim());
const m = JSON.parse(readFileSync(manifestPath, "utf8"));

const named = flag("template");
const template: CovenantTemplate = JSON.parse(
  readFileSync(named ? new URL(named, `file://${process.cwd()}/`) : new URL("../covenant-template.json", import.meta.url), "utf8"),
);
const have = templateFingerprint(template);
if (m.covenant && m.covenant !== have) {
  console.error(
    `this manifest was issued under covenant ${m.covenant}, and the template loaded is ${have}.\n` +
      `Deriving an address from the wrong covenant does not fail loudly: it produces a\n` +
      `plausible address, finds nothing there, and reports the grant missing.\n` +
      `Pass --template <path to that covenant's template>.`,
  );
  process.exit(1);
}

const principalKey = flag("principal", m.principal ?? m.agent)!;
const authority = { principalKey, revocationKey: flag("revocation", m.revocation ?? principalKey)! };
const { prefix } = resolveNetwork({ prefix: flag("prefix"), network: flag("network"), action: "delegate" });
const parentDepth = BigInt(flag("parent-depth", String(m.delegation_depth ?? 2))!);

const state: GrantState = {
  agentKey: m.agent,
  budgetTotal: BigInt(m.budget),
  maxPerSpend: BigInt(m.max_per_spend),
  epochLimit: BigInt(m.epoch_limit),
  epochLength: BigInt(m.epoch_length),
  recipientsRoot: m.recipients_root,
  notBefore: BigInt(m.not_before),
  expiresAt: BigInt(m.expires_at),
  delegationDepth: parentDepth,
  templateId: templateIdFor(template, authority),
  spentTotal: BigInt(m.spent_total),
  reserved: BigInt(m.reserved),
  epochIndex: BigInt(m.epoch_index),
  epochSpent: BigInt(m.epoch_spent),
  reserveRoot: m.reserve_root ?? EMPTY_RESERVE,
};

const found = resolveSigner(secret, state.agentKey, m.agent_key_derived ?? null);
if (!found) {
  console.error(
    `WARDA_SK does not control this grant's agent (${state.agentKey}), and the\n` +
      `manifest gives no derivation that reaches it. Only the agent may delegate.`,
  );
  process.exit(1);
}
const parentSecret = found.secret;

const indexA = Number(flag("index-a", "0")!);
const indexB = Number(flag("index-b", "1")!);
const derivedA = derivePublic(parentSecret, KEY_DOMAIN.subAgent, indexA);
const derivedB = derivePublic(parentSecret, KEY_DOMAIN.subAgent, indexB);
const keyA = flag("a-key", derivedA)!;
const keyB = flag("b-key", derivedB)!;
if (keyA.toLowerCase() === keyB.toLowerCase()) {
  console.error(
    `both children carry the same agent key.\n` +
      `That is ONE authority issued twice: they share a child id, the reserve chain\n` +
      `carries it twice, and the second settlement would release a reserve the parent\n` +
      `never took. Use --index-a/--index-b, or two real sub-agent keys.`,
  );
  process.exit(1);
}

const parentMembersFlag = flag("recipients");
const aMembersFlag = flag("a-recipients");
const bMembersFlag = flag("b-recipients");
if ((aMembersFlag || bMembersFlag) && !parentMembersFlag) {
  console.error(
    `narrowing a child's allowlist needs the PARENT's full member set too: the\n` +
      `witness is a path through the parent's tree, and a root alone cannot produce\n` +
      `one. Pass --recipients as well.`,
  );
  process.exit(1);
}
let parentSet: RecipientSet | undefined;
if (parentMembersFlag) {
  parentSet = new RecipientSet(membersFrom(parentMembersFlag));
  if (parentSet.rootHex !== state.recipientsRoot.toLowerCase()) {
    console.error(
      `the recipient set given hashes to ${parentSet.rootHex},\n` +
        `and this grant commits to ${state.recipientsRoot}.\n` +
        `A witness through the wrong tree proves nothing.`,
    );
    process.exit(1);
  }
}

const address = scriptHashToAddress(scriptHashFor(template, { authority, state }), prefix);

const client = await NodeClient.connect({ url: rpcFrom(flag("rpc")) });
let plan: Delegation2Plan, built;
try {
  const dag = flag("window") ? await client.getBlockDagInfo() : null;
  const window: { notBefore?: bigint; expiresAt?: bigint } = {};
  if (dag) {
    window.notBefore = state.notBefore;
    window.expiresAt = dag.virtualDaaScore + BigInt(flag("window")!);
  }

  const utxos = await client.getUtxosByAddresses([address]);
  const utxo = utxos[0];
  if (!utxo) {
    console.error(
      `no UTXO at ${address}.\n` +
        `  - the genesis may have been submitted seconds ago and not accepted yet\n` +
        `  - or the manifest is stale: a grant's address derives from its state, so\n` +
        `    spending or delegating MOVES it and the old address goes empty\n` +
        `  - or the authority is wrong: principal, revocation and depth are all part\n` +
        `    of the address`,
    );
    process.exit(1);
  }

  const depth = BigInt(flag("depth", (parentDepth - 1n).toString())!);
  const childOf = (p: string, key: string, members?: string) => ({
    agentKey: key,
    budgetTotal: BigInt(flag(`${p}-budget`, "25000000")!),
    maxPerSpend: BigInt(flag(`${p}-max-per-spend`, String(state.maxPerSpend))!),
    epochLimit: BigInt(flag(`${p}-epoch-limit`, String(state.epochLimit))!),
    delegationDepth: depth,
    ...(members ? { recipients: membersFrom(members) } : {}),
    ...window,
  });

  plan = {
    template,
    authority,
    state,
    utxo: {
      outpointTransactionId: utxo.outpoint.transactionId,
      outpointIndex: utxo.outpoint.index,
      value: utxo.entry.value,
      blockDaaScore: utxo.entry.blockDaaScore,
      isCoinbase: utxo.entry.isCoinbase,
      covenantId: utxo.entry.covenantId!,
    },
    childA: childOf("a", keyA, aMembersFlag),
    childB: childOf("b", keyB, bMembersFlag),
    recipients: parentSet,
    fee: BigInt(flag("fee", DEFAULT_FEE.toString())!),
    computeBudget: DELEGATE2_COMPUTE_BUDGET,
  };
  built = buildUnsignedDelegation2(plan);
} finally {
  client.close();
}

const signature = signDigest(built.sighash, parentSecret);
if (!verifyDigest(signature, built.sighash, fromHex(state.agentKey))) {
  throw new Error("signature failed to verify against the digest it was made over");
}
const tx = attachDelegation2Signature(plan, built.tx, signature);
const txid = toWire(tx, built.entry).txid;

const addrOf = (s: GrantState) => scriptHashToAddress(scriptHashFor(template, { authority, state: s }), prefix);

/* The manifests, written BEFORE anything is broadcast. A submit that succeeds
   while the write fails strands coin at an address nobody can reconstruct —
   and here it would strand two.

   `parent_reserve_root_before` DIFFERS between them, and that is the whole
   care in this block: A went onto the parent's existing root, B went onto the
   root that already had A. Writing the same value into both leaves one child
   that can never be settled. */
const rootBefore = [state.reserveRoot, pushChild(state.reserveRoot, built.childStates[0])];
const paths: string[] = [];
built.childStates.forEach((c, i) => {
  const path = join(dirname(manifestPath), `grant-child-${c.agentKey.slice(0, 8)}.json`);
  if (existsSync(path)) {
    console.error(`${path} already exists. Move it aside, or use --index-a/--index-b.`);
    process.exit(1);
  }
  writeFileSync(path, JSON.stringify({
    _comment:
      "A child grant, created by an ATOMIC delegation — one transaction, two children. It shares its parent's principal and revocation keys: delegation subdivides a budget, it does not hand over the right to revoke or reclaim.",
    covenant: m.covenant ?? templateFingerprint(template),
    covenant_id: m.covenant_id,
    agent: c.agentKey,
    principal: authority.principalKey,
    revocation: authority.revocationKey,
    agent_key_derived:
      c.agentKey === (i === 0 ? derivedA : derivedB)
        ? { domain: KEY_DOMAIN.subAgent, index: i === 0 ? indexA : indexB }
        : null,
    parent_agent: state.agentKey,
    parent_txid: txid,
    /* Which of the two this is, and the sibling it shares a transaction with.
       Settlement order is not a preference here: the chain pops from the end,
       so the SECOND child comes home first. */
    atomic_sibling: built.childStates[i === 0 ? 1 : 0]!.agentKey,
    atomic_position: i === 0 ? "first pushed, settles LAST" : "second pushed, settles FIRST",
    parent_reserve_root_before: rootBefore[i],
    reserve_root: EMPTY_RESERVE,
    recipients_root: c.recipientsRoot,
    not_before: Number(c.notBefore),
    expires_at: Number(c.expiresAt),
    budget: Number(c.budgetTotal),
    max_per_spend: Number(c.maxPerSpend),
    epoch_limit: Number(c.epochLimit),
    epoch_length: Number(c.epochLength),
    delegation_depth: Number(c.delegationDepth),
    grant_value: Number(c.budgetTotal),
    spent_total: 0,
    reserved: 0,
    epoch_index: 0,
    epoch_spent: 0,
  }, null, 2) + "\n");
  paths.push(path);
});

console.error(`parent      : ${address}`);
console.error(`  moves to  : ${addrOf(built.parentSuccessorState)}`);
console.error(`  keeps     : ${built.parentChange} sompi, reserved now ${built.parentSuccessorState.reserved}`);
built.childStates.forEach((c, i) => {
  console.error(`child ${i === 0 ? "A" : "B"}     : ${addrOf(c)}`);
  console.error(`  receives  : ${c.budgetTotal} sompi, cap ${c.maxPerSpend}, depth ${c.delegationDepth}`);
  console.error(`  agent key : ${c.agentKey}`);
  console.error(
    `  payees    : ${
      c.recipientsRoot === state.recipientsRoot
        ? "inherited — may pay anyone the parent may"
        : "narrowed, proven by witness"
    }`,
  );
});
console.error(
  `conserved   : ${plan.utxo.value} = ${built.parentChange} + ` +
    `${plan.childA.budgetTotal} + ${plan.childB.budgetTotal} + ${plan.fee}`,
);
console.error(`ONE transaction, both children. Settlement is B then A.`);
for (const p of paths) console.error(`wrote       : ${p}`);

process.stdout.write(
  JSON.stringify(toWire(tx, built.entry, "@warda_protocol/kaspa (atomic delegation)"), null, 2) + "\n",
);

if (process.argv.includes("--submit")) {
  const submitter = await NodeClient.connect({ url: rpcFrom(flag("rpc")) });
  try {
    const { txid: sent } = await submitCorrectingFee({
      client: submitter,
      tx,
      fee: plan.fee,
      what: "the atomic delegation",
      rebuild: (corrected) => {
        const p2 = { ...plan, fee: corrected };
        const b2 = buildUnsignedDelegation2(p2);
        const s2 = signDigest(b2.sighash, parentSecret);
        return { tx: attachDelegation2Signature(p2, b2.tx, s2), entry: b2.entry };
      },
    });
    console.error(`\nSUBMITTED: ${sent}`);
  } finally {
    submitter.close();
  }
}
