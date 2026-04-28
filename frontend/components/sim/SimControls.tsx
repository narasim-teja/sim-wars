"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Pause, Play, Square, Loader2 } from "lucide-react";
import { controlSim } from "@/lib/api";
import type { SimStatus } from "@/lib/types";

export function SimControls({ simId, status }: { simId: string; status: SimStatus }) {
  const [busy, setBusy] = useState<string | null>(null);

  const send = async (cmd: "pause" | "resume" | "abort") => {
    setBusy(cmd);
    try {
      await controlSim(simId, cmd);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(null);
    }
  };

  const isRunning = status === "running";
  const isPaused = status === "paused";
  const isTerminal =
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "death_spiral";

  return (
    <div className="flex items-center gap-1.5">
      {isPaused ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy != null || isTerminal}
          onClick={() => send("resume")}
          className="h-8 border-emerald-400/40 font-mono text-[10px] uppercase tracking-widest text-emerald-300 hover:bg-emerald-400/10"
        >
          {busy === "resume" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
          resume
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          disabled={busy != null || !isRunning}
          onClick={() => send("pause")}
          className="h-8 border-amber-400/40 font-mono text-[10px] uppercase tracking-widest text-amber-300 hover:bg-amber-400/10"
        >
          {busy === "pause" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Pause className="h-3 w-3" />}
          pause
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy != null || isTerminal}
        onClick={() => send("abort")}
        className="h-8 border-red-500/40 font-mono text-[10px] uppercase tracking-widest text-red-300 hover:bg-red-500/10"
      >
        {busy === "abort" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
        abort
      </Button>
    </div>
  );
}
