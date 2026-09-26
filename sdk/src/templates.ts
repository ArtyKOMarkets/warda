/**
 * Every covenant template this installation can reach, and which one a
 * manifest belongs to.
 *
 * `template.ts` is deliberately pure: it can say whether a template matches a
 * manifest, and which of several does, but not where templates come from. That
 * is a different problem in a browser, in a bundled service and in Node, so it
 * lives outside — and this is the Node answer.
 *
 * ## Why this file exists at all
 *
 * It was written the day after a covenant freeze broke a running agent.
 *
 * `sdk/covenant-template.json` is not code; it is data, and on 25 September it
 * changed from v4 to v5 in a commit whose subject said every consumer resolves
 * by fingerprint. Every consumer that had been AUDITED did. The one that spends
 * — `Agent.open` in the wallet — took the packaged template as a default,
 * derived a v5 address for a v4 grant, found nothing at it, and reported "no
 * UTXO". The grant had not moved and nothing was wrong on chain. Six passes of
 * a live agent failed over twenty-one hours before anyone knew, because a wrong
 * address is not an error: it is an address.
 *
 * The lesson is not "resolve by fingerprint" — that was already written down,
 * in this SDK, with a comment naming the three tools that did not. It is that a
 * loader nobody can import gets reimplemented per caller, and a caller that
 * reimplements it is a caller that can forget the resolution step. So the
 * loader is here, once, where the template files are: whoever owns the data
 * owns the way in.
 *
 * ## What it will not do
 *
 * It will not fall back to the current template for a manifest that names a
 * covenant it cannot find. See `templateForManifest`: falling back derives a
 * well-formed address for the wrong bytecode and reports a funded grant as
 * empty, which is the exact failure this file was written after.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  templateFingerprint,
  templateForManifest,
  type CovenantTemplate,
} from "./template.ts";

/**
 * Current FIRST. A manifest with no `covenant` field is answered with
 * `available[0]`, so this order is the one place that decides what "current"
 * means for every caller downstream.
 *
 * `covenant-template.json` and `covenant-template-v5.json` are the same bytes
 * today; the dedup below keeps one. Listing both is what makes the next freeze
 * a one-line change here rather than a silent gap.
 */
const TEMPLATE_NAMES = [
  "covenant-template.json",
  "covenant-template-v5.json",
  "covenant-template-v4.json",
  "covenant-template-v3.json",
  "covenant-template-v2.json",
  "covenant-template-v1.json",
] as const;

/**
 * Where one template might be, in order.
 *
 * The resolver entry is first among the real ones because it is the only
 * candidate that is right in every layout: this module ships as `dist/` inside
 * a package called `kaspa` whose source directory is called `sdk`, and a
 * relative path can be correct for at most one of those. The relative entries
 * remain for the repo, where a caller may be running the TypeScript source
 * through `--experimental-strip-types` before anything has been built.
 *
 * WARDA_TEMPLATE overrides the CURRENT template only, and never an archive: it
 * exists for testing an unreleased covenant, and a grant issued under an
 * archived one has a fingerprint that says so.
 */
function candidates(name: string): string[] {
  const out: string[] = [];
  if (name === "covenant-template.json" && process.env.WARDA_TEMPLATE) {
    out.push(process.env.WARDA_TEMPLATE);
  }
  try {
    out.push(createRequire(import.meta.url).resolve(`@warda_protocol/kaspa/${name}`));
  } catch {
    /* Not resolvable from here — the relative candidates below still apply. */
  }
  out.push(fileURLToPath(new URL(`../${name}`, import.meta.url)));
  out.push(fileURLToPath(new URL(`../../${name}`, import.meta.url)));
  return out;
}

let cached: CovenantTemplate[] | undefined;

/**
 * Every template reachable here, current first, deduplicated by fingerprint.
 *
 * A MISSING archive is not an error. An installation that only ever holds
 * current grants has no use for v1, and failing at import time because a file
 * from August is absent would make the archives load-bearing for callers that
 * do not need them. What IS an error is holding none at all, and what is an
 * error later is being asked for a covenant that is not in the list —
 * `templateForManifest` raises that, naming what it does have.
 */
export function loadTemplates(): CovenantTemplate[] {
  if (cached) return cached;
  const found: CovenantTemplate[] = [];
  const seen = new Set<string>();
  const tried: string[] = [];
  for (const name of TEMPLATE_NAMES) {
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
      if (!seen.has(fp)) {
        seen.add(fp);
        found.push(tpl);
      }
      break;
    }
  }
  if (found.length === 0) {
    throw new Error(
      `cannot read any covenant template. Tried:\n  ${tried.join("\n  ")}\n` +
        `Set WARDA_TEMPLATE, or reinstall @warda_protocol/kaspa, which ships them.`,
    );
  }
  cached = found;
  return cached;
}

/** The current covenant. For genesis, where there is no manifest to resolve from. */
export function loadTemplate(): CovenantTemplate {
  return loadTemplates()[0] as CovenantTemplate;
}

/**
 * The template this manifest was issued under.
 *
 * This is the call every tool that reads a manifest should be making instead of
 * importing `covenant-template.json`. It throws rather than guessing.
 */
export function templateFor(
  manifest: { covenant?: string },
  what = "this grant",
): CovenantTemplate {
  return templateForManifest(manifest, loadTemplates(), what);
}

/** For tests that mutate WARDA_TEMPLATE between cases. */
export function forgetTemplates(): void {
  cached = undefined;
}
