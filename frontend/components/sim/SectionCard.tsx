"use client";

import { cn } from "@/lib/utils";

/**
 * MiroFish-style numbered section card.
 *
 *   ┌─ 01 / Title ────────────────────── [done] ┐
 *   │ optional subtitle                          │
 *   │ ────────────────────────────────────────── │
 *   │ children                                   │
 *   └────────────────────────────────────────────┘
 */
export function SectionCard({
  number,
  title,
  subtitle,
  rightSlot,
  status,
  children,
  className,
}: {
  number: string;
  title: string;
  subtitle?: string;
  rightSlot?: React.ReactNode;
  status?: "live" | "ready" | "complete";
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-md border border-zinc-200 bg-white", className)}>
      <header className="flex items-center justify-between gap-3 border-b border-zinc-100 px-4 py-3">
        <div className="flex items-baseline gap-3">
          <span className="section-number text-[12px]">{number}</span>
          <span className="text-[14px] font-semibold text-zinc-900">{title}</span>
        </div>
        <div className="flex items-center gap-3">
          {rightSlot}
          {status && <StatusPill status={status} />}
        </div>
      </header>
      {subtitle && (
        <div className="border-b border-zinc-100 bg-zinc-50/60 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-500">
          {subtitle}
        </div>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

function StatusPill({ status }: { status: "live" | "ready" | "complete" }) {
  const v = {
    live:     { label: "● live",     cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
    ready:    { label: "● ready",    cls: "bg-amber-50 text-amber-700 border border-amber-200" },
    complete: { label: "● complete", cls: "bg-emerald-50 text-emerald-700 border border-emerald-200" },
  }[status];
  return (
    <span className={cn("rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em]", v.cls)}>
      {v.label}
    </span>
  );
}
