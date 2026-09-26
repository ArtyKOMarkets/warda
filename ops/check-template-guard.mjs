#!/usr/bin/env node
// Nothing on a live path may pin the packaged covenant template.
//
//     node ops/check-template-guard.mjs
//
// ## What this used to check, and why that was not enough
//
// `sdk/covenant-template.json` is the PACKAGED template: whatever covenant is
// current. Nearly every tool loaded it by default and took `--template` to
// override. That was harmless while the file had held the same bytes since
// September — the default was always right, so a tool that never checked was
// never wrong.
//
// Freezing a covenant changes what that file means. From that moment a v4
// manifest and the packaged template are a mismatched pair, and the failure is
// not an error: `scriptHashFor` derives a perfectly well-formed address from the
// wrong bytecode. Nothing is at it.
//
// So this file was written, one day before the freeze, to require that any tool
// holding a manifest AND a template compare the two. It scanned `sdk/tools`. It
// passed. Nineteen hours after the freeze the agent fleet stopped paying, and it
// still passed, because:
//
//   * the bug was in `wallet/src/agent.ts`, which this never looked at;
//   * that file did not `JSON.parse` a manifest — it took one from a Store, so
//     even inside the scan its manifest would not have been recognised;
//   * comparing is not enough anyway. `follow-grant` and `topup` DID compare,
//     correctly, and refused — which left the recovery tools unable to operate
//     the six live v4 grants they exist for.
//
// Three holes, one shape: the check described the mistake instead of the rule.
//
// ## The rule now, in three tiers
//
// The tiers are about who is there when it goes wrong, because that is what
// decides whether "refuse and tell them to pass --template" is an answer.
//
// UNATTENDED code — a wallet under cron, a hosted runner, a service — must
// RESOLVE: `templateFor(manifest)`, the covenant the manifest names. Pinning is
// a failure here whether or not it is guarded, because a guard produces an error
// message and there is nobody to read it. This is the tier the wallet was in.
//
// OPERATOR tools — sdk/tools, run by a person at a terminal — may default to the
// current template PROVIDED they compare it with the manifest. Refusing with
// "pass --template with the archived template for b3e5…" is a real answer when
// somebody is there to do it, and eleven of these tools already take the flag.
// Resolving is better and several now do; this tier does not force the churn.
//
// FIXTURES — tests — must not pin a template ALONGSIDE a manifest that names an
// archived covenant. That combination is not a mistake waiting to happen, it is
// one that has already happened: it is self-consistent, so both halves move
// together, and it is why `wallet/test/e2e.test.ts` and `test/buy-e2e.test.ts`
// stayed green throughout an outage they were written to catch.
//
// The allowlist is the set of legitimate reasons to want the current covenant,
// and each entry says which. Adding to it should feel expensive.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

/* Tier 1: nobody is watching. Resolution is not a nicety here. */
const UNATTENDED = [
  "wallet/src",
  "runner/src",
  "mcp/src",
  "verify/src",
  "growth/src",
  "growth/tools",
  "agents/tools",
  "agent/tools",
];

/* Tier 2: a person at a terminal, who can pass --template. */
const OPERATOR = ["sdk/tools"];

/* Tier 3: fixtures. Scanned because a test that pins cannot disagree with
   itself, which is the failure mode that let this outage through. */
const FIXTURES = ["sdk/test", "wallet/test", "runner/test", "mcp/test", "verify/test", "test"];

/**
 * Where "the current covenant" is the right answer, and why.
 *
 * Genesis is the honest case: a grant created now is created under the current
 * covenant, and there is no manifest to resolve from — the manifest is what
 * genesis WRITES. The rest are generators and bundlers whose subject is the
 * current template itself.
 */
const ALLOWED = new Map([
  ["sdk/tools/genesis.ts", "creates a grant, so there is no manifest to resolve from"],
  ["sdk/tools/build-spend.ts", "rebuilds golden-*.json, which ARE the current covenant's vectors"],
  ["sdk/tools/probes.ts", "generates the refusal suite against the current covenant"],
  ["sdk/tools/demo-card.ts", "renders the current covenant's card for the site"],
  ["mcp/deploy/index.ts", "bundles the template files into the deployed worker"],
  ["verify/deploy/api/verify.ts", "bundles the template files into the deployed worker"],
  ["runner/src/funding.ts", "issues NEW grants; a grant created today is current by definition"],
  ["provider/src/handler.ts", "documents `template` as an option and defaults it; reads scripts, not manifests"],
  ["extension/src/grants.ts", "a browser bundle: imports every archive statically, cannot read files"],
  ["mcp/test/deploy-template.test.ts", "asserts about the deployed bundle's template, not about a grant"],
  ["test/template-guard.test.ts", "the unit test for this property; it holds templates on purpose"],
]);

/* Comments are STRIPPED before matching, and then any string literal naming the
   file counts — an import, a readFileSync, a path handed to a local helper.
 *
 * Both halves of that are load-bearing. Matching only `import … from "…"` missed
 * `readJson("../covenant-template.json")` in build-spend.ts, and matching prose
 * flagged wallet/src/agent.ts for a comment that QUOTES the import it removed.
 * A checker that reports the file it just fixed is a checker people learn to
 * skim. */
const withoutComments = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

const PIN = /["'`][^"'`\n]*covenant-template\.json["'`]/;

const pinned = (s) => PIN.test(withoutComments(s));

/* Guarded: it compares the pair, however it words it. The five tools that wrote
   this by hand before `assertTemplateForManifest` existed are not churned. */
const guarded = (s) =>
  s.includes("assertTemplateForManifest") ||
  (s.includes("templateFingerprint") && /\.covenant\b/.test(s));

const resolves = (s) => /\btemplateFor(?:Manifest|Script)?\s*\(/.test(s);

/* Every archived covenant, from the file that names them. A fingerprint literal
   from this set, in a file that pins, is the self-consistent fixture. */
const versions = JSON.parse(readFileSync(join(REPO, "covenant/versions.json"), "utf8"));
const CURRENT = versions.current;

/* Every fingerprint whose TEMPLATE FILE IS ON DISK — not every fingerprint the
 * ledger mentions.
 *
 * The first version of this read the fingerprints out of versions.json and
 * called them loadable, which is a check of the bookkeeping rather than of the
 * repository: deleting sdk/covenant-template-v4.json left all 35 manifests
 * "loadable" and every one of them unspendable. Each entry names its file; the
 * file is what a tool can actually read. */
const ON_DISK = new Map();
for (const e of Object.values(versions.versions ?? {})) {
  if (!e?.fingerprint || !e?.template) continue;
  let present = true;
  try { statSync(join(REPO, e.template)); } catch { present = false; }
  if (present) ON_DISK.set(e.fingerprint, e.template);
}
const ARCHIVED = [...ON_DISK.keys()].filter((fp) => fp !== CURRENT);
if (ARCHIVED.length === 0) {
  console.error(
    "check-template-guard: covenant/versions.json lists no archived fingerprint, so the\n" +
      "  fixture tier is asserting nothing. Read it differently rather than deleting the check.",
  );
  process.exit(1);
}

const filesIn = (root) => {
  let entries;
  try { entries = readdirSync(join(REPO, root)); } catch { return []; }
  return entries
    .filter((n) => /\.(ts|mjs|js)$/.test(n))
    .map((n) => join(REPO, root, n))
    .filter((p) => statSync(p).isFile());
};

const problems = [];
let scanned = 0;
let exempt = 0;

const rel = (p) => relative(REPO, p).split(sep).join("/");

for (const root of UNATTENDED) {
  for (const p of filesIn(root)) {
    scanned++;
    const r = rel(p), s = readFileSync(p, "utf8");
    if (!pinned(s)) continue;
    if (ALLOWED.has(r)) { exempt++; continue; }
    /* Reading the template FILES is what a loader does — verify/src/template.ts
       is one, and so is the SDK's. What matters at this tier is that the
       covenant is chosen from the manifest, not that the bytes came from
       somewhere else. */
    if (resolves(s)) continue;
    problems.push(
      `${r} pins the packaged covenant template, and nothing here is attended.\n` +
        `  A guard would raise an error message with no reader. Resolve instead:\n` +
        `  templateFor(manifest) from @warda_protocol/kaspa/templates.`,
    );
  }
}

for (const root of OPERATOR) {
  for (const p of filesIn(root)) {
    scanned++;
    const r = rel(p), s = readFileSync(p, "utf8");
    if (!pinned(s)) continue;
    if (ALLOWED.has(r)) { exempt++; continue; }
    if (guarded(s) || resolves(s)) continue;
    problems.push(
      `${r} reads a manifest and pins the packaged template without comparing them.\n` +
        `  After a covenant freeze that pair derives a valid address for the wrong\n` +
        `  bytecode — the grant looks empty rather than the tool looking broken.\n` +
        `  Resolve with templateFor(manifest), or refuse with assertTemplateForManifest.`,
    );
  }
}

for (const root of FIXTURES) {
  for (const p of filesIn(root)) {
    scanned++;
    const r = rel(p), s = readFileSync(p, "utf8");
    if (!pinned(s)) continue;
    if (ALLOWED.has(r)) { exempt++; continue; }
    const stale = ARCHIVED.filter((fp) => s.includes(fp));
    if (stale.length === 0) continue;
    problems.push(
      `${r} pins the packaged template AND names archived covenant ${stale.join(", ")}.\n` +
        `  Both halves of this fixture then move with the package, so it cannot detect a\n` +
        `  template that disagrees with its own manifest — which is what it is for.\n` +
        `  Derive the template from the fixture: templateFor(MANIFEST).`,
    );
  }
}

/* A file that resolves in one place and uses the pinned template in another.
 *
 * This is the worst of the shapes and the one that actually shipped.
 * `test/buy-e2e.test.ts` resolved by fingerprint in `grantAddress` and, twenty
 * lines below, `fundNode` opened with `const t = covenantTemplate as never`. It
 * passed from the freeze until the day after the outage: the pinned half put the
 * coin where the agent (also pinned, in the wallet) went looking, and the
 * resolving half asserted about an address nothing was funded at. A
 * half-converted file is how that state survives review, because the diff shows
 * the resolution being ADDED.
 *
 * What is flagged is the pinned binding being taken as A TEMPLATE — assigned to
 * something, or handed to a call. Appearing inside an array is fine and is how
 * the loaders and the fixtures that hold every archive are written; the list is
 * the input to resolution, not a bypass of it. */
const pinnedNames = (s) => {
  const out = [];
  const src = withoutComments(s);
  for (const m of src.matchAll(/import\s+(\w+)\s+from\s+["'][^"']*covenant-template\.json["']/g)) {
    out.push(m[1]);
  }
  return out;
};

for (const root of [...UNATTENDED, ...OPERATOR, ...FIXTURES]) {
  for (const p of filesIn(root)) {
    const r = rel(p);
    if (ALLOWED.has(r)) continue;
    const s = readFileSync(p, "utf8");
    if (!resolves(s)) continue;
    const src = withoutComments(s);
    for (const name of pinnedNames(s)) {
      /* `= name` or `= name as T` — the binding being adopted as the template to
         derive with. Not `[name, other]`, which is a candidate list. */
      const used = new RegExp(`=\\s*${name}\\s*(?:as\\s[^;]*)?;`).test(src);
      if (!used) continue;
      problems.push(
        `${r} resolves a template from a manifest AND takes the packaged one directly\n` +
          `  (\`= ${name}\`). Whichever half is used where, the two disagree after a covenant\n` +
          `  freeze — and a fixture that pins on one side of its own assertion cannot detect\n` +
          `  that. Resolve at every derivation site, or delete the import.`,
      );
    }
  }
}

/* And the other direction: every manifest this repo holds must still be
 * operable.
 *
 * The rule above says code resolves from the manifest. That is worth nothing if
 * the template a manifest names has been dropped from the package — the tools
 * would then refuse, correctly and uselessly, for 28 grants at once. Archives
 * are files somebody could tidy away, so this is the assertion that says they
 * cannot: every `covenant` fingerprint written in this repo has a template here.
 *
 * It does not derive addresses. A manifest advances on every spend, so a pinned
 * address would go stale within the day and get deleted for being noisy; what is
 * stable is the covenant, which is fixed at genesis and never moves. */
const manifests = [];
const walk = (dir, depth) => {
  if (depth > 4) return;
  let entries;
  try { entries = readdirSync(join(REPO, dir)); } catch { return; }
  for (const name of entries) {
    if (["node_modules", ".git", "dist", "_to_delete", "_gitjunk"].includes(name)) continue;
    const r = dir ? `${dir}/${name}` : name;
    let st;
    try { st = statSync(join(REPO, r)); } catch { continue; }
    if (st.isDirectory()) { walk(r, depth + 1); continue; }
    if (!name.endsWith(".json")) continue;
    let j;
    try { j = JSON.parse(readFileSync(join(REPO, r), "utf8")); } catch { continue; }
    if (j && typeof j.covenant === "string" && j.agent && j.budget !== undefined) manifests.push([r, j.covenant]);
  }
};
walk("", 0);

const orphans = manifests.filter(([, fp]) => !ON_DISK.has(fp));
if (manifests.length < 10) {
  problems.push(
    `only ${manifests.length} manifests found. This repo holds dozens; the walk has stopped\n` +
      "  recognising them and is asserting nothing about whether its own grants are operable.",
  );
}
for (const [r, fp] of orphans) {
  const named = Object.values(versions.versions ?? {}).find((e) => e?.fingerprint === fp)?.template;
  problems.push(
    `${r} was issued under covenant ${fp}, and no template for it is on disk` +
      (named ? ` (${named} is named in covenant/versions.json and is not there).\n` : `.\n`) +
      `  Every tool reading this manifest now refuses — correctly, and with no way forward.\n` +
      `  Restore the archive rather than editing the manifest.`,
  );
}

if (scanned < 60) {
  console.error(
    `check-template-guard: scanned only ${scanned} files. The layout has moved and this is\n` +
      "  asserting almost nothing, which is worse than failing. Fix the roots, do not delete\n" +
      "  the check.",
  );
  process.exit(1);
}

/* The allowlist must not outlive its entries. A stale name is an exemption
   nobody can see is unused, and the next file to take that path inherits it. */
for (const r of ALLOWED.keys()) {
  let s;
  try { s = readFileSync(join(REPO, r), "utf8"); } catch {
    problems.push(`${r} is in ALLOWED and does not exist. Remove the exemption.`);
    continue;
  }
  if (!pinned(s)) problems.push(`${r} is in ALLOWED but no longer pins the packaged template. Remove the exemption.`);
}

if (problems.length) {
  console.error(`check-template-guard: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error("- " + p + "\n");
  process.exit(1);
}
console.log(
  `check-template-guard: ${scanned} files across three tiers; ${exempt} pin the current ` +
    `template for a stated reason, no unattended path pins one at all, and all ` +
    `${manifests.length} manifests here name a covenant that is still loadable`,
);
