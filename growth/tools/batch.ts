/**
 * The orchestrator's hands: open a batch, hire an agent, settle it, close.
 *
 *   WARDA_SK=$(cat ../covenant/deploy/warda-testnet.key) \
 *     node --experimental-strip-types tools/batch.ts hire scout \
 *       --payee <x-only> --agent-key <x-only> --budget 0.5 --max-per-spend 0.05
 *
 * Every verb checks the covenant's rules FIRST, in English, before anything is
 * built or broadcast — see `src/hiring.ts` for why that is worth a module.
 * Nothing here re-implements an operation: the SDK's own tools do the building,
 * the fee correction and the manifest advancement, exactly as the `warda` CLI
 * spawns them.
 *
 * Amounts are in KAS, for the reason the CLI switched: a budget off by a
 * factor of ten is invisible in sompi, and it is a grant ten times more
 * permissive than anyone intended.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EMPTY_RESERVE,
  RecipientSet,
  decodeAddress,
  templateIdFor,
  toHex,
  type CovenantTemplate,
  type GrantState,
} from "@warda_protocol/kaspa";
import rawTemplate from "@warda_protocol/kaspa/covenant-template.json" with { type: "json" };

/* `as unknown as`: the JSON import infers every number as `number`, and a
   template's state fields are bigint because sompi are u64. */
const TEMPLATE = rawTemplate as unknown as CovenantTemplate;
import { checkHire, checkSettle, hireTerms, uncommitted, type JobSpec } from "../src/hiring.ts";
import { childManifestPath, load, note, runTool, save, txidFrom, type BatchRecord } from "../src/batch.ts";

const SOMPI = 100_000_000n;

function toSompi(kas: string): bigint {
  const t = kas.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`not an amount in KAS: "${kas}"`);
  const [whole, frac = ""] = t.split(".");
  if (frac.length > 8) throw new Error(`KAS has eight decimal places; "${kas}" has ${frac.length}`);
  return BigInt(whole!) * SOMPI + BigInt(frac.padEnd(8, "0") || "0");
}
const toKas = (v: bigint) => {
  const f = (v % SOMPI).toString().padStart(8, "0").replace(/0+$/, "");
  return f ? `${v / SOMPI}.${f}` : `${v / SOMPI}`;
};

const argv = process.argv.slice(2);
const verb = argv[0];
const flag = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : fallback;
};
const has = (name: string) => argv.includes(`--${name}`);

const BATCH = resolve(flag("batch", "batch.json")!);
/** The parent's member list, as given: a path or an inline list. */
const PAYEES = flag("payees") ?? "";
/**
 * The same list, in a form the SPAWNED tool can read.
 *
 * `runTool` runs with the SDK as its working directory, so a relative path
 * that resolves here resolves somewhere else there — and the failure is
 * `no such file: payees.txt` from a tool that is looking in a directory the
 * person never typed. Absolute when it is a file; untouched when it is an
 * inline list, which has no directory to be relative to.
 */
const PAYEES_ARG = PAYEES && existsSync(PAYEES) ? resolve(PAYEES) : PAYEES;
const SDK = resolve(flag("sdk", "../sdk")!);
const TOOLS = `${SDK}/tools`;

function die(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}

/**
 * The parent's live state, read the way `build-delegation.ts` reads it.
 *
 * Field for field, including `reserve_root ?? EMPTY_RESERVE` — a manifest
 * predating that field has never delegated, so empty is right for it, and a
 * parent that HAS delegated is not at empty and its address depends on the
 * difference. Two readers that disagree about a grant's state disagree about
 * its address, which is the same as disagreeing about whether it exists.
 *
 * `templateId` is DERIVED from the template and the authority rather than read:
 * a stated id belonging to another covenant produces a plausible address with
 * nothing at it.
 */
function parentState(batch: BatchRecord): { state: GrantState; members: RecipientSet } {
  const m = JSON.parse(readFileSync(batch.manifest, "utf8"));
  const authority = { principalKey: String(m.principal), revocationKey: String(m.revocation ?? m.principal) };
  const state: GrantState = {
    agentKey: String(m.agent),
    budgetTotal: BigInt(m.budget),
    maxPerSpend: BigInt(m.max_per_spend),
    epochLimit: BigInt(m.epoch_limit),
    epochLength: BigInt(m.epoch_length),
    recipientsRoot: String(m.recipients_root),
    notBefore: BigInt(m.not_before),
    expiresAt: BigInt(m.expires_at),
    delegationDepth: BigInt(m.delegation_depth),
    templateId: templateIdFor(TEMPLATE, authority),
    spentTotal: BigInt(m.spent_total),
    reserved: BigInt(m.reserved),
    epochIndex: BigInt(m.epoch_index),
    epochSpent: BigInt(m.epoch_spent),
    reserveRoot: String(m.reserve_root ?? EMPTY_RESERVE),
  };

  /* The allowlist is NOT in the manifest — only its root is. That is not an
     omission to work around: a root cannot produce the witness a narrowed
     child needs, which is exactly why the quickstart says to keep the payees
     file and why losing it leaves a grant that can be revoked and never
     delegated. So the file is an argument, and it is checked against the root
     before anything is built. */
  const spec = PAYEES || die(
    "hire needs --payees <file|csv>: the parent's full member list.\n\n" +
      "A manifest records the allowlist's ROOT, not its members, and a child's narrowed " +
      "list is proved by a path through the parent's tree — which a root alone cannot " +
      "produce. This is the payees file the grant was created with.",
  );
  const raw = existsSync(spec) ? readFileSync(spec, "utf8") : spec;
  const members = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase()));
  if (members.length === 0) die(`no members in ${spec}`);

  const set = new RecipientSet(members);
  if (toHex(set.root) !== state.recipientsRoot) {
    die(
      `the list in ${spec} does not rebuild this grant's root.\n` +
        `  grant : ${state.recipientsRoot}\n` +
        `  list  : ${toHex(set.root)}\n` +
        `A spend proves against the root, so a list that disagrees with it can produce no ` +
        `valid proof. One of the two belongs to a different grant.`,
    );
  }
  return { state, members: set };
}

async function main() {
  switch (verb) {
    case "open": {
      if (existsSync(BATCH)) die(`${BATCH} already exists. Close it, or pass --batch elsewhere.`);
      const manifest = flag("manifest") ?? die("open needs --manifest <grant.json>: the batch's parent grant");
      if (!existsSync(manifest)) die(`no grant manifest at ${manifest}`);
      const batch: BatchRecord = {
        name: flag("name", "batch")!,
        network: process.env.WARDA_NETWORK ?? "testnet-10",
        manifest: resolve(manifest),
        openedAt: new Date().toISOString(),
        closedAt: null,
        outstanding: [],
        log: [],
      };
      note(batch, { what: "open", who: batch.name, detail: batch.manifest });
      save(BATCH, batch);
      const { state } = parentState(batch);
      console.error(`batch ${batch.name} open`);
      console.error(`  can commit : ${toKas(uncommitted(state))} KAS`);
      console.error(`  depth      : ${state.delegationDepth} (children may be ${state.delegationDepth - 1n})`);
      console.error(`  ends at    : DAA ${state.expiresAt}`);
      return;
    }

    case "hire": {
      const batch = load(BATCH);
      const name = argv[1] ?? die("hire needs a name: `hire scout`");
      const { state, members } = parentState(batch);
      const job: JobSpec = {
        name,
        agentKey: (flag("agent-key") ?? die("hire needs --agent-key: the sub-agent's x-only key, which it generated")).toLowerCase(),
        payee: (flag("payee") ?? die("hire needs --payee: the ONE address this agent may pay")).toLowerCase(),
        budgetSompi: toSompi(flag("budget") ?? die("hire needs --budget, in KAS")),
        maxPerSpendSompi: toSompi(flag("max-per-spend") ?? die("hire needs --max-per-spend, in KAS")),
        epochLimitSompi: flag("epoch-limit") ? toSompi(flag("epoch-limit")!) : undefined,
        windowDaa: flag("window") ? BigInt(flag("window")!) : undefined,
      };

      /* Before anything is built. Each of these is a refusal the chain would
         also make, in a script error, after a fee.

         `now` is the grant's OWN notBefore rather than the chain's tip, because
         this verb opens no node — the tool it spawns does. That makes the
         window check OPTIMISTIC: a term measured from the grant's opening can
         fit inside the parent when the same term measured from the tip would
         not, and this would wave it through. `build-delegation` makes the
         authoritative check against the live DAA and refuses, so the cost is a
         second error rather than a bad grant — but the error arrives later and
         from further away, which is the thing this module exists to avoid.
         Worth reading the tip here once there is a reason to open a node. */
      const now = state.notBefore;
      const refusals = checkHire(state, members, job, now);
      if (refusals.length) {
        console.error(`cannot hire ${name}:\n`);
        for (const r of refusals) console.error(`  [${r.code}] ${r.detail}\n`);
        process.exit(2);
      }

      const terms = hireTerms(state, job, now);
      const args = [
        `${TOOLS}/build-delegation.ts`,
        batch.manifest,
        "--child-key", terms.agentKey,
        "--budget", String(terms.budgetTotal),
        "--max-per-spend", String(terms.maxPerSpend),
        "--epoch-limit", String(terms.epochLimit),
        "--depth", String(terms.delegationDepth),
        /* BOTH lists, and the second is not redundant. The child commits to a
           NODE of the parent's tree, and the delegation carries the path from
           that node up to the parent's root — which only the parent's full
           member set can produce. Passing the subset alone was the first thing
           this orchestrator got wrong against a live grant, and the tool
           refused it, which is the only reason it cost nothing. */
        "--child-recipients", terms.recipients.join(","),
        "--recipients", PAYEES_ARG,
      ];
      if (job.windowDaa !== undefined) args.push("--window", String(job.windowDaa));
      if (has("submit")) args.push("--submit");

      /* What would be run, for a person who would rather read it than trust
         it. Exists because the missing flag above was invisible until a live
         grant said so. */
      if (has("dry-run")) {
        /* Flag and value on ONE line. Splitting them is what a naive join
           does, and it makes the thing you are trying to read — which value
           went with which flag — the one thing the output does not show. */
        const lines: string[] = [];
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!;
          const next = args[i + 1];
          if (a.startsWith("--") && next !== undefined && !next.startsWith("--")) {
            lines.push(`${a} ${next}`);
            i += 1;
          } else {
            lines.push(a);
          }
        }
        console.error(["node --experimental-strip-types", ...lines].join(" \\\n  "));
        return;
      }

      const result = await runTool(args[0]!, args.slice(1), SDK);
      if (result.code !== 0) die(`\nbuild-delegation refused this delegation; nothing was recorded.`, result.code);

      /* Recorded AFTER the tool succeeds and BEFORE anything else: the stack is
         the only record of which child may be settled next, and the chain will
         not reproduce it — the reserve is a hash chain, so it proves how much
         is reserved and not by whom. */
      batch.outstanding.push({
        name,
        agentKey: terms.agentKey,
        manifest: childManifestPath(batch.manifest, terms.agentKey),
        reservedSompi: String(terms.budgetTotal),
        hiredAt: new Date().toISOString(),
      });
      note(batch, {
        what: "hire", who: name, sompi: String(terms.budgetTotal),
        txid: txidFrom(result) ?? undefined,
        detail: `may pay ${job.payee.slice(0, 16)}… and nothing else`,
      });
      save(BATCH, batch);
      console.error(`\nhired ${name}: ${toKas(terms.budgetTotal)} KAS, one payee, depth ${terms.delegationDepth}`);
      /* `build-delegation` will have said "payees: inherited" here, and that is
         not a narrowing that failed. A subset witness over a set of ONE is the
         whole set, so `subtree` returns the root with an empty proof — the
         "inherit everything" case, by construction. The child may still pay
         only that address; the bound is the parent's own allowlist rather than
         a path through it. Said out loud because "inherited" reads like a
         security property that did not take. */
      if (members.members.length === 1) {
        console.error(
          `  the parent's allowlist has one member, so narrowing is a no-op — ` +
            `"inherited" and "narrowed" describe the same single address here.`,
        );
      }
      if (job.epochLimitSompi === undefined) {
        console.error(
          `  no --epoch-limit given, so it inherited the parent's ` +
            `(${toKas(terms.epochLimit)} KAS). With a child budget of ` +
            `${toKas(terms.budgetTotal)} KAS that is no rate limit at all.`,
        );
      }
      if (!has("submit")) console.error(`not broadcast. Re-run with --submit when the transaction looks right.`);
      return;
    }

    case "settle": {
      const batch = load(BATCH);
      const name = argv[1] ?? die("settle needs a name: `settle scout`");
      const child = batch.outstanding.find((c) => c.name === name)
        ?? die(`no outstanding child called ${name}. \`status\` lists them.`);

      const check = checkSettle(batch.outstanding, child.agentKey);
      if (!check.ok) die(`cannot settle ${name}:\n\n  ${check.detail}\n`, 2);

      const args = [`${TOOLS}/build-settlement.ts`, batch.manifest, child.manifest];
      if (has("submit")) args.push("--submit");
      const result = await runTool(args[0]!, args.slice(1), SDK);
      if (result.code !== 0) die(`\nbuild-settlement refused; ${name} is still outstanding.`, result.code);

      batch.outstanding.pop();
      note(batch, { what: "settle", who: name, txid: txidFrom(result) ?? undefined });
      save(BATCH, batch);
      console.error(`\nsettled ${name}. Its reserve is released and the parent is charged what it spent.`);
      return;
    }

    case "status": {
      const batch = load(BATCH);
      const { state } = parentState(batch);
      console.error(`batch ${batch.name} · ${batch.network}${batch.closedAt ? " · closed" : ""}`);
      console.error(`  budget    : ${toKas(state.budgetTotal)} KAS`);
      console.error(`  spent     : ${toKas(state.spentTotal)} KAS`);
      console.error(`  reserved  : ${toKas(state.reserved)} KAS in ${batch.outstanding.length} outstanding`);
      console.error(`  can commit: ${toKas(uncommitted(state))} KAS`);
      if (batch.outstanding.length) {
        console.error(`\n  settle order (last first):`);
        for (const c of [...batch.outstanding].reverse()) {
          console.error(`    ${c.name.padEnd(12)} ${toKas(BigInt(c.reservedSompi)).padStart(8)} KAS  ${c.manifest}`);
        }
      }
      console.error(`\n  ${batch.log.length} entries in the log`);
      return;
    }

    case "close": {
      const batch = load(BATCH);
      if (batch.outstanding.length) {
        die(
          `${batch.outstanding.length} child grant(s) are still outstanding, newest first: ` +
            `${[...batch.outstanding].reverse().map((c) => c.name).join(", ")}.\n` +
            `Settle them in that order, or let them expire — but a batch closed with children ` +
            `outstanding loses the record of which one may be settled next, and the chain ` +
            `cannot reproduce it.`,
          2,
        );
      }
      batch.closedAt = new Date().toISOString();
      note(batch, { what: "close", who: batch.name });
      save(BATCH, batch);
      console.error(`batch ${batch.name} closed. The parent grant is untouched; revoke or reclaim it separately.`);
      return;
    }

    default:
      console.error(
        `warda growth — agents hiring agents, under authority the network enforces\n\n` +
          `  batch.ts open   --manifest <grant.json> [--name <label>]\n` +
          `  batch.ts hire   <name> --agent-key <hex> --payee <hex> --budget <KAS> --max-per-spend <KAS>\n` +
          `                         [--epoch-limit <KAS>] [--window <daa>] [--submit]\n` +
          `  batch.ts settle <name> [--submit]\n` +
          `  batch.ts status\n` +
          `  batch.ts close\n\n` +
          `WARDA_SK signs. Amounts are KAS. Children settle newest first.\n`,
      );
      process.exit(verb ? 1 : 0);
  }
}

void main().catch((e: Error) => die(e.message));
