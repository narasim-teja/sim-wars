"use client";

import { motion } from "framer-motion";
import type { ThreatLevel } from "@/lib/types";
import { THREAT_META } from "@/lib/threat";
import { Skull, ShieldCheck, ShieldAlert, AlertTriangle, AlertOctagon } from "lucide-react";

const ICONS = {
  calm: ShieldCheck,
  watch: ShieldAlert,
  elevated: AlertTriangle,
  critical: AlertOctagon,
  death_spiral: Skull,
};

export function ThreatIndicator({
  level,
  reasons,
}: {
  level: ThreatLevel;
  reasons: string[];
}) {
  const meta = THREAT_META[level];
  const Icon = ICONS[level];

  return (
    <div
      className="relative flex flex-col gap-2 rounded border bg-black/50 px-4 py-3"
      style={{ borderColor: `${meta.color}60`, boxShadow: `inset 0 0 30px ${meta.color}20` }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <motion.div
            animate={meta.pulse ? { scale: [1, 1.15, 1] } : { scale: 1 }}
            transition={{ duration: 1.4, repeat: meta.pulse ? Infinity : 0 }}
            style={{ color: meta.color, filter: `drop-shadow(0 0 8px ${meta.color})` }}
          >
            <Icon className="h-5 w-5" />
          </motion.div>
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">
              threat level
            </div>
            <div
              className="font-mono text-base font-bold uppercase tracking-[0.25em]"
              style={{ color: meta.color, textShadow: `0 0 14px ${meta.color}80` }}
            >
              {meta.label}
            </div>
          </div>
        </div>
        <Bar level={level} />
      </div>
      {reasons.length > 0 && (
        <ul className="list-disc pl-4 font-mono text-[10px] text-zinc-400">
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
        const meta = THREAT_META[l];
        const active = i <= idx;
        return (
          <span
            key={l}
            className="h-2.5 w-3 rounded-sm transition-all"
            style={{
              background: active ? meta.color : "#27272a",
              boxShadow: active ? `0 0 10px ${meta.color}80` : undefined,
              opacity: active ? 1 : 0.4,
            }}
          />
        );
      })}
    </div>
  );
}
