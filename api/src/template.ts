/**
 * The covenant template, and why it is not a request field.
 *
 * A caller-supplied template would be the softest surface in this whole
 * service. The template decides how a grant's bytecode is laid out, so the
 * address derives from it — swap it and every address this server reports is
 * wrong, and a report saying "nothing there" is indistinguishable from a
 * stale manifest. A verifier that let the party being verified choose the
 * ruler would not be verifying anything.
 *
 * So it is loaded from the SDK, exactly the way the MCP server loads it, and
 * `WARDA_TEMPLATE` is an operator's override rather than a caller's.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { CovenantTemplate } from "@warda_protocol/kaspa";

let cached: CovenantTemplate | undefined;

function candidates(): string[] {
  const out: string[] = [];
  if (process.env.WARDA_TEMPLATE) out.push(process.env.WARDA_TEMPLATE);
  try {
    out.push(createRequire(import.meta.url).resolve("@warda_protocol/kaspa/covenant-template.json"));
  } catch {
    // Not installed as a dependency; the repo layout below still applies.
  }
  out.push(fileURLToPath(new URL("../../sdk/covenant-template.json", import.meta.url)));
  return out;
}

export function loadTemplate(): CovenantTemplate {
  if (cached) return cached;
  const tried = candidates();
  for (const path of tried) {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    cached = JSON.parse(raw) as CovenantTemplate;
    return cached;
  }
  throw new Error(
    `cannot read the covenant template. Tried:\n  ${tried.join("\n  ")}\n` +
      `Set WARDA_TEMPLATE, or reinstall @warda_protocol/kaspa, which ships it.`,
  );
}
