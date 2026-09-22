import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/cn";

export const inputCls = "h-10 w-full rounded-lg border border-line-strong bg-bg px-3 text-[14px] text-fg placeholder:text-fg-3 transition focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/15 disabled:opacity-60";

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-[13px] font-medium text-fg-2">{label}</span>
      {children}
      {error ? <span className="mt-1.5 block text-[12px] text-bad">{error}</span> : hint ? <span className="mt-1.5 block text-[12px] text-fg-3">{hint}</span> : null}
    </label>
  );
}

export function KasInput({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <span className="relative block">
      <input inputMode="decimal" autoComplete="off" className={cn(inputCls, "num pr-12", className)} {...p} />
      <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] font-medium text-fg-3">KAS</span>
    </span>
  );
}

export const kasOk = (v: string) => /^\d+(\.\d{1,8})?$/.test(v.trim()) && Number(v) > 0;


/** A drawn select: a button and a list, never the browser's own. */
export function Select<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode; hint?: ReactNode }[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const cur = options.find((o) => o.value === value);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", off);
    return () => document.removeEventListener("mousedown", off);
  }, [open]);
  const pick = (v: T) => { onChange(v); setOpen(false); };
  return (
    <div ref={ref} className={cn("relative", className)}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open}
        onClick={() => { setOpen(!open); setHi(Math.max(0, options.findIndex((o) => o.value === value))); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); if (!open) setOpen(true); else setHi((h) => Math.min(options.length - 1, h + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHi((h) => Math.max(0, h - 1)); }
          else if (e.key === "Enter" && open) { e.preventDefault(); pick(options[hi]!.value); }
          else if (e.key === "Escape") setOpen(false);
        }}
        className={cn(inputCls, "flex items-center justify-between gap-2 text-left", open && "border-accent/60 ring-2 ring-accent/15")}>
        <span className="min-w-0 truncate">{cur?.label ?? "Choose…"}</span>
        <ChevronDown className={cn("size-4 shrink-0 text-fg-3 transition", open && "rotate-180")} />
      </button>
      {open && (
        <ul role="listbox" onClick={(e) => e.preventDefault()} className="rise absolute left-0 right-0 z-30 mt-1.5 max-h-72 overflow-auto rounded-xl border border-line-strong bg-raised p-1 shadow-[0_16px_40px_-12px_rgba(0,0,0,.7)]">
          {options.map((o, i) => (
            <li key={o.value} role="option" aria-selected={o.value === value} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(o.value); }}
              className={cn("flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px]", i === hi ? "bg-hover" : "")}>
              <span className="min-w-0 flex-1"><span className="block truncate">{o.label}</span>{o.hint && <span className="block truncate text-[12px] text-fg-3">{o.hint}</span>}</span>
              {o.value === value && <Check className="size-4 shrink-0 text-accent" />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
