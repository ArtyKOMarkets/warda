/**
 * Create an agent whose key lives in Turnkey, and print the key a grant names.
 *
 *   TURNKEY_KEY_FILE=~/Downloads/turnkey-api-credentials-….json \
 *   TURNKEY_ORGANIZATION_ID=… \
 *     node --experimental-strip-types runner/tools/turnkey-agent.ts WARDA-011
 *
 * Writes runner/agents/WARDA-011.vault.json (a wallet id and an address; no
 * secret) and prints the x-only agent key on stdout, for `genesis --agent`.
 * The vault has already seen that key sign before it prints it.
 */
import { TurnkeyVault, turnkeyFromEnv } from "../src/vault-turnkey.ts";
import { vaultFileStore } from "./vault-file.ts";

const agent = process.argv[2];
if (!agent) {
  console.error("usage: turnkey-agent.ts <agent-id>");
  process.exit(2);
}
const format = process.argv.includes("--mainnet")
  ? "ADDRESS_FORMAT_BITCOIN_MAINNET_P2TR"
  : "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR";
const vault = new TurnkeyVault(await turnkeyFromEnv(), vaultFileStore(), { addressFormat: format });
const key = await vault.create(agent);
console.error(`agent ${agent}: key held by Turnkey, seen to sign, recorded in runner/agents/${agent}.vault.json`);
console.log(key);
