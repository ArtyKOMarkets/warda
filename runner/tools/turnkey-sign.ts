/**
 * A `--signer` command for any Warda tool: sign one sighash with an agent's
 * Turnkey-held key.
 *
 *   warda-tool … --signer "node --experimental-strip-types runner/tools/turnkey-sign.ts WARDA-011"
 *
 * Reads the digest as hex on stdin and prints a 64-byte BIP340 signature as
 * hex on stdout — the contract in sdk/src/signer.ts, which appends the
 * sighash byte and checks the result against the grant's agent key. Anything
 * else goes to stderr, because a signer that talks on stdout is a signer that
 * returns garbage.
 */
import { TurnkeyVault, turnkeyFromEnv } from "../src/vault-turnkey.ts";
import { vaultFileStore } from "./vault-file.ts";

const agent = process.argv[2];
if (!agent) {
  console.error("usage: turnkey-sign.ts <agent-id>  (digest hex on stdin)");
  process.exit(2);
}
let input = "";
for await (const chunk of process.stdin) input += chunk;
const hex = input.trim();
if (!/^[0-9a-f]{64}$/i.test(hex)) {
  console.error(`expected a 32-byte digest as hex on stdin, got ${hex.length} characters`);
  process.exit(2);
}
const log = console.log;
console.log = (...a: unknown[]) => console.error(...a); // nothing but the signature on stdout
const vault = new TurnkeyVault(await turnkeyFromEnv(), vaultFileStore());
const sig = await (await vault.signer(agent))(Buffer.from(hex, "hex"));
log(Buffer.from(sig.subarray(0, 64)).toString("hex"));
