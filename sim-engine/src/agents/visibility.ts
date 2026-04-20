import type { AgentAction, AgentPersona } from "../types";

/**
 * Per-observer rule describing *how* they see another agent's actions.
 *
 * - `delay`    — ticks between when the action happens and when the observer sees it.
 *                INSIDER gets 0 (or even "this tick" via batch ordering);
 *                ANALYST effectively publishes with delay 1 (others see next tick).
 * - `fidelity` — [0, 1]. < 1 means amount and reasoning are obscured so the
 *                observer can't exploit the precise signal — only the fact that
 *                something happened.
 *
 * If `target` is set the rule scopes to that agent. Otherwise it covers everyone.
 */
export interface VisibilityRule {
  observer: string;
  target?: string;
  delay: number;
  fidelity: number;
}

/**
 * Defaults for the 20-agent roster. Keep short — the orchestrator treats
 * anything unlisted as `delay: 0, fidelity: 1` (full visibility).
 */
export const DEFAULT_VISIBILITY_RULES: VisibilityRule[] = [
  // INSIDER has advance knowledge of TREASURY. Same-tick visibility
  // (delay=0) plus batch ordering = front-run treasury buybacks.
  { observer: "INSIDER_01", target: "TREASURY_01", delay: 0, fidelity: 1 },
  // ANALYST publishes with a lag — everyone else sees their actions 1 tick late,
  // modelling a "research note" that comes out after they traded.
  // The rule applies to what *others* see when ANALYST_01 acts: we invert
  // this at lookup time (see `resolveVisibility`).
];

/**
 * Rules describing how *everyone else* sees a given actor.
 * These are applied when the observer has no explicit rule.
 *
 * ANALYST_01 publishes with delay 1 (to others); SYBIL_01's sub-wallet
 * effects arrive with full fidelity (amplification is already visible in
 * the trade stream — no obscuring needed).
 */
export const DEFAULT_TARGET_RULES: Record<string, { delay: number; fidelity: number }> = {
  ANALYST_01: { delay: 1, fidelity: 1 },
};

export interface VisibilityResolution {
  delay: number;
  fidelity: number;
  action: AgentAction;
}

/**
 * Decide how (and if) an observer sees a given action. Applies fidelity by
 * obscuring `amount` and `reasoning` — the fact of the action remains, but
 * actionable detail is scrubbed. The caller decides whether to `recordObservation`
 * with the returned `delay`.
 */
export function resolveVisibility(
  observerId: string,
  action: AgentAction,
  rules: VisibilityRule[] = DEFAULT_VISIBILITY_RULES,
  targetRules: Record<string, { delay: number; fidelity: number }> = DEFAULT_TARGET_RULES,
): VisibilityResolution {
  // Rule match priority: observer-specific > target-specific > default.
  const specific = rules.find(
    (r) => r.observer === observerId && (!r.target || r.target === action.agentId),
  );
  const targetRule = specific ? null : targetRules[action.agentId];

  const delay = specific?.delay ?? targetRule?.delay ?? 0;
  const fidelity = specific?.fidelity ?? targetRule?.fidelity ?? 1;

  const out = fidelity < 1
    ? { ...action, amount: null, reasoning: "[obscured]" }
    : action;

  return { delay, fidelity, action: out };
}

/**
 * Pure filter used by tests and any caller that wants to compute what an
 * observer would see *right now*, given the current tick. Delayed actions
 * whose delivery tick hasn't arrived yet are dropped.
 */
export function computeObservableActions(
  observerId: string,
  allActions: AgentAction[],
  currentTick: number,
  rules: VisibilityRule[] = DEFAULT_VISIBILITY_RULES,
  targetRules: Record<string, { delay: number; fidelity: number }> = DEFAULT_TARGET_RULES,
): AgentAction[] {
  const out: AgentAction[] = [];
  for (const action of allActions) {
    if (action.agentId === observerId) continue;
    const { delay, action: shaped } = resolveVisibility(observerId, action, rules, targetRules);
    if (currentTick - action.tick < delay) continue;
    out.push(shaped);
  }
  return out;
}

/**
 * Deterministic batch ordering for observation fidelity. Treasury moves
 * before the insider so the insider's same-tick observation reflects
 * treasury's realized action; the analyst moves last so its action only
 * lands for others on the next tick (combined with the delay-1 rule).
 */
export function orderAgentsForObservation(personas: AgentPersona[]): AgentPersona[] {
  const rank = (p: AgentPersona): number => {
    if (p.type === "treasury") return 0;
    if (p.type === "insider") return 2;
    if (p.type === "analyst") return 3;
    return 1;
  };
  return [...personas].sort((a, b) => rank(a) - rank(b));
}
