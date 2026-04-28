"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SimSeriesPoint } from "@/hooks/useSimulation";

export function StakingChart({ series }: { series: SimSeriesPoint[] }) {
  const data = series.map((p) => ({ tick: p.tick, staked: p.staked * 100, apy: p.apy }));

  return (
    <div className="h-32">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="stakeFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#16a34a" stopOpacity={0.30} />
              <stop offset="100%" stopColor="#16a34a" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="tick" tick={{ fontSize: 9, fill: "#a1a1aa", fontFamily: "monospace" }} stroke="#e4e4e7" />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 9, fill: "#a1a1aa", fontFamily: "monospace" }}
            stroke="#e4e4e7"
            width={32}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: "1px solid #e4e4e7", fontFamily: "monospace", fontSize: 11 }}
            labelStyle={{ color: "#71717a" }}
            itemStyle={{ color: "#16a34a" }}
            formatter={(v) => (typeof v === "number" ? `${v.toFixed(2)}%` : String(v))}
          />
          <Area type="monotone" dataKey="staked" stroke="#16a34a" strokeWidth={1.6} fill="url(#stakeFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
