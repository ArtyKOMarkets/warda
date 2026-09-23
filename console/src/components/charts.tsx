import { useState, type ReactNode } from "react";
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

/* Eight categorical hues, stepped for this console's surface and checked with
   the palette validator: every adjacent pair clears the colour-blind and
   normal-vision floors against #0e1013. They are assigned in this order and
   never cycled — a ninth series folds into "Other" rather than inventing a
   colour that would collide with one already on screen. */
export const SERIES = ["#199e70", "#d95926", "#3987e5", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const OTHER = "#7a7a6f";
export const hueOf = (i: number) => SERIES[i] ?? OTHER;

/** Top eight by value; everything after that is one "Other" row. */
export function fold<T extends { value: number; label: any; key: string }>(rows: T[], keep = 8): (T | { key: string; label: string; value: number })[] {
  if (rows.length <= keep) return rows;
  const sorted = [...rows].sort((a, b) => b.value - a.value);
  const rest = sorted.slice(keep - 1).reduce((s, r) => s + r.value, 0);
  return [...sorted.slice(0, keep - 1), { key: "__other", label: `Other (${rows.length - keep + 1})`, value: rest }];
}

/** Where it went, by agent. */
export function Donut({ rows: all, size = 176 }: { rows: { key: string; label: string; value: number }[]; size?: number }) {
  const rows = fold(all) as { key: string; label: string; value: number }[];
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (!total) return <p className="py-6 text-center text-[13px] text-fg-3">Nothing spent in this range.</p>;
  const R = size / 2, r = R * 0.64, GAP = 0.02;   // a hair of surface between segments
  let a0 = -Math.PI / 2;
  const arcs = rows.map((row, i) => {
    const a1 = a0 + (row.value / total) * Math.PI * 2 - GAP;
    const big = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, rr: number) => `${(R + Math.cos(rad) * rr).toFixed(2)} ${(R + Math.sin(rad) * rr).toFixed(2)}`;
    const d = `M${p(a0, R)} A${R} ${R} 0 ${big} 1 ${p(a1, R)} L${p(a1, r)} A${r} ${r} 0 ${big} 0 ${p(a0, r)} Z`;
    a0 = a1 + GAP;
    return { d, row, i };
  });
  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} style={{ width: size, height: size }} role="img" aria-label="Spending by agent">
          {arcs.map(({ d, row, i }) => <path key={row.key} d={d} fill={row.key === "__other" ? OTHER : hueOf(i)}><title>{`${row.label}: ${kas(row.value)} KAS`}</title></path>)}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-content-center text-center">
          <div className="num text-[17px] font-semibold tracking-[-0.02em]">{kas(total)}</div>
          <div className="text-[11px] text-fg-3">KAS</div>
        </div>
      </div>
      <ul className="min-w-[12rem] flex-1 space-y-1.5">
        {rows.map((row, i) => (
          <li key={row.key} className="flex items-center gap-2 text-[12.5px]">
            <span className="size-2.5 shrink-0 rounded-sm" style={{ background: row.key === "__other" ? OTHER : hueOf(i) }} />
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
export function StackedBars({ days, series: allSeries, height = 200 }: { days: string[]; series: { key: string; label: string; values: number[] }[]; height?: number }) {
  const series = allSeries.length <= 8 ? allSeries : [...allSeries.slice(0, 7), {
    key: "__other", label: `Other (${allSeries.length - 7})`,
    values: days.map((_, i) => allSeries.slice(7).reduce((s, x) => s + (x.values[i] ?? 0), 0)),
  }];
  const [hi, setHi] = useState<number | null>(null);
  const totals = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = Math.max(0.0001, ...totals);
  return (
    <div>
      <div className="mb-3 flex items-end justify-between">
        <div><div className="text-[12px] text-fg-3">{hi === null ? `Last ${days.length} days` : days[hi]}</div>
          <div className="num text-[22px] font-semibold tracking-[-0.03em]">{kas(hi === null ? totals.reduce((a, b) => a + b, 0) : totals[hi]!)}<span className="ml-1 text-[12px] font-medium text-fg-3">KAS</span></div></div>
        <ul className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-[11.5px] text-fg-3">
          {series.map((x, i) => <li key={x.key} className="flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: x.key === "__other" ? OTHER : hueOf(i) }} />{x.label}</li>)}
        </ul>
      </div>
      <div className="flex items-end gap-[3px]" style={{ height }} onMouseLeave={() => setHi(null)}>
        {days.map((d, i) => (
          <div key={d} className="flex h-full flex-1 flex-col justify-end" onMouseEnter={() => setHi(i)}>
            {series.map((x, si) => {
              const v = x.values[i] ?? 0;
              return v > 0 ? <div key={x.key} title={`${x.label} · ${d}: ${kas(v)} KAS`}
                style={{ height: `${(v / max) * 100}%`, background: x.key === "__other" ? OTHER : hueOf(si), opacity: hi === null || hi === i ? 1 : 0.55, marginTop: si ? 2 : 0 }}
                className="w-full first:rounded-t-[4px]" /> : null;
            })}
            {totals[i] === 0 && <div className="h-[2px] w-full bg-line" />}
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-fg-3"><span>{days[0]}</span><span>{days[days.length - 1]}</span></div>
    </div>
  );
}

/** One ring: a share of something, drawn as the arc that is gone. */
export interface RingSeg { value: number; color: string; label?: string }

/** One circular progress mark. Either a single percentage, or ordered segments
    with a 2px surface gap between them so adjacent fills stay separable. */
export function Ring({ pct, segments, total, size = 72, width = 7, center, sub, warn, muted, className, title }: {
  pct?: number; segments?: RingSeg[]; total?: number; size?: number; width?: number;
  center?: ReactNode; sub?: ReactNode; warn?: boolean; muted?: boolean; className?: string; title?: string;
}) {
  const r = (size - width) / 2, C = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, isFinite(pct ?? 0) ? (pct ?? 0) : 0));
  const segs: RingSeg[] = segments?.filter((x) => x.value > 0) ?? [{ value: p, color: muted ? "var(--color-line-strong)" : warn ? "var(--color-warn)" : "var(--color-accent)" }];
  const tot = total ?? (segments ? segs.reduce((s, x) => s + x.value, 0) : 100);
  const gap = segs.length > 1 ? 2.5 : 0;
  let off = 0;
  const arcs = segs.map((sg, i) => {
    const len = tot > 0 ? (sg.value / tot) * C : 0;
    const draw = Math.max(0.5, len - gap);
    const node = (
      <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={width}
        stroke={sg.color} strokeLinecap={segs.length > 1 ? "butt" : "round"}
        strokeDasharray={`${draw} ${Math.max(0, C - draw)}`} strokeDashoffset={-off}
        style={{ transition: "stroke-dasharray .6s cubic-bezier(.3,.7,.3,1), stroke-dashoffset .6s cubic-bezier(.3,.7,.3,1)" }}>
        {sg.label && <title>{sg.label}</title>}
      </circle>
    );
    off += len;
    return node;
  });
  return (
    <div className={cn("relative shrink-0", className)} style={{ width: size, height: size }} title={title}>
      <svg viewBox={`0 0 ${size} ${size}`} className="-rotate-90" style={{ width: size, height: size }} role="img"
        aria-label={title ?? `${Math.round(p)}%`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-raised)" strokeWidth={width} />
        {arcs}
      </svg>
      <div className="absolute inset-0 grid place-content-center text-center">
        <div className="num font-semibold leading-none" style={{ fontSize: Math.max(11, Math.round(size * 0.2)) }}>
          {center ?? `${Math.round(p)}%`}
        </div>
        {sub && <div className="mt-1 text-[9.5px] uppercase tracking-[0.07em] text-fg-3">{sub}</div>}
      </div>
    </div>
  );
}
export function Rings({ rows }: { rows: { key: string; label: string; used: number; sub?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-5">
      {rows.map((r) => (
        <div key={r.key} className="w-[92px] text-center" title={`${r.label}: ${Math.round(r.used)}% of the budget spent`}>
          <Ring className="mx-auto" pct={r.used} warn={r.used > 80} sub="used" />
          <div className="mt-2 truncate text-[11.5px] text-fg-2">{r.label}</div>
          {r.sub && <div className="num truncate text-[11px] text-fg-3">{r.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/* Who spent it, and who they paid — one chart, one scale.
   This replaced two ranked lists sitting side by side, each normalised to its
   own widest bar: an agent's 1.62 KAS and a service's 1.2 KAS were drawn the
   same length, a few hundred pixels apart, in the same colour. Two panels
   showing the same measure on different scales is the chart mistake that
   actually misleads people, and it also threw away the only interesting
   structure in the data — WHICH agent paid WHICH service.
   The last segment is the covenant's own figure minus what the logs name:
   money a grant provably spent that no receipt accounts for. */
export function FlowBars({ series, rows, unlogged = "No receipt" }: {
  series: { key: string; label: string }[];
  rows: { key: string; label: string; values: number[]; unlogged: number; total: number }[];
  unlogged?: string;
}) {
  const max = Math.max(0.0001, ...rows.map((r) => r.total));
  const totals = series.map((_, i) => rows.reduce((s, r) => s + (r.values[i] ?? 0), 0));
  const grand = totals.reduce((a, b) => a + b, 0) + rows.reduce((s, r) => s + r.unlogged, 0);
  const anyUnlogged = rows.some((r) => r.unlogged > 0);
  return (
    <div>
      <ul className="mb-4 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]">
        {series.map((x, i) => (
          <li key={x.key} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: hueOf(i) }} />
            <span className="text-fg-2">{x.label}</span>
            <span className="num text-fg-3">{kas(totals[i]!)}</span>
          </li>
        ))}
        {anyUnlogged && (
          <li className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: OTHER }} />
            <span className="text-fg-2">{unlogged}</span>
            <span className="num text-fg-3">{kas(rows.reduce((s, r) => s + r.unlogged, 0))}</span>
          </li>
        )}
      </ul>
      <ul className="space-y-3">
        {rows.map((r) => {
          const segs = [
            ...series.map((x, i) => ({ key: x.key, label: x.label, v: r.values[i] ?? 0, color: hueOf(i) })),
            { key: "__unlogged", label: unlogged, v: r.unlogged, color: OTHER },
          ].filter((sg) => sg.v > 0);
          return (
            /* A phone has no room for a label column AND a bar worth reading,
               so the bar takes the whole width on its own line there. */
            <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_auto] sm:gap-y-0">
              <span className="order-1 truncate text-[13px] text-fg-2">{r.label}</span>
              <span className="order-3 col-span-2 flex h-[14px] w-full items-stretch sm:order-2 sm:col-span-1">
                {segs.map((sg, si) => (
                  <span key={sg.key} title={`${r.label} → ${sg.label}: ${kas(sg.v)} KAS`}
                    className={cn("overflow-hidden", si === 0 && "rounded-l-[4px]", si === segs.length - 1 && "rounded-r-[4px]")}
                    style={{
                      width: `${(sg.v / max) * 100}%`,
                      background: sg.color,
                      marginLeft: si ? 2 : 0,
                      transition: "width .5s cubic-bezier(.3,.7,.3,1)",
                    }} />
                ))}
                {!segs.length && <span className="h-[2px] w-full self-center bg-line" />}
              </span>
              <span className="num order-2 text-right text-[13px] text-fg sm:order-3">{kas(r.total)}<span className="ml-1 text-[11px] text-fg-3">KAS</span></span>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-[12px] leading-relaxed text-fg-3">
        One scale across every row: a bar twice as long is twice the money.
        {anyUnlogged && <> The grey is what the covenant says a grant spent that its own log does not name — <span className="num text-fg-2">{kas(rows.reduce((s, r) => s + r.unlogged, 0))}</span> of <span className="num text-fg-2">{kas(grand)}</span> KAS.</>}
      </p>
    </div>
  );
}
