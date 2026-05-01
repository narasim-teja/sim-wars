/**
 * Engine-wide tunables. Anything that's a "where do we draw the line"
 * decision lives here so it can be eyeballed without grepping.
 */

/**
 * Hard ceiling on agents per simulation. Above this the API rejects with 400.
 * Set conservatively because:
 *   - on-chain runs need 1 keypair per agent + 5 SOL airdrop per keypair on
 *     devnet, which gets rate-limited fast;
 *   - LLM cost scales linearly (agentCount × ticks × tokens/call).
 * Bump if you have a private RPC + budget for it.
 */
export const MAX_AGENTS = 100;

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
