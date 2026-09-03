/**
 * Turn two readings into a digest.
 *
 *   node --experimental-strip-types tools/digest.ts                  # last 24 h
 *   node --experimental-strip-types tools/digest.ts --window 7d --markdown
 *   node --experimental-strip-types tools/digest.ts a.json b.json
 *
 * Touches no network. Everything it publishes came out of two files that were
 * written by `read.ts` and are published alongside it, which is what makes the
 * output checkable rather than merely plausible.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { decodeReading, type ChainReading } from "../src/chain.ts";
import { compare, duration, renderMarkdown, renderText } from "../src/digest.ts";
import { loadReadings, pickPair, windowSeconds } from "../src/readings.ts";

function flag(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const files = process.argv.slice(2).filter((a, i, all) => {
  if (!a.endsWith(".json")) return false;
  return !all[i - 1]?.startsWith("--");
});

const window = windowSeconds(flag("window", "24h")!);

let before: ChainReading;
let after: ChainReading;
if (files.length === 2) {
  before = decodeReading(readFileSync(files[0]!, "utf8"));
  after = decodeReading(readFileSync(files[1]!, "utf8"));
} else if (files.length === 0) {
  const dir = flag("dir", fileURLToPath(new URL("../readings", import.meta.url)))!;
  const pair = pickPair(loadReadings(dir, flag("network")), window);
  if (!pair) {
    console.error(
      `need two readings in ${dir} and there are fewer than that.\n` +
        `Run tools/read.ts now, and again after the window you want to report on.`,
    );
    process.exit(1);
  }
  before = pair.before.reading;
  after = pair.after.reading;

  // Say what was actually obtained whenever it is not what was asked for. The
  // digest itself is already honest about this — its heading is computed from
  // the timestamps — but an operator reading a cron log should not have to
  // notice the discrepancy for themselves.
  if (Math.abs(pair.offBySeconds) > window * 0.05) {
    console.error(
      `asked for ${duration(window)}, closest available pair is ` +
        `${duration((Date.parse(after.at) - Date.parse(before.at)) / 1000)}. ` +
        `Reporting the interval that exists.`,
    );
  }
} else {
  console.error("usage: digest.ts [before.json after.json] [--window 24h] [--markdown] [--out path]");
  process.exit(2);
}

const report = compare(before, after);
const text = has("markdown") ? renderMarkdown(report) : renderText(report);

const out = flag("out");
if (out) {
  writeFileSync(out, text);
  console.error(`wrote ${out}`);
} else {
  process.stdout.write(text);
}
