import luna from "./luna.json";
import jupiter from "./jupiter.json";

export interface ScenarioPayload {
  config: unknown;
  agents: { id: string; type: string; name: string; complexity?: string }[];
  tickConfig: { intervalMs: number; maxTicks: number };
}

export interface ScenarioPreset {
  id: "luna" | "jupiter";
  label: string;
  description: string;
  payload: ScenarioPayload;
  defaultMaxTicks: number;
  /** Cosmetic flag the UI uses to badge backtests as "validated" vs experimental. */
  validated?: boolean;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: "luna",
    label: "LUNA / UST · death spiral",
    description: "Anchor's 19.45% APY + algorithmic stablecoin + zero lock = the May 2022 collapse. 100-agent cast: whales, governance attackers, sybil swarm, MEV bot, panic sellers — driving the burn-mint loop until UST → LUNA hyperinflation.",
    payload: luna as ScenarioPayload,
    defaultMaxTicks: 200,
    validated: true,
  },
  {
    id: "jupiter",
    label: "Jupiter JUP · Litterbox buyback",
    description: "Solana DEX aggregator. 50% of onchain revenue → Litterbox Trust → programmatic JUP buyback (~134M burned). Jupuary airdrop dumpers create persistent supply overhang absorbed by Litterbox + ASR holders. Real revenue, no peg.",
    payload: jupiter as ScenarioPayload,
    defaultMaxTicks: 200,
    validated: true,
  },
];

export function findScenario(id: string): ScenarioPreset | null {
  return SCENARIO_PRESETS.find((s) => s.id === id) ?? null;
}
