"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { LogEntry } from "@/lib/types";

const LEVEL_COLOR: Record<LogEntry["level"], string> = {
  info: "text-emerald-400",
  warn: "text-amber-400",
  error: "text-red-400 text-glow-red",
  system: "text-cyan-300 text-glow-cyan",
};

export function SimConsole({ logs }: { logs: LogEntry[] }) {
  return (
    <div className="relative flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
        console · stdout
      </div>
      <ScrollArea className="flex-1">
        <div className="thin-scroll p-3 font-mono text-[11px] leading-relaxed">
          {logs.length === 0 ? (
            <div className="text-zinc-600">$ awaiting events…</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="flex gap-2">
                <span className="text-zinc-700">[{formatTime(log.ts)}]</span>
                <span className={cn("uppercase tracking-widest", LEVEL_COLOR[log.level])}>
                  {log.level}
                </span>
                <span className="text-zinc-300">{log.message}</span>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}
