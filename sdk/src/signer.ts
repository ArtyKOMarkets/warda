/**
 * Signing without ever holding the key.
 *
 * `WardaPayer` has always taken `sign` as a function rather than bytes, and
 * its own comment promised "an HSM, a remote signer, or another process, and
 * this module never sees it". Nothing shipped that actually was one, so in
 * practice every agent read a secret out of a file — which is fine for a
 * tutorial and is the first thing anybody running this for real will refuse
 * to do.
 *
 * ## Why a command, and not an SDK per vendor
 *
 * The obvious move is an adapter each for KMS, Turnkey, Vault, Fireblocks.
 * That is four dependencies, four auth models and four things to keep current,
 * in a package whose entire job here is to turn 32 bytes into 64. So this
 * takes the shape git and ssh settled on: name a COMMAND. It receives the
 * digest as hex on stdin and answers with a signature as hex on stdout.
 *
 *     warda pay $URL --signer "aws-kms-sign --key-id alias/agent-001"
 *
 * Anything that can be scripted is now a signer, the vendor's own CLI does
 * the authentication it already knows how to do, and this file has no
 * dependencies and cannot go stale.
 *
 * ## Sixty-four bytes in, sixty-five out
 *
 * A Warda signature is BIP340 plus one trailing byte naming the sighash type,
 * which the script engine reads to know which digest to recompute. No HSM on
 * earth knows about that byte, and none should have to: the command is asked
 * for a plain 64-byte BIP340 signature — the one thing every signer already
 * produces — and the 65th is appended here.
 *
 * ## The check that makes it safe to use
 *
 * A wrong signer is not an error you want to discover from a refused
 * transaction, because by then a fee has been paid and the failure reads as a
 * covenant bug. So every signature is verified against the public key the
 * GRANT names before it is returned. A signer holding the wrong key fails
 * immediately and says so, which is the same guarantee `signSpend` gives when
 * it is handed raw bytes.
 */
import { concat, fromHex, toHex } from "./bytes.ts";
import { SIGHASH_TYPE_BYTE, verifyDigest } from "./sign.ts";

export interface ExternalSignerOptions {
  /** The command line to run. Split on spaces; quote nothing clever. */
  command: string;
  /** The agent's x-only public key, as the grant names it. Checked, not assumed. */
  publicKey: Uint8Array | string;
  /** Milliseconds before a signer that never answers is given up on. */
  timeoutMs?: number;
  /** Injected by the tests. Defaults to spawning `command`. */
  run?: (input: string) => Promise<string>;
}

export type Signer = (digest: Uint8Array) => Promise<Uint8Array>;

const HEX64 = /^[0-9a-f]{128}$/i;

export function externalSigner(options: ExternalSignerOptions): Signer {
  const pub = typeof options.publicKey === "string" ? fromHex(options.publicKey) : options.publicKey;
  if (pub.length !== 32) {
    throw new Error(
      `--signer needs the agent's x-only public key (32 bytes); got ${pub.length}. ` +
        `It is the \`agent\` field of the grant manifest.`,
    );
  }
  const run = options.run ?? spawnRunner(options.command, options.timeoutMs ?? 30_000);

  return async (digest: Uint8Array): Promise<Uint8Array> => {
    const out = (await run(toHex(digest))).trim();
    if (!HEX64.test(out)) {
      throw new Error(
        `the signer did not return a signature.\n\n` +
          `  command : ${options.command}\n` +
          `  wanted  : 64 bytes of hex, one line\n` +
          `  got     : ${out.length > 120 ? out.slice(0, 120) + "…" : out || "(nothing)"}\n\n` +
          `Whatever it printed is above. A signer that logs to stdout will fail here; ` +
          `send diagnostics to stderr.`,
      );
    }
    const full = concat(fromHex(out), Uint8Array.of(SIGHASH_TYPE_BYTE));
    /* Verified HERE, not at broadcast. A signer holding the wrong key is
       otherwise discovered from a transaction the network refused — after a
       fee, and wearing the costume of a covenant bug. */
    if (!verifyDigest(full, digest, pub)) {
      throw new Error(
        `the signer answered, but its signature is not this agent's.\n\n` +
          `  expected key : ${toHex(pub)}\n\n` +
          `The signature is well-formed and verifies against a different key, so the ` +
          `signer is holding the wrong one. Nothing was broadcast.`,
      );
    }
    return full;
  };
}

/**
 * Spawning is loaded lazily so this module stays importable where there is no
 * child_process — a browser build that never calls an external signer should
 * not fail to load because one exists.
 */
function spawnRunner(command: string, timeoutMs: number): (input: string) => Promise<string> {
  return async (input: string) => {
    const { spawn } = await import("node:child_process");
    const parts = command.split(/\s+/).filter(Boolean);
    if (!parts.length) throw new Error("--signer was given an empty command");
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(parts[0]!, parts.slice(1), { stdio: ["pipe", "pipe", "inherit"] });
      let out = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`the signer did not answer within ${timeoutMs}ms: ${command}`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (out += String(d)));
      child.on("error", (e) => { clearTimeout(timer); reject(new Error(`could not run the signer: ${e.message}`)); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`the signer exited ${code}: ${command}`));
        else resolve(out);
      });
      /* A signer that never reads stdin — because it takes the digest another
         way, or because it is not a signer at all — closes the pipe, and
         writing to a closed pipe raises EPIPE on the stream rather than on
         this promise. Unhandled, it takes the whole process down, which
         turned the one error message written to explain a misconfigured
         signer into a stack trace. Ignored on purpose: whether the command
         produced a signature is decided by its OUTPUT, not by whether it
         bothered to listen. */
      child.stdin.on("error", () => {});
      child.stdin.end(input + "\n");
    });
  };
}
