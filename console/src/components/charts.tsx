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
