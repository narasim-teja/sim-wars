"use client";

import { Maximize2, Minimize2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

export function GraphHeader({
  onRefresh,
  onFullscreen,
  isFullscreen,
  showEdgeLabels,
  onToggleEdgeLabels,
}: {
  onRefresh: () => void;
  onFullscreen: () => void;
  isFullscreen: boolean;
  showEdgeLabels: boolean;
  onToggleEdgeLabels: () => void;
}) {
  return (
    <div className="absolute right-3 top-2 z-10 flex items-center gap-2">
      <button
        onClick={onRefresh}
        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-200 bg-white/95 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-700 backdrop-blur transition-colors hover:border-zinc-400 hover:text-zinc-900"
        title="Reset layout"
      >
        <RefreshCw className="h-3 w-3" />
        Refresh
      </button>

      <Toggle on={showEdgeLabels} onClick={onToggleEdgeLabels} label="Edge labels" />

      <button
        onClick={onFullscreen}
        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-zinc-200 bg-white/95 px-2 py-1 font-mono text-zinc-700 backdrop-blur transition-colors hover:border-zinc-400 hover:text-zinc-900"
        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
      >
        {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

function Toggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex cursor-pointer items-center gap-2 rounded-md border border-zinc-200 bg-white/95 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.18em] text-zinc-700 backdrop-blur transition-colors hover:border-zinc-400 hover:text-zinc-900"
    >
      <span
        className={cn(
          "relative inline-flex h-3.5 w-7 items-center rounded-full transition-colors",
          on ? "bg-zinc-900" : "bg-zinc-300",
        )}
      >
        <span
          className={cn(
            "block h-2.5 w-2.5 transform rounded-full bg-white shadow-sm transition-transform",
            on ? "translate-x-3.5" : "translate-x-0.5",
          )}
        />
      </span>
      {label}
    </button>
  );
}

export function LivePill({ status }: { status: string }) {
  const isLive = status === "running" || status === "starting";
  const isDeath = status === "death_spiral";
  return (
    <div
      className={cn(
        "absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border px-3 py-1 font-mono text-[11px] uppercase tracking-[0.22em] backdrop-blur",
        isDeath
          ? "border-red-300 bg-red-50/95 text-red-700"
          : isLive
            ? "border-emerald-200 bg-white/95 text-emerald-700"
            : "border-zinc-200 bg-white/95 text-zinc-600",
      )}
    >
      <span className="flex items-center gap-2">
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            isDeath ? "bg-red-500" : isLive ? "bg-emerald-500 animate-pulse" : "bg-zinc-400",
          )}
        />
        {isDeath
          ? "death spiral · simulation halted"
          : isLive
            ? "updating in real-time…"
            : `simulation ${status}`}
      </span>
    </div>
  );
}
