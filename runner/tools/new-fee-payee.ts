/**
 * Give the runner its own fee address.
 *
 *   node --experimental-strip-types runner/tools/new-fee-payee.ts            testnet-10
 *   node --experimental-strip-types runner/tools/new-fee-payee.ts --mainnet
 *
 * The runner is paid its per-run fee into an address every new grant puts on
 * its allowlist. Until now that was `warda-testnet.key` — the repo's principal,
 * the key that funds grants — so fees landed in the same place as the money
 * they are fees on. This makes a key that is only the runner's revenue.
 *
 * - The secret is written to ~/.warda/runner-fee-<network>.key (0600, refuses
 *   to replace one that exists) and never printed. The runner never holds it:
 *   the runner only needs the ADDRESS, and to spend its fees you use this key.
 * - runner/.env: RUNNER_FEE_PAYEE becomes the new address, and the old one
 *   moves to RUNNER_FEE_PAYEES_PREVIOUS. A grant's allowlist is fixed when it
 *   is created, so grants made before today can still only pay the old
 *   address; the runner keeps settling theirs there.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentPublicKey, pubkeyToAddress, toHex } from "@warda_protocol/kaspa";
import { readDotenv, setDotenv, ENV_PATH } from "./dotenv-set.ts";

const mainnet = process.argv.includes("--mainnet");
const network = mainnet ? "mainnet" : "testnet-10";
const prefix = mainnet ? "kaspa" : "kaspatest";
const dir = join(homedir(), ".warda");
const path = join(dir, `runner-fee-${network}.key`);

if (existsSync(path)) {
  console.error(`${path} already exists. This makes a key once; it will not replace one that may hold fees.`);
  process.exit(1);
}

const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
let secret: Uint8Array;
for (;;) {
  secret = new Uint8Array(randomBytes(32));
  const v = BigInt("0x" + toHex(secret));
  if (v > 0n && v < N) break;
}
const pub = agentPublicKey(secret);
const address = pubkeyToAddress(pub, prefix as never);

mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(path, toHex(secret) + "\n", { mode: 0o600, flag: "wx" });
writeFileSync(path + ".pub", toHex(pub) + "\n", { mode: 0o644, flag: "wx" });

const env = readDotenv();
const old = env.RUNNER_FEE_PAYEE;
const previous = (env.RUNNER_FEE_PAYEES_PREVIOUS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!mainnet) {
  if (old && old !== address && !previous.includes(old)) previous.unshift(old);
  setDotenv("RUNNER_FEE_PAYEE", address);
  if (previous.length) setDotenv("RUNNER_FEE_PAYEES_PREVIOUS", previous.join(","));
}

console.log(`runner fee key (${network})`);
console.log(`  secret  : ${path}   (0600 — back it up; it is the only way to spend the fees)`);
console.log(`  public  : ${toHex(pub)}`);
console.log(`  address : ${address}`);
if (mainnet) {
  console.log(`\nMainnet: runner/.env was left alone. Set RUNNER_FEE_PAYEE=${address} on the mainnet runner.`);
} else {
  console.log(`\n${ENV_PATH}:`);
  console.log(`  RUNNER_FEE_PAYEE           = the address above`);
  if (previous.length) console.log(`  RUNNER_FEE_PAYEES_PREVIOUS = ${previous.join(", ")}   (grants made before today still settle there)`);
  console.log(`\nThen: runner/deploy/env.sh && runner/deploy/deploy.sh`);
}
