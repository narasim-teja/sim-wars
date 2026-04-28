"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import type { SimSeriesPoint } from "@/hooks/useSimulation";

export function GiniChart({ series }: { series: SimSeriesPoint[] }) {
  const data = series.map((p) => ({ tick: p.tick, gini: p.gini }));
  const last = series[series.length - 1]?.gini;

  return (
    <div className="panel rounded p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">gini · concentration</h3>
        <span className={`font-mono text-xs tabular-nums ${last && last > 0.7 ? "text-red-400 text-glow-red" : "text-zinc-300"}`}>
          {last != null ? last.toFixed(3) : "—"}
        </span>
      </div>
      <div className="h-32">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <XAxis dataKey="tick" tick={{ fontSize: 9, fill: "#71717a", fontFamily: "monospace" }} stroke="#27272a" />
            <YAxis
              domain={[0, 1]}
              tick={{ fontSize: 9, fill: "#71717a", fontFamily: "monospace" }}
              stroke="#27272a"
              width={32}
              tickFormatter={(v: number) => v.toFixed(2)}
            />
            <Tooltip
              contentStyle={{ background: "#0a0a0a", border: "1px solid #27272a", fontFamily: "monospace", fontSize: 11 }}
              labelStyle={{ color: "#a1a1aa" }}
              itemStyle={{ color: "#a855f7" }}
              formatter={(v) => (typeof v === "number" ? v.toFixed(3) : String(v))}
            />
            <ReferenceLine y={0.7} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5} />
            <ReferenceLine y={0.6} stroke="#fb923c" strokeDasharray="3 3" strokeOpacity={0.4} />
            <Line type="monotone" dataKey="gini" stroke="#a855f7" strokeWidth={1.5} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
