/**
 * Two readings in, one digest out.
 *
 * ## What makes a number publishable
 *
 * Everything here is a difference between two counters the network maintains
 * for its own reasons. Nothing is sampled, estimated or extrapolated, with one
 * exception that is labelled as the node's estimate wherever it appears.
 *
 * That is a deliberately narrow claim, and it is the reason this agent can run
 * unattended without anyone auditing its output. A digest that said "roughly
 * 340,000 transactions today" would need someone to check it. A digest that
 * says "the circulating supply rose by 43,195.62 KAS between these two DAA
 * scores" needs only the two readings, both of which are published beside it,
 * and either of which anyone with a node can re-derive.
 *
 * ## Counters that go backwards
 *
 * Three of the six counters are monotonic and three are not. `blockCount` falls
 * when the node prunes. A restarted or resynced node can move in ways no
 * arithmetic here should paper over. So every difference is taken through
 * `advance`, which reports a reset as a reset rather than as a negative delta,
 * and the renderers omit the line entirely rather than print a minus sign that
 * would be read as the network shrinking.
 *
 * ## What is deliberately not rendered
 *
 * The node's URL. It is recorded in the reading, because provenance belongs
 * with the data, but a digest is a public artefact and the node behind it is
 * infrastructure, not content. Its version and network are what a reader needs
 * to judge the numbers.
 */
import type { ChainReading } from "./chain.ts";

export interface Advance {
  from: bigint;
  to: bigint;
  /** Non-negative. Null when the counter went backwards. */
  delta: bigint | null;
  /** True when the counter went backwards, which is a fact about the NODE. */
  reset: boolean;
}

export interface IntervalReport {
  network: string;
  from: string;
  to: string;
  /** Wall clock, by the agent's own clock at each reading. */
  seconds: number;
  serverVersion: string;
  synced: boolean;

  daa: Advance;
  blockCount: Advance;
  blueScore?: Advance;
  /** Sompi that came into existence. The network's emission over the window. */
  minted?: Advance;

  /** The state at the closing reading — context, not measurement. */
  end: {
    daaScore: bigint;
    circulatingSompi?: bigint;
    maxSompi?: bigint;
    hashesPerSecond?: bigint;
    mempoolSize: bigint;
    tips: number;
    blockCount: bigint;
  };

  /** Methods either reading could not obtain, deduplicated by method name. */
  missing: { method: string; why: string }[];
}

function advance(from: bigint, to: bigint): Advance {
  const back = to < from;
  return { from, to, delta: back ? null : to - from, reset: back };
}

/**
 * Compare two readings.
 *
 * The two refusals are both cases where an answer exists but means nothing:
 * a difference across networks is arithmetic on unrelated chains, and a
 * difference across zero elapsed time divides by zero to produce rates that
 * would be rendered as though measured.
 */
export function compare(before: ChainReading, after: ChainReading): IntervalReport {
  if (before.network !== after.network) {
    throw new Error(
      `these readings are from different networks (${before.network} then ${after.network}), ` +
        `so no difference between them describes anything`,
    );
  }
  const seconds = (Date.parse(after.at) - Date.parse(before.at)) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(
      `the closing reading (${after.at}) is not after the opening one (${before.at})`,
    );
  }

  const both = <T>(a: T | undefined, b: T | undefined, f: (a: T, b: T) => Advance) =>
    a === undefined || b === undefined ? undefined : f(a, b);

  const missing = [...before.missing, ...after.missing].filter(
    (m, i, all) => all.findIndex((o) => o.method === m.method) === i,
  );

  return {
    network: after.network,
    from: before.at,
    to: after.at,
    seconds,
    serverVersion: after.node.serverVersion,
    synced: after.node.synced,
    daa: advance(before.daaScore, after.daaScore),
    blockCount: advance(before.blockCount, after.blockCount),
    blueScore: both(before.blueScore, after.blueScore, advance),
    minted: both(before.circulatingSompi, after.circulatingSompi, advance),
    end: {
      daaScore: after.daaScore,
      circulatingSompi: after.circulatingSompi,
      maxSompi: after.maxSompi,
      hashesPerSecond: after.hashesPerSecond,
      mempoolSize: after.mempoolSize,
      tips: after.tips,
      blockCount: after.blockCount,
    },
    missing,
  };
}

// ---- formatting ----------------------------------------------------------

export function group(v: bigint): string {
  return v.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function kas(sompi: bigint, decimals = 2): string {
  const whole = sompi / 100_000_000n;
  const frac = (sompi % 100_000_000n).toString().padStart(8, "0").slice(0, decimals);
  return decimals === 0 || /^0*$/.test(frac) ? group(whole) : `${group(whole)}.${frac}`;
}

/** Per-second rate, two decimals, computed in bigint so nothing rounds early. */
export function perSecond(delta: bigint, seconds: number): string {
  const hundredths = (delta * 100n) / BigInt(Math.round(seconds));
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
}

export function hashrate(hps: bigint): string {
  const units = ["H", "kH", "MH", "GH", "TH", "PH", "EH"];
  let v = Number(hps);
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}/s`;
}

export function duration(seconds: number): string {
  let h = Math.floor(seconds / 3600);
  let m = Math.round((seconds % 3600) / 60);
  // 86,399 seconds is 23 h and 59.98 m, which rounds to 60 and reads as
  // "23 h 60 m". An hourly schedule lands a second or two either side of the
  // hour constantly, so this is the ordinary case rather than an edge one.
  if (m === 60) {
    h += 1;
    m = 0;
  }

  // Days only past 48 h. A daily digest's own window is 24 h, and "1 d" for it
  // would be a worse heading than "24 h" — the hours are the point at that
  // scale. Past two days the hours stop carrying meaning and the days start.
  if (h >= 48) {
    const d = Math.floor(h / 24);
    return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`;
  }
  if (h === 0) return `${m} m`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/**
 * kaspad names its networks `kaspa-testnet-10`, and a heading reading
 * "Kaspa kaspa-testnet-10" says it twice. The stored reading keeps the node's
 * own spelling; only the display drops the prefix.
 */
export function networkLabel(network: string): string {
  return network.replace(/^kaspa-/, "");
}

function stamp(iso: string): string {
  return iso.replace("T", " ").replace(/:\d\d\.\d+Z$/, " UTC");
}

// ---- rendering -----------------------------------------------------------

interface Line {
  label: string;
  value: string;
  note: string;
}

/**
 * The lines, in one place, so the two renderers cannot drift apart and start
 * publishing different numbers under the same name.
 */
function lines(r: IntervalReport): Line[] {
  const out: Line[] = [];

  if (r.blueScore?.delta != null) {
    out.push({
      label: "blue score",
      value: `+${group(r.blueScore.delta)}`,
      note: `${perSecond(r.blueScore.delta, r.seconds)} blue blocks/s`,
    });
  }
  if (r.daa.delta != null) {
    out.push({
      label: "DAA score",
      value: `+${group(r.daa.delta)}`,
      note: `now ${group(r.end.daaScore)}`,
    });
  }
  if (r.minted?.delta != null) {
    out.push({
      label: "minted",
      value: `+${kas(r.minted.delta)} KAS`,
      note: r.end.circulatingSompi
        ? `${kas(r.end.circulatingSompi, 0)} KAS in existence`
        : "",
    });
  }
  if (r.end.hashesPerSecond !== undefined) {
    out.push({
      label: "hashrate",
      value: hashrate(r.end.hashesPerSecond),
      note: "node estimate over its last 1,000 blocks",
    });
  }
  out.push({
    label: "mempool",
    value: `${group(r.end.mempoolSize)} tx`,
    note: "held, unaccepted, at the closing reading",
  });
  out.push({
    label: "DAG",
    value: `${r.end.tips} tips`,
    note: `${group(r.end.blockCount)} blocks held by this node`,
  });

  return out;
}

/** For a terminal, or a post. Fixed-width, no markdown, no links. */
export function renderText(r: IntervalReport): string {
  const rows = lines(r);
  const w = Math.max(...rows.map((l) => l.label.length));
  const v = Math.max(...rows.map((l) => l.value.length));

  const body = rows
    .map((l) => `  ${l.label.padEnd(w)}  ${l.value.padEnd(v)}${l.note ? `  ${l.note}` : ""}`)
    .join("\n");

  const head = `Kaspa ${networkLabel(r.network)} · ${duration(r.seconds)} to ${stamp(r.to)}`;
  const foot = [
    `measured between two readings of one node (kaspad ${r.serverVersion})`,
    r.synced ? null : `WARNING: that node reported itself NOT SYNCED`,
    r.missing.length
      ? `not read: ${r.missing.map((m) => m.method).join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  return `${head}\n\n${body}\n\n${foot}\n`;
}

/** For publishing. Says where every number came from and how to redo it. */
export function renderMarkdown(r: IntervalReport): string {
  const rows = lines(r)
    .map((l) => `| ${l.label} | ${l.value} | ${l.note} |`)
    .join("\n");

  const notes: string[] = [];
  if (!r.synced) {
    notes.push(
      `- The node reported itself **not synced** at the closing reading. Every ` +
        `number above is therefore a lower bound at best.`,
    );
  }
  if (r.blueScore?.reset || r.daa.reset || r.minted?.reset) {
    notes.push(
      `- A counter that only ever rises was **lower** at the closing reading than ` +
        `at the opening one. That is a fact about the node, not the network — a ` +
        `resync or a swapped node — and the affected line is omitted rather than ` +
        `printed as a negative.`,
    );
  }
  if (r.end.blockCount < r.blockCount.from) {
    notes.push(
      `- The node holds fewer blocks than it did at the opening reading. This is ` +
        `normal: pruning removes them. It is why "blocks held" is reported as a ` +
        `state and never as a difference.`,
    );
  }
  for (const m of r.missing) {
    notes.push(`- \`${m.method}\` did not answer, so its line is absent: ${m.why}`);
  }

  return [
    `# Kaspa ${networkLabel(r.network)} — ${duration(r.seconds)} to ${stamp(r.to)}`,
    ``,
    `| measure | over this window | context |`,
    `|---|---|---|`,
    rows,
    ``,
    `## Where these came from`,
    ``,
    `Two readings of a single kaspad (${r.serverVersion}), taken at ${stamp(r.from)} ` +
      `and ${stamp(r.to)}. Every figure above is the difference between two counters ` +
      `the network maintains for its own reasons, or the state at the closing reading. ` +
      `Nothing is sampled or extrapolated; the hashrate is the node's own estimate and ` +
      `is labelled as such.`,
    ``,
    `Both readings are published beside this digest. Anyone with a Kaspa node can take ` +
      `their own pair and get the same differences.`,
    ...(notes.length ? [``, `## Caveats`, ``, ...notes] : []),
    ``,
  ].join("\n");
}
