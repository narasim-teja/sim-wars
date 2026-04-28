"use client";

import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import type { SimSeriesPoint } from "@/hooks/useSimulation";

export function GiniChart({ series }: { series: SimSeriesPoint[] }) {
  const data = series.map((p) => ({ tick: p.tick, gini: p.gini }));
  return (
    <div className="h-32">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="tick" tick={{ fontSize: 9, fill: "#a1a1aa", fontFamily: "monospace" }} stroke="#e4e4e7" />
          <YAxis
            domain={[0, 1]}
            tick={{ fontSize: 9, fill: "#a1a1aa", fontFamily: "monospace" }}
            stroke="#e4e4e7"
            width={32}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: "1px solid #e4e4e7", fontFamily: "monospace", fontSize: 11 }}
            labelStyle={{ color: "#71717a" }}
            itemStyle={{ color: "#a855f7" }}
            formatter={(v) => (typeof v === "number" ? v.toFixed(3) : String(v))}
          />
          <ReferenceLine y={0.7} stroke="#ef4444" strokeDasharray="3 3" strokeOpacity={0.5} />
          <ReferenceLine y={0.6} stroke="#fb923c" strokeDasharray="3 3" strokeOpacity={0.4} />
          <Line type="monotone" dataKey="gini" stroke="#a855f7" strokeWidth={1.6} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
