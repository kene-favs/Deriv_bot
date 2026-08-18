// ============================================================
//  AutoCycle Deriv Bot — Trade Manager  v11.5
//
//  CHANGES FROM v11.4:
//    Fix 1 — maxPerSymbol read from dynConfig (instrumentConfig)
//             not from strategy.config.MAX_TRADES_PER_SYMBOL
//    Fix 2 — maxTrades read from dynConfig; enforced before open
//    Fix 3 — stake/limits read from dynConfig (stake, tp, sl)
//             set by bot.js getDynamicParams() — previously
//             always called risk.getStake() which returned $15
//             regardless of balance
//
//  All other behaviour unchanged from v11.4:
//    closeCounterTrades, openPreSpikePosition, closeSpikeVictims,
//    trailing stop, tiered quick exit, printSummary
// ============================================================

const EventEmitter = require('events');

class TradeManager extends EventEmitter {

  constructor(derivClient, riskManager, strategy) {
    super();
    this.client   = derivClient;
    this.risk     = riskManager;
    this.strategy = strategy;
    this.trades   = new Map();
    this.stats    = { opened: 0, closed: 0, totalPnL: 0 };

    this._preSpikeOpen = new Set();

    this.client.setMaxListeners(50);
    this.client.on('proposal_open_contract', (msg) => this._onPocUpdate(msg));
  }

  // ── Shared P&L update handler ──────────────────────────────
  _onPocUpdate(msg) {
    const poc = msg.proposal_open_contract;
    if (!poc) return;

    const trade = this.trades.get(String(poc.contract_id));
    if (!trade || trade.closing) return;

    if (poc.is_sold) {
      const finalPnL = parseFloat(poc.profit || 0);
      this._recordClose(trade, finalPnL, 'Server closed (TP/SL)');
      return;
    }

    const pnl   = parseFloat(poc.profit || 0);
    const ageMs = Date.now() - trade.openTime;
    trade.currentPnL = pnl;
    if (pnl > trade.peakPnL) trade.peakPnL = pnl;

    const se             = this.strategy.config.SMART_EXIT || {};
    const TRAIL_ACTIVATE = se.TRAIL_ACTIVATE_PCT || 1;
    const TRAIL_DISTANCE = se.TRAIL_DISTANCE_PCT  || 2;
    const TIERS          = (se.QUICK_EXIT && se.QUICK_EXIT.TIERS) || [];

    // ── Trailing stop ────────────────────────────────────────
    const pnlPct = (pnl / trade.stake) * 100;
    if (!trade.trailingActive && pnlPct >= TRAIL_ACTIVATE) {
      trade.trailingActive = true;
      trade.trailingStop   = trade.peakPnL * (1 - TRAIL_DISTANCE / 100);
      console.log(`[SmartExit] Trailing ACTIVATED ${trade.symbol} | locked $${trade.trailingStop.toFixed(2)}`);
    }
    if (trade.trailingActive) {
      const newStop = trade.peakPnL * (1 - TRAIL_DISTANCE / 100);
      if (newStop > trade.trailingStop) {
        trade.trailingStop = newStop;
        console.log(`[SmartExit] Trail raised -> $${trade.trailingStop.toFixed(2)} on ${trade.symbol}`);
      }
      if (pnl <= trade.trailingStop) {
        console.log(
          `[SmartExit] Trail hit ${trade.symbol} | P&L $${pnl.toFixed(2)} (peak $${trade.peakPnL.toFixed(2)})`
        );
        this._closeContract(trade, 'Trailing stop');
        return;
      }
    }

    // ── Pre-spike: loss cap ──────────────────────────────────
    if (trade.preSpike) {
      const maxLoss = trade.stake * 0.03;
      if (pnl < 0 && Math.abs(pnl) >= maxLoss) {
        console.log(`[SmartExit] Pre-spike loss cap ${trade.symbol} | P&L $${pnl.toFixed(2)}`);
        this._closeContract(trade, 'Pre-spike loss cap');
        return;
      }
      return;
    }

    // ── Tiered quick exit ────────────────────────────────────
    for (const tier of TIERS) {
      if (ageMs <= tier.MAX_AGE_MS && pnl < 0) {
        const lossPct = Math.abs(pnl) / trade.stake;
        if (lossPct >= tier.LOSS_PCT) {
          const pct = (lossPct * 100).toFixed(1);
          console.log(
            `[SmartExit] Quick exit ${trade.symbol} | ${(ageMs / 1000).toFixed(1)}s | loss ${pct}%`
          );
          this._closeContract(trade, `Quick exit (${pct}% loss at ${(ageMs / 1000).toFixed(0)}s)`);
          return;
        }
      }
    }
  }

  // ── Open a new contract ────────────────────────────────────
  //
  //  instrumentConfig now comes from bot.js getDynamicParams():
  //    { stake, tp, sl, maxTrades, maxPerSymbol, multiplier, ...rest }
  //
  async open(symbol, signal, balance, instrumentConfig) {

    // FIX 2: maxTrades from dynConfig
    const maxTrades = instrumentConfig.maxTrades;
    if (maxTrades != null && this.trades.size >= maxTrades) {
      console.log(`[Trade] Max trades reached (${this.trades.size}/${maxTrades})`);
      return null;
    }

    const check = this.risk.canTrade(balance, this.trades.size);
    if (!check.ok) {
      console.log(`[Trade] ${check.reason}`);
      return null;
    }

    // FIX 1: maxPerSymbol from dynConfig
    const maxPerSymbol = instrumentConfig.maxPerSymbol != null
      ? instrumentConfig.maxPerSymbol
      : (this.strategy.config.MAX_TRADES_PER_SYMBOL || 2);

    const symbolCount = [...this.trades.values()].filter(t => t.symbol === symbol).length;
    if (symbolCount >= maxPerSymbol) {
      console.log(`[Trade] ${symbol}: per-symbol limit (${symbolCount}/${maxPerSymbol})`);
      return null;
    }

    // FIX 3: stake / limits from dynConfig
    const stake = instrumentConfig.stake != null
      ? instrumentConfig.stake
      : this.risk.getStake(balance, instrumentConfig);

    const limits = (instrumentConfig.tp != null && instrumentConfig.sl != null)
      ? { takeProfit: instrumentConfig.tp, stopLoss: instrumentConfig.sl }
      : this.risk.getLimits(stake, instrumentConfig);

    const withSpike =
      (symbol.includes('CRASH') && signal.contractType === 'MULTDOWN') ||
      (symbol.includes('BOOM')  && signal.contractType === 'MULTUP');

    if (withSpike && instrumentConfig.spike_tp_pct != null) {
      limits.takeProfit = parseFloat((stake * instrumentConfig.spike_tp_pct).toFixed(2));
      console.log(`[Trade]   With-spike trade — TP raised to $${limits.takeProfit}`);
    }

    const dir = withSpike ? 'WITH-SPIKE' : 'COUNTER';
    console.log(`\n[Trade] ${symbol} | ${signal.contractType} | stake $${stake} x${instrumentConfig.multiplier} | ${dir}`);
    console.log(`[Trade]   Reason : ${signal.reason}`);
    console.log(`[Trade]   TP: $${limits.takeProfit ?? 'trailing'} | SL: $${limits.stopLoss}`);

    try {
      const result = await this.client.buyContract({
        symbol,
        contractType: signal.contractType,
        stake,
        multiplier:   instrumentConfig.multiplier,
        takeProfit:   limits.takeProfit,
        stopLoss:     limits.stopLoss,
      });

      const trade = {
        contractId:     String(result.contract_id),
        symbol,
        contractType:   signal.contractType,
        stake,
        openTime:       Date.now(),
        reason:         signal.reason,
        withSpike,
        currentPnL:     0,
        peakPnL:        0,
        trailingActive: false,
        trailingStop:   -limits.stopLoss,
        closing:        false,
      };

      this.trades.set(trade.contractId, trade);
      this.stats.opened++;
      this.strategy.markEntry(symbol);

      console.log(`[Bot] NEW TRADE ${symbol} ${signal.contractType}  stake=$${stake}  ${dir}`);

      this.client.subscribeContract(trade.contractId).catch((err) => {
        console.error(`[Monitor] Subscribe failed ${trade.contractId}: ${err.message}`);
      });

      this.emit('opened', trade);
      return trade;

    } catch (err) {
      console.error(`[Trade] Open failed on ${symbol}: ${err.message}`);
      return null;
    }
  }

  // ── PRE-SPIKE: close counter trades early ─────────────────
  async closeCounterTrades(symbol) {
    const counterType = symbol.includes('CRASH') ? 'MULTUP' : 'MULTDOWN';
    const counters = [...this.trades.values()].filter(
      t => t.symbol === symbol && t.contractType === counterType && !t.closing
    );
    if (counters.length === 0) return;
    console.log(
      `[PreSpike] PRE_SPIKE on ${symbol} — closing ${counters.length}` +
      ` counter-spike ${counterType} trade(s) early`
    );
    for (const trade of counters) {
      await this._closeContract(trade, 'Pre-spike early exit (85% alert)');
    }
  }

  // ── PRE-SPIKE: open with-spike pre-position ───────────────
  async openPreSpikePosition(symbol, balance) {
    const instrumentConfig = this.strategy.config.INSTRUMENTS?.[symbol];
    if (!instrumentConfig) return;

    if (this._preSpikeOpen.has(symbol)) {
      console.log(`[PreSpike] Already have pre-spike position on ${symbol} — skip`);
      return;
    }

    const contractType = symbol.includes('CRASH') ? 'MULTDOWN' : 'MULTUP';

    const existing = [...this.trades.values()].find(
      t => t.symbol === symbol && t.contractType === contractType && !t.closing
    );
    if (existing) {
      console.log(`[PreSpike] Already have ${contractType} on ${symbol} — skip`);
      return;
    }

    const check = this.risk.canTrade(balance, this.trades.size);
    if (!check.ok) {
      console.log(`[PreSpike] ${check.reason} — cannot open pre-spike position`);
      return;
    }

    const stake = this.risk.getStake(balance, instrumentConfig);
    const sl    = parseFloat((stake * (instrumentConfig.sl_pct || 0.10)).toFixed(2));
    const tp    = parseFloat((stake * (instrumentConfig.spike_tp_pct || 0.15)).toFixed(2));

    console.log(
      `\n[PreSpike] Opening WITH-SPIKE pre-position on ${symbol}` +
      ` | ${contractType} | stake $${stake} | TP $${tp} | SL $${sl}`
    );

    try {
      const result = await this.client.buyContract({
        symbol,
        contractType,
        stake,
        multiplier:  instrumentConfig.multiplier,
        takeProfit:  tp,
        stopLoss:    sl,
      });

      const trade = {
        contractId:     String(result.contract_id),
        symbol,
        contractType,
        stake,
        openTime:       Date.now(),
        reason:         `${symbol}: Pre-spike position (awaiting spike TP $${tp})`,
        withSpike:      true,
        preSpike:       true,
        currentPnL:     0,
        peakPnL:        0,
        trailingActive: false,
        trailingStop:   -sl,
        closing:        false,
      };

      this.trades.set(trade.contractId, trade);
      this.stats.opened++;
      this._preSpikeOpen.add(symbol);

      this.client.subscribeContract(trade.contractId).catch((err) => {
        console.error(`[Monitor] Subscribe failed ${trade.contractId}: ${err.message}`);
      });

      this.emit('opened', trade);
      return trade;

    } catch (err) {
      console.error(`[PreSpike] Open failed on ${symbol}: ${err.message}`);
      return null;
    }
  }

  // ── Safety net on actual spike ─────────────────────────────
  async closeSpikeVictims(symbol) {
    const counterType = symbol.includes('CRASH') ? 'MULTUP' : 'MULTDOWN';
    const victims = [...this.trades.values()].filter(
      t => t.symbol === symbol && t.contractType === counterType && !t.closing
    );
    if (victims.length === 0) {
      this._preSpikeOpen.delete(symbol);
      return;
    }
    console.log(
      `[SpikeGuard] Spike on ${symbol} — closing ${victims.length}` +
      ` remaining counter-spike trade(s) (safety net)`
    );
    for (const trade of victims) {
      await this._closeContract(trade, 'Spike guard safety net');
    }
    this._preSpikeOpen.delete(symbol);
  }

  // ── Strategy exits ─────────────────────────────────────────
  async checkSmartExits(tickBuffers) {
    for (const [, trade] of this.trades) {
      if (trade.closing) continue;
      if (trade.preSpike) continue;
      const ticks = tickBuffers[trade.symbol];
      if (!ticks || ticks.length < 10) continue;
      const exit = this.strategy.shouldExit(trade, ticks);
      if (exit && exit.exit) {
        console.log(`[SmartExit] ${exit.reason} — closing ${trade.symbol}`);
        await this._closeContract(trade, exit.reason);
      }
    }
  }

  // ── Close a contract ────────────────────────────────────────
  async _closeContract(trade, reason) {
    if (trade.closing || !this.trades.has(trade.contractId)) return;
    trade.closing = true;
    try {
      const result   = await this.client.sellContract(trade.contractId);
      const soldFor  = parseFloat(result?.sold_for);
      const finalPnL = !isNaN(soldFor) ? soldFor - trade.stake : (trade.currentPnL || 0);
      this._recordClose(trade, finalPnL, reason);
    } catch (err) {
      console.error(`[Trade] Close failed ${trade.contractId}: ${err.message}`);
      trade.closing = false;
    }
  }

  _recordClose(trade, finalPnL, reason) {
    if (!this.trades.has(trade.contractId)) return;
    this.trades.delete(trade.contractId);
    if (trade.preSpike) this._preSpikeOpen.delete(trade.symbol);
    this.stats.closed++;
    this.stats.totalPnL += finalPnL;
    const sign = finalPnL >= 0 ? '+' : '';
    console.log(
      `[Trade] CLOSED ${trade.symbol} (${reason}) | P&L: ${sign}$${finalPnL.toFixed(2)} | Session: ${sign}$${this.stats.totalPnL.toFixed(2)}`
    );
    this.strategy.recordTradeResult(trade.symbol, finalPnL);
    this.emit('closed', { ...trade, finalPnL });
  }

  sync(serverContracts) {
    const serverIds = new Set(serverContracts.map((c) => String(c.contract_id)));
    for (const [id, trade] of this.trades) {
      if (!serverIds.has(String(id))) {
        this._recordClose(trade, trade.currentPnL || 0, 'Sync detected close');
      }
    }
  }

  async closeAll() {
    for (const [, trade] of this.trades) {
      await this._closeContract(trade, 'Shutdown');
    }
  }

  openCount() { return this.trades.size; }
  getStats()  { return { ...this.stats, currentOpen: this.trades.size }; }

  printSummary() {
    const s    = this.getStats();
    const sign = s.totalPnL >= 0 ? '+' : '';
    console.log(
      `[Bot] Summary | Open: ${s.currentOpen} | ` +
      `Closed: ${s.closed} | Session P&L: ${sign}${s.totalPnL.toFixed(2)}`
    );
  }
}

module.exports = TradeManager;
