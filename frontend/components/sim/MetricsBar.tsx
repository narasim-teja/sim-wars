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
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="TICK" value={`${tick}`} accent="cyan" />
      <Stat
        label="PRICE"
        value={`$${formatNum(price, 4)}`}
        accent={price > 1 ? "green" : price < 0.5 ? "red" : "amber"}
      />
      <Stat label="GINI" value={gini.toFixed(3)} accent={gini > 0.7 ? "red" : gini > 0.6 ? "amber" : "green"} />
      <Stat label="STAKED" value={`${stakedRatio.toFixed(1)}%`} accent="cyan" />
      <Stat label="APY" value={`${apy.toFixed(1)}%`} accent={apy > 15 ? "amber" : "green"} />
      {peg != null ? (
        <Stat
          label="PEG"
          value={peg.toFixed(4)}
          accent={peg < 0.95 ? "red" : peg < 0.99 ? "amber" : "green"}
        />
      ) : reserveDepleted != null ? (
        <Stat
          label="RESERVE DRAIN"
          value={`${reserveDepleted.toFixed(1)}%`}
          accent={reserveDepleted > 70 ? "red" : reserveDepleted > 30 ? "amber" : "green"}
        />
      ) : (
        <Stat label="POOL" value={formatBig(state?.poolReserveB ?? 0)} accent="cyan" />
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
  accent: "cyan" | "green" | "red" | "amber";
}) {
  const cls = {
    cyan:  "text-cyan-300 [text-shadow:0_0_10px_rgba(34,211,238,0.4)]",
    green: "text-emerald-300 [text-shadow:0_0_10px_rgba(52,211,153,0.4)]",
    red:   "text-red-400 [text-shadow:0_0_10px_rgba(239,68,68,0.5)]",
    amber: "text-amber-300 [text-shadow:0_0_10px_rgba(251,191,36,0.4)]",
  }[accent];

  return (
    <div className="panel rounded px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.25em] text-zinc-500">{label}</div>
      <div className={cn("mt-1 font-mono text-lg font-semibold tabular-nums", cls)}>{value}</div>
    </div>
  );
}

function formatNum(n: number, dp = 2): string {
  if (!Number.isFinite(n)) return "—";
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
