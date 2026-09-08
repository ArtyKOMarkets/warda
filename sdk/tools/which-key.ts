/**
 * Which file holds the key for this address?
 *
 *     node --experimental-strip-types tools/which-key.ts \
 *       --address kaspatest:qq7xj0mpl0p46875mnkzhwatdy478pjkum745srhaey44l9jx566zefjaam3e \
 *       ~/Desktop ~/Documents ~/.config
 *
 * Offline. It derives, it does not connect: an address is a hash of a public
 * key which is a function of a secret, so the whole question is arithmetic and
 * a node would add nothing but a dependency.
 *
 * ## Why this exists
 *
 * A grant's authority is a key, and this project is built on the claim that
 * the key is the whole authority. The other side of that claim is that a key
 * you cannot find is an agent that is over — and there is no way to tell from
 * the chain, because an address whose secret is lost looks exactly like one
 * whose secret is safe.
 *
 * Agent #001 is the case that prompted it: paid at an address whose secret was
 * in none of the repository's key files, with no way to answer "is it gone or
 * is it somewhere else" short of checking every file by hand.
 *
 * ## It does not print what it finds
 *
 * The answer is a PATH, never a secret. A tool that searched a home directory
 * for private keys and echoed the matches into a terminal — and a shell
 * history, and whatever is scrolled back through later — would be a worse
 * problem than the one it solves. It says which file, and stops.
 *
 * It also never writes, never moves and never opens anything twice: a search
 * for a lost key runs over directories nobody audited, and the only safe
 * behaviour there is to read and report.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  agentPublicKey,
  decodeAddress,
  fromHex,
  pubkeyToAddress,
  toHex,
  type NetworkPrefix,
} from "@warda_protocol/kaspa";

const flag = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : d;
};

const address = flag("address");
const pubkeyFlag = flag("pubkey");
if (!address && !pubkeyFlag) {
  console.error(
    "usage: which-key.ts --address <kaspa address> [paths…]\n" +
      "       which-key.ts --pubkey  <64 hex chars> [paths…]\n\n" +
      "  Searches the given files and directories for the secret behind that address.\n" +
      "  Defaults to the current directory. Prints the PATH of a match, never the key.",
  );
  process.exit(2);
}

let wanted: string;
if (pubkeyFlag) {
  wanted = pubkeyFlag.toLowerCase();
} else {
  try {
    wanted = toHex(decodeAddress(address!).payload).toLowerCase();
  } catch (e) {
    console.error(`--address: ${(e as Error).message}`);
    process.exit(2);
  }
}
if (!/^[0-9a-f]{64}$/.test(wanted)) {
  console.error(`that resolves to ${wanted.length} hex characters; an x-only public key is 64.`);
  process.exit(2);
}

const roots = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"))
  .filter((a) => a !== address && a !== pubkeyFlag);
if (roots.length === 0) roots.push(".");

/* Directories that are never the answer and are always enormous. Walking a
   node_modules is minutes of reading that cannot contain a key anyone chose. */
const SKIP = new Set([
  "node_modules", ".git", "dist", "build", ".next", ".cache", "Library",
  ".Trash", "Applications", ".npm", ".vscode", "target", "venv", ".venv",
]);
const MAX_BYTES = 2_000_000;
const MAX_DEPTH = Number(flag("depth", "5"));

const candidates = new Set<string>();
const matches: string[] = [];
let filesRead = 0;

/* One derivation per DISTINCT value, not per occurrence. A repository repeats
   the same public keys across manifests dozens of times, and each check is an
   elliptic-curve multiplication. */
const derived = new Map<string, string>();
const isMatch = (hex: string): boolean => {
  let pub = derived.get(hex);
  if (pub === undefined) {
    try {
      pub = toHex(agentPublicKey(fromHex(hex)));
    } catch {
      pub = "";
    }
    derived.set(hex, pub);
  }
  return pub === wanted;
};

const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

const walk = (path: string, depth: number) => {
  let st;
  try {
    st = statSync(path);
  } catch {
    return; // unreadable, gone, or a permission we do not have. Not an error.
  }
  if (st.isDirectory()) {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(path);
    } catch {
      return;
    }
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      walk(join(path, e), depth + 1);
    }
    return;
  }
  if (!st.isFile() || st.size === 0 || st.size > MAX_BYTES) return;

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return; // binary, or not ours to read
  }
  filesRead++;
  for (const hex of text.match(/\b[0-9a-f]{64}\b/gi) ?? []) {
    const h = hex.toLowerCase();
    candidates.add(h);
    if (isMatch(h) && !matches.includes(path)) matches.push(path);
  }
};

for (const r of roots) walk(expand(r), 0);

console.error(
  `\nsearched ${roots.length} path${roots.length === 1 ? "" : "s"}, read ${filesRead} files, ` +
    `checked ${candidates.size} distinct 64-hex values\n`,
);

if (matches.length === 0) {
  console.error(
    `No file here holds the secret for that address.\n\n` +
      `  That is not proof it is gone — this reads only what it was pointed at, only\n` +
      `  files under ${MAX_BYTES / 1_000_000} MB, and only ${MAX_DEPTH} directories deep. Widen it with more\n` +
      `  paths or --depth, and remember a key in a password manager or an encrypted\n` +
      `  file is invisible to a search for plain hex.\n`,
  );
  process.exit(1);
}

const prefix = (address?.split(":")[0] ?? "kaspatest") as NetworkPrefix;
console.error(`Found the key for ${address ?? wanted}${address ? "" : " (as an x-only public key)"} in:\n`);
for (const m of matches) console.error(`  ${m}`);
console.error(
  `\n  ${matches.length > 1 ? "Those files hold" : "That file holds"} the secret. Not printed here, and it should not be\n` +
    `  echoed into a terminal — check it with:  warda wallet --key <that file>\n` +
    `  which should print ${pubkeyToAddress(fromHex(wanted), prefix)}\n`,
);
