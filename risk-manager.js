// ============================================================
//  AutoCycle Deriv Bot — Risk Manager  (fixed)
//  Fixes:
//   1. getStake() now respects tier.max_stake cap
//   2. getLimits() returns null takeProfit when tp_pct is null
//      (null = no fixed TP, trailing stop handles exits instead)
// ============================================================

class RiskManager {
  constructor(config) {
    this.config = config;
  }

  getTier(balance) {
    for (const tier of this.config.TIERS) {
      if (balance >= tier.minBalance && balance <= tier.maxBalance) return tier;
    }
    return this.config.TIERS[this.config.TIERS.length - 1];
  }

  // Stake = balance × stakePct, capped at tier.max_stake
  getStake(balance, instrumentConfig) {
    const tier  = this.getTier(balance);
    const raw   = balance * tier.stakePct;
    const cap   = tier.max_stake || Infinity;
    const stake = Math.min(raw, cap);
    return Math.max(parseFloat(stake.toFixed(2)), this.config.MIN_STAKE);
  }

  getMaxTrades(balance) {
    return this.getTier(balance).maxTrades;
  }

  // Returns { takeProfit, stopLoss }
  // takeProfit = null when tp_pct is null (means: no fixed TP, use trailing stop)
  getLimits(stake, instrumentConfig) {
    const takeProfit = (instrumentConfig.tp_pct != null)
      ? parseFloat((stake * instrumentConfig.tp_pct).toFixed(2))
      : null;
    const stopLoss = parseFloat((stake * instrumentConfig.sl_pct).toFixed(2));
    return { takeProfit, stopLoss };
  }

  canTrade(balance, openCount) {
    if (balance < this.config.MIN_STAKE) {
      return { ok: false, reason: `Balance $${balance.toFixed(2)} below minimum` };
    }
    const max = this.getMaxTrades(balance);
    if (openCount >= max) {
      return { ok: false, reason: `At max trades: ${openCount}/${max}` };
    }
    return { ok: true };
  }

  status(balance, openCount) {
    const tier  = this.getTier(balance);
    const stake = this.getStake(balance);
    return `💰 $${balance.toFixed(2)} | Stake: $${stake} | Trades: ${openCount}/${tier.maxTrades}`;
  }
}

module.exports = RiskManager;
