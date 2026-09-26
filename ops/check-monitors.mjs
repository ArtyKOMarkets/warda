#!/usr/bin/env node
// Are the endpoint monitors wired to a person, and does that wiring work?
//
//     node ops/check-monitors.mjs
//
// ## Why this exists
//
// ops/check-verify.sh was written because /v1/verify answered `internal` to
// every request for days and nothing said so. It was then scheduled to append
// its exit code to ~/Library/Logs/warda-verify.log, which is the same outage
// with better records. ops/monitor.sh turns those exit codes into messages;
// this file is what stops that from quietly coming undone again.
//
// Four ways it could come undone, one check each:
//
//   a new monitor is scheduled without the wrapper
//   a fifth copy of the Telegram curl appears instead of ops/notify.sh
//   the state file gets committed, so one laptop's incident ships to everyone
//   the wrapper's own self-test rots into something that cannot fail
//
// The last one is the only interesting check here. A green self-test proves
// nothing on its own: an assertion that has never fired is indistinguishable
// from one that cannot. So this breaks monitor.sh on purpose — one mutation,
// alerting on every run instead of on the edge — and requires the self-test
// to go RED. If it stays green, the self-test is decoration and this fails.
import { readFileSync, writeFileSync, mkdtempSync, rmSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OPS = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(OPS);
const problems = [];
const read = (p) => readFileSync(join(REPO, p), "utf8");

// ---------------------------------------------------------------- 1. wrapped
//
// Any cron entry that runs one of the ops/check-*.sh probes has to go through
// the wrapper. Written as a property of the ENTRY lines rather than a list of
// three names, so the next monitor somebody adds is covered before they think
// about it.
const cron = read("ops/install-cron.sh");

/* The entries name their scripts through variables — VERIFY, VENDOR,
   NODECHK, TURNKEY — so this resolves the assignments rather than listing the
   variable names. The first version listed them, and the fourth monitor added
   after it was invisible to this check on the day it was written: a checker
   that has to be edited whenever the thing it checks grows is a checker that
   silently stops covering the newest case, which is always the one most
   likely to be wrong. */
const vars = new Map();
for (const m of cron.matchAll(/^([A-Z][A-Z0-9_]*)="([^"]*)"/gm)) vars.set(m[1], m[2]);
/* Repeatedly, because the values nest: MONITOR is "$OPS/monitor.sh" and
   VERIFY is "$OPS/check-verify.sh", so one pass leaves a fresh $OPS behind and
   the entry still does not look like it names a check script. One pass found
   exactly one of the four monitors — the one that happened to spell its path
   out — and reported the other three as not needing to be checked. */
const expand = (s) => {
  let out = s;
  for (let i = 0; i < 8; i++) {
    const next = out.replace(/\$([A-Z][A-Z0-9_]*)/g, (whole, name) => vars.get(name) ?? whole);
    if (next === out) break;
    out = next;
  }
  return out;
};

for (const line of cron.split("\n")) {
  const m = line.match(/^([A-Z]+ENTRY)="([^"]*)"/);
  if (!m) continue;
  const entry = m[2];
  if (!/ops\/check-[a-z]+\.sh/.test(expand(entry))) continue;
  if (!entry.includes("$MONITOR")) {
    problems.push(
      `ops/install-cron.sh: ${m[1]} schedules a check without ops/monitor.sh, so its\n` +
        `  failures go to a log file and nowhere else:\n    ${entry}`,
    );
  }
}

// -------------------------------------------------------- 1c. and the SPENDERS
//
// The rule above covers `ops/check-*.sh` probes, which is what a monitor meant
// when it was written: an endpoint, watched from outside. It did not cover the
// jobs that hold money.
//
// So on 25 September the Listener, agent-003 and agent-005 failed every purchase
// for twenty-one hours. All three wrappers translated buy.ts's exit code into a
// careful sentence and appended it to ~/Library/Logs, and the monitors that had
// been built to stop exactly this were pointed at three HTTP endpoints, all of
// which were fine the whole time.
//
// Named explicitly, unlike 1's property, because there is no textual signal that
// an entry spends — and the list being short and hand-written is the point: a
// fourth spender is something somebody has to add here, which is a smaller
// mistake than never noticing it was never watched.
const SPENDERS = [
  ["BUYENTRY", "agent-003's daily digest buy"],
  ["INTEROPENTRY", "agent-005's daily interop buy"],
  ["GROWTHENTRY", "the growth fleet's weekly batch"],
  ["LISTENERENTRY", "the Listener's twice-daily pass"],
];
for (const [name, what] of SPENDERS) {
  const entry = vars.get(name);
  if (!entry) {
    problems.push(`ops/install-cron.sh has no ${name}. ${what} is named here and does not exist there.`);
    continue;
  }
  if (!entry.includes("$MONITOR")) {
    problems.push(
      `ops/install-cron.sh: ${name} (${what}) SPENDS and does not go through\n` +
        `  ops/monitor.sh, so a run that could not buy reports into a log file. That is\n` +
        `  the twenty-one-hour outage of 25 September, exactly:\n    ${entry}`,
    );
    continue;
  }
  /* CONFIRM=2 is right for a probe firing every fifteen minutes and wrong for a
     job firing once a day: it would wait a full day before saying anything, and
     there is no blip to ride out — a purchase either happened or it did not. */
  if (!/WARDA_MONITOR_CONFIRM=1/.test(entry)) {
    problems.push(
      `ops/install-cron.sh: ${name} (${what}) is wrapped but keeps CONFIRM=2, so the\n` +
        `  first failed run says nothing and the alert waits for the NEXT scheduled run —\n` +
        `  a day later, or a week for the weekly one.`,
    );
  }
}

// ------------------------------------------------- 1d. and they mean the same thing
//
// `agents/tools/buy.ts` calls its exit codes "the API when you call this from
// another language", and ops/monitor.sh is now one of the callers. If the two
// drift, the wrapper reports a covenant refusal as an outage or — far worse — a
// paid-and-unserved purchase as something to retry.
const buy = read("agents/tools/buy.ts");
const mon = read("ops/monitor.sh");
const CODES = [
  [3, /3\s+refused/, /\[ "\$code" = 3 \]/, "the covenant refused; nothing was spent"],
  [4, /4\s+paid, unserved/, /\[ "\$code" = 4 \]/, "paid and not served"],
];
for (const [code, inBuy, inMon, meaning] of CODES) {
  if (!inBuy.test(buy)) {
    problems.push(
      `agents/tools/buy.ts no longer documents exit ${code} (${meaning}) in its usage text.\n` +
        `  ops/monitor.sh reads that code and words its alert from it; the two are a protocol.`,
    );
  }
  if (!inMon.test(mon)) {
    problems.push(
      `ops/monitor.sh no longer handles exit ${code} (${meaning}), so it reports it as\n` +
        `  "is DOWN" — which for ${code === 3 ? "a grant enforcing its own terms" : "money already spent"} is the wrong sentence.`,
    );
  }
}
/* 4 is the one that must not be edge-triggered: every occurrence is another
   payment, so suppressing the second one suppresses a second loss. */
if (!/Do NOT re-run to compensate/.test(mon)) {
  problems.push(
    'ops/monitor.sh\'s exit-4 alert no longer says not to re-run. Re-running is the\n' +
      "  instinct, the proof is resumable, and the alert is where that has to be said.",
  );
}
/* And listen.ts must not squat on 4. It exits 5 for "every buy failed", which is
   the opposite situation — nothing spent — and wearing 4 would tell a person
   money was gone. */
if (/process\.exit\(4\)/.test(read("growth/tools/listen.ts"))) {
  problems.push(
    "growth/tools/listen.ts exits 4, which buy.ts defines as paid-and-unserved and\n" +
      "  ops/monitor.sh alerts on every single time. Its own condition is that NOTHING was\n" +
      "  spent. Use 5.",
  );
}

// ---------------------------------------------------------------- 1b. one predicate
//
// install-cron.sh warns when the wrapper has no way to speak — the one moment
// a person is standing there to hear it. It first asked that question with a
// regex, `TOKEN="."`, which matches a one-character token and nothing longer,
// so it fired on a fully configured machine. A warning that is wrong when
// things are right is worse than no warning at all, because the time it is
// right looks identical. It has to ask the sender, not guess at the file.
if (!/warda_notify_configured/.test(cron)) {
  problems.push(
    "ops/install-cron.sh decides whether alerting is configured without calling\n" +
      "  warda_notify_configured. Anything else is a second opinion about the same\n" +
      "  question, and the two can disagree — the regex it replaced did.",
  );
}

// ---------------------------------------------------------------- 2. one send path
const senders = spawnSync("grep", ["-rl", "api.telegram.org", join(REPO, "ops")], {
  encoding: "utf8",
}).stdout.trim().split("\n").filter(Boolean);
for (const f of senders) {
  const rel = f.slice(REPO.length + 1);
  if (!rel.endsWith(".sh")) continue; // alerts.ts has ops/check-alerts.mjs; .env files hold the token
  if (rel === "ops/notify.sh") continue;
  problems.push(
    `${rel} sends to Telegram directly. There is one send path, ops/notify.sh —\n` +
      `  four copies of that curl is why the endpoint monitors never got one.`,
  );
}

// ------------------------------------------------- 2b. and the scripts can run
//
// Every `.sh` in ops/ has to be mode 755 IN GIT, not just on this laptop.
//
// install-cron.sh chmods what it installs, which covers the machine standing in
// front of it and nothing else: a mode lost in a commit reaches every fresh
// clone and CI, and the entry is still in the crontab saying the job exists.
// That file's own comment puts it better than this one can — "installing a
// schedule of commands that cannot run is worse than installing nothing."
//
// Added because the commit that wired the spenders to the monitors dropped
// install-cron.sh's exec bit: a Python rewrite of the file wrote it back at 644,
// `git commit` recorded the mode change, and nothing would have said so until
// somebody cloned the repo and ran the installer. The same way check-vendor.sh
// lost its bit, which is why the chmod loop exists at all.
const modes = spawnSync("git", ["ls-files", "-s", "ops"], { cwd: REPO, encoding: "utf8" }).stdout ?? "";
for (const line of modes.split("\n")) {
  const m = line.match(/^(\d{6}) \S+ \d+\t(ops\/.+\.sh)$/);
  if (!m) continue;
  if (m[1] !== "100755") {
    problems.push(
      `${m[2]} is mode ${m[1]} in git, so a fresh clone cannot execute it. cron would\n` +
        `  fail on it every time it fired, into a log whose purpose is to be empty:\n` +
        `    git update-index --chmod=+x ${m[2]}`,
    );
  }
}

// ---------------------------------------------------------------- 3. state stays local
if (!/^ops\/monitor-state\/$/m.test(read(".gitignore"))) {
  problems.push(
    ".gitignore does not ignore ops/monitor-state/. It records whether THIS\n" +
      "  machine has already alerted; committed, it tells another machine an\n" +
      "  incident it never had was already announced.",
  );
}

// ---------------------------------------------------------------- 4. the self-test can fail
const run = (script, args) =>
  spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, WARDA_REPO: REPO, WARDA_MONITOR_NO_ENV: "1" },
    timeout: 120_000,
  });

const honest = run(join(OPS, "monitor.sh"), ["--selftest"]);
if (honest.status !== 0) {
  problems.push(`ops/monitor.sh --selftest fails:\n${(honest.stdout || honest.stderr || "").trim()}`);
}

// The mutation: alert on every failed run rather than on the edge. That is the
// behaviour every sending script in ops/ has a comment warning against, and it
// is the one a tired hand would reintroduce while "making sure we hear about
// it". The self-test exists to catch it, so it must.
const dir = mkdtempSync(join(tmpdir(), "warda-monitor-"));
try {
  const src = read("ops/monitor.sh");
  const edge = 'elif [ "$m_announced" = 1 ] && [ $((now - m_notified)) -ge "$REMIND" ]; then';
  if (!src.includes(edge)) {
    problems.push(
      "ops/check-monitors.mjs cannot find the reminder condition it mutates in\n" +
        "  ops/monitor.sh. The check is not testing what it says it tests — fix the\n" +
        "  mutation here rather than deleting it.",
    );
  } else {
    const mutant = join(dir, "monitor.sh");
    writeFileSync(mutant, src.replace(edge, 'elif [ "$m_announced" = 1 ]; then'));
    chmodSync(mutant, 0o755);
    const broken = run(mutant, ["--selftest"]);
    if (broken.status === 0) {
      problems.push(
        "ops/monitor.sh --selftest passes on a monitor that alerts on EVERY failed\n" +
          "  run — ninety-six messages a day for one outage. A self-test that cannot\n" +
          "  fail is not evidence the alerting works.",
      );
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ----------------------------------------------------------------
if (problems.length) {
  console.error("check-monitors: " + problems.length + " problem(s)\n");
  for (const p of problems) console.error("- " + p + "\n");
  process.exit(1);
}
console.log("check-monitors: monitors wrapped · one send path · state local · self-test fails when it should");
