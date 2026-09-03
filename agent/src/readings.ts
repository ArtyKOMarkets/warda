/**
 * Where readings live, and how a daily digest finds its pair.
 *
 * The agent takes a reading on a schedule and keeps every one of them. A digest
 * is then two of those files, and choosing WHICH two is the only decision in
 * the whole pipeline that could quietly produce a wrong headline: pick a pair
 * 19 hours apart, label it "24 h", and every rate in the digest is off by a
 * fifth while every individual number remains true.
 *
 * So the picking is a pure function, it is tested, and — this is the part that
 * matters — the digest reports the interval it ACTUALLY got rather than the one
 * that was asked for. `duration(r.seconds)` in the heading is computed from the
 * two timestamps, never from the window argument. A run that misses its cron
 * slot publishes "23 h 12 m" and stays true.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { decodeReading, type ChainReading } from "./chain.ts";

export interface StoredReading {
  path: string;
  reading: ChainReading;
}

/** Every readable reading in a directory, oldest first. */
export function loadReadings(dir: string, network?: string): StoredReading[] {
  const out: StoredReading[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    let reading: ChainReading;
    try {
      reading = decodeReading(readFileSync(path, "utf8"));
    } catch {
      // A file that is not a reading is not an error. This directory is also
      // where digests and their sidecars land, and a half-written file from an
      // interrupted run must not stop the next one.
      continue;
    }
    if (network && reading.network !== network) continue;
    out.push({ path, reading });
  }
  return out.sort((a, b) => Date.parse(a.reading.at) - Date.parse(b.reading.at));
}

export interface Pair {
  before: StoredReading;
  after: StoredReading;
  /** How far the interval actually obtained is from the one asked for. */
  offBySeconds: number;
}

/**
 * The newest reading, and whichever earlier one sits closest to `windowSeconds`
 * before it.
 *
 * Closest rather than "the first one at least that old" because both directions
 * of error are equally wrong and the nearest is the nearest. A 24 h window with
 * hourly readings picks a pair within half an hour of 24 h; with one reading a
 * day it picks yesterday's; with nothing older than the window it picks the
 * oldest there is and says so through `offBySeconds`.
 */
export function pickPair(input: StoredReading[], windowSeconds: number): Pair | null {
  if (input.length < 2) return null;

  // `loadReadings` already returns these in order, and depending on that would
  // have worked for every caller in this repository. It would then have picked
  // whichever reading happened to be last for the first caller that assembled a
  // list some other way, and the digest built from it would have looked fine.
  const readings = [...input].sort(
    (a, b) => Date.parse(a.reading.at) - Date.parse(b.reading.at),
  );
  const after = readings[readings.length - 1]!;
  const target = Date.parse(after.reading.at) - windowSeconds * 1000;

  let before = readings[0]!;
  for (const candidate of readings.slice(0, -1)) {
    const closer =
      Math.abs(Date.parse(candidate.reading.at) - target) <
      Math.abs(Date.parse(before.reading.at) - target);
    if (closer) before = candidate;
  }

  const actual = (Date.parse(after.reading.at) - Date.parse(before.reading.at)) / 1000;
  return { before, after, offBySeconds: Math.round(actual - windowSeconds) };
}

/**
 * A filename that sorts chronologically and survives every filesystem.
 *
 * Colons are legal on ext4 and a bad idea on anything that might one day be a
 * zip, a share or a Windows checkout, so the ISO timestamp is flattened rather
 * than embedded verbatim. The timestamp inside the file is the authority; this
 * is only a name.
 */
export function readingFilename(reading: ChainReading): string {
  const t = reading.at.replace(/[:.]/g, "-").replace(/Z$/, "Z");
  return `${reading.network}-${t}.json`;
}

/** Parse `24h`, `90m`, `3600`, `7d` into seconds. */
export function windowSeconds(spec: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd]?)$/.exec(spec.trim());
  if (!m) throw new Error(`not a window: ${spec} (try 24h, 90m, 7d)`);
  const scale = { s: 1, m: 60, h: 3600, d: 86400, "": 1 }[m[2]!]!;
  return Math.round(Number(m[1]) * scale);
}
