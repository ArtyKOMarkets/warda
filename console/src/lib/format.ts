/** "1.2 KAS" → 1.2. Readings carry amounts as display strings; nulls stay null. */
export function kasOf(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  const m = /-?[\d,]*\.?\d+/.exec(String(v));
  return m ? Number(m[0].replace(/,/g, "")) : null;
}

/** 0.94 → "0.94", 1234.5 → "1,234.5", 0.00001 → "0.00001". Never scientific notation. */
export function kas(n: number | null | undefined, opts: { max?: number } = {}): string {
  if (n === null || n === undefined || !isFinite(n)) return "—";
  const a = Math.abs(n);
  const max = opts.max ?? (a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 3 : 6);
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: max });
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.max(0, Math.min(100, (part / whole) * 100)) : 0;
}

export function ago(at: string | number | Date | null | undefined): string {
  if (!at) return "never";
  const t = typeof at === "number" ? at : new Date(at).getTime();
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 90) return "1 min ago";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 5400) return "1 h ago";
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? "yesterday" : d < 30 ? `${d} days ago` : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function inTime(ms: number | null): string {
  if (ms === null) return "—";
  if (ms <= 0) return "ended";
  const h = ms / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

/** A period of the covenant's epoch, in words: 1000 DAA ≈ 100 s. */
export function periodWords(seconds: number | null): string {
  if (!seconds) return "period";
  if (seconds < 120) return `${Math.round(seconds)} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172800) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} days`;
}

export function short(s: string | null | undefined, head = 10, tail = 6): string {
  if (!s) return "—";
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

export function dateTime(at: string | number | null | undefined): string {
  if (!at) return "—";
  return new Date(at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
