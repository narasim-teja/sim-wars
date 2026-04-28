import luna8 from "./luna-8.json";
import luna20 from "./luna-20.json";

export interface ScenarioPayload {
  config: unknown;
  agents: { id: string; type: string; name: string; complexity?: string }[];
  tickConfig: { intervalMs: number; maxTicks: number };
}

export interface ScenarioPreset {
  id: "luna-8" | "luna-20";
  label: string;
  description: string;
  payload: ScenarioPayload;
  defaultMaxTicks: number;
}

export const SCENARIO_PRESETS: ScenarioPreset[] = [
  {
    id: "luna-20",
    label: "LUNA / UST · 20 agents",
    description: "Full Phase-2 roster reproducing the May 2022 death spiral. Whales, governance attackers, sybil swarm, MEV bot, insiders, panic seller — the works.",
    payload: luna20 as ScenarioPayload,
    defaultMaxTicks: 50,
  },
  {
    id: "luna-8",
    label: "LUNA / UST · 8 agents",
    description: "Slimmed roster — 2 whales, 2 farmers, 1 degen, 1 governance attacker, 2 long-term holders. Faster iteration, same dynamics.",
    payload: luna8 as ScenarioPayload,
    defaultMaxTicks: 30,
  },
];

export function findScenario(id: string): ScenarioPreset | null {
  return SCENARIO_PRESETS.find((s) => s.id === id) ?? null;
}
