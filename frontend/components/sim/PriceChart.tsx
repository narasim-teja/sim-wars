"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import type { SimSeriesPoint } from "@/hooks/useSimulation";

export function PriceChart({ series }: { series: SimSeriesPoint[] }) {
  const data = series.map((p) => ({
    tick: p.tick,
    price: p.price,
    peg: p.pegPrice || null,
  }));

  return (
    <div className="panel rounded p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="font-mono text-[10px] uppercase tracking-[0.25em] text-zinc-500">price · tokens</h3>
        <span className="font-mono text-xs text-cyan-300 tabular-nums">
          {series.length > 0 ? `$${series[series.length - 1].price.toFixed(4)}` : "—"}
        </span>
      </div>
      <div className="h-40">
        <ResponsiveContainer>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor="#22d3ee" stopOpacity={0.6} />
                <stop offset="100%" stopColor="#22d3ee" stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="tick" tick={{ fontSize: 9, fill: "#71717a", fontFamily: "monospace" }} stroke="#27272a" />
            <YAxis
              domain={["dataMin", "dataMax"]}
              tick={{ fontSize: 9, fill: "#71717a", fontFamily: "monospace" }}
              stroke="#27272a"
              width={48}
              tickFormatter={(v: number) => v.toFixed(2)}
            />
            <Tooltip
              contentStyle={{ background: "#0a0a0a", border: "1px solid #27272a", fontFamily: "monospace", fontSize: 11 }}
              labelStyle={{ color: "#a1a1aa" }}
              itemStyle={{ color: "#22d3ee" }}
              formatter={(v) => (typeof v === "number" ? v.toFixed(4) : String(v))}
            />
            <ReferenceLine y={1} stroke="#fb923c" strokeDasharray="3 3" strokeOpacity={0.4} />
            <Area type="monotone" dataKey="price" stroke="#22d3ee" strokeWidth={1.5} fill="url(#priceFill)" />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
