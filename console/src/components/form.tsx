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
