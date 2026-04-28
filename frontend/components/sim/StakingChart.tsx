"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { SimSeriesPoint } from "@/hooks/useSimulation";

export function StakingChart({ series }: { series: SimSeriesPoint[] }) {
  const data = series.map((p) => ({ tick: p.tick, staked: p.staked * 100, apy: p.apy }));
  const last = data[data.length - 1];

  return (
    <div className="panel rounded p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">staking ratio</h3>
        <span className="font-mono text-xs text-emerald-300 tabular-nums">
          {last ? `${last.staked.toFixed(1)}% @ ${last.apy.toFixed(1)}% apy` : "—"}
        </span>
      </div>
      <div className="h-32">
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="stakeFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#22c55e" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#22c55e" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="tick" tick={{ fontSize: 9, fill: "#71717a", fontFamily: "monospace" }} stroke="#27272a" />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 9, fill: "#71717a", fontFamily: "monospace" }}
              stroke="#27272a"
              width={32}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              contentStyle={{ background: "#0a0a0a", border: "1px solid #27272a", fontFamily: "monospace", fontSize: 11 }}
              labelStyle={{ color: "#a1a1aa" }}
              itemStyle={{ color: "#22c55e" }}
              formatter={(v) => (typeof v === "number" ? `${v.toFixed(2)}%` : String(v))}
            />
            <Area type="monotone" dataKey="staked" stroke="#22c55e" strokeWidth={1.5} fill="url(#stakeFill)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
