/**
 * BYOK model registry.
 *
 * Why this file exists: OpenRouter presets are account-scoped. When a user
 * brings their own OpenRouter key, the server's preset slugs (e.g.
 * `agent-decisions`) don't exist on the user's account and the request
 * fails. For BYOK runs we route through explicit model IDs instead, so the
 * request resolves against any valid OpenRouter account.
 *
 * Tier mapping mirrors the server presets one-for-one:
 *   primary   ←→ @preset/agent-decisions
 *   boost     ←→ @preset/agent-decisions-fast
 *   report    ←→ @preset/report-writer
 *
 * Temperatures match the dashboard-configured values for those presets so
 * BYOK runs behave like non-BYOK runs at the model level.
 *
 * The reasoning tier is intentionally omitted — the server preset for it is
 * commented out in .env.example and not part of the BYOK contract.
 */

export interface ByokTierModel {
  /** OpenRouter model id used as the request body's `model` field. */
  model: string;
  /** Temperature applied when the call site doesn't pass one explicitly. */
  defaultTemperature: number;
}

export const BYOK_MODELS = {
  primary: {
    model: "google/gemini-2.5-flash-lite",
    defaultTemperature: 0.5,
  },
  boost: {
    model: "mistralai/ministral-3b-2512",
    defaultTemperature: 0.6,
  },
  report: {
    model: "google/gemini-3-flash-preview",
    defaultTemperature: 0.3,
  },
} as const satisfies Record<string, ByokTierModel>;

/** Env flag that toggles BYOK mode for the worker subprocess. */
export const BYOK_MODE_ENV = "SIMWARS_BYOK_MODE";

export function isByokMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[BYOK_MODE_ENV] === "1";
}
