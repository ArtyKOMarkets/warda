import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeReading, encodeReading, type ChainReading } from "../src/chain.ts";
import {
  compare,
  duration,
  networkLabel,
  group,
  hashrate,
  kas,
  perSecond,
  renderMarkdown,
  renderText,
} from "../src/digest.ts";

/**
 * A reading with plausible testnet-10 magnitudes. Every test below moves one
 * thing from this baseline, so a failure names the thing that moved.
 */
function reading(at: string, over: Partial<ChainReading> = {}): ChainReading {
  return {
    at,
    network: "kaspa-testnet-10",
    node: { url: "ws://127.0.0.1:18210", serverVersion: "1.0.1", synced: true },
    daaScore: 41_000_000n,
    sink: "aa".repeat(32),
    tips: 3,
    mempoolSize: 7n,
    blockCount: 1_200_000n,
    blueScore: 40_900_000n,
    circulatingSompi: 4_800_000_000n * 100_000_000n,
    maxSompi: 28_700_000_000n * 100_000_000n,
    hashesPerSecond: 1_210_000_000_000_000n,
    missing: [],
    ...over,
  };
}

const DAY = 86_400;
const later = (seconds: number) => new Date(Date.parse("2026-09-01T06:00:00.000Z") + seconds * 1000).toISOString();

test("differences are taken counter by counter", () => {
  const r = compare(
    reading(later(0)),
    reading(later(DAY), {
      daaScore: 41_864_000n,
      blueScore: 41_763_000n,
      circulatingSompi: 4_800_000_000n * 100_000_000n + 431_956_200_000n,
      blockCount: 1_205_000n,
    }),
  );

  assert.equal(r.seconds, DAY);
  assert.equal(r.daa.delta, 864_000n);
  assert.equal(r.blueScore!.delta, 863_000n);
  assert.equal(r.minted!.delta, 431_956_200_000n);
  assert.equal(r.blockCount.delta, 5_000n);
  assert.equal(r.network, "kaspa-testnet-10");
});

test("readings from two networks are refused rather than subtracted", () => {
  assert.throws(
    () => compare(reading(later(0)), reading(later(DAY), { network: "kaspa-mainnet" })),
    /different networks/,
  );
});

test("a closing reading that is not after the opening one is refused", () => {
  assert.throws(() => compare(reading(later(DAY)), reading(later(0))), /not after/);
  assert.throws(() => compare(reading(later(0)), reading(later(0))), /not after/);
});

test("a counter that went backwards is a reset, never a negative delta", () => {
  const r = compare(reading(later(0)), reading(later(DAY), { blueScore: 40_000_000n }));

  assert.equal(r.blueScore!.reset, true);
  assert.equal(r.blueScore!.delta, null);

  // and the line is gone rather than rendered as a loss
  const text = renderText(r);
  assert.ok(!text.includes("blue score"), text);
  // a leading minus on any rendered figure; the network name's own hyphen in
  // "testnet-10" is not one, which is why this looks for the space before it
  assert.ok(!/ -\d/.test(text), `a negative number reached the output:\n${text}`);
});

test("pruning is reported as state, and explained rather than subtracted", () => {
  const r = compare(reading(later(0)), reading(later(DAY), { blockCount: 900_000n }));
  assert.equal(r.blockCount.reset, true);
  assert.match(renderMarkdown(r), /pruning removes them/);
});

test("an optional counter missing from either reading drops out of the report", () => {
  const missing = { method: "getCoinSupply", why: "method not found" };
  const r = compare(
    reading(later(0), { circulatingSompi: undefined, maxSompi: undefined, missing: [missing] }),
    reading(later(DAY), { missing: [missing] }),
  );

  assert.equal(r.minted, undefined);
  assert.equal(r.missing.length, 1, "the same failure in both readings is one footnote");
  assert.ok(!renderText(r).includes("minted"));
  assert.match(renderMarkdown(r), /getCoinSupply` did not answer/);
});

test("an unsynced node is called out in both renderings", () => {
  const stale = reading(later(DAY), {
    daaScore: 41_010_000n,
    node: { url: "ws://x", serverVersion: "1.0.1", synced: false },
  });
  assert.match(renderText(compare(reading(later(0)), stale)), /NOT SYNCED/);
  assert.match(renderMarkdown(compare(reading(later(0)), stale)), /not synced/);
});

test("the heading states the interval obtained, not the one wanted", () => {
  const short = compare(reading(later(0)), reading(later(DAY - 48 * 60), { daaScore: 41_800_000n }));
  assert.match(renderText(short), /23 h 12 m/);
});

test("the node's url is never rendered", () => {
  const r = compare(reading(later(0)), reading(later(DAY), { daaScore: 41_864_000n }));
  assert.ok(!renderText(r).includes("127.0.0.1"));
  assert.ok(!renderMarkdown(r).includes("127.0.0.1"));
});

test("both renderers publish the same numbers", () => {
  const r = compare(
    reading(later(0)),
    reading(later(DAY), {
      daaScore: 41_864_000n,
      blueScore: 41_763_000n,
      circulatingSompi: 4_800_000_000n * 100_000_000n + 431_956_200_000n,
    }),
  );
  const text = renderText(r);
  const md = renderMarkdown(r);
  for (const value of ["+864,000", "+863,000", "+4,319.56 KAS", "1.21 PH/s"]) {
    assert.ok(text.includes(value), `text is missing ${value}:\n${text}`);
    assert.ok(md.includes(value), `markdown is missing ${value}:\n${md}`);
  }
});

// ---- formatting ----------------------------------------------------------

test("group inserts separators and leaves signs alone", () => {
  assert.equal(group(0n), "0");
  assert.equal(group(999n), "999");
  assert.equal(group(1_000n), "1,000");
  assert.equal(group(41_203_881n), "41,203,881");
  assert.equal(group(-1_234n), "-1,234");
});

test("kas truncates rather than rounds, because a rounded balance is a wrong balance", () => {
  assert.equal(kas(100_000_000n), "1");
  assert.equal(kas(150_000_000n), "1.50");
  assert.equal(kas(199_999_999n), "1.99");
  assert.equal(kas(1n), "0");
  assert.equal(kas(431_956_200_000n), "4,319.56");
  assert.equal(kas(431_956_200_000n, 0), "4,319");
});

test("perSecond keeps two decimals without floating point", () => {
  assert.equal(perSecond(864_000n, 86_400), "10.00");
  assert.equal(perSecond(863_000n, 86_400), "9.98");
  assert.equal(perSecond(1n, 86_400), "0.00");
});

test("the network is named once, not twice", () => {
  assert.equal(networkLabel("kaspa-testnet-10"), "testnet-10");
  assert.equal(networkLabel("kaspa-mainnet"), "mainnet");
  assert.equal(networkLabel("testnet-10"), "testnet-10");
  const r = compare(reading(later(0)), reading(later(DAY), { daaScore: 41_864_000n }));
  assert.match(renderText(r), /^Kaspa testnet-10 ·/);
});

test("hashrate scales", () => {
  assert.equal(hashrate(999n), "999.00 H/s");
  assert.equal(hashrate(1_210_000_000_000_000n), "1.21 PH/s");
});

test("duration reads as a person would write it", () => {
  assert.equal(duration(86_400), "24 h");
  assert.equal(duration(83_520), "23 h 12 m");
  assert.equal(duration(600), "10 m");
  assert.equal(duration(3_600), "1 h");
  assert.equal(duration(604_800), "7 d");
  assert.equal(duration(90_000), "25 h");
  assert.equal(duration(200_000), "2 d 7 h");
});

// ---- storage -------------------------------------------------------------

test("a reading survives the round trip with its bigints intact", () => {
  const before = reading(later(0));
  const after = decodeReading(encodeReading(before));
  assert.deepEqual(after, before);
});

test("bigints are quoted on the way out, so nothing downstream can round them", () => {
  // A real supply figure, not a round one. 4.8e17 happens to be exactly
  // representable as a double, so a round fixture would have passed this test
  // whether or not the quoting worked.
  const exact = 480_000_123_456_789_017n;
  const json = JSON.parse(encodeReading(reading(later(0), { circulatingSompi: exact })));

  assert.equal(typeof json.circulatingSompi, "string");
  assert.equal(json.circulatingSompi, exact.toString());
  assert.notEqual(
    BigInt(Number(json.circulatingSompi)),
    exact,
    "this fixture must be a value a double cannot hold, or it proves nothing",
  );
  assert.equal(decodeReading(encodeReading(reading(later(0), { circulatingSompi: exact }))).circulatingSompi, exact);
});

test("a file that is not a reading is refused rather than half-decoded", () => {
  assert.throws(() => decodeReading('{"at":"2026-09-01T00:00:00Z"}'), /not a chain reading/);
  assert.throws(() => decodeReading('{"at":1,"network":"x","missing":[]}'), /not a chain reading/);
});
