import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { encodeReading, type ChainReading } from "../src/chain.ts";
import {
  loadReadings,
  pickPair,
  readingFilename,
  windowSeconds,
  type StoredReading,
} from "../src/readings.ts";

function reading(at: string, network = "kaspa-testnet-10"): ChainReading {
  return {
    at,
    network,
    node: { url: "ws://127.0.0.1:18210", serverVersion: "1.0.1", synced: true },
    daaScore: 41_000_000n,
    sink: "aa".repeat(32),
    tips: 3,
    mempoolSize: 7n,
    blockCount: 1_200_000n,
    missing: [],
  };
}

const stored = (at: string): StoredReading => ({ path: at, reading: reading(at) });
const hoursAgo = (h: number) =>
  new Date(Date.parse("2026-09-02T06:00:00.000Z") - h * 3_600_000).toISOString();

test("windowSeconds understands the units a person types", () => {
  assert.equal(windowSeconds("24h"), 86_400);
  assert.equal(windowSeconds("7d"), 604_800);
  assert.equal(windowSeconds("90m"), 5_400);
  assert.equal(windowSeconds("3600"), 3_600);
  assert.equal(windowSeconds(" 24 h "), 86_400);
  assert.throws(() => windowSeconds("a while"), /not a window/);
  assert.throws(() => windowSeconds("24 hours"), /not a window/);
});

test("pickPair takes the newest reading and the one closest to the window", () => {
  const readings = [0, 1, 12, 23, 24, 25, 48].map((h) => stored(hoursAgo(h))).reverse();
  const pair = pickPair(readings, 86_400)!;

  assert.equal(pair.after.reading.at, hoursAgo(0));
  assert.equal(pair.before.reading.at, hoursAgo(24));
  assert.equal(pair.offBySeconds, 0);
});

test("closest means closest, in either direction", () => {
  // nothing at 24 h: 23 h is nearer than 26 h
  const pair = pickPair([26, 23, 0].map((h) => stored(hoursAgo(h))), 86_400)!;
  assert.equal(pair.before.reading.at, hoursAgo(23));
  assert.equal(pair.offBySeconds, -3_600);
});

test("with nothing old enough it reports the interval it could get", () => {
  const pair = pickPair([6, 3, 0].map((h) => stored(hoursAgo(h))), 86_400)!;
  assert.equal(pair.before.reading.at, hoursAgo(6));
  assert.equal(pair.offBySeconds, -(18 * 3_600));
});

test("the caller's ordering is not trusted", () => {
  const shuffled = [12, 0, 24, 3].map((h) => stored(hoursAgo(h)));
  const pair = pickPair(shuffled, 86_400)!;
  assert.equal(pair.after.reading.at, hoursAgo(0));
  assert.equal(pair.before.reading.at, hoursAgo(24));
  assert.equal(pair.offBySeconds, 0);
});

test("one reading is not a pair", () => {
  assert.equal(pickPair([stored(hoursAgo(0))], 86_400), null);
  assert.equal(pickPair([], 86_400), null);
});

test("loadReadings sorts by time, ignores junk, and can filter by network", () => {
  const dir = mkdtempSync(join(tmpdir(), "warda-readings-"));
  for (const h of [24, 0, 12]) {
    writeFileSync(join(dir, `t-${h}.json`), encodeReading(reading(hoursAgo(h))));
  }
  writeFileSync(join(dir, "main.json"), encodeReading(reading(hoursAgo(1), "kaspa-mainnet")));
  writeFileSync(join(dir, "digest.md"), "# not a reading\n");
  writeFileSync(join(dir, "half-written.json"), '{"at":"2026-');

  const all = loadReadings(dir);
  assert.equal(all.length, 4);
  assert.deepEqual(
    all.map((r) => r.reading.at),
    [hoursAgo(24), hoursAgo(12), hoursAgo(1), hoursAgo(0)],
  );

  const testnet = loadReadings(dir, "kaspa-testnet-10");
  assert.equal(testnet.length, 3);
  assert.ok(testnet.every((r) => r.reading.network === "kaspa-testnet-10"));
});

test("filenames sort chronologically and carry nothing a filesystem dislikes", () => {
  const names = [24, 0, 12].map((h) => readingFilename(reading(hoursAgo(h))));
  assert.deepEqual([...names].sort(), [names[0], names[2], names[1]].sort());
  for (const name of names) {
    assert.ok(!/[:*?"<>|]/.test(name), name);
    assert.match(name, /^kaspa-testnet-10-.*\.json$/);
  }
});
