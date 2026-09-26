/**
 * A fresh keypair, printed once.
 *
 *   node --experimental-strip-types tools/new-key.ts
 *   node --experimental-strip-types tools/new-key.ts --label demo-agent \\
 *     --out ../covenant/deploy/demo-agent.key
 *   node --experimental-strip-types tools/new-key.ts --check
 *
 * Every other tool here takes keys and never makes them, which left the first
 * step of any deployment as "find a way to generate 32 random bytes" — and the
 * ways people find are usually worse than crypto.randomBytes.
 *
 * The secret goes to STDOUT and the public half to STDERR, so
 *
 *     node --experimental-strip-types tools/new-key.ts > agent.key
 *
 * writes the secret to a file and still shows you the public key. `*.key` is
 * gitignored in this repo; check that it is in yours before you redirect.
 *
 * ## On publishing a key deliberately
 *
 * The attack demo publishes an agent secret on purpose. That is safe only
 * because the key is INDEPENDENT: generated here from system randomness, never
 * derived from a funder or principal secret. A derived agent key would also be
 * safe to publish in theory — the derivation is a keyed hash and does not run
 * backwards — but "in theory" is the wrong standard for a key you are about to
 * hand to strangers. Generate a separate one.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

import { fromHex, toHex } from "../src/bytes.ts";
import { pubkeyToAddress, type NetworkPrefix } from "../src/address.ts";
import { agentPublicKey } from "../src/sign.ts";
import { resolveNetwork } from "./network.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

/* Resolved and CHECKED together: a prefix and a network that disagree
   derive a well-formed address on the wrong chain, which holds nothing and
   is indistinguishable from a grant that was drained. See network.ts. */
const { prefix, network } = resolveNetwork({
  prefix: flag("prefix"),
  network: flag("network"),
  action: "make a key",
});
const label = flag("label", "key")!;

/**
 * A PRINCIPAL key may not be generated on a machine that runs agents.
 *
 * The principal is the one key a grant pays out to: `revoke` and `reclaim` send
 * the whole remaining balance there and no covenant bounds it. `ops/PRINCIPAL.md`
 * is four pages on why it has to be made on a machine that has never run an
 * agent, a runner or a node.
 *
 * ## It has now been made on the wrong machine twice in one hour
 *
 * The first time, in a repository root: `cd` into the offline bundle failed and
 * the next line of a pasted block ran anyway. This check was written in response,
 * and it looked for `runner/.env`, `ops/node.env`, `covenant/deploy` and the rest
 * RELATIVE TO THE CURRENT DIRECTORY.
 *
 * The second time, inside the bundle, in $HOME, on the same machine. The guard
 * passed — because the bundle is a directory you CARRY, so it holds none of those
 * markers wherever it is, and "wherever" includes the machine the document
 * forbids. I had written, in this comment, that it "looks for the things that make
 * a machine an agent machine". It looked at a directory. The noun was wrong.
 *
 * ## So it asks about the MACHINE
 *
 * The evidence has to be something a carried bundle cannot shed, which means it
 * cannot be relative to the working directory at all. Four signals, any one
 * sufficient, all of them things the offline machine by definition does not have:
 *
 *   a crontab mentioning warda    the agent machine's schedule. 19 entries on the
 *                                 machine this was run on; none anywhere else
 *   ~/.warda                      the state directory the tools keep
 *   ~/Library/Logs/warda-*.log    what those schedules write
 *   a warda checkout under $HOME   found by its own marker files, not by name
 *
 * A wiped laptop or a live USB session has none of them, which is the whole
 * definition of the machine this is for.
 *
 * ## What it still cannot prove
 *
 * That the machine has never run an agent — no check can, and a brand-new machine
 * that will become an agent machine tomorrow looks exactly like the right one
 * today. What it can do is refuse the case that has actually happened twice, which
 * is the machine you are already standing at.
 *
 * ## Why there is no --force
 *
 * Because the honest reason to want one is "I know what I am doing and I am in a
 * hurry", and that is the state this is guarding. `--label something-else` already
 * works for a key that is not a principal.
 */
/**
 * `--check`: is this machine acceptable? Answers without generating anything.
 *
 * Added on 26 September after the third wrong-machine key in an hour, and this one
 * was caused by the instruction rather than by the tool. To confirm the guard
 * fired, I told somebody to run new-key.ts with no redirect and look for a
 * refusal. The bundle on that machine predated the guard, so nothing refused — and
 * a key generator that is not refusing generates a key, which went to stdout,
 * which was a terminal, which was pasted into a chat.
 *
 * A command whose purpose is "check that it says no" must not be a command that
 * makes a secret when it says yes. That is not a warning to add; it is a flag.
 */
const CHECK = has("check");

if (/^principal/i.test(label) || CHECK) {
  const home = homedir();
  const reasons: [string, string][] = [];

  /* The strongest signal, and the one that cannot be carried: this machine has a
     schedule that runs Warda. `crontab -l` exits non-zero with no crontab, which
     is the answer the offline machine gives. */
  try {
    const cron = spawnSync("crontab", ["-l"], { encoding: "utf8", timeout: 5000 });
    if (cron.status === 0 && /warda/i.test(cron.stdout ?? "")) {
      const n = (cron.stdout ?? "").split("\n").filter((l) => /warda/i.test(l)).length;
      reasons.push(["the crontab", `${n} scheduled Warda job(s) run on this machine`]);
    }
  } catch { /* no crontab command is not evidence either way */ }

  if (existsSync(join(home, ".warda"))) {
    reasons.push(["~/.warda", "the state directory the Warda tools keep on a machine they run on"]);
  }
  try {
    const logs = readdirSync(join(home, "Library", "Logs")).filter((f) => /^warda-.*\.log$/.test(f));
    if (logs.length > 0) reasons.push(["~/Library/Logs", `${logs.length} warda-*.log file(s) — something here has been running`]);
  } catch { /* no such directory: fine, and the usual case off macOS */ }

  /* A checkout found by its own marker files rather than by being called "warda",
     two levels down from $HOME, which covers ~/Desktop/warda, ~/src/warda and the
     rest without guessing names. */
  const MARKERS = ["runner/.env", "ops/node.env", "ops/alerts.env", "covenant/deploy", "growth/keys", "ops/auto-issue.key"];
  const checkouts: string[] = [];
  const look = (dir: string, depth: number) => {
    if (depth > 2 || checkouts.length > 0) return;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".") && name !== ".warda") continue;
      const p = join(dir, name);
      try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
      const hit = MARKERS.filter((m) => existsSync(join(p, m)));
      if (hit.length > 0) { checkouts.push(`${p} (${hit.join(", ")})`); return; }
      look(p, depth + 1);
    }
  };
  look(home, 0);
  if (checkouts.length > 0) reasons.push(["a checkout on this machine", checkouts[0]!]);

  /* And the original, cwd-relative check. Kept: it is the case where somebody is
     standing IN the repository, and it names the thing in front of them. */
  const hereHits = MARKERS.filter((m) => existsSync(join(process.cwd(), m)));
  if (hereHits.length > 0) reasons.push(["this directory", hereHits.join(", ")]);
  let looseKeys: string[] = [];
  try {
    /* A principal's own key is NOT evidence. Without this exception the guard
       refused the SECOND run — the one MAKE-THE-KEY.txt asks for, generate then
       run again and check the public half differs — so the guard against making
       the key in the wrong place made the check that it is random impossible. */
    looseKeys = readdirSync(process.cwd()).filter((f) => f.endsWith(".key") && !/principal/i.test(f));
  } catch { /* unreadable cwd is not evidence either way */ }
  if (looseKeys.length > 0) reasons.push(["this directory", `${looseKeys.length} other *.key file(s)`]);

  if (reasons.length > 0) {
    console.error("");
    console.error(CHECK
      ? "This machine is NOT suitable for generating a principal key."
      : "Refusing to generate a PRINCIPAL key on this machine.");
    console.error("");
    for (const [where, what] of reasons) console.error(`  ${where.padEnd(28)} ${what}`);
    console.error("");
    console.error("The principal receives a grant's ENTIRE remaining balance on revoke or");
    console.error("reclaim, and no covenant bounds that. It has to be generated on a machine that");
    console.error("has never run an agent, a runner or a node — ops/PRINCIPAL.md says why at");
    console.error("length. This refusal exists because the key was made on the wrong machine");
    console.error("twice in one hour: once in a repository root after a failed `cd`, and once");
    console.error("inside the carried bundle, on the same machine, past a check that was looking");
    console.error("at the directory instead of the machine.");
    console.error("");
    console.error("  ops/principal-bundle.sh    builds and verifies what to carry");
    console.error("");
    console.error("Copy that to removable media and run this THERE. There is no --force: a key");
    console.error("that costs nothing to regenerate and everything to place wrongly is not a");
    console.error("judgement call at 5pm.");
    console.error("");
    console.error("  --check    ask this question anywhere, without generating anything");
    console.error("");
    process.exit(2);
  }
  if (CHECK) {
    console.error("");
    console.error("This machine shows no sign of running agents:");
    console.error("  no crontab mentioning warda, no ~/.warda, no warda-*.log, no checkout under $HOME,");
    console.error("  and nothing in this directory that belongs to somebody else.");
    console.error("");
    console.error("It cannot be PROVEN that a machine has never run an agent — a new machine that");
    console.error("becomes one tomorrow looks exactly like this. Read ops/PRINCIPAL.md and decide;");
    console.error("this only rules out the case that keeps happening.");
    console.error("");
    console.error("Nothing was generated. Drop --check when you mean it.");
    console.error("");
    process.exit(0);
  }
}

// A secp256k1 secret is any 32 bytes below the curve order. The order is close
// enough to 2^256 that a random draw lands above it with probability under
// 2^-128, but "vanishingly unlikely" is not "impossible" and the failure would
// be a key that cannot sign.
const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
let secret: Uint8Array;
for (;;) {
  secret = new Uint8Array(randomBytes(32));
  const v = BigInt("0x" + toHex(secret));
  if (v > 0n && v < N) break;
}

// agentPublicKey returns BYTES. Printing it without toHex gives a comma
// separated list of 32 integers that looks almost like a key.
const publicKey = agentPublicKey(secret);
const publicHex = toHex(publicKey);

/**
 * `--out` writes both halves, the way ssh-keygen does: the secret at the path
 * given, the public key at `<path>.pub`.
 *
 * Without it the public key only ever reached a human's eyes on stderr, which
 * made the next step — "now pass that key to genesis" — a copy-paste job, and
 * copy-paste of a 64-character hex string is how you end up funding a grant
 * whose agent nobody holds.
 */
const out = flag("out");
console.error(`${label}`);
console.error(`  public  : ${publicHex}`);
console.error(`  address : ${pubkeyToAddress(publicKey, prefix)}`);

if (out) {
  /**
   * Refuse to overwrite a key that already exists.
   *
   * This wrote unconditionally, and on 17 September that silently replaced a
   * funder key holding 1000 KAS — the whole of a faucet's minimum grant —
   * because the setup block that creates a key was pasted twice. The coin was
   * still at the old address; the only copy of the key that could move it was
   * not. Nothing warned, because nothing looked.
   *
   * A key file is the single copy of an authority. Losing one is not a state
   * this tool can undo, so it is a state this tool will not enter: --force is
   * available and says what it costs, and the address of the key already there
   * is printed, because "which key am I about to destroy" is the question
   * somebody needs answered before they answer the prompt.
   */
  if (existsSync(out) && !has("force")) {
    let existing = "";
    try {
      existing = pubkeyToAddress(
        agentPublicKey(fromHex(readFileSync(out, "utf8").trim())),
        prefix,
      );
    } catch {
      existing = "unreadable — but it is a file, and this would have replaced it";
    }
    console.error();
    console.error(`${out} already exists, and holds the key for:`);
    console.error();
    console.error(`  ${existing}`);
    console.error();
    console.error(
      `Refusing to overwrite it. If that address holds anything, this is the only\n` +
        `copy of the key that can move it — there is no recovery from replacing it.\n\n` +
        `  warda wallet --key ${out}        what is actually there\n` +
        `  warda key --out <another.key>    a new key, beside it\n` +
        `  warda key --out ${out} --force   destroy it anyway\n`,
    );
    process.exit(2);
  }

  // 0600. A secret written world-readable is a secret you have to rotate.
  writeFileSync(out, toHex(secret) + "\n", { mode: 0o600 });
  writeFileSync(`${out}.pub`, publicHex + "\n");
  console.error(`  secret  : ${out}`);
  console.error(`  public  : ${out}.pub`);
} else {
  console.error(`  secret  : written to stdout`);
  process.stdout.write(toHex(secret) + "\n");
}
