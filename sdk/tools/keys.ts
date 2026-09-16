/**
 * What can each key actually do?
 *
 * Nobody could answer that. The question "what does warda-testnet.key control"
 * needed a person to open seven manifests and compare hex by eye, which is the
 * same as not being able to answer it.
 *
 *     node --experimental-strip-types sdk/tools/keys.ts
 *     node --experimental-strip-types sdk/tools/keys.ts --json
 *     node --experimental-strip-types sdk/tools/keys.ts path/to/grant.json …
 *
 * Offline. It reads manifests and nothing else — no node, no network, no key
 * material. A key's SECRET never appears here and is never needed: every role
 * a grant names is a public key.
 *
 * ## The three powers, and why the split is the whole point
 *
 *   agentKey       spends, inside the limits
 *   revocationKey  stops the grant at any moment, and receives NOTHING
 *   principalKey   receives the balance on revoke or reclaim
 *
 * `revoke` pays the principal rather than its own signer, deliberately, so
 * that a monitor can be handed the power to stop a grant without being trusted
 * with its balance. That promise is only worth anything if the two keys are
 * actually different. Collapse them and the monitor you were going to trust
 * with "stop it" is trusted with "take it" — and nothing in the grant, or on
 * chain, says so.
 *
 * This tool exists to say so.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

interface Manifest {
  agent?: string;
  principal?: string;
  revocation?: string;
  budget?: number | string;
  grant_value?: number | string;
}

const args = process.argv.slice(2);
const wantJson = args.includes("--json");
const given = args.filter((a) => !a.startsWith("--"));

/* Every tracked manifest, so this cannot quietly omit a grant by being run
   from the wrong directory or with a stale list. A manifest is a file naming
   all three roles; nothing else is. */
function tracked(): string[] {
  try {
    return execFileSync("git", ["ls-files", "*.json"], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .filter((f) => !f.includes("node_modules") && !f.startsWith("site/web/"));
  } catch {
    return [];
  }
}

const files = given.length > 0 ? given : tracked();

/**
 * Labels, from ops/known-keys.json, following agents/known-payees.json.
 *
 * A key with no entry is printed as a bare key rather than guessed at. That is
 * the honest rendering of one nobody has accounted for, and it is the state
 * this whole tool exists to make visible: an unlabelled key holding something
 * is a question, not a fact.
 */
interface Known { key: string; label: string; secretLives?: string }
let known: Known[] = [];
try {
  known = JSON.parse(
    readFileSync(new URL("../../ops/known-keys.json", import.meta.url), "utf8"),
  ).keys;
} catch {
  /* Absent is fine: the report is about manifests, and labels only decorate it. */
}
const labelOf = (k: string) => known.find((x) => x.key.toLowerCase() === k)?.label;
const custodyOf = (k: string) => known.find((x) => x.key.toLowerCase() === k)?.secretLives;

interface Role { file: string; role: "principal" | "revocation" | "agent"; value: bigint }

const roles = new Map<string, Role[]>();
const grants: { file: string; m: Manifest }[] = [];

for (const f of files) {
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(f, "utf8"));
  } catch {
    continue;
  }
  if (!m.agent || !m.principal) continue;
  grants.push({ file: f, m });
  const value = BigInt(m.grant_value ?? m.budget ?? 0);
  const add = (key: string | undefined, role: Role["role"]) => {
    if (!key) return;
    const k = key.toLowerCase();
    if (!roles.has(k)) roles.set(k, []);
    roles.get(k)!.push({ file: f, role, value });
  };
  add(m.principal, "principal");
  add(m.revocation ?? m.principal, "revocation");
  add(m.agent, "agent");
}

const kas = (sompi: bigint) => (Number(sompi) / 1e8).toFixed(2);

/* A key's exposure is what it can TAKE, which is only ever the grants it is
   principal of. Being revocation of a grant can destroy its usefulness and
   cannot move its balance anywhere but home — that asymmetry is the design,
   and reporting one number for both would erase it.
   
   The figure is READ FROM MANIFESTS and is therefore a ceiling, not a balance.
   It counts grants that have since been revoked, settled or spent down, and a
   manifest that has fallen behind its grant reports the value it had when it
   was written. Overstating what a key controls is its own dishonesty, so the
   output says which number this is rather than letting it read as live. */
const findings: string[] = [];
for (const { file, m } of grants) {
  const p = m.principal!.toLowerCase();
  const r = (m.revocation ?? m.principal!).toLowerCase();
  const a = m.agent!.toLowerCase();
  if (a === p) findings.push(`${file}: the AGENT is the principal. It can reclaim its own grant, so no limit here binds it.`);
  if (p === r) findings.push(`${file}: principal and revocation are one key. Whoever can stop this grant can also take its balance.`);
}

const report = {
  grants: grants.length,
  keys: [...roles.entries()]
    .map(([key, rs]) => {
      const of = (role: Role["role"]) => rs.filter((x) => x.role === role);
      const holds = of("principal").reduce((n, x) => n + x.value, 0n);
      return {
        key,
        label: labelOf(key) ?? null,
        secretLives: custodyOf(key) ?? null,
        principalOf: of("principal").length,
        revocationOf: of("revocation").length,
        agentOf: of("agent").length,
        /* Sompi as a string: a u64 does not fit a double, and this number is
           the answer to "how much is behind this key". */
        /* Named for what it is: the sum across every grant this key has ever
           been principal of, live or not. */
        everBehindItSompi: holds.toString(),
        everBehindItKas: kas(holds),
      };
    })
    .sort((a, b) => Number(BigInt(b.everBehindItSompi) - BigInt(a.everBehindItSompi))),
  findings,
};

if (wantJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

console.log(`\n${report.grants} grant manifest(s), ${report.keys.length} distinct key(s).`);
console.log(
  "The KAS column is summed from the manifests, so it is a ceiling and not a balance:\n" +
    "it counts grants since revoked, settled or spent down. Ask a node for what is live.\n",
);
console.log("key                 principal  revoke  agent   ever behind it");
console.log("------------------  ---------  ------  -----   --------------");
for (const k of report.keys) {
  console.log(
    `${k.key.slice(0, 16)}…  ${String(k.principalOf).padStart(9)}  ${String(k.revocationOf).padStart(6)}  ` +
      `${String(k.agentOf).padStart(5)}   ${k.everBehindItKas.padStart(8)} KAS` +
      (k.label ? `   ${k.label}` : ""),
  );
}

/* Keys we hold that no manifest names. A revocation key generated and not yet
   used is exactly this, and it should read as "ready" rather than vanish. */
const unused = known.filter((k) => !roles.has(k.key.toLowerCase()));
if (unused.length > 0) {
  console.log("\nHeld, and named by no grant yet:");
  for (const k of unused) {
    console.log(`  ${k.key.slice(0, 16)}…   ${k.label}`);
    if (k.secretLives) console.log(`                      secret: ${k.secretLives}`);
  }
}

if (findings.length > 0) {
  console.log(`\n${findings.length} finding(s):\n`);
  for (const f of findings) console.log(`  ${f}`);
  console.log(
    "\nNeither is a bug in the covenant — the covenant enforces exactly what the grant says.\n" +
      "They are statements about which secrets exist, and a grant cannot express that its\n" +
      "principal and its revocation key happen to be the same file.\n",
  );
} else {
  console.log("\nNo role collapses: every grant separates spending, stopping and receiving.\n");
}
