/**
 * A fresh keypair, printed once.
 *
 *   node --experimental-strip-types tools/new-key.ts
 *   node --experimental-strip-types tools/new-key.ts --label demo-agent \\
 *     --out ../covenant/deploy/demo-agent.key
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
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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
 * is four pages on why it has to be made somewhere that has never run an agent,
 * a runner or a node — and on 26 September 2026 it was made in the repository
 * root on the machine that runs all three, because a `cd` into the offline bundle
 * failed and the next line ran anyway.
 *
 * That is the whole failure: the procedure was right, written down, and followed
 * by somebody who had read it. Nothing checked. A key that costs nothing to
 * regenerate and everything to place wrongly is exactly the case for a refusal
 * rather than a paragraph.
 *
 * ## What it looks for
 *
 * Not "am I in a repository" — the offline bundle IS a piece of this repository,
 * and refusing that would refuse the correct case. It looks for the things that
 * make a machine an agent machine, which the bundle deliberately does not carry:
 * other private keys, the runner's environment, a node URL, a funder. Any one of
 * them and this is the wrong machine, whatever the directory is called.
 *
 * ## Why there is no --force
 *
 * Because the honest reason to want one is "I know what I am doing and I am in a
 * hurry", and that is the state this is guarding. `--label something-else`
 * already works for a key that is not a principal; there is no legitimate need
 * to make a PRINCIPAL here.
 */
if (/^principal/i.test(label)) {
  const here = process.cwd();
  const markers: [string, string][] = [
    ["runner/.env", "the runner's environment, with its database and signing config"],
    ["ops/node.env", "a node RPC URL, so this machine talks to the chain"],
    ["ops/alerts.env", "the ops machine's alerting credentials"],
    ["covenant/deploy", "the funder and agent keys this project deploys with"],
    ["growth/keys", "the growth fleet's agent keys"],
    ["ops/auto-issue.key", "the unattended issuer's float key"],
  ];
  const found = markers.filter(([rel]) => existsSync(join(here, rel)));
  /* Other keys in the working directory count too: a directory that already holds
     somebody else's secret is a directory something reads.
   *
     EXCEPT a principal's own — and that exception is not a nicety. Without it the
     first version of this refused the SECOND run, which is the one
     MAKE-THE-KEY.txt asks for: generate the key, then run it again and check the
     public half differs, because two identical keys would mean this is returning
     a constant. The guard against making the key in the wrong place had made the
     check that it is random impossible to perform. */
  let looseKeys: string[] = [];
  try {
    looseKeys = readdirSync(here).filter((f) => f.endsWith(".key") && !/principal/i.test(f));
  } catch { /* unreadable cwd is not evidence either way */ }

  if (found.length > 0 || looseKeys.length > 0) {
    console.error("");
    console.error("Refusing to generate a PRINCIPAL key here.");
    console.error("");
    console.error(`  ${here}`);
    console.error("");
    console.error("This looks like a machine that runs agents:");
    for (const [rel, why] of found) console.error(`  ${rel.padEnd(22)} ${why}`);
    if (looseKeys.length > 0) {
      console.error(`  ${String(looseKeys.length + " *.key file(s)").padEnd(22)} a directory holding secrets is a directory something reads`);
    }
    console.error("");
    console.error("The principal receives a grant's ENTIRE remaining balance on revoke or");
    console.error("reclaim, and no covenant bounds that. It has to be generated somewhere that");
    console.error("has never run an agent, a runner or a node. ops/PRINCIPAL.md says why at");
    console.error("length; this refusal exists because on 26 September a failed `cd` meant the");
    console.error("next line ran here instead of in the offline bundle, and the key was made on");
    console.error("this machine by somebody who had read the document.");
    console.error("");
    console.error("  ops/principal-bundle.sh    builds and verifies what to carry");
    console.error("");
    console.error("There is no --force. A key that costs nothing to regenerate and everything to");
    console.error("place wrongly is not a judgement call at 5pm.");
    console.error("");
    process.exit(2);
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
