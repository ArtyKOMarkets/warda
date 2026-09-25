/**
 * Give the runner a Turnkey key that can do exactly two things.
 *
 *   node --experimental-strip-types runner/tools/turnkey-lockdown.ts
 *
 * The key the runner has used since 22 September is the organisation's ROOT
 * API key, and Turnkey does not apply policies to root users: that key could
 * export every wallet, add users, rewrite policies. The runner needs two
 * activities and nothing else:
 *
 *   ACTIVITY_TYPE_CREATE_WALLET        a new agent's key
 *   ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2  signing a sighash with it
 *
 * So, using the root key once, here, on your machine:
 *
 *   1. makes a P-256 API key pair locally (the private half never leaves
 *      this machine except into the runner's own environment);
 *   2. creates a NON-root user, "warda-runner", holding only that key;
 *   3. creates one ALLOW policy for that user and those two activities.
 *      Everything else is denied by default for a non-root user.
 *   4. proves it, with the NEW key: creates a probe wallet and signs with it
 *      (must work), then asks for each verb DESIGN.md promises it cannot do —
 *      export, delete, write a policy, add a user tag — and must be refused
 *      every time. Each probe is harmless if it were ever approved.
 *   5. writes the new key to ~/.warda/turnkey-runner.json (0600) and points
 *      runner/.env's TURNKEY_KEY_FILE at it. The root key file is untouched —
 *      keep it offline; the runner no longer needs it.
 *
 * Reads the root credentials from runner/.env (TURNKEY_KEY_FILE,
 * TURNKEY_ORGANIZATION_ID). Prints no secret.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnv } from "./env.ts";
import { credentialsFile, TurnkeyVault, type TurnkeyApi } from "../src/vault-turnkey.ts";
import { vaultFileStore } from "./vault-file.ts";
import { setDotenv, ENV_PATH } from "./dotenv-set.ts";

loadEnv();
const USER = "warda-runner";
const out = join(homedir(), ".warda", "turnkey-runner.json");
if (existsSync(out)) {
  console.error(`${out} exists: the runner already has its own key. Delete that file only if you have also removed the user "${USER}" in Turnkey.`);
  process.exit(1);
}
const file = process.env.TURNKEY_KEY_FILE ? credentialsFile(process.env.TURNKEY_KEY_FILE) : {};
const org = process.env.TURNKEY_ORGANIZATION_ID || file.TURNKEY_ORGANIZATION_ID;
const rootPub = process.env.TURNKEY_API_PUBLIC_KEY || file.TURNKEY_API_PUBLIC_KEY;
const rootPriv = process.env.TURNKEY_API_PRIVATE_KEY || file.TURNKEY_API_PRIVATE_KEY;
if (!org || !rootPub || !rootPriv) {
  console.error("runner/.env needs TURNKEY_ORGANIZATION_ID and TURNKEY_KEY_FILE (the root API key the runner used until now).");
  process.exit(1);
}

const { Turnkey } = await import("@turnkey/sdk-server");
const { generateP256KeyPair } = await import("@turnkey/crypto");
const base = process.env.TURNKEY_API_BASE_URL ?? "https://api.turnkey.com";
const clientFor = (pub: string, priv: string) =>
  new Turnkey({ apiBaseUrl: base, apiPublicKey: pub, apiPrivateKey: priv, defaultOrganizationId: org }).apiClient();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const root = clientFor(rootPub, rootPriv) as any;
const step = (s: string) => console.log(`• ${s}`);

/* 0. The key in hand is root, or none of this is needed — and a name taken
      is somebody else's decision, not one to overwrite. */
const who = await root.getWhoami({ organizationId: org });
const users = (await root.getUsers({ organizationId: org })).users as { userId: string; userName: string }[];
if (users.some((u) => u.userName === USER)) {
  console.error(`A Turnkey user named "${USER}" already exists. Remove it in the dashboard (Users) first, or rename USER in this file.`);
  process.exit(1);
}
step(`signed in as ${who.username ?? who.userId} (organisation ${org.slice(0, 8)}…)`);

/* 1. */
const kp = generateP256KeyPair();

/* 2. */
const created = await root.createUsers({
  users: [{
    userName: USER,
    apiKeys: [{ apiKeyName: "warda-runner", publicKey: kp.publicKey, curveType: "API_KEY_CURVE_P256" }],
    authenticators: [], oauthProviders: [], userTags: [],
  }],
});
const userId: string = created.userIds[0];
step(`created user ${USER} (${userId}) — not in the root quorum, so policies apply to it`);

/* 3. */
const policy = await root.createPolicy({
  policyName: "warda-runner: create agent wallets and sign, nothing else",
  effect: "EFFECT_ALLOW",
  consensus: `approvers.any(user, user.id == '${userId}')`,
  condition: "activity.type == 'ACTIVITY_TYPE_CREATE_WALLET' || activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2'",
  notes: "The Warda runner's key. Agent keys are created and used for signing; export, users, policies and deletion are not allowed. Made by runner/tools/turnkey-lockdown.ts.",
});
step(`created policy ${policy.policyId}: ${USER} may create wallets and sign raw payloads`);

/* 4. With the NEW key only. */
const runner = clientFor(kp.publicKey, kp.privateKey);
const probeDir = mkdtempSync(join(tmpdir(), "warda-probe-"));
const vault = new TurnkeyVault(runner as unknown as TurnkeyApi, vaultFileStore(probeDir), { retries: 8 });
const probeName = `lockdown-probe-${new Date().toISOString().slice(0, 10)}`;
let signed = false;
for (let i = 0; i < 6 && !signed; i++) {
  try {
    await vault.create(probeName); // createWallet + a signature that must verify
    signed = true;
  } catch (e) {
    // A brand-new API key can take a moment to be accepted.
    if (i === 5) { console.error(`✗ the new key could not create and sign: ${(e as Error).message}`); process.exit(1); }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
}
step(`the new key created wallet "warda-${probeName}" and signed with it (signature verified)`);

/* Refusals, plural.
 *
 * This probed ONE thing — creating a user tag — and reported it as "refused
 * anything else". Those are different claims. The reasoning behind the single
 * probe is sound (a non-root user with one ALLOW policy is deny-by-default, so
 * one refusal implies the rest), but reasoning is what the policy is supposed
 * to replace, and DESIGN.md's promise is specific: a leaked runner credential
 * "cannot create, export or delete anything".
 *
 * So each verb in that sentence gets asked. Export first, because it is the
 * only one that turns a leaked API key into the agents' private keys — the
 * others cost availability, that one costs the money.
 *
 * Every probe is chosen to be harmless if it were ever approved: a tag with no
 * users, an export of a wallet this run just made, a policy that allows
 * nothing to nobody. A probe whose success would do damage is not a probe.
 */
/* The probe wallet's real id, looked up with the ROOT key.
 *
 * Not a made-up one. `exportWallet` on a walletId that does not exist is
 * refused for not existing, and a refusal for the wrong reason proves nothing
 * about the policy — which is the failure this repository has now found in
 * three separate suites. Root does the lookup; the runner's key does the thing
 * that has to be denied. */
const probeWalletId: string = ((await root.getWallets({ organizationId: org })).wallets as
  { walletId: string; walletName: string }[])
  .find((w) => w.walletName === `warda-${probeName}`)?.walletId ?? "";
if (!probeWalletId) {
  console.error(`✗ could not find the probe wallet "warda-${probeName}" to aim the export probe at.`);
  console.error(`  Without a real wallet id the export refusal would prove only that the id was wrong.`);
  process.exit(1);
}

const probes: [string, () => Promise<unknown>][] = [
  ["export a wallet — the one that turns a leaked key into the agents' keys",
    () => (runner as any).exportWallet({ walletId: probeWalletId, targetPublicKey: kp.publicKey })],
  ["delete wallets",
    () => (runner as any).deleteWallets({ walletIds: [probeWalletId], deleteWithoutExport: true })],
  ["write itself a wider policy — the escalation that makes the rest moot",
    () => (runner as any).createPolicy({
      policyName: "warda-runner-lockdown-probe",
      effect: "EFFECT_ALLOW",
      consensus: "false",
      condition: "false",
      notes: "Probe from runner/tools/turnkey-lockdown.ts. Allows nothing to nobody. Reject it.",
    })],
  ["add a user tag",
    () => (runner as any).createUserTag({ userTagName: "warda-runner-lockdown-probe", userIds: [] })],
];

const allowed: string[] = [];
for (const [what, run] of probes) {
  try {
    await run();
    allowed.push(what);
  } catch (e) {
    step(`refused: ${what} (${String((e as Error).message).slice(0, 70)}…)`);
  }
}
if (allowed.length) {
  console.error(`\n✗ the new key was ALLOWED to do ${allowed.length} thing(s) the policy is supposed to deny:`);
  for (const a of allowed) console.error(`    ${a}`);
  console.error(
    `\n  The policy is broader than DESIGN.md claims. Nothing was written — the runner\n` +
      `  still uses its old key. Delete the user "${USER}" in the dashboard, and reject\n` +
      `  any pending activity this left behind.`,
  );
  process.exit(1);
}

/* 5. */
mkdirSync(join(homedir(), ".warda"), { recursive: true, mode: 0o700 });
writeFileSync(out, JSON.stringify({ organizationId: org, publicKey: kp.publicKey, privateKey: kp.privateKey, user: USER, userId }, null, 2) + "\n", { mode: 0o600, flag: "wx" });
setDotenv("TURNKEY_KEY_FILE", out);
step(`wrote ${out} (0600) and pointed ${ENV_PATH} at it`);

console.log(`
Done. Next:
  runner/deploy/env.sh && runner/deploy/deploy.sh      the runner now uses the restricted key

Then, in the Turnkey dashboard:
  • Wallets: delete "warda-${probeName}" and the spike's test wallets (keep every warda-<agent> wallet).
  • Reject any pending activity named "warda-runner-lockdown-probe" — every one of
    them is a refusal probe from step 4, and each is harmless even if approved.
  • Your root API key file (${process.env.TURNKEY_KEY_FILE}) is no longer used by the runner. Keep it offline, or delete that API key.`);
