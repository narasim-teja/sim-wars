import type { SimulationState, ThreatLevel } from "./types";
import type { SimSeriesPoint } from "@/hooks/useSimulation";

/**
 * Threat level gates. Match the spec in plan.md → ThreatIndicator section.
 *
 *   green: stable
 *   yellow: 1 alarm bit
 *   red: 2+ alarm bits OR steep drop
 *   death_spiral: emitted by worker — handled separately
 */
export function computeThreat(
  current: SimulationState | null,
  series: SimSeriesPoint[],
): { level: ThreatLevel; reasons: string[] } {
  if (!current || series.length === 0) return { level: "calm", reasons: [] };

  const reasons: string[] = [];
  let alarms = 0;

  // Gini concentration
  if (current.giniCoefficient > 0.7) { alarms++; reasons.push(`Gini ${current.giniCoefficient.toFixed(2)} > 0.7`); }
  else if (current.giniCoefficient > 0.6) { reasons.push(`Gini ${current.giniCoefficient.toFixed(2)} (watch)`); }

  // Reserve depletion (LUNA-style scenarios)
  if (current.initialReserveBalance && current.reserveBalance != null) {
    const depletion = 1 - current.reserveBalance / current.initialReserveBalance;
    if (depletion > 0.7) { alarms++; reasons.push(`reserve ${(depletion * 100).toFixed(0)}% depleted`); }
    else if (depletion > 0.3) { reasons.push(`reserve ${(depletion * 100).toFixed(0)}% drained`); }
  }

  // Peg break
  if (current.pegPrice != null && current.pegPrice < 0.99) {
    alarms++;
    reasons.push(`peg ${current.pegPrice.toFixed(3)} < 0.99`);
  }

  // Price drop velocity (last 1 tick)
  if (series.length >= 2) {
    const prev = series[series.length - 2].price;
    const curr = series[series.length - 1].price;
    if (prev > 0) {
      const drop = (prev - curr) / prev;
      if (drop > 0.2) { alarms += 2; reasons.push(`price -${(drop * 100).toFixed(0)}% this tick`); }
      else if (drop > 0.05) { alarms++; reasons.push(`price -${(drop * 100).toFixed(0)}% this tick`); }
    }
  }

  let level: ThreatLevel = "calm";
  if (alarms >= 3) level = "critical";
  else if (alarms === 2) level = "elevated";
  else if (alarms === 1) level = "watch";

  return { level, reasons };
}

export const THREAT_META: Record<ThreatLevel, { label: string; color: string; ringColor: string; pulse: boolean }> = {
  calm:         { label: "STABLE",       color: "#22c55e", ringColor: "#22c55e80", pulse: false },
  watch:        { label: "WATCH",        color: "#facc15", ringColor: "#facc1580", pulse: false },
  elevated:     { label: "ELEVATED",     color: "#fb923c", ringColor: "#fb923c80", pulse: true  },
  critical:     { label: "CRITICAL",     color: "#ef4444", ringColor: "#ef444480", pulse: true  },
  death_spiral: { label: "DEATH SPIRAL", color: "#dc2626", ringColor: "#dc2626a0", pulse: true  },
};
