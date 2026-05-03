import type { SimulationConfig, SimulationState } from "../types";

export interface StablecoinTickResult {
  reserveBalance: number;
  initialReserve: number;
  stablecoinSupply: number;
  pegPrice: number;
  yieldSustainable: boolean;
  reserveWarning: boolean;
  baseMinted: number;
  yieldPaid: number;
  borrowerRevenue: number;
  reserveDrainedThisTick: number;
}

interface StablecoinRiskModel {
  borrowerRevenueRatio: number;
  redemptionThreshold: number;
  maxRedemptionPercentPerTick: number;
  redemptionRateMultiplier: number;
  sellPressureCoefficient: number;
  reservePressureCoefficient: number;
  momentumPressureCoefficient: number;
}

const DEFAULT_RISK_MODEL: StablecoinRiskModel = {
  borrowerRevenueRatio: 0.15,
  redemptionThreshold: 0.98,
  maxRedemptionPercentPerTick: 0.2,
  redemptionRateMultiplier: 0.5,
  sellPressureCoefficient: 0.4,
  reservePressureCoefficient: 0.3,
  momentumPressureCoefficient: 0.3,
};

/**
 * Generic stablecoin mechanism controller.
 *
 * This models a peg-target asset with reserve-funded yield and mint/burn
 * reflexivity. Terra/LUNA is one fixture that sets these parameters; custom
 * stablecoin whitepapers use the same code path with their extracted config.
 */
export class StablecoinMechanismController {
  private reserveBalance: number;
  private initialReserve: number;
  private stablecoinSupply: number;
  private ticksPerYear = 365;
  private yieldPerTick: number;
  private targetPeg: number;
  private mintBurnRatio: number;
  private risk: StablecoinRiskModel;

  constructor(config: SimulationConfig) {
    this.reserveBalance = config.stablecoin?.reserveAmount ?? 0;
    this.initialReserve = this.reserveBalance;
    this.stablecoinSupply = config.amm.initialLiquidity * config.amm.initialPrice;
    this.targetPeg = config.stablecoin?.targetPeg ?? 1;
    this.mintBurnRatio = config.stablecoin?.mintBurnRatio ?? 1;
    this.risk = { ...DEFAULT_RISK_MODEL, ...(config.stablecoin?.riskModel ?? {}) };
    this.risk.redemptionThreshold = Math.min(this.targetPeg, this.risk.redemptionThreshold);
    this.yieldPerTick = config.staking.baseAPY / 100 / this.ticksPerYear;
  }

  processTick(state: SimulationState): StablecoinTickResult {
    const yieldPaid = state.stakedSupply * this.yieldPerTick;
    const borrowerRevenue = yieldPaid * this.risk.borrowerRevenueRatio;
    const netDrain = Math.max(0, yieldPaid - borrowerRevenue);
    this.reserveBalance = Math.max(0, this.reserveBalance - netDrain);

    const pegPressure = this.computePegPressure(state);
    const pegPrice = Math.max(0.001, this.targetPeg - pegPressure);

    let baseMinted = 0;
    if (pegPrice < this.risk.redemptionThreshold && state.tokenPrice > 0.001) {
      const deviation = Math.max(0, this.targetPeg - pegPrice);
      const redeemPercent = Math.min(
        this.risk.maxRedemptionPercentPerTick,
        deviation * this.risk.redemptionRateMultiplier,
      );
      const redeemAmount = this.stablecoinSupply * redeemPercent;
      const basePerStable = (this.mintBurnRatio * this.targetPeg) / state.tokenPrice;
      baseMinted = redeemAmount * basePerStable;
      this.stablecoinSupply = Math.max(0, this.stablecoinSupply - redeemAmount);
    }

    return {
      reserveBalance: this.reserveBalance,
      initialReserve: this.initialReserve,
      stablecoinSupply: this.stablecoinSupply,
      pegPrice,
      yieldSustainable: this.reserveBalance > 0,
      reserveWarning: this.initialReserve > 0 && this.reserveBalance < this.initialReserve * 0.3,
      baseMinted,
      yieldPaid,
      borrowerRevenue,
      reserveDrainedThisTick: netDrain,
    };
  }

  private computePegPressure(state: SimulationState): number {
    const sellVolume = state.recentLargeTrades
      .filter((t) => t.action === "sell" || t.action === "unstake")
      .reduce((sum, t) => sum + t.amount, 0);

    const pressureFromSells = Math.min(
      this.risk.sellPressureCoefficient,
      (sellVolume / Math.max(1, state.totalSupply)) * 50,
    );

    const reserveRatio = this.initialReserve > 0
      ? this.reserveBalance / this.initialReserve
      : 1;
    const pressureFromReserve = Math.max(
      0,
      (1 - reserveRatio) * this.risk.reservePressureCoefficient,
    );

    let pressureFromMomentum = 0;
    if (state.priceHistory.length >= 5) {
      const recentPrice = state.priceHistory[state.priceHistory.length - 1] ?? state.tokenPrice;
      const olderPrice = state.priceHistory[Math.max(0, state.priceHistory.length - 5)] ?? recentPrice;
      if (olderPrice > 0) {
        const decline = (olderPrice - recentPrice) / olderPrice;
        pressureFromMomentum = Math.max(0, decline * this.risk.momentumPressureCoefficient);
      }
    }

    return Math.min(this.targetPeg - 0.001, pressureFromSells + pressureFromReserve + pressureFromMomentum);
  }

  getReserveBalance(): number {
    return this.reserveBalance;
  }

  getStablecoinSupply(): number {
    return this.stablecoinSupply;
  }
}
