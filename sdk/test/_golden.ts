/**
 * The template a golden vector was compiled from.
 *
 * These vectors are the reference: a transaction the Rust compiler produced,
 * which this SDK must reproduce byte for byte. They are pinned to a SPECIFIC
 * covenant — that is the whole point of them — and every test loaded
 * `../covenant-template.json`, whichever covenant happened to be current.
 *
 * Those were the same file until a covenant was frozen. Afterwards they are
 * not, and the tests would have compared a v4 transaction against v5 bytecode
 * and failed on a byte diff: a true failure, reported as the wrong thing, and
 * the obvious repair would have been to regenerate the vectors — which throws
 * away the evidence that this SDK ever matched the compiler for v4, while
 * eighteen v4 grants are still live.
 *
 * So the vector says which covenant it is, and this loads that one.
 */
import { readFileSync } from "node:fs";
import { templateForManifest, type CovenantTemplate } from "../src/template.ts";

const read = (p: string): CovenantTemplate =>
  JSON.parse(readFileSync(new URL(p, import.meta.url), "utf8"));

/** Current first, so a vector with no `covenant` field still gets it. */
const TEMPLATES: CovenantTemplate[] = [
  "../covenant-template.json",
  "../covenant-template-v5.json",
  "../covenant-template-v4.json",
  "../covenant-template-v3.json",
  "../covenant-template-v2.json",
  "../covenant-template-v1.json",
].flatMap((p) => {
  try {
    return [read(p)];
  } catch {
    return [];
  }
});

export function templateForGolden(vector: { covenant?: string }): CovenantTemplate {
  return templateForManifest(vector, TEMPLATES, "this golden vector");
}
