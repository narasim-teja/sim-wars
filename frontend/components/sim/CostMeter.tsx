"use client";

import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CostSeriesPoint } from "@/hooks/useSimulation";
import type { LLMUsage } from "@/lib/types";
import { cn } from "@/lib/utils";

interface CostMeterProps {
  totalUsage: LLMUsage;
  lastTickUsage: LLMUsage;
  costSeries: CostSeriesPoint[];
}

export function CostMeter({ totalUsage, lastTickUsage, costSeries }: CostMeterProps) {
  const cacheHitPct =
    totalUsage.promptTokens > 0
      ? (totalUsage.cachedTokens / totalUsage.promptTokens) * 100
      : 0;
  const avgCostPerCall = totalUsage.calls > 0 ? totalUsage.costUsd / totalUsage.calls : 0;
  const lastTickCalls = lastTickUsage.calls;
  const lastTickCost = lastTickUsage.costUsd;

  return (
    <div className="grid gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="$ spent" value={`$${totalUsage.costUsd.toFixed(4)}`} accent="primary" />
        <Stat label="Calls" value={totalUsage.calls.toLocaleString()} />
        <Stat
          label="Cache hit"
          value={`${cacheHitPct.toFixed(1)}%`}
          accent={cacheHitPct >= 15 ? "good" : cacheHitPct >= 5 ? "warn" : undefined}
        />
        <Stat label="$/call" value={totalUsage.calls > 0 ? `$${avgCostPerCall.toFixed(6)}` : "—"} />
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Tick cost" value={`$${lastTickCost.toFixed(6)}`} compact />
        <Stat label="Tick calls" value={lastTickCalls.toLocaleString()} compact />
        <Stat
          label="Prompt tok"
          value={formatTokens(totalUsage.promptTokens)}
          compact
        />
        <Stat
          label="Cached tok"
          value={formatTokens(totalUsage.cachedTokens)}
          compact
        />
      </div>

      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
          cumulative cost ($)
        </div>
        <CostSparkline series={costSeries} />
      </div>
    </div>
  );
}

function CostSparkline({ series }: { series: CostSeriesPoint[] }) {
  if (series.length === 0) {
    return (
      <div className="grid h-32 place-items-center font-mono text-[11px] uppercase tracking-[0.22em] text-zinc-400">
        waiting for first tick…
      </div>
    );
  }

  const data = series.map((p) => ({ tick: p.tick, cost: p.cumulativeCost }));

  return (
    <div className="h-32 w-full min-w-0">
      <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="costFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0a0a0a" stopOpacity={0.18} />
              <stop offset="100%" stopColor="#0a0a0a" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="tick"
            tick={{ fontSize: 9, fill: "#a1a1aa", fontFamily: "monospace" }}
            stroke="#e4e4e7"
          />
          <YAxis
            domain={[0, "dataMax"]}
            tick={{ fontSize: 9, fill: "#a1a1aa", fontFamily: "monospace" }}
            stroke="#e4e4e7"
            width={56}
            tickFormatter={(v: number) => `$${v.toFixed(v < 0.01 ? 4 : 2)}`}
          />
          <Tooltip
            contentStyle={{
              background: "#ffffff",
              border: "1px solid #e4e4e7",
              fontFamily: "monospace",
              fontSize: 11,
            }}
            labelStyle={{ color: "#71717a" }}
            itemStyle={{ color: "#0a0a0a" }}
            formatter={(v) => (typeof v === "number" ? `$${v.toFixed(6)}` : String(v))}
          />
          <Area
            type="monotone"
            dataKey="cost"
            stroke="#0a0a0a"
            strokeWidth={1.6}
            fill="url(#costFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  compact,
}: {
  label: string;
  value: string;
  accent?: "primary" | "good" | "warn";
  compact?: boolean;
}) {
  const valueCls = {
    primary: "text-zinc-900",
    good: "text-emerald-700",
    warn: "text-amber-600",
  }[accent ?? "primary"];

  return (
    <div className="flex flex-col gap-0.5 border-l-2 border-zinc-200 pl-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">
        {label}
      </span>
      <span
        className={cn(
          "font-semibold tabular-nums",
          compact ? "text-[14px]" : "text-[18px]",
          valueCls,
        )}
      >
        {value}
      </span>
    </div>
  );
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}
