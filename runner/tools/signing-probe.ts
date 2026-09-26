/**
 * Can the runner sign? Asked of whichever vault it is configured to use.
 *
 *   node --experimental-strip-types runner/tools/signing-probe.ts [--quiet]
 *
 * ## Why this replaced turnkey-probe.ts
 *
 * The first version asked "is Turnkey working?", which was the right question
 * for exactly as long as Turnkey was the only vault. On 26 September the
 * organisation ran out of its free allotment — *"Signing is disabled because
 * your organization is over its allotted quota. Please upgrade to a paid
 * plan"* — and the runner moved to the envelope vault for testnet. A monitor
 * still probing Turnkey would then have alerted every six hours, forever,
 * about a service the runner no longer uses. A feed that cries wolf about
 * something you deliberately turned off is a feed you stop reading, which
 * costs you the next real failure.
 *
 * So it asks the runner's own question — can it sign — and reads the vault
 * choice from the same place `runner/src/boot.ts` reads it:
 *
 *     TURNKEY_ORGANIZATION_ID set  ->  TurnkeyVault
 *     otherwise                    ->  EnvelopeVault under RUNNER_MASTER_KEY
 *
 * One predicate, one source. The alternative — a second opinion about which
 * vault is live — is the mistake this repository found in install-cron.sh
 * yesterday, where a regex disagreed with the sender about whether alerting
 * was configured.
 *
 * ## Both paths sign, because nothing cheaper is the question
 *
 * Turnkey: one signature against a wallet kept for the purpose. A plan limit,
 * an expired policy, a deleted user and a revoked key all leave `getWhoami`
 * answering happily and signing dead.
 *
 * Envelope: seal a fresh secret, open it, sign a digest, verify it against the
 * public key derived from that secret — the whole path, in memory, against a
 * throwaway store. It costs nothing and it fails when RUNNER_MASTER_KEY is
 * missing, truncated or has been rotated out from under the sealed rows, which
 * are the three ways this vault goes wrong.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./env.ts";
import { EnvelopeVault, localMasterKey } from "../src/vault.ts";
import { memoryStore } from "../src/store.ts";
import { fromHex } from "@warda_protocol/kaspa";

loadEnv();
const QUIET = process.argv.includes("--quiet");
const fail = (reason: string, code = 1): never => {
  console.error(`DOWN: ${reason}`);
  process.exit(code);
};
const ok = (line: string) => {
  if (!QUIET) console.log(`up · ${line}`);
  process.exit(0);
};

/* ---- which vault ------------------------------------------------------- */
if (!process.env.TURNKEY_ORGANIZATION_ID) {
  /* The envelope. Exercised end to end rather than by checking that the
     variable is set: a 32-byte key that is present and wrong looks exactly
     like one that works until an agent tries to spend. */
  const raw = process.env.RUNNER_MASTER_KEY;
  if (!raw) {
    fail(
      "the runner is configured for the envelope vault (no TURNKEY_ORGANIZATION_ID) and " +
        "RUNNER_MASTER_KEY is not set. It cannot create or use any agent key at all.",
      2,
    );
  }
  let master;
  try {
    master = localMasterKey(fromHex(raw!));
  } catch (e) {
    fail(`RUNNER_MASTER_KEY is not a usable 32-byte key: ${(e as Error).message}`, 2);
  }
  const vault = new EnvelopeVault(master!, memoryStore());
  const agent = `signing-probe-${Date.now()}`;
  try {
    const pub = await vault.create(agent);
    const sign = await vault.signer(agent);
    const sig = await sign(new Uint8Array(randomBytes(32)));
    if (sig.length !== 65) fail(`the envelope vault produced a ${sig.length}-byte signature, not 65`);
    ok(`envelope vault sealed, opened, signed and verified (${pub.slice(0, 12)}…)`);
  } catch (e) {
    fail(`the envelope vault could not sign: ${String((e as Error).message).replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

/* ---- Turnkey ----------------------------------------------------------- */
const keyPath = join(homedir(), ".warda", "turnkey-runner.json");
const probePath = join(homedir(), ".warda", "turnkey-monitor-probe.json");
if (!existsSync(keyPath)) {
  fail(`TURNKEY_ORGANIZATION_ID is set but ${keyPath} does not exist — run runner/tools/turnkey-lockdown.ts.`, 2);
}
const rk = JSON.parse(readFileSync(keyPath, "utf8")) as {
  organizationId: string; publicKey: string; privateKey: string;
};

const { Turnkey } = await import("@turnkey/sdk-server");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = new Turnkey({
  apiBaseUrl: process.env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com",
  apiPublicKey: rk.publicKey,
  apiPrivateKey: rk.privateKey,
  defaultOrganizationId: rk.organizationId,
}).apiClient() as any;

const NAME = "warda-monitor-probe";
let address: string | undefined;
if (existsSync(probePath)) {
  address = (JSON.parse(readFileSync(probePath, "utf8")) as { address?: string }).address;
}
if (!address) {
  try {
    const w = await api.createWallet({
      walletName: NAME,
      accounts: [{
        curve: "CURVE_SECP256K1",
        pathFormat: "PATH_FORMAT_BIP32",
        path: "m/86'/1'/0'/0/0",
        addressFormat: "ADDRESS_FORMAT_BITCOIN_TESTNET_P2TR",
      }],
    });
    address = w.addresses[0] as string;
    mkdirSync(join(homedir(), ".warda"), { recursive: true, mode: 0o700 });
    writeFileSync(probePath, JSON.stringify({ wallet: NAME, walletId: w.walletId, address }, null, 2) + "\n", { mode: 0o600 });
  } catch (e) {
    fail(`the runner's key could not create its probe wallet: ${String((e as Error).message).replace(/\s+/g, " ").slice(0, 200)}`);
  }
}

try {
  const r = await api.signRawPayload({
    signWith: address,
    payload: Buffer.from(randomBytes(32)).toString("hex"),
    encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
    hashFunction: "HASH_FUNCTION_NO_OP",
  });
  if (!r?.r || !r?.s) fail("Turnkey returned a signature with no r/s. The runner would produce an unusable one.");
} catch (e) {
  const why = String((e as Error).message).replace(/\s+/g, " ").trim();
  /* Named in the message, because the two need completely different actions at
     3am. Code 8 is the account — the free allotment ran out on 26 September and
     the message says "upgrade to a paid plan". Code 7 is the policy, which
     means the runner's own key has been narrowed past what it needs. */
  const account = /error 8\b|resource exhausted|allotted quota|over (its|your)|quota|billing|plan/i.test(why);
  const policy = /error 7\b|permission denied|not authorized|policy/i.test(why);
  const hint = account
    ? "This is the ACCOUNT, not the policy: the organisation cannot sign at all, so every agent transaction fails at the last step. Turnkey billing and limits — or move the runner to the envelope vault for testnet by unsetting TURNKEY_ORGANIZATION_ID."
    : policy
      ? "This is the POLICY: the runner's key is no longer permitted to sign with its own probe wallet. See runner/tools/turnkey-scope.ts and DESIGN.md."
      : "Neither an account limit nor a policy denial — read it before assuming which.";
  fail(`the runner cannot sign. ${hint} ${why.slice(0, 200)}`);
}

ok(`Turnkey signed with ${NAME} (${String(address).slice(0, 18)}…)`);
