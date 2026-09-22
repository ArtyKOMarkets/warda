/**
 * Five-field cron, UTC, minute resolution: `m h dom mon dow`.
 *
 * Written here rather than imported because the runner needs exactly two
 * questions answered — does this minute match, and which was the latest
 * matching minute in a window — and a scheduler that pays money should not
 * depend on a package's opinion of what `0 9 * * 1-5` means in a timezone.
 * Everything is UTC. The console converts once, in front of the person.
 *
 * Supported: `*`, `n`, `a-b`, `a,b,c`, `* /n` and `a-b/n` (written without the
 * space). Day-of-week 0 and 7 are both Sunday. As in classic cron, when both
 * day-of-month and day-of-week are restricted, either may match.
 */

const RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];
const NAMES = ["minute", "hour", "day of month", "month", "day of week"];

export interface Cron {
  source: string;
  sets: Set<number>[];
  domAny: boolean;
  dowAny: boolean;
}

export function parseCron(source: string): Cron {
  const fields = source.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`a schedule is five fields (minute hour day month weekday), got ${fields.length}: "${source}"`);
  }
  const sets = fields.map((f, i) => field(f, i));
  const dow = sets[4]!;
  if (dow.has(7)) dow.add(0);
  return { source, sets, domAny: fields[2] === "*", dowAny: fields[4] === "*" };
}

function field(text: string, i: number): Set<number> {
  const [lo, hi] = RANGES[i]!;
  const out = new Set<number>();
  for (const part of text.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`"${part}" is not a valid ${NAMES[i]} in a schedule`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`a step of ${step} in the ${NAMES[i]} field never advances`);
    let a = lo;
    let b = hi;
    if (m[1] !== "*") {
      const [x, y] = m[1]!.split("-").map(Number);
      a = x!;
      b = y ?? (m[2] ? hi : x!);
    }
    if (a < lo || b > hi || a > b) throw new Error(`${m[1]} is outside ${lo}-${hi} for the ${NAMES[i]}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function matches(c: Cron, at: Date): boolean {
  const [mi, h, dom, mon, dow] = c.sets as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
  if (!mi.has(at.getUTCMinutes()) || !h.has(at.getUTCHours()) || !mon.has(at.getUTCMonth() + 1)) return false;
  const d = dom.has(at.getUTCDate());
  const w = dow.has(at.getUTCDay());
  if (c.domAny && c.dowAny) return true;
  if (c.domAny) return w;
  if (c.dowAny) return d;
  return d || w;
}

const MIN = 60_000;

/**
 * Every matching minute in (after, upTo], newest first, looking back at most
 * `lookbackMs`. The engine runs the newest and logs the rest as missed: a
 * runner that was down for a day must not wake up and buy 24 hourly digests.
 */
export function slotsBetween(c: Cron, after: number, upTo: number, lookbackMs = 7 * 24 * 60 * MIN): number[] {
  const out: number[] = [];
  const floor = Math.max(after, upTo - lookbackMs);
  for (let t = Math.floor(upTo / MIN) * MIN; t > floor; t -= MIN) {
    if (matches(c, new Date(t))) out.push(t);
  }
  return out;
}

/** The shortest gap between two consecutive runs, found over two weeks. */
export function minimumIntervalMs(c: Cron): number {
  const start = Date.UTC(2026, 0, 5);
  let prev: number | null = null;
  let best = Infinity;
  for (let t = start; t < start + 14 * 24 * 60 * MIN; t += MIN) {
    if (!matches(c, new Date(t))) continue;
    if (prev !== null) best = Math.min(best, t - prev);
    prev = t;
  }
  return best;
}
