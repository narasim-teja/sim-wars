import type { SimulationState, SimulationConfig, Proposal } from "../types";

/**
 * StateManager reads on-chain state and computes derived metrics.
 * In Phase 1, it uses a simplified in-memory model for staking
 * (real staking program comes Days 6-7).
 */
export class StateManager {
  private priceHistory: number[] = [];
  private stakingBalances: Map<string, number> = new Map();
  private totalStaked = 0;
  private stakingAPY: number;
  private recentLargeTrades: { agentId: string; action: string; amount: number }[] = [];

  /**
   * veToken-style locks. When `config.veToken.enabled`, `stake()` callers can
   * pass `lockTicks` to commit tokens for a duration. `unstake` is refused
   * until `currentTick >= lockedUntilTick`. Maps agent ID → unlock tick.
   *
   * For protocols without veToken, this map stays empty and unstake works
   * the way it always did.
   */
  private lockUntilTick: Map<string, number> = new Map();

  // Pool state (read from chain or simulated)
  private poolReserveA: number;
  private poolReserveB: number;
  private totalSupply: number;

  // In-memory governance mirror — when on-chain governance isn't configured,
  // these drive the Proposal list surfaced to agents. The orchestrator keeps
  // the chain-side copy (if any) and these in sync.
  private proposals: Proposal[] = [];
  private votes: Map<number, Set<string>> = new Map(); // proposalId → voter set (prevents double-vote)
  private currentTick = 0;

  constructor(private config: SimulationConfig) {
    // Initialize from config
    this.poolReserveA = config.amm.initialLiquidity;
    this.poolReserveB = config.amm.initialLiquidity * config.amm.initialPrice;
    this.totalSupply = config.token.totalSupply;
    this.stakingAPY = config.staking.baseAPY;

    // Set initial price
    const initialPrice = this.poolReserveB / this.poolReserveA;
    this.priceHistory.push(initialPrice);
  }

  /**
   * Read the current simulation state for a given tick.
   */
  async readState(
    tick: number,
    agentBalances: Map<string, { token: number; staked: number; usdc: number }>
  ): Promise<SimulationState> {
    const price = this.getPrice();
    this.priceHistory.push(price);

    // Keep last 100 prices
    if (this.priceHistory.length > 100) {
      this.priceHistory = this.priceHistory.slice(-100);
    }

    // Compute Gini from all token balances
    const allBalances = Array.from(agentBalances.values()).map(
      (b) => b.token + b.staked
    );
    const gini = this.computeGini(allBalances);

    // Top holders
    const topHolders = Array.from(agentBalances.entries())
      .map(([agentId, b]) => ({
        address: agentId,
        agentId,
        balance: b.token + b.staked,
      }))
      .sort((a, b) => b.balance - a.balance)
      .slice(0, 5);

    this.currentTick = tick;
    this.tallyExpiredProposals();

    return {
      tick,
      tokenPrice: price,
      priceHistory: [...this.priceHistory],
      totalSupply: this.totalSupply,
      circulatingSupply: this.totalSupply - this.totalStaked,
      stakedSupply: this.totalStaked,
      stakingAPY: this.stakingAPY,
      giniCoefficient: gini,
      governanceProposals: this.proposals.map((p) => ({ ...p })),
      topHolders,
      recentLargeTrades: [...this.recentLargeTrades],
      coordinationEdges: [],
      poolReserveA: this.poolReserveA,
      poolReserveB: this.poolReserveB,
    };
  }

  /**
   * Execute a swap on the simulated AMM pool.
   * Returns the amount of tokens received.
   */
  executeSwap(amountIn: number, aToB: boolean): number {
    const feeBps = this.config.amm.feeTier * 100; // feeTier is in %, convert to bps
    const fee = (amountIn * feeBps) / 10_000;
    const amountInAfterFee = amountIn - fee;

    const [reserveIn, reserveOut] = aToB
      ? [this.poolReserveA, this.poolReserveB]
      : [this.poolReserveB, this.poolReserveA];

    // Constant product: dy = y * dx / (x + dx)
    const amountOut = (reserveOut * amountInAfterFee) / (reserveIn + amountInAfterFee);

    if (amountOut <= 0 || amountOut >= reserveOut) {
      return 0;
    }

    // Update reserves
    if (aToB) {
      this.poolReserveA += amountIn;
      this.poolReserveB -= amountOut;
    } else {
      this.poolReserveB += amountIn;
      this.poolReserveA -= amountOut;
    }

    return amountOut;
  }

  /**
   * Simulate staking (in-memory for Phase 1).
   *
   * For veToken protocols, callers can pass `lockTicks` to commit tokens for
   * a duration. The longest active commitment wins — restaking with a longer
   * lock extends `lockedUntilTick`; restaking with a shorter lock leaves the
   * existing one in place.
   */
  stake(agentId: string, amount: number, lockTicks?: number): void {
    const current = this.stakingBalances.get(agentId) || 0;
    this.stakingBalances.set(agentId, current + amount);
    this.totalStaked += amount;

    if (lockTicks !== undefined && lockTicks > 0) {
      const newUnlock = this.currentTick + lockTicks;
      const existing = this.lockUntilTick.get(agentId) ?? 0;
      if (newUnlock > existing) this.lockUntilTick.set(agentId, newUnlock);
    }
  }

  /**
   * Simulate unstaking. For veToken protocols, returns 0 if the lock hasn't
   * expired — caller can detect this and treat it as a no-op / "still locked"
   * outcome rather than success.
   */
  unstake(agentId: string, amount: number): number {
    if (this.config.veToken?.enabled) {
      const unlockAt = this.lockUntilTick.get(agentId) ?? 0;
      if (this.currentTick < unlockAt) return 0;
    }
    const current = this.stakingBalances.get(agentId) || 0;
    const actual = Math.min(amount, current);
    this.stakingBalances.set(agentId, current - actual);
    this.totalStaked -= actual;
    return actual;
  }

  /**
   * Returns the unlock tick for the given agent, or null if no lock is held.
   * Useful for telemetry + agent prompts ("you can't unstake until tick X").
   */
  getUnlockTick(agentId: string): number | null {
    const t = this.lockUntilTick.get(agentId);
    return t === undefined ? null : t;
  }

  /**
   * Compute the time-weighted vote weight for an agent. For non-veToken
   * protocols this just returns the staked amount. For veToken with
   * `linear-decay`, weight = stake × boost × (remaining_lock / max_lock).
   * For `constant`, weight = stake × boost as long as any lock is active.
   */
  getVoteWeight(agentId: string): number {
    const stake = this.stakingBalances.get(agentId) ?? 0;
    const ve = this.config.veToken;
    if (!ve?.enabled) return stake;

    const unlockAt = this.lockUntilTick.get(agentId) ?? 0;
    const remaining = Math.max(0, unlockAt - this.currentTick);
    if (remaining === 0) return stake; // expired lock — fall back to stake-weight

    const maxLockTicks = ve.maxLockMonths * 30;
    if (ve.voteWeightCurve === "constant") {
      return stake * ve.boostMultiplier;
    }
    // linear-decay: full boost at remaining = max, 0 boost at remaining = 0,
    // floor at 1× so locked stake never weighs less than liquid stake.
    const fraction = Math.min(1, remaining / maxLockTicks);
    const multiplier = 1 + (ve.boostMultiplier - 1) * fraction;
    return stake * multiplier;
  }

  /**
   * Compute staking rewards for a tick.
   */
  computeStakingRewards(): Map<string, number> {
    const rewards = new Map<string, number>();
    // A3: treat each tick as ~1 day so the 19.45% APY compresses the death-spiral
    // timeline into ~30-50 ticks (Phase 1 design target), not months.
    const ticksPerYear = 365;
    const rewardRate = this.stakingAPY / 100 / ticksPerYear;

    for (const [agentId, staked] of this.stakingBalances) {
      if (staked > 0) {
        rewards.set(agentId, staked * rewardRate);
      }
    }

    return rewards;
  }

  /**
   * Record a large trade for visibility to other agents.
   */
  recordTrade(agentId: string, action: string, amount: number): void {
    this.recentLargeTrades.push({ agentId, action, amount });
    // Keep only last 10
    if (this.recentLargeTrades.length > 10) {
      this.recentLargeTrades = this.recentLargeTrades.slice(-10);
    }
  }

  /**
   * Increase total supply (for LUNA mint-from-burn hyperinflation).
   */
  inflateSupply(amount: number): void {
    this.totalSupply += amount;
  }

  /**
   * Overwrite pool reserves (used in chain mode to sync from on-chain after a swap).
   */
  setPoolReserves(reserveA: number, reserveB: number): void {
    this.poolReserveA = reserveA;
    this.poolReserveB = reserveB;
  }

  getPrice(): number {
    if (this.poolReserveA === 0) return 0;
    return this.poolReserveB / this.poolReserveA;
  }

  getStakedBalance(agentId: string): number {
    return this.stakingBalances.get(agentId) || 0;
  }

  /** Sum of all per-agent staked balances. Used by emissions scheduler. */
  getTotalStaked(): number {
    return this.totalStaked;
  }

  /** Read-only view of the SimulationConfig — orchestrator uses it for veToken defaults. */
  getConfig(): SimulationConfig {
    return this.config;
  }

  // ============================================================
  // In-memory governance — always available, mirrors the on-chain
  // program's semantics (proposal threshold in stake amount, stake-weighted
  // voting, voting period, quorum). When on-chain governance is enabled
  // the orchestrator is also calling the chain; these values stay in sync
  // because amount/weight are derived from the same stakingBalances map.
  // ============================================================

  /** Proposer must have staked ≥ threshold (expressed as fraction of totalSupply). */
  createProposal(proposerId: string, description: string): Proposal | null {
    const thresholdFraction = this.config.governance.proposalThresholdPercent / 100;
    const required = this.totalSupply * thresholdFraction;
    const proposerStake = this.stakingBalances.get(proposerId) ?? 0;
    if (proposerStake < required) return null;

    const id = this.proposals.length;
    const proposal: Proposal = {
      id,
      proposer: proposerId,
      description,
      votesFor: 0,
      votesAgainst: 0,
      status: "active",
      tickCreated: this.currentTick,
      tickExpires: this.currentTick + this.config.governance.votingPeriodTicks,
    };
    this.proposals.push(proposal);
    this.votes.set(id, new Set());
    return proposal;
  }

  /** Returns the proposal the voter's weight is recorded against, or null on reject. */
  castVote(voterId: string, proposalId: number, support: boolean): Proposal | null {
    const proposal = this.proposals.find((p) => p.id === proposalId);
    if (!proposal) return null;
    if (proposal.status !== "active") return null;
    if (this.currentTick > proposal.tickExpires) return null;

    const voters = this.votes.get(proposalId)!;
    if (voters.has(voterId)) return null; // no double-vote

    // veToken vote-weighting: getVoteWeight() applies the boost curve when
    // the protocol uses time-locked stake; otherwise it returns raw stake.
    const weight = this.getVoteWeight(voterId);
    if (weight <= 0) return null;

    if (support) proposal.votesFor += weight;
    else proposal.votesAgainst += weight;
    voters.add(voterId);
    return proposal;
  }

  /**
   * Latest active proposal — surfaced to agent prompts so voters can
   * act without guessing the most-recent id.
   */
  getLatestActiveProposalId(): number | null {
    for (let i = this.proposals.length - 1; i >= 0; i--) {
      if (this.proposals[i].status === "active") return this.proposals[i].id;
    }
    return null;
  }

  private tallyExpiredProposals(): void {
    const quorum = this.totalSupply * (this.config.governance.quorumPercent / 100);
    for (const p of this.proposals) {
      if (p.status !== "active") continue;
      if (this.currentTick <= p.tickExpires) continue;

      const total = p.votesFor + p.votesAgainst;
      p.status = total >= quorum && p.votesFor > p.votesAgainst ? "passed" : "failed";
    }
  }

  /**
   * Gini coefficient: 0 = perfect equality, 1 = perfect inequality.
   */
  private computeGini(balances: number[]): number {
    if (balances.length === 0) return 0;

    const sorted = [...balances].sort((a, b) => a - b);
    const n = sorted.length;
    const totalWealth = sorted.reduce((s, v) => s + v, 0);
    if (totalWealth === 0) return 0;

    let giniSum = 0;
    for (let i = 0; i < n; i++) {
      giniSum += (2 * (i + 1) - n - 1) * sorted[i];
    }

    return giniSum / (n * totalWealth);
  }
}
