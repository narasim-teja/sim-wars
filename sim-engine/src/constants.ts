/**
 * Engine-wide tunables. Anything that's a "where do we draw the line"
 * decision lives here so it can be eyeballed without grepping.
 */

/**
 * Hard ceiling on agents per simulation. Above this the API rejects with 400.
 * Bumped to 5000 for OASIS-scale stress tests: at this size the bottleneck
 * is LLM cost ($) and on-chain RPC throughput, not engine memory. The
 * roster expander, orchestrator, and DB are all O(N) so 5k is fine; just
 * be aware that:
 *   - on-chain runs at >1k agents need a paid RPC (Helius) — public devnet
 *     will rate-limit deploy at ~50 concurrent ATA-creates;
 *   - LLM cost scales linearly (agentCount × ticks × tokens/call). At
 *     5k agents × 30 ticks × ~$0.0002/call ≈ $30/run on the cheap preset.
 * Override at runtime via SIM_MAX_AGENTS env var (intended for CI).
 */
export const MAX_AGENTS = Number(process.env.SIM_MAX_AGENTS) || 5000;

/**
 * On-chain cap. Below `MAX_AGENTS` because on-chain deploy hits real
 * resource limits the off-chain path doesn't:
 *   - per-agent SOL funding from the deployer keypair (~0.05 SOL × N)
 *   - devnet ATA-create / airdrop throughput
 *   - per-tick RPC fan-out
 *
 * 50 is a deliberate pragmatic cap for the public website. Self-hosted
 * users can raise it via `SIM_ONCHAIN_MAX_AGENTS` — the codebase is
 * open-source.
 */
export const MAX_ONCHAIN_AGENTS = Number(process.env.SIM_ONCHAIN_MAX_AGENTS) || 50;

/**
 * Default agent count when a request omits both `agents[]` and `agentCount`.
 * Mirrors the canonical 20-agent LUNA scenario.
 */
export const DEFAULT_AGENT_COUNT = 20;

/**
 * SOL airdropped per agent when on-chain mode is enabled. Devnet faucet is
 * stingy; 5 SOL covers tx fees comfortably for a 100-tick run.
 */
export const SOL_PER_AGENT_DEFAULT = 5;

/**
 * Bounds on per-roster perturbation when the expander clones archetypes.
 * Capital ±20%, risk-tolerance ±0.05. Seeded by simId so runs reproduce.
 */
export const ROSTER_PERTURBATION = {
  capitalRange: 0.2,
  riskRange: 0.05,
} as const;
