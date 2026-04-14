import type { SimulationConfig, SimulationState } from "../types";

export interface LunaTickResult {
  reserveBalance: number;
  initialReserve: number;
  ustSupply: number;
  pegPrice: number;
  yieldSustainable: boolean;
  reserveWarning: boolean;
  lunaMinted: number;
  yieldPaid: number;
  borrowerRevenue: number;
  reserveDrainedThisTick: number;
}

/**
 * LUNA/UST scenario controller.
 * Simulates the specific mechanics that led to the LUNA death spiral:
 *
 * 1. Anchor Protocol paid 19.45% APY funded mostly by reserves, not real revenue
 * 2. Reserve slowly depleted as deposits grew
 * 3. When confidence broke, UST holders redeemed → minting new LUNA at falling prices
 * 4. More LUNA minted → price drops → more minting needed per redemption → hyperinflation
 */
export class LunaScenarioController {
  private reserveBalance: number;
  private initialReserve: number;
  private ustSupply: number;
  private ticksPerYear: number;
  private yieldPerTick: number;

  constructor(config: SimulationConfig) {
    this.reserveBalance = config.stablecoin?.reserveAmount ?? 3_000_000_000;
    this.initialReserve = this.reserveBalance;
    this.ustSupply = config.amm.initialLiquidity * config.amm.initialPrice;
    // A3: compressed timeline — each tick ≈ 1 day — so yield and reserve drain
    // are visible within the 50-tick Phase 1 sim window.
    this.ticksPerYear = 365;
    this.yieldPerTick = config.staking.baseAPY / 100 / this.ticksPerYear;
  }

  /**
   * Process LUNA-specific mechanics for one tick.
   * Call this after agents have acted but before state is finalized.
   */
  processTick(state: SimulationState): LunaTickResult {
    // 1. Compute yield paid this tick
    const yieldPaid = state.stakedSupply * this.yieldPerTick;

    // 2. Simulate borrower revenue (much lower than yield paid — THE design flaw)
    // In reality, Anchor Protocol's yield was ~85% subsidized by reserves
    const borrowerRevenue = yieldPaid * 0.15;

    // 3. Drain reserve
    const netDrain = yieldPaid - borrowerRevenue;
    this.reserveBalance = Math.max(0, this.reserveBalance - netDrain);

    // 4. Compute peg pressure
    const pegPressure = this.computePegPressure(state);
    const pegPrice = Math.max(0.001, 1.0 - pegPressure);

    // 5. If peg deviates, UST holders redeem → mint LUNA → hyperinflation
    let lunaMinted = 0;
    if (pegPrice < 0.98 && state.tokenPrice > 0.001) {
      // Redemption rate scales with peg deviation
      const deviation = 1.0 - pegPrice;
      const redeemPercent = Math.min(0.2, deviation * 0.5); // Up to 20% of UST redeemed per tick
      const redeemAmount = this.ustSupply * redeemPercent;

      // $1 worth of LUNA at current price
      // If LUNA = $85: 1/85 = 0.0118 LUNA per UST
      // If LUNA = $1:  1/1  = 1 LUNA per UST (HYPERINFLATION!)
      const lunaPerUst = 1.0 / state.tokenPrice;
      lunaMinted = redeemAmount * lunaPerUst;

      this.ustSupply = Math.max(0, this.ustSupply - redeemAmount);
    }

    return {
      reserveBalance: this.reserveBalance,
      initialReserve: this.initialReserve,
      ustSupply: this.ustSupply,
      pegPrice,
      yieldSustainable: this.reserveBalance > 0,
      reserveWarning: this.reserveBalance < this.initialReserve * 0.3,
      lunaMinted,
      yieldPaid,
      borrowerRevenue,
      reserveDrainedThisTick: netDrain,
    };
  }

  /**
   * Compute peg pressure based on market conditions.
   * Pressure increases when:
   * - Large sells happen (agents dumping LUNA)
   * - Reserve is low (can't defend peg)
   * - High sell/unstake volume
   */
  private computePegPressure(state: SimulationState): number {
    // Pressure from sells (agents dumping tokens)
    const sellVolume = state.recentLargeTrades
      .filter((t) => t.action === "sell" || t.action === "unstake")
      .reduce((sum, t) => sum + t.amount, 0);

    const pressureFromSells = Math.min(
      0.4,
      (sellVolume / Math.max(1, state.totalSupply)) * 50
    );

    // Pressure from reserve depletion
    const reserveRatio = this.reserveBalance / this.initialReserve;
    const pressureFromReserve = Math.max(0, (1 - reserveRatio) * 0.3);

    // Pressure from price decline (momentum)
    let pressureFromMomentum = 0;
    if (state.priceHistory.length >= 5) {
      const recentPrice = state.priceHistory[state.priceHistory.length - 1];
      const olderPrice = state.priceHistory[Math.max(0, state.priceHistory.length - 5)];
      if (olderPrice > 0) {
        const decline = (olderPrice - recentPrice) / olderPrice;
        pressureFromMomentum = Math.max(0, decline * 0.3);
      }
    }

    return Math.min(0.99, pressureFromSells + pressureFromReserve + pressureFromMomentum);
  }

  getReserveBalance(): number {
    return this.reserveBalance;
  }

  getUstSupply(): number {
    return this.ustSupply;
  }
}
