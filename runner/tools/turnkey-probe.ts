/**
 * Can the runner still sign? Asked by signing.
 *
 *   node --experimental-strip-types runner/tools/turnkey-probe.ts [--quiet]
 *
 * ## Why this exists
 *
 * On 25 September the organisation's signing was disabled — "Resource
 * exhausted: signing is disabled because your organization is over" a plan
 * limit — and nothing said so. The hosted runner could not have completed a
 * single agent transaction, and the way it was discovered was a tool run for
 * an unrelated reason. `runner/agents/first-hosted-grant.json` has
 * `spent_total: 0`, so there was no spend history to look wrong.
 *
 * It is the same shape as the outage `ops/check-verify.sh` was written for:
 * the door answers, the room behind it does not, and the failure is silent
 * because nothing exercises the path that does the work.
 *
 * ## It signs, because nothing cheaper is the question
 *
 * `getWhoami` proves the credential is accepted. That is the `/health` mistake
 * — it answered perfectly through a total outage of the path that mattered.
 * A plan limit, an expired policy, a deleted user and a revoked key all leave
 * whoami working and signing dead, and signing is the one thing the runner
 * needs. So this signs 32 random bytes with a wallet kept for the purpose.
 *
 * The cost is one signature per run, against the quota that just ran out. That
 * is the reason it is hourly rather than every fifteen minutes like the
 * endpoint monitors: a plan limit does not flap, two consecutive failures is
 * two hours, and 96 probes a day against an exhausted quota would make the
 * monitor a meaningful share of the usage it is watching.
 *
 * ## It holds the runner's key, never root
 *
 * A monitor with root credentials would be a larger liability than the outage
 * it watches. This uses ~/.warda/turnkey-runner.json — the restricted key,
 * which may create a wallet and sign with one. Both of the things it does
 * here are things the runner does in normal operation.
 *
 * The probe wallet is created once and its address recorded locally, so this
 * does not need to list wallets (a read the restricted user may not have) and
 * does not leave a new wallet behind on every run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const QUIET = process.argv.includes("--quiet");
const keyPath = join(homedir(), ".warda", "turnkey-runner.json");
const probePath = join(homedir(), ".warda", "turnkey-monitor-probe.json");

function fail(reason: string, code = 1): never {
  console.error(`DOWN: ${reason}`);
  process.exit(code);
}

if (!existsSync(keyPath)) {
  fail(`${keyPath} does not exist, so there is no runner key to test. Run runner/tools/turnkey-lockdown.ts.`, 2);
}
const rk = JSON.parse(readFileSync(keyPath, "utf8")) as {
  organizationId: string; publicKey: string; privateKey: string;
};

const { Turnkey } = await import("@turnkey/sdk-server");
const base = process.env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com";
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = new Turnkey({
  apiBaseUrl: base,
  apiPublicKey: rk.publicKey,
  apiPrivateKey: rk.privateKey,
  defaultOrganizationId: rk.organizationId,
}).apiClient() as any;

/* The probe wallet. `warda-` because the policy is scoped to that prefix —
   a probe outside the scope would test the scope rather than the signing. */
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
    fail(`the runner's key could not create its probe wallet: ${String((e as Error).message).replace(/\s+/g, " ").slice(0, 160)}`);
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
  /* Said in the message, because this is what arrives on a phone at 3am and
     the two causes need completely different actions. Code 8 is the account —
     billing, a plan limit, a quota — and the runner is mute until somebody
     logs in. Code 7 is the policy, which means the runner's own key has been
     narrowed past what it needs. */
  const account = /error 8\b|resource exhausted|over (its|your)|quota|billing|plan/i.test(why);
  const policy = /error 7\b|permission denied|not authorized|policy/i.test(why);
  const hint = account
    ? "This is the ACCOUNT, not the policy: the organisation cannot sign at all, so every agent transaction fails at the last step. Turnkey dashboard, billing and limits."
    : policy
      ? "This is the POLICY: the runner's key is no longer permitted to sign with its own probe wallet. See runner/tools/turnkey-scope.ts and DESIGN.md."
      : "Neither an account limit nor a policy denial — read it before assuming which.";
  fail(`the runner cannot sign. ${hint} ${why.slice(0, 200)}`);
}

if (!QUIET) console.log(`up · signed with ${NAME} (${String(address).slice(0, 18)}…)`);
