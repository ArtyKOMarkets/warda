/**
 * One week of the growth fleet, unattended.
 *
 *   source ops/node.env
 *   node --experimental-strip-types growth/tools/week.ts            this week's batch, or resume it
 *   node --experimental-strip-types growth/tools/week.ts --dry-run  search and plan; nothing on chain
 *
 * Run weekly by ops/weekly-growth.sh. Every step is recorded in
 * growth/batches/<week>/week.json before the next starts, so a run that stops
 * half way — a node down, a refusal — resumes at the step that stopped rather
 * than paying for anything twice. src/week.ts has the steps and the numbers.
 *
 * ## Who signs what
 *
 *   genesis, revoke     the principal (GROWTH_FUNDER_KEY) — it funds the batch and can end all of it
 *   hire, settle        the orchestrator — only a grant's agent may delegate or reabsorb
 *   settle (the child)  the principal again, as revocation key, so a silent child cannot lock the budget
 *   buy                 Scout — its grant may pay Researcher and nobody else
 *   drafts              nobody: Outreach holds no key and sends nothing
 *
 * Keys are read from files by the step that needs them and passed only to the
 * tool that signs. None is printed, and none goes to anything that does not sign.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { childManifestPath, txidFrom, type RunResult } from "../src/batch.ts";
import { scout, type Candidate } from "../src/scout.ts";
import { draft, draftsMarkdown } from "../src/outreach.ts";
import { githubFetcher } from "../src/service.ts";
import {
  kas, nextStep, plan, readPurchase, report, seenFrom, summary, weekLabel,
  type Purchase, type Step, type WeekState,
} from "../src/week.ts";

const GROWTH = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(GROWTH, "..");
const SDK = join(REPO, "sdk");
const KEYS = join(GROWTH, "keys");

const argv = process.argv.slice(2);
const has = (n: string) => argv.includes(`--${n}`);
const flag = (n: string, d?: string) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1]! : d;
};

const LABEL = flag("label", weekLabel(new Date()))!;
const NETWORK = process.env.WARDA_NETWORK ?? "testnet-10";
const RESEARCHER = (process.env.GROWTH_RESEARCHER_URL ?? "https://warda-growth.vercel.app").replace(/\/$/, "");
const RECORDS = Number(flag("records", process.env.GROWTH_RECORDS ?? "12"));
const FUNDER = process.env.GROWTH_FUNDER_KEY ?? join(REPO, "covenant/deploy/warda-testnet.key");
const PLAN = plan(RECORDS);

const B = join(GROWTH, "batches", LABEL);
const P = {
  state: join(B, "week.json"),
  grant: join(B, "grant.json"),
  batch: join(B, "batch.json"),
  payees: join(GROWTH, "payees.txt"),
  scoutPayees: join(B, "scout-payees.txt"),
  candidates: join(B, "candidates.json"),
  purchases: join(B, "purchases"),
  drafts: join(B, "drafts.md"),
  draftsJson: join(B, "drafts.json"),
  report: join(B, "report.json"),
  reportMd: join(B, "report.md"),
  lock: join(B, ".lock"),
};

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}
const key = (name: string) => readFileSync(join(KEYS, name), "utf8").trim();
const secret = (path: string) => {
  if (!existsSync(path)) die(`no key at ${path}. See growth/RUNBOOK.md, "Weekly".`);
  return readFileSync(path, "utf8").trim();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const k = (sompi: bigint) => kas(sompi);

/** A tool, with the ONE key it needs in its environment and no other. */
function run(tool: string, args: string[], cwd: string, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((done, fail) => {
    const base = { ...process.env };
    delete base.WARDA_SK;
    delete base.WARDA_REVOCATION_SK;
    const child = spawn(process.execPath, ["--experimental-strip-types", tool, ...args], {
      cwd, env: { ...base, ...env }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => { stderr += String(d); process.stderr.write(d); });
    child.on("error", fail);
    child.on("close", (code) => done({ code: code ?? 1, stdout, stderr }));
  });
}

function load(): WeekState {
  if (existsSync(P.state)) return JSON.parse(readFileSync(P.state, "utf8")) as WeekState;
  return { label: LABEL, startedAt: new Date().toISOString(), done: {} };
}
function save(s: WeekState) {
  writeFileSync(P.state, JSON.stringify(s, null, 2) + "\n");
}
function mark(s: WeekState, step: Step, extra: { txid?: string; note?: string } = {}) {
  s.done[step] = { at: new Date().toISOString(), ...extra };
  delete s.stoppedAt;
  save(s);
  console.error(`✓ ${step}${extra.txid ? ` ${extra.txid}` : ""}${extra.note ? ` — ${extra.note}` : ""}`);
}
function stop(s: WeekState, step: Step, reason: string, code = 1): never {
  s.stoppedAt = { step, reason, at: new Date().toISOString() };
  save(s);
  die(`\nstopped at ${step}: ${reason}\nRe-run to resume from here; nothing already done is repeated.`, code);
}

function purchases(dir: string): Purchase[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).flatMap((f) => {
    try {
      const p = readPurchase(JSON.parse(readFileSync(join(dir, f), "utf8")));
      return p ? [p] : [];
    } catch {
      return [];
    }
  });
}
function everyPurchase(): Purchase[] {
  const root = join(GROWTH, "batches");
  if (!existsSync(root)) return [];
  return readdirSync(root).flatMap((w) => purchases(join(root, w, "purchases")));
}
const bought = (p: Purchase) => p.outcome === "bought" || p.outcome === "served";

async function main() {
  mkdirSync(B, { recursive: true });
  if (existsSync(P.lock)) {
    const pid = Number(readFileSync(P.lock, "utf8"));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* gone */ }
    if (alive) die(`another run (pid ${pid}) is working on ${LABEL}.`, 2);
  }
  writeFileSync(P.lock, String(process.pid));
  process.on("exit", () => { try { unlinkSync(P.lock); } catch { /* already gone */ } });

  const s = load();
  console.error(`growth · ${LABEL} · ${NETWORK} · ${RECORDS} records at ${k(PLAN.priceSompi)} KAS from ${RESEARCHER}`);

  if (has("dry-run")) {
    const found = await findCandidates();
    console.error(`\nwould issue a batch grant of ${k(PLAN.parentBudget)} KAS, hire Scout with ${k(PLAN.childBudget)} KAS ` +
      `(cap ${k(PLAN.maxPerSpendChild)}, ${k(PLAN.childEpochLimit)} per epoch), and buy:`);
    for (const c of found.candidates) console.error(`  ${c.fullName.padEnd(40)} ${String(c.stars).padStart(6)}★  ${c.matched.join(", ")}`);
    for (const q of found.searched) if (q.status !== 200) console.error(`  (search "${q.label}" answered ${q.status})`);
    return;
  }

  const orchPub = key("orchestrator.key.pub");
  const scoutPub = key("scout.key.pub");
  const researcherPub = key("researcher.key.pub");
  const child = childManifestPath(P.grant, scoutPub);

  for (let step = nextStep(s); step; step = nextStep(s)) {
    switch (step) {
      case "genesis": {
        if (existsSync(P.grant)) stop(s, step, `${P.grant} exists but genesis is not recorded. Check the chain for it before anything else; do not delete it.`, 2);
        const r = await run(join(SDK, "tools/genesis.ts"), [
          "--agent", orchPub, "--recipients", P.payees,
          "--budget", String(PLAN.parentBudget), "--max-per-spend", String(PLAN.maxPerSpendParent),
          "--epoch-limit", String(PLAN.parentBudget), "--depth", "2",
          "--window", String(PLAN.parentWindowDaa), "--out", P.grant, "--submit",
        ], SDK, { WARDA_SK: secret(FUNDER) });
        if (r.code !== 0) stop(s, step, "genesis refused — usually the funder's largest coin is smaller than the batch. `warda wallet` shows it.");
        mark(s, step, { txid: txidFrom(r) ?? undefined, note: `${k(PLAN.parentBudget)} KAS, one payee: Researcher` });
        await sleep(15_000);
        break;
      }
      case "open": {
        const r = await run(join(GROWTH, "tools/batch.ts"), ["open", "--batch", P.batch, "--manifest", P.grant, "--payees", P.payees, "--name", LABEL, "--sdk", SDK], GROWTH);
        if (r.code !== 0) stop(s, step, "the batch did not open");
        mark(s, step);
        break;
      }
      case "scout": {
        const found = await findCandidates();
        writeFileSync(P.candidates, JSON.stringify(found, null, 2) + "\n");
        mark(s, step, { note: `${found.candidates.length} candidates` });
        break;
      }
      case "hire": {
        const { candidates } = JSON.parse(readFileSync(P.candidates, "utf8")) as { candidates: Candidate[] };
        if (!candidates.length) {
          for (const skip of ["hire", "buy", "settle"] as Step[]) mark(s, skip, { note: "no candidates this week — nobody hired" });
          break;
        }
        const budget = BigInt(candidates.length) * PLAN.priceSompi;
        let r: RunResult | null = null;
        for (let attempt = 1; attempt <= 4; attempt++) {
          r = await run(join(GROWTH, "tools/batch.ts"), [
            "hire", "scout", "--batch", P.batch, "--payees", P.payees, "--sdk", SDK,
            "--agent-key", scoutPub, "--payee", researcherPub,
            "--budget", k(budget), "--max-per-spend", k(PLAN.maxPerSpendChild),
            "--epoch-limit", k(PLAN.childEpochLimit > budget ? budget : PLAN.childEpochLimit),
            "--window", String(PLAN.childWindowDaa), "--submit",
          ], GROWTH, { WARDA_SK: key("orchestrator.key") });
          if (r.code === 0) break;
          if (existsSync(child)) break; // it may have broadcast; do not try again blind
          if (attempt < 4) { console.error(`hire attempt ${attempt} failed; the batch grant may not be visible yet. Waiting.`); await sleep(20_000); }
        }
        if (!r || r.code !== 0) stop(s, step, "the delegation was refused. `node --experimental-strip-types growth/tools/batch.ts status --batch " + P.batch + "` shows the parent.");
        writeFileSync(P.scoutPayees, researcherPub + "\n");
        mark(s, step, { txid: txidFrom(r) ?? undefined, note: `Scout: ${k(budget)} KAS, may pay Researcher only` });
        await sleep(15_000);
        break;
      }
      case "buy": {
        const { candidates } = JSON.parse(readFileSync(P.candidates, "utf8")) as { candidates: Candidate[] };
        mkdirSync(P.purchases, { recursive: true });
        let misses = 0;
        for (const c of candidates) {
          const url = `${RESEARCHER}/verify?url=${encodeURIComponent(c.url)}`;
          const already = purchases(P.purchases).filter((p) => p.url === url);
          if (already.some(bought)) continue;
          if (already.some((p) => p.txid && !bought(p))) stop(s, step, `${c.fullName} was paid for and not served. Resolve it with agents/tools/buy.ts (it resumes that proof) before buying more.`, 4);
          const r = await run(join(REPO, "agents/tools/buy.ts"), [
            url, "--json", "--id", "GROWTH-SCOUT", "--grant", child, "--recipients", P.scoutPayees,
            "--out", P.purchases, "--task", `research ${c.fullName}`,
          ], REPO, { WARDA_SK: key("scout.key") });
          if (r.code === 0) { misses = 0; continue; }
          if (r.code === 3) { console.error(`the covenant refused ${c.fullName}; Scout's budget or rate is spent. Stopping purchases.`); break; }
          if (r.code === 4) stop(s, step, `PAID AND NOT SERVED for ${c.fullName}. The money is gone; do not re-run to compensate.`, 4);
          misses += 1;
          if (misses >= 2) { console.error("two purchases in a row did not complete — Researcher or GitHub is unwell. Stopping purchases; the rest can wait for next week."); break; }
        }
        const got = purchases(P.purchases).filter(bought);
        mark(s, step, { note: `${got.length} records` });
        await sleep(10_000);
        break;
      }
      case "settle": {
        const r = await run(join(GROWTH, "tools/batch.ts"), ["settle", "scout", "--batch", P.batch, "--sdk", SDK, "--submit"], GROWTH,
          { WARDA_SK: key("orchestrator.key"), WARDA_REVOCATION_SK: secret(FUNDER) });
        if (r.code !== 0) stop(s, step, "settlement refused. Scout's grant also expires on its own a day after it was hired; nothing is lost by waiting.");
        mark(s, step, { txid: txidFrom(r) ?? undefined, note: "Scout came home; the parent is charged what it spent" });
        await sleep(15_000);
        break;
      }
      case "close": {
        const r = await run(join(GROWTH, "tools/batch.ts"), ["close", "--batch", P.batch, "--sdk", SDK], GROWTH);
        if (r.code !== 0) stop(s, step, "the batch would not close");
        mark(s, step);
        break;
      }
      case "revoke": {
        const r = await run(join(SDK, "tools/build-exit.ts"), [P.grant, "--revoke", "--submit"], SDK, { WARDA_SK: secret(FUNDER) });
        if (r.code !== 0) stop(s, step, "the revocation was refused. The batch grant also ends on its own three days after genesis.");
        mark(s, step, { txid: txidFrom(r) ?? undefined, note: "the batch grant ended; the remainder went home to the principal" });
        break;
      }
      case "drafts": {
        const results = purchases(P.purchases).filter((p) => bought(p) && p.record).map((p) => draft(p.record!));
        writeFileSync(P.draftsJson, JSON.stringify(results, null, 2) + "\n");
        writeFileSync(P.drafts, draftsMarkdown(LABEL, results));
        mark(s, step, { note: `${results.filter((r) => "body" in r).length} drafts` });
        break;
      }
      case "report": {
        const cands = JSON.parse(readFileSync(P.candidates, "utf8")) as { candidates: Candidate[]; searched: { label: string; status: number; found: number }[] };
        const results = JSON.parse(readFileSync(P.draftsJson, "utf8"));
        const r = report(s, NETWORK, cands.candidates, purchases(P.purchases), results, cands.searched.map(({ label, status, found }) => ({ label, status, found })));
        writeFileSync(P.report, JSON.stringify(r, null, 2) + "\n");
        const rows = purchases(P.purchases).filter(bought).map((p) =>
          `| ${p.record?.project ?? p.url} | ${p.record?.findings.length ?? 0} | ${p.record?.unverified.length ?? 0} | ${p.record?.signals.length ?? 0} | ${p.txid ? p.txid.slice(0, 12) + "…" : "—"} |`);
        writeFileSync(P.reportMd, [
          `# Growth · ${LABEL}`, "", "```", summary(r), "```", "",
          "| project | findings | unverified | signals | payment |", "|---|---|---|---|---|", ...rows, "",
        ].join("\n"));
        /* What the site publishes as agents #009 and #010: the latest finished week. */
        writeFileSync(join(GROWTH, "current.json"), JSON.stringify({
          _comment: "The latest finished growth week. growth/tools/reading.ts turns it into the readings for agents #009 (the batch grant) and #010 (Scout).",
          label: LABEL, network: NETWORK,
          grant: P.grant, child: existsSync(child) ? child : null, purchases: P.purchases,
          payees: P.payees, scoutPayees: P.scoutPayees,
          genesis: s.done.genesis?.txid ?? null, hire: s.done.hire?.txid ?? null,
          settle: s.done.settle?.txid ?? null, revoke: s.done.revoke?.txid ?? null,
          report: r,
        }, null, 2) + "\n");
        mark(s, step);
        await notify(summary(r));
        console.log(summary(r));
        break;
      }
    }
  }
  if (!nextStep(s)) console.error(`\n${LABEL} is finished. growth/batches/${LABEL}/drafts.md is waiting for you.`);
}

async function findCandidates() {
  const seen = seenFrom(everyPurchase());
  const since = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
  const token = process.env.GITHUB_TOKEN;
  return scout(githubFetcher(token), {
    since, seen, limit: RECORDS,
    /* 10 searches a minute without a token, 30 with one. */
    pauseMs: token ? 2_500 : 7_000,
    retryAfterMs: 61_000,
  });
}

async function notify(text: string) {
  const token = (process.env.WARDA_TELEGRAM_TOKEN ?? "").trim();
  const chat = (process.env.WARDA_TELEGRAM_CHAT ?? "").trim();
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }), signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    console.error(`telegram: ${(e as Error).message} — the report is on disk regardless.`);
  }
}

void main().catch((e: Error) => die(e.stack ?? e.message));
