/**
 * Are our grants where we think they are?
 *
 *     node --experimental-strip-types ops/check-located.ts
 *     node --experimental-strip-types ops/check-located.ts --quiet
 *
 * ## Why this exists
 *
 * On 25 September a covenant freeze changed what `sdk/covenant-template.json`
 * means, and the wallet took it as a default. Every agent then derived a v5
 * address for a v4 grant — a valid, well-formed, empty address — and the fleet
 * stopped paying for twenty-one hours. Nothing was wrong on chain. Nothing was
 * wrong with any manifest. The coin never moved.
 *
 * Everything that could have caught it was pointed somewhere else. The endpoint
 * monitors watched three HTTP endpoints, all fine. The agents' own wrappers
 * translated the failure into a sentence and wrote it to a log. CI ran 251 SDK
 * tests and a 13-shape covenant matrix against fixtures, whose templates travel
 * with the code and so can never disagree with it.
 *
 * The missing question was the simplest one anybody could ask:
 *
 *     take the manifests we actually hold, resolve each one's covenant the way
 *     the agents do, derive the address, and ask the chain if the coin is there.
 *
 * It needs the chain, so it cannot live in CI — that is the point. A fixture
 * cannot answer it. This is the check that has to run against testnet, on a
 * schedule, and it is the one a covenant freeze must pass before it is called
 * done.
 *
 * ## What a failure means, and what it does not
 *
 * A grant not at its recorded address has three causes, and this reports them
 * differently because they need different things done:
 *
 *   * it MOVED and the record did not follow — a spend landed and the manifest
 *     was not advanced. `sdk/tools/follow-grant.ts` walks it forward.
 *   * it ENDED — revoked, reclaimed, or the term ran out. Expected, and the
 *     expiry is in the manifest, so this says so rather than alarming.
 *   * the ADDRESS is wrong — the covenant resolved here is not the covenant the
 *     coin is under. This is the September failure and the reason for the file.
 *
 * The third is distinguishable without any chain history: derive the address
 * under every template on disk and see whether the coin is sitting at one of the
 * others. If it is, the answer is not "the grant is missing", it is "this code is
 * reading the wrong covenant", and the message says which one.
 *
 * ## Exit codes
 *
 *   0  every grant checked is where its manifest says
 *   1  at least one is not, and it is not explained by expiry
 *   2  cannot check — no node, or no manifests to check
 *
 * 2 rather than 1 for "cannot check" because ops/monitor.sh reads it: a probe
 * that could not ask must not be reported as an answer. That distinction is
 * itself a bug this repo shipped — see the comment in ops/check-node.sh.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  EMPTY_RESERVE,
  NodeClient,
  scriptHashFor,
  scriptHashToAddress,
  templateFingerprint,
  templateIdFor,
  type CovenantTemplate,
  type GrantAuthority,
  type GrantState,
} from "@warda_protocol/kaspa";
import { loadTemplates, templateFor } from "@warda_protocol/kaspa/templates";
import { rpcFrom, resolveNetwork } from "../sdk/tools/network.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const QUIET = process.argv.includes("--quiet");
const say = (s: string) => { if (!QUIET) console.log(s); };

/**
 * The grants worth waking somebody about: the ones something still spends from.
 *
 * Not every manifest in the repo. Thirty-five of those exist and most are
 * finished demos whose coin is legitimately gone — checking them would produce a
 * standing list of expected failures, which is the fastest way to teach a person
 * to skim an alert. This is the fleet, named, and a new agent is a line here.
 */
const WATCHED: [string, string][] = [
  ["listener", "growth/listener-grant.json"],
  ["agent-003", "x402/demo/agent-003-grant.json"],
  ["agent-005", "x402/demo/agent-005-grant.json"],
  ["agent-006", "agent-006/grant-006.json"],
  ["agent-011", "x402/demo/agent-011-grant.json"],
  ["growth-batch", "growth/batch-grant.json"],
];

/**
 * And the one that is deliberately NOT here.
 *
 * `runner/agents/first-hosted-grant.json` was in this list on the first real
 * run, and it was the only failure: nothing at its derived address, no other
 * covenant holding it. The grant is fine. The FILE is a snapshot of genesis and
 * is not advanced by anything — its own commit says so, da9474b: "This file is
 * the manifest as genesis wrote it; the runner's copy in Neon is the one that
 * advances." It shows spent_total 0 while the runner has already paid the demo
 * vendor 0.03 KAS out of it.
 *
 * Which makes it exactly the standing expected failure this list's comment warns
 * about — an alert that is always there, teaching a person to skim the one day it
 * matters. Watching a file that is not the record cannot be made to work by
 * trying harder; the hosted grants' record is in the registry, and reading it
 * needs DATABASE_URL and a different probe.
 *
 * Open, and deliberately not solved here: the hosted fleet has no equivalent of
 * this check. `MAINNET.md` §3.3e carries it.
 */
const NOT_ADVANCED = new Set(["runner/agents/first-hosted-grant.json"]);

const { prefix, network } = resolveNetwork({
  network: process.env.WARDA_NETWORK ?? "testnet-10",
  action: "look up a grant",
});

function stateOf(m: Record<string, unknown>, tpl: CovenantTemplate): { authority: GrantAuthority; state: GrantState } {
  const authority: GrantAuthority = {
    principalKey: m.principal as string,
    revocationKey: (m.revocation as string) ?? (m.principal as string),
  };
  return {
    authority,
    state: {
      agentKey: m.agent as string,
      budgetTotal: BigInt(m.budget as number),
      maxPerSpend: BigInt(m.max_per_spend as number),
      epochLimit: BigInt(m.epoch_limit as number),
      epochLength: BigInt(m.epoch_length as number),
      recipientsRoot: m.recipients_root as string,
      notBefore: BigInt(m.not_before as number),
      expiresAt: BigInt(m.expires_at as number),
      delegationDepth: BigInt((m.delegation_depth as number) ?? 0),
      templateId: templateIdFor(tpl, authority),
      spentTotal: BigInt((m.spent_total as number) ?? 0),
      reserved: BigInt((m.reserved as number) ?? 0),
      epochIndex: BigInt((m.epoch_index as number) ?? 0),
      epochSpent: BigInt((m.epoch_spent as number) ?? 0),
      reserveRoot: (m.reserve_root as string) ?? EMPTY_RESERVE,
    },
  };
}

/** Has this manifest ever been advanced? Genesis counters are all zero. */
const atGenesis = (m: Record<string, unknown>): boolean =>
  BigInt((m.spent_total as number) ?? 0) === 0n && BigInt((m.epoch_index as number) ?? 0) === 0n;

const addressUnder = (m: Record<string, unknown>, tpl: CovenantTemplate): string => {
  const { authority, state } = stateOf(m, tpl);
  return scriptHashToAddress(scriptHashFor(tpl, { authority, state }), prefix);
};

type Verdict = {
  name: string;
  path: string;
  covenant: string;
  address: string;
  ok: boolean;
  /* Filled in only when the grant is NOT at its address, and only with the one
     of the three causes the evidence supports. */
  note?: string;
  expired?: boolean;
  elsewhere?: string;
};

for (const [name, rel] of WATCHED) {
  if (!NOT_ADVANCED.has(rel)) continue;
  console.error(`check-located: ${name} names ${rel}, which NOT_ADVANCED says is a genesis`);
  console.error("  snapshot rather than a live record. Watching it produces a permanent failure.");
  console.error("  Remove it from WATCHED, or remove it from NOT_ADVANCED and say why it advances now.");
  process.exit(2);
}

const present = WATCHED.filter(([, p]) => existsSync(join(REPO, p)));
if (present.length === 0) {
  console.error("check-located: none of the watched manifests exist here — nothing to check.");
  console.error(`  Looked for: ${WATCHED.map(([, p]) => p).join(", ")}`);
  process.exit(2);
}

let client: NodeClient;
try {
  client = await NodeClient.connect({ url: rpcFrom(process.env.WARDA_RPC_JSON) });
} catch (e) {
  /* 2, deliberately. A node that is asleep is not a grant that has moved, and
     reporting it as one is how "the grant is missing" gets believed on the day
     it is not true. sdk/tools/follow-grant.ts carries the same warning: an empty
     address has three causes and the third is the node you asked. */
  console.error(`check-located: cannot reach a node — ${(e as Error).message}`);
  console.error("  Set WARDA_RPC_JSON (ops/node.env), or start kaspad. NOTHING is concluded");
  console.error("  about any grant: an unreachable node and a moved grant look identical.");
  process.exit(2);
}

const tip = (await client.getBlockDagInfo()).virtualDaaScore;
const templates = loadTemplates();
const verdicts: Verdict[] = [];

try {
  for (const [name, rel] of present) {
    const m = JSON.parse(readFileSync(join(REPO, rel), "utf8")) as Record<string, unknown>;
    const tpl = templateFor(m as { covenant?: string }, rel);
    const address = addressUnder(m, tpl);
    const here = await client.getUtxosByAddresses([address]);
    const expired = BigInt((m.expires_at as number) ?? 0) <= tip;

    if (here.length > 0) {
      verdicts.push({ name, path: rel, covenant: templateFingerprint(tpl), address, ok: true });
      continue;
    }

    /* THE September question, asked before anything else is concluded: is the
       coin at the address another covenant would derive? If it is, the grant is
       fine and this process is reading the wrong bytecode — which is not a
       degree of the same problem, it is a different problem with a different
       fix, and the alert has to say so or somebody goes looking on chain for
       money that was never lost. */
    let elsewhere: string | undefined;
    for (const other of templates) {
      if (templateFingerprint(other) === templateFingerprint(tpl)) continue;
      const alt = addressUnder(m, other);
      const at = await client.getUtxosByAddresses([alt]);
      if (at.length > 0) {
        elsewhere = `${templateFingerprint(other)} at ${alt} (${at[0]!.entry.value} sompi)`;
        break;
      }
    }

    verdicts.push({
      name, path: rel, covenant: templateFingerprint(tpl), address, ok: false, expired,
      ...(elsewhere ? { elsewhere } : {}),
      note: elsewhere
        ? `the coin is under covenant ${elsewhere}. This manifest says ${m.covenant}, and that is what resolved here — so the MANIFEST is wrong about its own covenant, or an archive is missing.`
        : expired
          ? `the term ended at DAA ${m.expires_at} and the tip is ${tip}. Expected: an expired grant holds nothing anybody can spend.`
          : atGenesis(m)
            /* A THIRD cause, and it was missing from this message on the first
               real run — which is how a snapshot-of-genesis file read as a lost
               grant. A manifest whose counters have never moved cannot have been
               left behind by a spend it recorded, so either it was never funded
               or something else advances the real record. Both are answered by
               looking at what writes it, not by walking the chain. */
            ? `nothing at the derived address, and this manifest is still AT GENESIS — spent_total 0, epoch 0. So either the grant was never funded, or this file is not what advances and the live record is elsewhere (the runner keeps its copy in the registry). Walking the chain forward will not help either way.`
            : `nothing at the derived address, and no other covenant on disk holds it either. Either it moved and the record did not follow — sdk/tools/follow-grant.ts walks it forward — or it was revoked or reclaimed.`,
    });
  }
} finally {
  await client.close?.();
}

/* A status file, like every other probe here, so the state is readable without
   re-running it against the chain. */
const out = join(REPO, "site/src/located-status.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({
  _comment: "Written by ops/check-located.ts. Whether each live grant is at the address its manifest derives, under the covenant its manifest names. See the file's header for why this cannot be a CI check.",
  checkedAt: new Date().toISOString(),
  network, tipDaa: String(tip),
  templatesLoaded: templates.map(templateFingerprint),
  grants: verdicts.map((v) => ({
    name: v.name, manifest: v.path, covenant: v.covenant, address: v.address,
    located: v.ok, ...(v.expired ? { expired: true } : {}), ...(v.note ? { note: v.note } : {}),
  })),
}, null, 2) + "\n");

const bad = verdicts.filter((v) => !v.ok && !v.expired);
const gone = verdicts.filter((v) => !v.ok && v.expired);

for (const v of verdicts.filter((v) => v.ok)) say(`  ok       ${v.name.padEnd(13)} ${v.covenant}  ${v.address}`);
for (const v of gone) say(`  expired  ${v.name.padEnd(13)} ${v.covenant}  (the term ended; nothing to hold)`);

if (bad.length === 0) {
  say(`\ncheck-located: ${verdicts.length - gone.length} live grant(s) are where their manifests say, at DAA ${tip}.`);
  process.exit(0);
}

/* Loud even with --quiet: the log this writes to is supposed to be empty, and
   the wrapper reads stderr into the alert. */
console.error(`\ncheck-located: ${bad.length} grant(s) are NOT where their manifests say.\n`);
for (const v of bad) {
  console.error(`  ${v.name} — ${v.path}`);
  console.error(`    covenant resolved: ${v.covenant}`);
  console.error(`    address derived  : ${v.address}`);
  console.error(`    ${v.note}\n`);
}
if (bad.some((v) => v.elsewhere)) {
  console.error("  At least one grant's coin is sitting under a DIFFERENT covenant than the one");
  console.error("  resolved here. No money is missing. Something is reading the wrong template —");
  console.error("  which is the 25 September outage, and ops/check-template-guard.mjs is the");
  console.error("  check that is supposed to make it impossible.");
}
process.exit(1);
