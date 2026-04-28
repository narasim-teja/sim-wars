"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { SimulationState } from "@/lib/types";
import { AGENT_COLORS, agentTypeFromId } from "@/lib/agent-colors";

export function TopHolders({ state }: { state: SimulationState | null }) {
  if (!state || state.topHolders.length === 0) {
    return (
      <div className="grid h-32 place-items-center font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-400">
        no holders yet
      </div>
    );
  }

  const top5 = state.topHolders.slice(0, 5);
  const restBalance = Math.max(
    0,
    state.circulatingSupply - top5.reduce((s, h) => s + h.balance, 0),
  );
  const data = [
    ...top5.map((h) => ({ name: h.agentId, value: h.balance, type: agentTypeFromId(h.agentId) })),
    { name: "Rest", value: restBalance, type: "unknown" as const },
  ];
  const total = data.reduce((s, d) => s + d.value, 0) || 1;

  return (
    <div className="grid grid-cols-[140px_1fr] gap-3">
      <div className="h-32 w-full">
        <ResponsiveContainer>
          <PieChart>
            <Pie data={data} dataKey="value" innerRadius={28} outerRadius={56} paddingAngle={2} stroke="#ffffff" strokeWidth={2}>
              {data.map((d, i) => (
                <Cell key={i} fill={AGENT_COLORS[d.type as keyof typeof AGENT_COLORS]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{ background: "#ffffff", border: "1px solid #e4e4e7", fontFamily: "monospace", fontSize: 11 }}
              labelStyle={{ color: "#71717a" }}
              formatter={(v) =>
                typeof v === "number"
                  ? v.toLocaleString(undefined, { maximumFractionDigits: 0 })
                  : String(v)
              }
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="flex flex-col gap-1.5 self-center">
        {data.slice(0, 6).map((d) => {
          const pct = (d.value / total) * 100;
          return (
            <div key={d.name} className="flex items-center gap-2 font-mono text-[11px]">
              <span
                className="h-2 w-2 rounded-full"
                style={{ background: AGENT_COLORS[d.type as keyof typeof AGENT_COLORS] }}
              />
              <span className="w-20 truncate text-zinc-700">{d.name}</span>
              <span className="ml-auto tabular-nums text-zinc-500">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
