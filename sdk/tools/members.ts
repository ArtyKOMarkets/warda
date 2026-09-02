/**
 * Reading an allowlist from a flag.
 *
 * Shared by `genesis.ts`, which fixes the list, and `build-live-spend.ts`,
 * which has to reproduce it exactly. Those two agreeing is not a nicety: a
 * grant commits to a Merkle ROOT, so a spend rebuilds the member list from
 * somewhere and proves against it. If the two tools disagree about how to read
 * a list, the second one produces a root the first never committed to, and the
 * covenant rejects a proof that names nothing useful.
 *
 * It lived in genesis.ts alone while only genesis needed it. Copying it was
 * the obvious move and the wrong one.
 */
import { existsSync, readFileSync } from "node:fs";

import { decodeAddress } from "../src/address.ts";
import { toHex } from "../src/bytes.ts";

/**
 * Members from a path or an inline list.
 *
 * Accepts kaspa addresses or bare x-only keys, comma- or whitespace-separated,
 * inline or one per line in a file.
 *
 * ## Why a missing file is an error rather than a list
 *
 * `--recipients recipients.txt` with the file absent is a typo, but read as an
 * inline list it is a perfectly well-formed request to allow one payee named
 * "recipients.txt". That fails much later, inside hex decoding, with a message
 * naming neither the file nor the flag — and if it did not fail, it would
 * commit a grant to an allowlist nobody intended.
 *
 * So anything that LOOKS like a path and is not there stops here. The previous
 * test for that only caught paths containing a separator: its extension branch
 * was written `\\.(txt|json|list)$`, which matches a literal backslash before
 * the extension and so matched nothing real. A bare `recipients.txt` in the
 * working directory went straight through.
 */
export function membersFrom(spec: string): string[] {
  const looksLikePath = /[/\\]|\.(txt|json|list)$/i.test(spec);
  if (looksLikePath && !existsSync(spec)) {
    throw new Error(
      `no such file: ${spec}\nA list can be given inline, but this looks like a path — and ` +
        `treating a missing path as a one-member list produces a failure deep inside hex ` +
        `decoding that names neither the file nor the flag.`,
    );
  }
  const raw = existsSync(spec) ? readFileSync(spec, "utf8") : spec;
  const members = raw
    .split(/\r?\n/)
    // Comments are stripped PER LINE, before anything is split on whitespace.
    // Dropping tokens that begin with "#" instead leaves every other word of
    // the comment behind as a payee, and the failure surfaces as "hex string
    // has odd length: 3" from inside the hasher — which names neither the file
    // nor the line. demo-card.ts writes a three-line header into the list it
    // publishes, so this is the normal case, not an edge one.
    .map((line) => line.replace(/#.*$/, ""))
    .join("\n")
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t.includes(":") ? toHex(decodeAddress(t).payload) : t.toLowerCase()));
  if (members.length === 0) {
    throw new Error(`no members in ${existsSync(spec) ? spec : "the list given"}`);
  }
  return members;
}
