"use client";

import type { SimulationState } from "@/lib/types";
import { cn } from "@/lib/utils";

export function MetricsBar({ state, tick }: { state: SimulationState | null; tick: number }) {
  const price = state?.tokenPrice ?? 0;
  const gini = state?.giniCoefficient ?? 0;
  const stakedRatio =
    state && state.totalSupply > 0 ? (state.stakedSupply / state.totalSupply) * 100 : 0;
  const apy = state?.stakingAPY ?? 0;
  const peg = state?.pegPrice;
  const reserve = state?.reserveBalance;
  const initReserve = state?.initialReserveBalance;
  const reserveDepleted =
    reserve != null && initReserve && initReserve > 0
      ? (1 - reserve / initReserve) * 100
      : null;

  return (
    <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
      <Stat label="Tick" value={`${tick}`} />
      <Stat
        label="Price"
        value={`$${formatNum(price, 4)}`}
        accent={price > 1 ? "good" : price < 0.5 ? "bad" : "warn"}
      />
      <Stat
        label="Gini"
        value={gini.toFixed(3)}
        accent={gini > 0.7 ? "bad" : gini > 0.6 ? "warn" : "good"}
      />
      <Stat label="Staked" value={`${stakedRatio.toFixed(1)}%`} />
      <Stat label="APY" value={`${apy.toFixed(1)}%`} accent={apy > 15 ? "warn" : "good"} />
      {peg != null ? (
        <Stat
          label="Peg"
          value={peg.toFixed(4)}
          accent={peg < 0.95 ? "bad" : peg < 0.99 ? "warn" : "good"}
        />
      ) : reserveDepleted != null ? (
        <Stat
          label="Reserve drain"
          value={`${reserveDepleted.toFixed(1)}%`}
          accent={reserveDepleted > 70 ? "bad" : reserveDepleted > 30 ? "warn" : "good"}
        />
      ) : (
        <Stat label="Pool" value={formatBig(state?.poolReserveB ?? 0)} />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "good" | "warn" | "bad";
}) {
  const valueCls = {
    good: "text-zinc-900",
    warn: "text-amber-600",
    bad: "text-red-600",
  }[accent ?? "good"];

  return (
    <div className="flex flex-col gap-0.5 border-l-2 border-zinc-200 pl-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-zinc-500">{label}</span>
      <span className={cn("text-[18px] font-semibold tabular-nums", valueCls)}>{value}</span>
    </div>
  );
}

function formatNum(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "-";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(dp);
}

function formatBig(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(0);
}
