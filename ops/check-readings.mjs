/**
 * Every published reading describes the same kind of object. Does it?
 *
 * ## The failure this catches
 *
 * There are two dashboard tools here — `agent/tools/dashboard.ts` writes agent
 * #001's reading and `agents/tools/dashboard.ts` writes everybody else's — and
 * they are copies that have drifted by three hundred lines. When `expiresAt`
 * was added to the second one, five agent pages gained a term and the sixth
 * silently did not, because nothing compares the two.
 *
 * That is the shape: a field added to one writer, absent from the other, and
 * no error anywhere. The page renders, the build passes, and one agent's page
 * is quietly poorer than its neighbours. It has happened before with a missing
 * `--readings` flag, which cost agent #001 its digest, its run count and its
 * second grant on a command that exited 0.
 *
 * So this asserts the floor: the fields every reading must carry whoever wrote
 * it. Not the whole shape — a retired grant has `retired` and a live one does
 * not, and that difference is the point of those fields. Only the ones that
 * are true of every grant that has ever existed.
 *
 * Run by .github/workflows/check.yml.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const dir = fileURLToPath(new URL("../site/src/", import.meta.url));

/**
 * Required of every reading, with the reason each one is not optional.
 *
 * A path like "timelock.expiresAt" must be present and not null. `expiresIn`
 * is deliberately NOT here: it is null once the term is over, and that null is
 * information rather than an omission.
 */
const REQUIRED = [
  ["checkedAt", "without it nothing downstream can tell a reading from a memory"],
  ["network", "a testnet figure on a mainnet page is the worst kind of correct"],
  ["identity.grantAddress", "the address is what anybody checks the rest against"],
  ["authority.budget", "the limit the whole page is about"],
  ["authority.sompi.budget", "the figure a node would actually compare"],
  ["timelock.notBefore", "when the grant opened"],
  ["timelock.expiresAt", "when it stops. A grant has two ends and a reading that carries one of them cannot say whether the agent is still able to pay"],
  ["timelock.expired", "a boolean, so nothing downstream has to infer it from the sign of a subtraction"],
];

const at = (o, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);

const files = readdirSync(dir).filter((f) => /^agent-\d+\.json$/.test(f)).sort();
const problems = [];

if (files.length === 0) {
  problems.push("no agent readings in site/src/ at all. Something is very wrong, or this check moved.");
}

for (const f of files) {
  let d;
  try {
    d = JSON.parse(readFileSync(dir + f, "utf8"));
  } catch (e) {
    problems.push(`${f} is not readable JSON: ${e.message}`);
    continue;
  }
  /* Named from the reading's own header, so the message points at the file to
     fix rather than at "a dashboard". The two writers say which they are. */
  const wroteBy = /Written by ([\w./-]+)/.exec(d._comment ?? "")?.[1] ?? "a dashboard tool";
  for (const [path, why] of REQUIRED) {
    if (at(d, path) == null) {
      problems.push(`${f} has no ${path} — ${why}.\n      Written by ${wroteBy}`);
    }
  }
}

/**
 * And nothing may carry its own copy of the list.
 *
 * The console had `["001", "002", … "006"]` typed into its script. A seventh
 * agent would have had a page, a reading and a sitemap row, and been invisible
 * there until somebody noticed — the same shape as `first-contact` watching
 * seven packages when there were ten on npm, and the eleventh instance of
 * extracted-then-copied in this repository.
 *
 * `site/build.py` generates `agents.json` from the readings that exist. This
 * refuses a second list beside it.
 */
const bareOf = (src) =>
  src
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

for (const f of ["site/src/app.html", "site/src/agents.html", "site/src/network.html"]) {
  const path = fileURLToPath(new URL("../" + f, import.meta.url));
  let src;
  try {
    src = readFileSync(path, "utf8");
  } catch {
    continue; // a page that does not exist is not a page with a stale list
  }
  const found = [...bareOf(src).matchAll(/\[\s*"(00\d)"(?:\s*,\s*"00\d")+\s*,?\s*\]/g)];
  if (found.length) {
    problems.push(
      `${f} carries its own list of agent ids: ${found[0][0].slice(0, 60)}\n` +
        `      Read /agents.json instead — site/build.py derives it from the readings that\n` +
        `      exist, so publishing one is the only thing anybody has to remember.`,
    );
  }
}

if (problems.length) {
  console.error(`check-readings: ${problems.length} problem(s) across ${files.length} reading(s)\n`);
  for (const p of problems) console.error("  - " + p + "\n");
  console.error(
    "A reading missing a field is usually one of two things:\n\n" +
      "  the reading is STALE — regenerate it:  ops/refresh-agents.sh\n" +
      "  the WRITER is behind — a field was added to one dashboard and not the\n" +
      "  other. There are two of them and they are copies; anything true of every\n" +
      "  grant belongs in @warda_protocol/core, called by both.\n",
  );
  process.exit(1);
}
console.error(`readings: ${files.length} published, each carrying all ${REQUIRED.length} fields every grant has.`);
