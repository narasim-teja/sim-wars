"use client";

import { useEffect, useRef } from "react";
import type { LogEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

const LEVEL_COLOR: Record<LogEntry["level"], string> = {
  info: "text-emerald-400",
  warn: "text-amber-300",
  error: "text-red-400",
  system: "text-cyan-300",
};

/**
 * MiroFish-style fixed-height terminal strip. Sits at the bottom of the dashboard,
 * always visible. Tail-follows the latest log line.
 */
export function SystemDashboard({
  logs,
  simId,
  tick,
}: {
  logs: LogEntry[];
  simId?: string;
  tick: number;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Logs come in newest-first; render oldest-first inside terminal so it reads top-down
  const ordered = [...logs].reverse();

  useEffect(() => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [ordered.length]);

  return (
    <div className="terminal flex h-[150px] flex-col border-t border-zinc-200">
      <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-1.5">
        <div className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-[0.25em] text-zinc-300">
          <span className="text-emerald-300">▶</span>
          <span>SYSTEM DASHBOARD</span>
        </div>
        <div className="flex items-center gap-4 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
          <span>tick {tick}</span>
          {simId && (
            <span>
              sim <span className="text-zinc-300">{simId.slice(0, 12)}</span>
            </span>
          )}
        </div>
      </div>
      <div ref={scrollRef} className="thin-scroll-dark flex-1 overflow-y-auto px-4 py-2">
        <div className="font-mono text-[11px] leading-relaxed">
          {ordered.length === 0 ? (
            <div className="text-zinc-500">
              $ awaiting events…<span className="blink-cursor ml-0.5">▌</span>
            </div>
          ) : (
            ordered.map((log) => (
              <div key={log.id} className="flex gap-3">
                <span className="text-zinc-500">[{formatTime(log.ts)}]</span>
                <span className="text-zinc-500">⌙</span>
                <span className={cn("uppercase", LEVEL_COLOR[log.level])}>{log.level}</span>
                <span className="text-zinc-200">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${(d.getMilliseconds()).toString().padStart(3, "0")}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
