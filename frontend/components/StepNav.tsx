"use client";

import { cn } from "@/lib/utils";
import { Activity, FileText, FlaskConical, Rocket } from "lucide-react";

const STEPS = [
  { id: "configure", label: "Configure", Icon: FlaskConical },
  { id: "deploy", label: "Deploy", Icon: Rocket },
  { id: "simulate", label: "Simulate", Icon: Activity },
  { id: "report", label: "Report", Icon: FileText },
] as const;

export type StepId = typeof STEPS[number]["id"];

export function StepNav({ active, status }: { active: StepId; status?: string }) {
  return (
    <header className="relative z-10 flex items-center justify-between border-b border-white/5 bg-black/40 px-6 py-3 backdrop-blur">
      <div className="flex items-center gap-3">
        <div className="relative h-8 w-8 rounded bg-gradient-to-br from-cyan-400 to-fuchsia-500 glow-cyan">
          <span className="absolute inset-0 grid place-items-center font-mono text-xs font-bold text-black">
            ⚔
          </span>
        </div>
        <div>
          <h1 className="font-mono text-sm font-semibold tracking-[0.3em] text-glow-cyan text-cyan-300">
            TOKENOMICS WAR GAME
          </h1>
          <p className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">
            adversarial agent stress-tests · solana
          </p>
        </div>
      </div>

      <ol className="flex items-center gap-1 font-mono text-xs">
        {STEPS.map((s, i) => {
          const idx = STEPS.findIndex((x) => x.id === active);
          const reached = i <= idx;
          const current = i === idx;
          return (
            <li key={s.id} className="flex items-center">
              <div
                className={cn(
                  "flex items-center gap-2 rounded-full border px-3 py-1 transition-all",
                  current
                    ? "border-cyan-400/60 bg-cyan-400/10 text-cyan-300 glow-cyan"
                    : reached
                      ? "border-white/15 text-zinc-300"
                      : "border-white/5 text-zinc-600",
                )}
              >
                <s.Icon className="h-3 w-3" />
                <span className="text-[10px] uppercase tracking-[0.2em]">{s.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <span
                  className={cn(
                    "mx-1 h-px w-6",
                    reached ? "bg-cyan-400/40" : "bg-white/10",
                  )}
                />
              )}
            </li>
          );
        })}
      </ol>

      <div className="flex items-center gap-2">
        {status && <StatusBadge status={status} />}
      </div>
    </header>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string; dot: string }> = {
    starting:     { label: "STARTING",     cls: "border-amber-400/40 text-amber-300",       dot: "bg-amber-400" },
    running:      { label: "RUNNING",      cls: "border-emerald-400/40 text-emerald-300",   dot: "bg-emerald-400 pulse-glow" },
    paused:       { label: "PAUSED",       cls: "border-zinc-400/40 text-zinc-300",         dot: "bg-zinc-400" },
    completed:    { label: "COMPLETED",    cls: "border-cyan-400/40 text-cyan-300",         dot: "bg-cyan-400" },
    failed:       { label: "FAILED",       cls: "border-red-500/40 text-red-300",           dot: "bg-red-500" },
    interrupted:  { label: "INTERRUPTED",  cls: "border-zinc-400/40 text-zinc-300",         dot: "bg-zinc-400" },
    death_spiral: { label: "DEATH SPIRAL", cls: "border-red-500/60 text-red-400 text-glow-red", dot: "bg-red-500 pulse-glow" },
  };
  const v = map[status] ?? map.running;
  return (
    <div className={cn("flex items-center gap-2 rounded-full border bg-black/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em]", v.cls)}>
      <span className={cn("h-2 w-2 rounded-full", v.dot)} />
      {v.label}
    </div>
  );
}
