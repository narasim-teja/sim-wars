"use client";

import { useState } from "react";
import { Pause, Play, Square, Loader2 } from "lucide-react";
import { controlSim } from "@/lib/api";
import type { SimStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

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
        <Btn
          onClick={() => send("resume")}
          disabled={busy != null || isTerminal}
          icon={busy === "resume" ? Loader2 : Play}
          iconClass={busy === "resume" ? "animate-spin" : ""}
          label="Resume"
        />
      ) : (
        <Btn
          onClick={() => send("pause")}
          disabled={busy != null || !isRunning}
          icon={busy === "pause" ? Loader2 : Pause}
          iconClass={busy === "pause" ? "animate-spin" : ""}
          label="Pause"
        />
      )}
      <Btn
        onClick={() => send("abort")}
        disabled={busy != null || isTerminal}
        icon={busy === "abort" ? Loader2 : Square}
        iconClass={busy === "abort" ? "animate-spin" : ""}
        label="Abort"
        tone="danger"
      />
    </div>
  );
}

function Btn({
  onClick,
  disabled,
  icon: Icon,
  iconClass,
  label,
  tone = "default",
}: {
  onClick: () => void;
  disabled?: boolean;
  icon: React.ElementType;
  iconClass?: string;
  label: string;
  tone?: "default" | "danger";
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex cursor-pointer items-center gap-1 rounded border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.22em] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        tone === "danger"
          ? "border-zinc-300 text-zinc-700 hover:border-red-400 hover:text-red-600"
          : "border-zinc-300 text-zinc-700 hover:border-zinc-900 hover:text-zinc-900",
      )}
    >
      <Icon className={cn("h-3 w-3", iconClass)} />
      {label}
    </button>
  );
}
