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
