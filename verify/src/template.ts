/**
 * The covenant templates, and why they are not a request field.
 *
 * A caller-supplied template would be the softest surface in this whole
 * service. The template decides how a grant's bytecode is laid out, so the
 * address derives from it — swap it and every address this server reports is
 * wrong, and a report saying "nothing there" is indistinguishable from a
 * stale manifest. A verifier that let the party being verified choose the
 * ruler would not be verifying anything.
 *
 * So they are loaded from the SDK, exactly the way the MCP server loads them,
 * and `WARDA_TEMPLATE` is an operator's override rather than a caller's.
 *
 * ## Why this is plural now
 *
 * It loaded one template — whichever was current — and derived every address
 * from it. That was correct for exactly as long as there was one covenant
 * anybody still held a grant under.
 *
 * There are two. Freezing v5 makes the packaged template v5's, and the
 * eighteen v4 grants still inside their window would then be answered with an
 * address derived from bytecode they do not run: well-formed, on the right
 * network, holding nothing, reported as a grant that was never funded. Not an
 * error — a wrong answer, given confidently, to the question this service
 * exists to answer without anybody having to trust us.
 *
 * So it loads every archived template the SDK ships and picks by the
 * fingerprint the manifest itself records. A manifest naming a covenant this
 * deployment does not carry is REFUSED rather than answered from the nearest
 * one: see `templateForManifest` in the SDK for why that is the right answer
 * and not the timid one.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { templateFingerprint, templateForManifest, type CovenantTemplate } from "@warda_protocol/kaspa";

let cached: CovenantTemplate[] | undefined;

/** The current template's filename first: it is what a manifest with no
 *  `covenant` field is answered with, and `templateForManifest` takes the
 *  head of the list for that. */
const NAMES = [
  "covenant-template.json",
  "covenant-template-v5.json",
  "covenant-template-v4.json",
  "covenant-template-v3.json",
  "covenant-template-v2.json",
  "covenant-template-v1.json",
] as const;

function candidates(name: string): string[] {
  const out: string[] = [];
  if (name === "covenant-template.json" && process.env.WARDA_TEMPLATE) {
    out.push(process.env.WARDA_TEMPLATE);
  }
  try {
    out.push(createRequire(import.meta.url).resolve(`@warda_protocol/kaspa/${name}`));
  } catch {
    // Not installed as a dependency; the two layouts below still apply.
  }
  // The repo, and the deployed function's own directory — the deploy copies
  // its templates in beside itself, which is the arrangement that broke in
  // September when the copy was missing and every request answered `internal`.
  out.push(fileURLToPath(new URL(`../../sdk/${name}`, import.meta.url)));
  out.push(fileURLToPath(new URL(`./${name}`, import.meta.url)));
  return out;
}

/**
 * Every template this deployment can reach, current one first.
 *
 * Missing archives are not an error: a deployment that only ever sees current
 * manifests does not need them, and failing to boot over a template nobody
 * asks for would take the service down to prevent a wrong answer it was never
 * going to give. What IS an error is having none at all — that is the
 * September outage, and it is thrown below.
 */
export function loadTemplates(): CovenantTemplate[] {
  if (cached) return cached;
  const found: CovenantTemplate[] = [];
  const seen = new Set<string>();
  const tried: string[] = [];
  for (const name of NAMES) {
    for (const path of candidates(name)) {
      tried.push(path);
      let raw: string;
      try {
        raw = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const tpl = JSON.parse(raw) as CovenantTemplate;
      const fp = templateFingerprint(tpl);
      // covenant-template.json is a copy of whichever archive is current, so
      // the first two names usually hash the same. Keep one.
      if (!seen.has(fp)) {
        seen.add(fp);
        found.push(tpl);
      }
      break;
    }
  }
  if (!found.length) {
    throw new Error(
      `cannot read any covenant template. Tried:\n  ${tried.join("\n  ")}\n` +
        `Set WARDA_TEMPLATE, or reinstall @warda_protocol/kaspa, which ships them.`,
    );
  }
  cached = found;
  return cached;
}

/** The current template — for callers with no manifest in hand. */
export function loadTemplate(): CovenantTemplate {
  const all = loadTemplates();
  return all[0] as CovenantTemplate;
}

/** The template this manifest was issued under. Throws if it is not here. */
export function templateFor(manifest: unknown): CovenantTemplate {
  const m =
    typeof manifest === "object" && manifest !== null && !Array.isArray(manifest)
      ? (manifest as { covenant?: string })
      : {};
  return templateForManifest(m, loadTemplates(), "this manifest");
}
