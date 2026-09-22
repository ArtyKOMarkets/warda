import { useState } from "react";
import { kas } from "@/lib/format";
import { cn } from "@/lib/cn";

export interface Bar { key: string; label: string; value: number; blocked?: number }

/** Daily bars. Hover shows the day; KAS on the axis, nothing else. */
export function BarChart({ data, height = 200 }: { data: Bar[]; height?: number }) {
  const [hi, setHi] = useState<number | null>(null);
  const max = Math.max(0.0001, ...data.map((d) => d.value));
  const cur = hi !== null ? data[hi] : null;
  return (
    <div className="relative">
      <div className="mb-3 flex h-10 items-end justify-between">
        <div>
          <div className="text-[12px] text-fg-3">{cur ? cur.label : "Last 30 days"}</div>
          <div className="num text-[22px] font-semibold tracking-[-0.03em]">
            {kas(cur ? cur.value : data.reduce((s, d) => s + d.value, 0))}<span className="ml-1 text-[12px] font-medium text-fg-3">KAS</span>
            {cur?.blocked ? <span className="ml-3 text-[12px] font-normal text-bad">{cur.blocked} blocked</span> : null}
          </div>
        </div>
        <div className="num text-right text-[11px] text-fg-3">max {kas(max)} / day</div>
      </div>
      <div className="relative flex items-end gap-[3px]" style={{ height }} onMouseLeave={() => setHi(null)}>
        {[0.25, 0.5, 0.75].map((f) => <div key={f} className="pointer-events-none absolute inset-x-0 border-t border-dashed border-line" style={{ bottom: `${f * 100}%` }} />)}
        {data.map((d, i) => (
          <div key={d.key} className="relative flex h-full flex-1 cursor-default items-end" onMouseEnter={() => setHi(i)} onTouchStart={() => setHi(i)}>
            <div className={cn("w-full rounded-t-[3px] transition-[background,height] duration-300", d.value ? (hi === i ? "bg-accent-strong" : "bg-accent/80") : "bg-line")}
              style={{ height: d.value ? `${Math.max(3, (d.value / max) * 100)}%` : 2 }} />
            {d.blocked ? <span className="absolute -top-2 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-bad" /> : null}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-fg-3"><span>{data[0]?.label}</span><span>{data[data.length - 1]?.label}</span></div>
    </div>
  );
}

export function HBars({ rows, unit = "KAS" }: { rows: { label: React.ReactNode; value: number; key: string }[]; unit?: string }) {
  const max = Math.max(0.0001, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-3.5">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate">{r.label}</span>
            <span className="num shrink-0 text-fg-2">{unit === "KAS" ? kas(r.value) : r.value}<span className="ml-1 text-[11px] text-fg-3">{unit}</span></span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-gradient-to-r from-accent/60 to-accent" style={{ width: `${(r.value / max) * 100}%` }} /></div>
        </li>
      ))}
    </ul>
  );
}

/** Cumulative KAS over the range, with the date under the cursor. */
export function CumulativeChart({ points, height = 180 }: { points: { at: number; total: number }[]; height?: number }) {
  const [hi, setHi] = useState<number | null>(null);
  if (points.length < 2) return <p className="py-8 text-center text-[13px] text-fg-3">Not enough payments yet to draw a line.</p>;
  const W = 600, H = height;
  const t0 = points[0]!.at, t1 = points[points.length - 1]!.at || t0 + 1;
  const max = points[points.length - 1]!.total || 1;
  const xy = points.map((p) => [((p.at - t0) / Math.max(1, t1 - t0)) * (W - 4) + 2, H - 4 - (p.total / max) * (H - 16)] as const);
  const d = xy.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
  const cur = hi === null ? points[points.length - 1]! : points[hi]!;
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <div><div className="text-[12px] text-fg-3">{new Date(cur.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
          <div className="num text-[22px] font-semibold tracking-[-0.03em]">{kas(cur.total)}<span className="ml-1 text-[12px] font-medium text-fg-3">KAS spent by then</span></div></div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full" style={{ height }} onMouseLeave={() => setHi(null)}
        onMouseMove={(e) => { const r = (e.target as SVGElement).closest("svg")!.getBoundingClientRect(); const f = (e.clientX - r.left) / r.width; setHi(Math.max(0, Math.min(points.length - 1, Math.round(f * (points.length - 1))))); }}>
        <path d={`${d} L${xy[xy.length - 1]![0]} ${H} L2 ${H} Z`} fill="var(--color-accent)" fillOpacity="0.1" />
        <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        {hi !== null && <line x1={xy[hi]![0]} x2={xy[hi]![0]} y1="0" y2={H} stroke="var(--color-line-strong)" vectorEffect="non-scaling-stroke" />}
      </svg>
    </div>
  );
}

export const HUES = [172, 200, 228, 262, 292, 330, 18, 42, 140];
export const hueOf = (i: number) => `hsl(${HUES[i % HUES.length]} 62% 52%)`;

/** Where it went, by agent. */
export function Donut({ rows, size = 168 }: { rows: { key: string; label: string; value: number }[]; size?: number }) {
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (!total) return <p className="py-6 text-center text-[13px] text-fg-3">Nothing spent in this range.</p>;
  const R = size / 2, r = R * 0.62;
  let a0 = -Math.PI / 2;
  const arcs = rows.map((row, i) => {
    const a1 = a0 + (row.value / total) * Math.PI * 2;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, rr: number) => `${(R + Math.cos(rad) * rr).toFixed(2)} ${(R + Math.sin(rad) * rr).toFixed(2)}`;
    const d = `M${p(a0, R)} A${R} ${R} 0 ${big} 1 ${p(a1, R)} L${p(a1, r)} A${r} ${r} 0 ${big} 0 ${p(a0, r)} Z`;
    a0 = a1;
    return { d, row, i };
  });
  return (
    <div className="flex flex-wrap items-center gap-6">
      <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }} role="img" aria-label="Spending by agent">
        {arcs.map(({ d, row, i }) => <path key={row.key} d={d} fill={hueOf(i)} opacity={0.9} />)}
      </svg>
      <ul className="min-w-[12rem] flex-1 space-y-1.5">
        {rows.map((row, i) => (
          <li key={row.key} className="flex items-center gap-2 text-[12.5px]">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: hueOf(i) }} />
            <span className="min-w-0 flex-1 truncate">{row.label}</span>
            <span className="num text-fg-2">{kas(row.value)}</span>
            <span className="num w-10 text-right text-fg-3">{Math.round((row.value / total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Daily spend, stacked by agent. */
export function StackedBars({ days, series, height = 200 }: { days: string[]; series: { key: string; label: string; values: number[] }[]; height?: number }) {
  const [hi, setHi] = useState<number | null>(null);
  const totals = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = Math.max(0.0001, ...totals);
  return (
    <div>
      <div className="mb-3 flex items-end justify-between">
        <div><div className="text-[12px] text-fg-3">{hi === null ? `Last ${days.length} days` : days[hi]}</div>
          <div className="num text-[22px] font-semibold tracking-[-0.03em]">{kas(hi === null ? totals.reduce((a, b) => a + b, 0) : totals[hi]!)}<span className="ml-1 text-[12px] font-medium text-fg-3">KAS</span></div></div>
        <ul className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-[11.5px] text-fg-3">
          {series.map((x, i) => <li key={x.key} className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: hueOf(i) }} />{x.label}</li>)}
        </ul>
      </div>
      <div className="flex items-end gap-[3px]" style={{ height }} onMouseLeave={() => setHi(null)}>
        {days.map((d, i) => (
          <div key={d} className="flex h-full flex-1 flex-col justify-end" onMouseEnter={() => setHi(i)}>
            {series.map((x, si) => {
              const v = x.values[i] ?? 0;
              return v > 0 ? <div key={x.key} style={{ height: `${(v / max) * 100}%`, background: hueOf(si), opacity: hi === null || hi === i ? 1 : 0.55 }} className="w-full first:rounded-t-[3px]" /> : null;
            })}
            {totals[i] === 0 && <div className="h-[2px] w-full bg-line" />}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-fg-3"><span>{days[0]}</span><span>{days[days.length - 1]}</span></div>
    </div>
  );
}

/** How much of a budget is gone, one ring per grant. */
export function Rings({ rows }: { rows: { key: string; label: string; used: number }[] }) {
  return (
    <div className="flex flex-wrap gap-5">
      {rows.map((r) => {
        const pct = Math.max(0, Math.min(100, r.used));
        const C = 2 * Math.PI * 26;
        return (
          <div key={r.key} className="w-[86px] text-center">
            <svg viewBox="0 0 64 64" className="mx-auto size-[64px] -rotate-90">
              <circle cx="32" cy="32" r="26" fill="none" stroke="var(--color-raised)" strokeWidth="7" />
              <circle cx="32" cy="32" r="26" fill="none" stroke={pct > 80 ? "var(--color-warn)" : "var(--color-accent)"} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${(pct / 100) * C} ${C}`} />
            </svg>
            <div className="num -mt-[42px] text-[13px] font-semibold">{Math.round(pct)}%</div>
            <div className="mt-[26px] truncate text-[11.5px] text-fg-3" title={r.label}>{r.label}</div>
          </div>
        );
      })}
    </div>
  );
}
