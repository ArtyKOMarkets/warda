import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type AnchorHTMLAttributes } from "react";
import { Check, Copy as CopyIcon, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Status } from "@/lib/model";

type Variant = "primary" | "secondary" | "ghost" | "danger";
const V: Record<Variant, string> = {
  primary: "bg-accent text-accent-ink hover:bg-accent-strong shadow-[0_0_0_1px_rgba(20,215,193,.4),0_8px_24px_-8px_rgba(20,215,193,.5)]",
  secondary: "bg-raised text-fg border border-line-strong hover:bg-hover hover:border-fg-3/40",
  ghost: "text-fg-2 hover:text-fg hover:bg-raised",
  danger: "bg-bad/10 text-bad border border-bad/30 hover:bg-bad/20",
};
const S = { sm: "h-8 px-3 text-[13px] gap-1.5", md: "h-9 px-3.5 text-sm gap-2", lg: "h-11 px-5 text-[15px] gap-2" };

export function Button({ variant = "secondary", size = "md", className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof S }) {
  return <button className={cn("inline-flex items-center justify-center rounded-lg font-medium transition-[background,border,color,box-shadow] duration-150 disabled:opacity-50 disabled:pointer-events-none select-none whitespace-nowrap", V[variant], S[size], className)} {...p} />;
}

export function LinkButton({ variant = "secondary", size = "md", className, ...p }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant; size?: keyof typeof S }) {
  return <a className={cn("inline-flex items-center justify-center rounded-lg font-medium whitespace-nowrap transition-[background,border,color,box-shadow] duration-150 select-none", V[variant], S[size], className)} {...p} />;
}

export function Card({ className, children, interactive, ...p }: { className?: string; children: ReactNode; interactive?: boolean } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("min-w-0 rounded-[var(--radius-card)] border border-line bg-surface shadow-[var(--shadow-card)]",
      interactive && "transition-[border-color,background,transform] duration-150 hover:border-line-strong hover:bg-[#101317]", className)} {...p}>
      {children}
    </div>
  );
}

export function CardHeader({ title, sub, action, className }: { title: ReactNode; sub?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-4 px-5 pt-5", className)}>
      <div className="min-w-0">
        <h3 className="text-[15px] font-semibold tracking-[-0.01em]">{title}</h3>
        {sub && <p className="mt-1 text-[13px] text-fg-3">{sub}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

const TONE = {
  ok: "text-ok bg-ok/10 ring-ok/25",
  warn: "text-warn bg-warn/10 ring-warn/25",
  bad: "text-bad bg-bad/10 ring-bad/25",
  info: "text-info bg-info/10 ring-info/25",
  accent: "text-accent bg-accent/10 ring-accent/25",
  muted: "text-fg-2 bg-raised ring-line-strong",
};
export type Tone = keyof typeof TONE;

export function Badge({ tone = "muted", dot, children, className }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12px] font-medium ring-1 ring-inset", TONE[tone], className)}>
      {dot && <span className="size-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const STATUS: Record<Status, [Tone, string]> = {
  active: ["ok", "Active"],
  scheduled: ["info", "Scheduled"],
  waiting: ["warn", "Waiting for funds"],
  paused: ["warn", "Paused"],
  expired: ["muted", "Expired"],
  ended: ["muted", "Ended"],
  unknown: ["muted", "Unknown"],
};
export function StatusBadge({ status }: { status: Status }) {
  const [tone, words] = STATUS[status];
  return <Badge tone={tone} dot>{words}</Badge>;
}

export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden className={cn("skeleton inline-block h-4 w-20 align-middle", className)} />;
}

/* A number that changes while you are looking at it should be seen to change:
   the eye catches the movement, not the new value. Respects reduced motion,
   and never animates the first paint. */
function useCountUp(text: string): string {
  const [shown, setShown] = useState(text);
  const from = useRef<number | null>(null);
  useEffect(() => {
    const to = Number(text.replace(/,/g, ""));
    const start = from.current;
    from.current = isFinite(to) ? to : null;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced || start === null || !isFinite(to) || start === to || Math.abs(to - start) < 1e-9) { setShown(text); return; }
    const dp = (text.split(".")[1] ?? "").length;
    const t0 = performance.now(), ms = 420;
    let raf = 0;
    const tick = (now: number) => {
      const f = Math.min(1, (now - t0) / ms), e = 1 - (1 - f) ** 3;
      setShown((start + (to - start) * e).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }));
      if (f < 1) raf = requestAnimationFrame(tick); else setShown(text);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text]);
  return shown;
}

/** A money figure: KAS first, always. */
export function Kas({ value, className, unit = true, loading }: { value: string; className?: string; unit?: boolean; loading?: boolean }) {
  const shown = useCountUp(value);
  if (loading) return <Skeleton className="h-[1em] w-16" />;
  return (
    <span className={cn("num", className)}>
      {shown}
      {unit && value !== "—" && <span className="ml-[0.3em] text-[0.62em] font-medium tracking-normal text-fg-3">KAS</span>}
    </span>
  );
}

export function Stat({ label, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="text-[12px] font-medium text-fg-3">{label}</div>
      <div className="mt-1.5 truncate text-[22px] font-semibold leading-none tracking-[-0.02em] text-fg">{children}</div>
      {hint && <div className="mt-2 truncate text-[12px] text-fg-3">{hint}</div>}
    </div>
  );
}

/** Spent vs left, in one bar. Left is the accent; spent is quiet. */
export function Meter({ spent, budget, className, height = 6, muted }: { spent: number | null; budget: number | null; className?: string; height?: number; muted?: boolean }) {
  const p = budget && spent !== null ? Math.min(100, Math.max(0, (spent / budget) * 100)) : 0;
  if (muted) return <div className={cn("w-full rounded-full bg-line-strong/70", className)} style={{ height }} />;
  return (
    <div className={cn("relative w-full overflow-hidden rounded-full bg-accent/15", className)} style={{ height }}>
      <div className="absolute inset-y-0 right-0 rounded-full bg-gradient-to-r from-accent/70 to-accent" style={{ width: `${100 - p}%` }} />
      <div className="absolute inset-y-0 left-0 bg-fg-3/60" style={{ width: `${p}%` }} />
    </div>
  );
}

export function Empty({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-14 text-center", className)}>
      {icon && <div className="mb-4 grid size-11 place-items-center rounded-xl border border-line-strong bg-raised text-fg-2">{icon}</div>}
      <div className="text-[15px] font-semibold">{title}</div>
      {children && <p className="mt-1.5 max-w-sm text-[13px] leading-relaxed text-fg-3">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Copy({ text, className, label }: { text: string; className?: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      type="button"
      aria-label={label ?? "Copy"}
      title={label ?? "Copy"}
      className={cn("inline-grid size-7 place-items-center rounded-md text-fg-3 transition hover:bg-raised hover:text-fg", className)}
      onClick={(e) => { e.stopPropagation(); e.preventDefault(); navigator.clipboard?.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }); }}
    >
      {ok ? <Check className="size-3.5 text-ok" /> : <CopyIcon className="size-3.5" />}
    </button>
  );
}

export function External({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener" className={cn("inline-flex items-center gap-1 text-fg-2 underline-offset-4 transition hover:text-accent hover:underline", className)}>
      {children}<ArrowUpRight className="size-3.5 opacity-70" />
    </a>
  );
}

export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { value: T; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <div role="tablist" className={cn("flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none]", className)}>
      {items.map((it) => (
        <button key={it.value} role="tab" aria-selected={value === it.value} onClick={() => onChange(it.value)}
          className={cn("relative -mb-px flex h-10 shrink-0 items-center gap-2 px-2.5 text-sm sm:px-3 font-medium transition",
            value === it.value ? "text-fg" : "text-fg-3 hover:text-fg-2")}>
          {it.label}
          {it.count !== undefined && <span className={cn("num rounded-md px-1.5 text-[11px]", value === it.value ? "bg-raised text-fg-2" : "text-fg-3")}>{it.count}</span>}
          {value === it.value && <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent" />}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({ title, sub, actions, eyebrow }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-7 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-2 text-[13px] text-fg-3">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.025em] sm:text-[28px]">{title}</h1>
        {sub && <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-fg-2">{sub}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Row({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-2.5", className)}>
      <dt className="shrink-0 text-[13px] text-fg-3">{label}</dt>
      <dd className="min-w-0 text-right text-[13.5px] text-fg">{children}</dd>
    </div>
  );
}
