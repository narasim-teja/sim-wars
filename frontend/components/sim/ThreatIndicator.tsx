"use client";

import { motion } from "framer-motion";
import type { ThreatLevel } from "@/lib/types";
import { Skull, ShieldCheck, ShieldAlert, AlertTriangle, AlertOctagon } from "lucide-react";

const META: Record<
  ThreatLevel,
  { label: string; color: string; bg: string; border: string; pulse: boolean; Icon: typeof ShieldCheck }
> = {
  calm:         { label: "STABLE",       color: "#16a34a", bg: "#f0fdf4", border: "#bbf7d0", pulse: false, Icon: ShieldCheck },
  watch:        { label: "WATCH",        color: "#ca8a04", bg: "#fefce8", border: "#fde68a", pulse: false, Icon: ShieldAlert },
  elevated:     { label: "ELEVATED",     color: "#ea580c", bg: "#fff7ed", border: "#fed7aa", pulse: true,  Icon: AlertTriangle },
  critical:     { label: "CRITICAL",     color: "#dc2626", bg: "#fef2f2", border: "#fecaca", pulse: true,  Icon: AlertOctagon },
  death_spiral: { label: "DEATH SPIRAL", color: "#b91c1c", bg: "#fef2f2", border: "#fca5a5", pulse: true,  Icon: Skull },
};

export function ThreatIndicator({
  level,
  reasons,
}: {
  level: ThreatLevel;
  reasons: string[];
}) {
  const m = META[level];
  const Icon = m.Icon;

  return (
    <div
      className="flex flex-col gap-2 rounded-md border px-4 py-3"
      style={{ background: m.bg, borderColor: m.border }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <motion.div
            animate={m.pulse ? { scale: [1, 1.1, 1] } : { scale: 1 }}
            transition={{ duration: 1.4, repeat: m.pulse ? Infinity : 0 }}
            style={{ color: m.color }}
          >
            <Icon className="h-5 w-5" />
          </motion.div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
              Threat level
            </div>
            <div
              className="font-mono text-[14px] font-bold uppercase tracking-[0.2em]"
              style={{ color: m.color }}
            >
              {m.label}
            </div>
          </div>
        </div>
        <Bar level={level} />
      </div>
      {reasons.length > 0 && (
        <ul className="list-disc pl-4 font-mono text-[10px] text-zinc-600">
          {reasons.slice(0, 3).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Bar({ level }: { level: ThreatLevel }) {
  const order: ThreatLevel[] = ["calm", "watch", "elevated", "critical", "death_spiral"];
  const idx = order.indexOf(level);
  return (
    <div className="flex items-center gap-1">
      {order.map((l, i) => {
        const m = META[l];
        const active = i <= idx;
        return (
          <span
            key={l}
            className="h-2.5 w-3 rounded-sm transition-all"
            style={{ background: active ? m.color : "#e4e4e7" }}
          />
        );
      })}
    </div>
  );
}
