/**
 * One task, two agents, one coordinator, and every step on chain.
 *
 *   source ops/node.env
 *   node --experimental-strip-types growth/tools/one-job.ts --submit
 *
 * The scenario people describe when they talk about agents hiring agents: a
 * coordinator takes a job, splits it, hires specialists for the parts, and
 * each one is paid for its own piece. This does that, with the rules enforced
 * by Kaspa rather than by anybody's good behaviour, and writes a trace a
 * stranger can follow from the first transaction to the last.
 *
 * The job is real and so are the workers. RESEARCH buys a checkable record
 * about the Silverscript repository from Warda's Researcher. VERIFY buys an
 * audit of Warda's own grant covenant from the Covenant Auditor. Two
 * different jobs, two different sellers, both already running and neither of
 * them told anything about this demonstration.
 *
 * ## Three keys, three roles
 *
 * The coordinator has a key of its own. It signs the genesis spend and both
 * delegations and never signs a purchase; each worker signs its own purchase
 * and nothing else. The stopper is a fourth key the ops machine holds and no
 * agent here has, so any of this can be halted without the agents' agreement.
 *
 * ## What each worker can and cannot do
 *
 * Each child grant is narrowed to exactly ONE payee — the seller it was hired
 * to buy from — out of a coordinator that may pay two. RESEARCH cannot pay
 * the Auditor, VERIFY cannot pay the Researcher, and neither can pay anybody
 * else, at any price, however their code is written. That is the subset
 * witness, and it is the part worth watching.
 *
 * ## Three things this does NOT show, all of them deliberate
 *
 * **It is not atomic.** Everyone joining one agreement in a single step is
 * the shape people usually describe, and it is exactly what the covenant
 * forbids: `#[covenant.fanout(to = 2)]` fixes the topology at parent plus ONE
 * child. Two workers is two delegations.
 *
 * **They are not even concurrent.** A grant is one UTXO, so the second
 * delegation's input is the first one's output and does not exist until it
 * confirms. Hiring is serial by construction.
 *
 * **The workers had to be known before the job existed.** A grant's payee set
 * is fixed at genesis and a child may only narrow it, so a coordinator can
 * hire from the cast it was created with and nobody else. An agent discovered
 * at run time cannot be paid, at any delegation depth. That is the honest
 * distance between this and an open market, and no amount of tooling closes
 * it — it needs the covenant to change.
 *
 * ## Resumable
 *
 * Every step records itself. A step that already ran is skipped, so a failure
 * halfway costs the rest of that step and nothing before it — which matters
 * when the failure is after a genesis that broadcast.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childManifestPath } from "../src/batch.ts";
import { MASS_CEILING, PLAN, preflight } from "../src/one-job-plan.ts";

const GROWTH = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(GROWTH, "..");
const SDK = join(REPO, "sdk");
const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : d;
};
const die = (m: string, c = 1): never => { console.error(m); process.exit(c); };

const DIR = join(REPO, flag("dir", "one-job")!);
const P = {
  state: join(DIR, "state.json"),
  grant: join(DIR, "grant.json"),
  batch: join(DIR, "batch.json"),
  payees: join(DIR, "payees.txt"),
  researchPayees: join(DIR, "research-payees.txt"),
  verifyPayees: join(DIR, "verify-payees.txt"),
  purchases: join(DIR, "purchases"),
  trace: join(DIR, "trace.json"),
  keys: join(DIR, "keys"),
};

/* The two sellers, by the key their coin is paid to. Both are listed in
   site/services.json and each one publishes the same key at its own
   /.well-known/warda-service.json, so a reader can check that the
   coordinator's allowlist names the services this claims and not two addresses
   chosen here. Each worker's cap below is its seller's listed price to the
   sompi, which is why a worker cannot overpay even by mistake. */
const RESEARCHER_PAYEE = "254385aa03abefa14e997d01ad5e6b8c13ca4aba7b030d675ca5922c39f8af48";
const AUDITOR_PAYEE = "8e5ec153d5e3f099b64d90d8664acb62133d86fc64e693d7330a3dc4abf12724";
const RESEARCHER_URL = (process.env.GROWTH_RESEARCHER_URL ?? "https://warda-growth.vercel.app").replace(/\/$/, "");
const AUDITOR_URL = (process.env.AUDITOR_URL ?? "https://warda-node.tailc0c0ec.ts.net:8443").replace(/\/$/, "");
const TARGET_REPO = flag("target", "https://github.com/kaspanet/silverscript")!;
const COVENANT = join(REPO, "covenant/warda_grant.sil");

const FUNDER = process.env.GROWTH_FUNDER_KEY ?? join(REPO, "covenant/deploy/warda-testnet.key");
const REVOKER = process.env.GROWTH_REVOCATION_KEY ?? join(REPO, "ops/warda-revocation.key");
const KNOWN_KEYS = join(REPO, "ops/known-keys.json");

const STEPS = ["keys", "genesis", "open", "hire-research", "hire-verify",
               "buy-research", "buy-verify", "settle-verify", "settle-research",
               "close", "trace"] as const;
type Step = (typeof STEPS)[number];
interface State { startedAt: string; done: Partial<Record<Step, { at: string; txid?: string; note?: string }>>; stoppedAt?: { step: Step; reason: string; at: string } }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const kas = (s: bigint) => (Number(s) / 1e8).toString();
const secret = (p: string) => existsSync(p) ? readFileSync(p, "utf8").trim() : die(`no key at ${p}`);

/* The PUBLIC half of the revocation key, by the name ops/known-keys.json gives
   it — the same lookup ops/grants.ts does, so this run cannot end up naming a
   different stopper than every other grant issued from here. The secret half
   sits in REVOKER and is read only to settle. */
function revocationKey(): string {
  if (!existsSync(KNOWN_KEYS)) die(`no ${KNOWN_KEYS}: the revocation key is named there, not derived here.`);
  const inv = JSON.parse(readFileSync(KNOWN_KEYS, "utf8")) as { keys: { key: string; label: string }[] };
  const k = inv.keys.find((x) => x.label.startsWith("revocation key, for grants issued from here on"));
  if (!k) die("ops/known-keys.json names no revocation key for new grants.");
  return k!.key;
}

interface RunResult { code: number; stdout: string; stderr: string }
function run(tool: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((done, fail) => {
    const base = { ...process.env };
    delete base.WARDA_SK;
    delete base.WARDA_REVOCATION_SK;
    const c = spawn(process.execPath, ["--experimental-strip-types", tool, ...args], { cwd, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += String(d)));
    c.stderr.on("data", (d) => { stderr += String(d); process.stderr.write(d); });
    c.on("error", fail);
    c.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}
const txidFrom = (r: RunResult) => /SUBMITTED:\s*([0-9a-f]{64})/.exec(r.stdout + r.stderr)?.[1];

const load = (): State => existsSync(P.state)
  ? JSON.parse(readFileSync(P.state, "utf8")) as State
  : { startedAt: new Date().toISOString(), done: {} };
const save = (s: State) => writeFileSync(P.state, JSON.stringify(s, null, 2) + "\n");
function mark(s: State, step: Step, extra: { txid?: string; note?: string } = {}) {
  s.done[step] = { at: new Date().toISOString(), ...extra };
  delete s.stoppedAt;
  save(s);
  console.error(`✓ ${step}${extra.txid ? ` ${extra.txid}` : ""}${extra.note ? ` — ${extra.note}` : ""}`);
}
function stop(s: State, step: Step, reason: string, code = 1): never {
  s.stoppedAt = { step, reason, at: new Date().toISOString() };
  save(s);
  return die(`\nstopped at ${step}: ${reason}\nRe-run to resume; nothing already done is repeated.`, code);
}

async function main() {
  /* Before the help, before the keys, before anything is written: every
     transaction this plan implies, massed. It costs nothing and it is the
     check whose absence cost a genesis and two delegations. */
  const rows = preflight();
  const over = rows.filter((r) => r.mass > MASS_CEILING);
  console.error("storage mass, against a ceiling of " + MASS_CEILING + ":");
  for (const r of rows) {
    console.error(`  ${r.step.padEnd(18)} ${String(r.mass).padStart(8)}${r.mass > MASS_CEILING ? "   REFUSED BY CONSENSUS" : ""}`);
  }
  if (over.length) {
    die(
      `\n${over.length} of these would be refused by the network, not by the covenant.\n` +
      `Mass counts 1/value over a transaction's outputs, so what costs is what the grant has\n` +
      `LEFT after paying — a nearly-empty grant is the expensive one. Raise the budget of the\n` +
      `worker named above; its price and its cap can stay exactly as they are.`, 2);
  }
  if (!has("submit")) {
    console.error(
      "\none-job.ts plans and broadcasts a real sequence on testnet-10.\n\n" +
      "  --submit        do it\n" +
      "  --target <url>  the repository RESEARCH looks up (default: kaspanet/silverscript)\n" +
      `  --dir <name>    where it writes (default: one-job) — a fresh name is a fresh run\n\n` +
      "Needs: ops/node.env sourced, a funded funder key, and the Auditor answering.\n" +
      `Everything it writes lives in ${DIR} and every step is resumable.`,
    );
    process.exit(2);
  }
  mkdirSync(P.keys, { recursive: true });
  mkdirSync(P.purchases, { recursive: true });
  const s = load();
  const done = (x: Step) => Boolean(s.done[x]);
  const agentPub = (n: string) => readFileSync(join(P.keys, `${n}.key.pub`), "utf8").trim();
  /* Where `batch.ts hire` puts a child's manifest: beside the parent's, named
     for the first eight characters of the agent key. Derived the same way the
     orchestrator derives it, rather than guessed — an earlier version invented
     `child-<name>.json`, which nothing writes, and the run got all the way to
     the first purchase before finding out. */
  const childManifest = (n: string) => childManifestPath(P.grant, agentPub(n));
  /* Paths, made publishable. batch.ts records manifest paths that begin with
     somebody's home directory, and this file is meant to be read by strangers.
     Cutting at the run directory's own name rather than at REPO because a
     trace can be finished from a different checkout than the one that opened
     the batch — which is exactly how the first attempt published two absolute
     paths from a Mac while running somewhere else. */
  const RUN = DIR.split("/").filter(Boolean).pop()!;
  const relative = (x: string) => {
    const cut = x.lastIndexOf(`/${RUN}/`);
    return cut >= 0 ? x.slice(cut + 1) : x.split(`${REPO}/`).join("");
  };

  for (const step of STEPS) {
    /* `trace` is a projection of what the other steps recorded, not an action:
       it broadcasts nothing and reading it twice costs nothing. Re-running it
       is how a finished run picks up a better trace, so it never skips. */
    if (done(step) && step !== "trace") continue;
    switch (step) {
      case "keys": {
        /* Three keys, and the third is the point. The COORDINATOR signs the
           genesis spend and both delegations; each WORKER signs only its own
           purchase. If the coordinator and a worker shared a key, that worker
           would hold the parent too — and "RESEARCH cannot pay the Auditor"
           would be a claim about which file the script happened to read rather
           than about what the chain allows. */
        for (const n of ["coord", "research", "verify"]) {
          const out = join(P.keys, `${n}.key`);
          if (existsSync(out)) continue;
          const r = await run(join(SDK, "tools/new-key.ts"), ["--out", out], SDK);
          if (r.code !== 0) stop(s, step, `could not generate ${n}.key`);
        }
        writeFileSync(P.payees, `# The coordinator may pay these two, and nothing else, ever.\n` +
          `${RESEARCHER_PAYEE}\n${AUDITOR_PAYEE}\n`);
        writeFileSync(P.researchPayees, RESEARCHER_PAYEE + "\n");
        writeFileSync(P.verifyPayees, AUDITOR_PAYEE + "\n");
        mark(s, step, { note: "a coordinator key, two worker keys, and an allowlist of exactly two sellers" });
        break;
      }
      case "genesis": {
        const r = await run(join(SDK, "tools/genesis.ts"), [
          "--agent", readFileSync(join(P.keys, "coord.key.pub"), "utf8").trim(),
          "--recipients", P.payees,
          "--revocation", revocationKey(),
          "--budget", String(PLAN.parentBudget),
          "--max-per-spend", String(PLAN.parentMaxPerSpend),
          "--epoch-limit", String(PLAN.parentBudget),
          "--depth", "2",
          "--window", String(PLAN.parentWindowDaa),
          "--out", P.grant, "--submit",
        ], SDK, { WARDA_SK: secret(FUNDER) });
        if (r.code !== 0) stop(s, step, "genesis refused — usually the funder's largest single coin is smaller than the budget. `warda wallet` shows it.");
        mark(s, step, { txid: txidFrom(r), note: `coordinator: ${kas(PLAN.parentBudget)} KAS, two payees` });
        await sleep(15_000);
        break;
      }
      case "open": {
        const r = await run(join(GROWTH, "tools/batch.ts"),
          ["open", "--batch", P.batch, "--manifest", P.grant, "--payees", P.payees, "--name", "one-job", "--sdk", SDK], GROWTH);
        if (r.code !== 0) stop(s, step, "the batch did not open");
        mark(s, step);
        break;
      }
      case "hire-research":
      case "hire-verify": {
        const who = step === "hire-research" ? "research" : "verify";
        const terms = who === "research" ? PLAN.research : PLAN.verify;
        const payee = who === "research" ? RESEARCHER_PAYEE : AUDITOR_PAYEE;
        let r: RunResult | null = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
          r = await run(join(GROWTH, "tools/batch.ts"), [
            "hire", who, "--batch", P.batch, "--payees", P.payees, "--sdk", SDK,
            "--agent-key", agentPub(who),
            "--payee", payee,
            "--budget", kas(terms.budget), "--max-per-spend", kas(terms.cap),
            "--epoch-limit", kas(terms.epoch), "--window", String(PLAN.childWindowDaa), "--submit",
          ], GROWTH, { WARDA_SK: secret(join(P.keys, "coord.key")) });
          if (r.code === 0) break;
          if (existsSync(childManifest(who))) break;   // it may have broadcast; never try a genesis twice blind
          if (attempt < 4) { console.error(`hire ${who}: attempt ${attempt} failed, the parent may not be visible yet. Waiting.`); await sleep(20_000); }
        }
        if (!r || r.code !== 0) stop(s, step, `the delegation was refused. \`batch.ts status --batch ${P.batch}\` shows the parent.`);
        mark(s, step, { txid: txidFrom(r), note: `${who}: ${kas(terms.budget)} KAS, may pay ONE seller` });
        await sleep(15_000);
        break;
      }
      case "buy-research": {
        const url = `${RESEARCHER_URL}/verify?url=${encodeURIComponent(TARGET_REPO)}`;
        const r = await run(join(REPO, "agents/tools/buy.ts"), [
          url, "--json", "--id", "ONE-JOB-RESEARCH", "--grant", childManifest("research"),
          "--recipients", P.researchPayees, "--out", P.purchases, "--task", `research ${TARGET_REPO}`,
        ], REPO, { WARDA_SK: secret(join(P.keys, "research.key")) });
        if (r.code === 4) stop(s, step, "PAID AND NOT SERVED. The money moved; resolve with agents/tools/buy.ts rather than re-running.", 4);
        if (r.code !== 0) stop(s, step, "the research purchase did not complete");
        mark(s, step, { note: `a record about ${TARGET_REPO}` });
        break;
      }
      case "buy-verify": {
        const r = await run(join(REPO, "agents/tools/buy.ts"), [
          `${AUDITOR_URL}/v1/report`, "--json", "--id", "ONE-JOB-VERIFY", "--grant", childManifest("verify"),
          "--recipients", P.verifyPayees, "--out", P.purchases, "--data", `@${COVENANT}`,
          /* Silverscript, not JSON. buy.ts parses the body to catch the common
             case of a malformed prompt before it spends a round trip, and a
             covenant fails that check — so the type has to say what this
             actually is. The Auditor reads the raw body and does not care. */
          "--content-type", "text/plain; charset=utf-8",
          "--task", "audit warda_grant.sil",
        ], REPO, { WARDA_SK: secret(join(P.keys, "verify.key")) });
        if (r.code === 4) stop(s, step, "PAID AND NOT SERVED by the Auditor. Resolve the proof rather than re-running.", 4);
        if (r.code !== 0) stop(s, step, "the audit purchase did not complete — is the Auditor answering?");
        mark(s, step, { note: "an audit of warda_grant.sil, bought by an agent that may pay nobody else" });
        break;
      }
      case "settle-verify":
      case "settle-research": {
        /* LIFO, and not a preference: settle pops the reserve chain from the
           end, and a child settled out of order is refused before anything is
           built. VERIFY was hired second, so it comes home first. */
        const who = step === "settle-verify" ? "verify" : "research";
        const r = await run(join(GROWTH, "tools/batch.ts"),
          ["settle", who, "--batch", P.batch, "--sdk", SDK, "--submit"], GROWTH,
          { WARDA_SK: secret(join(P.keys, "coord.key")), WARDA_REVOCATION_SK: secret(REVOKER) });
        if (r.code !== 0) stop(s, step, `${who} did not settle; its reserve is still committed.`);
        mark(s, step, { txid: txidFrom(r), note: `${who} returned what it did not spend` });
        await sleep(15_000);
        break;
      }
      case "close": {
        const r = await run(join(GROWTH, "tools/batch.ts"), ["close", "--batch", P.batch, "--sdk", SDK], GROWTH);
        if (r.code !== 0) stop(s, step, "the batch would not close — something is still outstanding");
        mark(s, step);
        break;
      }
      case "trace": {
        /* What the page is built from. Every figure here came from a step that
           ran, so a claim on the page can be traced to a transaction. */
        const batch = JSON.parse(readFileSync(P.batch, "utf8")) as { log: unknown[] };
        /* The purchases, by what can be checked rather than by their contents.
           The audit is 12 KB of HTML and the record already holds it; what a
           reader needs here is which transaction bought it and a digest they
           can compare against the file. */
        const purchases = readdirSync(P.purchases).filter((f) => f.endsWith(".json")).sort().map((f) => {
          const rec = JSON.parse(readFileSync(join(P.purchases, f), "utf8")) as Record<string, unknown>;
          const body = JSON.stringify(rec.response ?? null);
          return {
            record: f,
            at: rec.at, url: rec.url, task: rec.task,
            outcome: rec.outcome, status: rec.status,
            txid: (rec.proof as { txid?: string } | undefined)?.txid ?? rec.txid,
            resumedFrom: rec.resumedFrom ?? null,
            responseBytes: body.length,
            responseSha256: createHash("sha256").update(body).digest("hex"),
          };
        });
        writeFileSync(P.trace, JSON.stringify({
          _comment: "Written by growth/tools/one-job.ts. Every txid is a transaction this run broadcast.",
          generated: new Date().toISOString(),
          target: TARGET_REPO,
          coordinator: JSON.parse(readFileSync(P.grant, "utf8")),
          plan: PLAN,
          /* Each worker's grant as it ended: the terms the covenant actually
             held it to, and — the part worth looking at — a recipientsRoot
             that is NOT the coordinator's. A child commits to a node of its
             parent's allowlist tree and carries the path from there to the
             parent's root, so these two roots differing is the narrowing,
             visible rather than asserted. */
          workers: ["research", "verify"].map((n) => ({
            name: n,
            agentKey: agentPub(n),
            payee: n === "research" ? RESEARCHER_PAYEE : AUDITOR_PAYEE,
            grant: JSON.parse(readFileSync(childManifest(n), "utf8")) as unknown,
          })),
          massed: preflight().map((r) => ({ ...r, mass: r.mass })),
          sellers: { researcher: RESEARCHER_PAYEE, auditor: AUDITOR_PAYEE },
          steps: s.done,
          purchases,
          batchLog: batch.log,
          /* A REPLACER, not a shallow map over PLAN's own entries. The first
             version mapped the top level and missed the bigints one layer down
             in `research` and `verify`, so the whole run finished and the trace
             — the only durable product of it — threw on the last line.

             It also strips the repository's absolute path. This file is meant
             to be published, and batch.ts records manifest paths that begin
             with somebody's home directory. Publishing that is a small leak
             nobody would notice until it was on a page. */
        }, (_k, v) => (typeof v === "bigint" ? String(v) : typeof v === "string" ? relative(v) : v), 2) + "\n");
        mark(s, step, { note: relative(P.trace) });
        break;
      }
    }
  }
  console.error(`\none job, two agents, ${Object.keys(s.done).length} steps. The trace is ${P.trace}.`);
}

void main().catch((e: Error) => die(e.stack ?? e.message));
