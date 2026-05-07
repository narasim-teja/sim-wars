"use client";

import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ArrowLeft, ArrowUpRight } from "lucide-react";

export type ViewMode = "graph" | "split" | "workbench";

const STEPS = [
  { idx: 1, label: "Configure" },
  { idx: 2, label: "Deploy" },
  { idx: 3, label: "Simulate" },
  { idx: 4, label: "Analyze" },
  { idx: 5, label: "Report" },
] as const;

export function TopNav({
  view,
  onViewChange,
  step,
  status,
  back,
}: {
  view?: ViewMode;
  onViewChange?: (v: ViewMode) => void;
  step?: number;
  status?: string;
  back?: string;
}) {
  const current = STEPS.find((s) => s.idx === step);

  return (
    <header className="relative z-30 flex items-center justify-between border-b border-zinc-200 bg-white/95 px-6 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        {back && (
          <Link
            href={back}
            aria-label="Back"
            className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-zinc-200 bg-white text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-900"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
        )}
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo-spiral.svg" alt="" width={22} height={22} priority />
          <span className="font-mono text-base font-semibold tracking-[0.32em] text-zinc-900">
            SIMWARS
          </span>
        </Link>
      </div>

      {view && onViewChange ? (
        <ViewTabs value={view} onChange={onViewChange} />
      ) : (
        <nav className="flex items-center gap-5 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
          <Link href="/" className="hover:text-zinc-900">Launch</Link>
          <Link href="/demos" className="hover:text-zinc-900">Demos</Link>
          <Link href="/about" className="hover:text-zinc-900">About</Link>
        </nav>
      )}

      <div className="flex items-center gap-4">
        {step && current ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500">
              Step {step}/5
            </span>
            <span className="text-sm font-semibold text-zinc-900">{current.label}</span>
          </div>
        ) : (
          <a
            href="https://github.com/narasim-teja/sim-wars"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-500 hover:text-zinc-900"
          >
            github
            <ArrowUpRight className="h-3 w-3" />
          </a>
        )}
        {status && <StatusDot status={status} />}
      </div>
    </header>
  );
}

function ViewTabs({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const tabs: { id: ViewMode; label: string }[] = [
    { id: "graph", label: "Graph" },
    { id: "split", label: "Split" },
    { id: "workbench", label: "Workbench" },
  ];
  return (
    <nav className="flex items-center gap-1 rounded-md border border-zinc-200 bg-white p-0.5">
      {tabs.map((t) => {
        const active = value === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={cn(
              "cursor-pointer rounded px-4 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors",
              active
                ? "bg-zinc-900 text-white"
                : "text-zinc-500 hover:text-zinc-900",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}

function StatusDot({ status }: { status: string }) {
  const v = STATUS_META[status] ?? STATUS_META.running;
  return (
    <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em]">
      <span className={cn("relative flex h-2 w-2 items-center justify-center")}>
        <span className={cn("absolute inset-0 rounded-full", v.dot)} />
        {v.pulse && (
          <span className={cn("absolute inset-0 animate-ping rounded-full opacity-60", v.dot)} />
        )}
      </span>
      <span className={v.text}>{v.label}</span>
    </div>
  );
}

const STATUS_META: Record<string, { label: string; dot: string; text: string; pulse: boolean }> = {
  starting:     { label: "STARTING",     dot: "bg-amber-500",   text: "text-amber-700",   pulse: true  },
  running:      { label: "RUNNING",      dot: "bg-emerald-500", text: "text-emerald-700", pulse: true  },
  paused:       { label: "PAUSED",       dot: "bg-zinc-400",    text: "text-zinc-600",    pulse: false },
  completed:    { label: "COMPLETED",    dot: "bg-emerald-500", text: "text-emerald-700", pulse: false },
  ready:        { label: "READY",        dot: "bg-emerald-500", text: "text-emerald-700", pulse: false },
  failed:       { label: "FAILED",       dot: "bg-red-500",     text: "text-red-700",     pulse: false },
  interrupted:  { label: "INTERRUPTED",  dot: "bg-zinc-400",    text: "text-zinc-600",    pulse: false },
  death_spiral: { label: "DEATH SPIRAL", dot: "bg-red-500",     text: "text-red-700",     pulse: true  },
};
