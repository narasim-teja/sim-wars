"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine } from "recharts";
import type { SimSeriesPoint } from "@/hooks/useSimulation";

export function PriceChart({ series }: { series: SimSeriesPoint[] }) {
  const data = series.map((p) => ({ tick: p.tick, price: p.price }));

  return (
    <div className="h-44">
      <ResponsiveContainer>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%"   stopColor="#0a0a0a" stopOpacity={0.18} />
              <stop offset="100%" stopColor="#0a0a0a" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="tick" tick={{ fontSize: 9, fill: "#a1a1aa", fontFamily: "monospace" }} stroke="#e4e4e7" />
          <YAxis
            domain={["dataMin", "dataMax"]}
            tick={{ fontSize: 9, fill: "#a1a1aa", fontFamily: "monospace" }}
            stroke="#e4e4e7"
            width={48}
            tickFormatter={(v: number) => v.toFixed(2)}
          />
          <Tooltip
            contentStyle={{ background: "#ffffff", border: "1px solid #e4e4e7", fontFamily: "monospace", fontSize: 11 }}
            labelStyle={{ color: "#71717a" }}
            itemStyle={{ color: "#0a0a0a" }}
            formatter={(v) => (typeof v === "number" ? v.toFixed(4) : String(v))}
          />
          <ReferenceLine y={1} stroke="#fb923c" strokeDasharray="3 3" strokeOpacity={0.45} />
          <Area type="monotone" dataKey="price" stroke="#0a0a0a" strokeWidth={1.6} fill="url(#priceFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
