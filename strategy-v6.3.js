// ============================================================
//  AutoCycle Deriv Bot — Strategy Engine  v6.2
//
//  COUNTER-SPIKE BLOCK — 3 layers:
//   POST_SPIKE  (0–300 ticks after spike): block counter-spike
//               Catches rapid back-to-back spikes.
//   EARLY_ALERT (50%+ ticks): block counter-spike entries
//   PRE_SPIKE   (85%+ ticks): block ALL entries on symbol
//
//  Counter-spike = CRASH+MULTUP or BOOM+MULTDOWN
//  EVERYTHING ELSE UNCHANGED: TP, trailing stop, momentum, cooldowns
// ============================================================

const SPIKE_COOLDOWN_MS = 15000;
const MOMENTUM_EXIT_MS  = 8000;
const SIGNAL_EXIT_MS    = 20000;

const spikeTracker = require('./spike-tracker');

let AIScorer;
try {
  AIScorer = require('./ai-scorer');
} catch (_) {
  AIScorer = class {
    isAllowed()    { return true; }
    recordResult() {}
  };
  console.warn('[Strategy] ai-scorer.js not found — running without adaptive scoring');
}

class Strategy {
  constructor(config) {
    this.config     = config;
    this.aiScorer   = new AIScorer();
    this.lastEntry  = {};
    this.lastSpike  = {};
    this.globalLast = 0;
  }

  _hasSpike(ticks) {
    if (ticks.length < 6) return false;
    const sample = ticks.slice(-10);
    const moves  = [];
    for (let i = 1; i < sample.length; i++) moves.push(Math.abs(sample[i] - sample[i - 1]));
    const avg      = moves.reduce((a, b) => a + b, 0) / moves.length || 0;
    const lastMove = Math.abs(ticks[ticks.length - 1] - ticks[ticks.length - 2]);
    if (avg > 0 && lastMove > avg * 3) return true;
    if (ticks.length >= 3) {
      const m1 = ticks[ticks.length - 1] - ticks[ticks.length - 2];
      const m2 = ticks[ticks.length - 2] - ticks[ticks.length - 3];
      if (Math.sign(m1) !== Math.sign(m2) && Math.abs(m1) > avg * 2) return true;
    }
    return false;
  }

  _momentum(ticks) {
    if (!ticks || ticks.length < 10) return null;
    const last10 = ticks.slice(-10);
    const last3  = ticks.slice(-3);
    let up = 0, dn = 0, net = 0;
    for (let i = 1; i < last10.length; i++) {
      const d = last10[i] - last10[i - 1];
      if (d > 0) { up++; net += d; }
      if (d < 0) { dn++; net += d; }
    }
    let up3 = 0, dn3 = 0;
    for (let i = 1; i < last3.length; i++) {
      if (last3[i] > last3[i - 1]) up3++;
      if (last3[i] < last3[i - 1]) dn3++;
    }
    if (up >= 6 && net > 0 && up3 >= 2) return 'MULTUP';
    if (dn >= 6 && net < 0 && dn3 >= 2) return 'MULTDOWN';
    return null;
  }

  analyze(symbol, ticks, openByType = {}) {
    const none = (r) => ({ action: 'NONE', contractType: null, reason: r });
    if (!ticks || ticks.length < 10) return none('Warming up...');

    const now  = Date.now();
    const mode = spikeTracker.getMode(symbol);

    // ── Gate 1: Spike cooldown (strategy-level) ───────────────
    if (this._hasSpike(ticks)) this.lastSpike[symbol] = now;
    if (this.lastSpike[symbol] && now - this.lastSpike[symbol] < SPIKE_COOLDOWN_MS) {
      const s = Math.ceil((SPIKE_COOLDOWN_MS - (now - this.lastSpike[symbol])) / 1000);
      return none(`${symbol}: spike cooldown ${s}s`);
    }

    // ── Gate 2: PRE_SPIKE / SPIKE — all entries blocked ───────
    if (mode === 'PRE_SPIKE' || mode === 'SPIKE') {
      return none(`${symbol}: ${mode} — entries paused`);
    }

    // ── Gate 3: Momentum signal ───────────────────────────────
    const signal = this._momentum(ticks);
    if (!signal) return none(`${symbol}: no momentum`);

    // ── Gate 4: Spike zone — ALL entries paused ─────────────────
    //  POST_SPIKE  = within 300 ticks of last spike
    //  EARLY_ALERT = 50%+ ticks in cycle
    //  We don't try to catch spikes — wait for NORMAL to resume
    if (spikeTracker.isCounterBlocked(symbol)) {
      const count = spikeTracker.getTickCount(symbol);
      const avg   = spikeTracker.getAverage(symbol);
      return none(
        `${symbol}: ${mode} (${count}/${avg}) — spike zone, all entries paused`
      );
    }

    // ── Gate 5: AI gate ───────────────────────────────────────
    if (!this.aiScorer.isAllowed(symbol)) return none(`${symbol}: AI blocked`);

    // ── Gate 6: Per-symbol cooldown ───────────────────────────
    if (this.lastEntry[symbol] && now - this.lastEntry[symbol] < 60000)
      return none(`${symbol}: cooldown`);

    // ── Gate 7: Global duplicate prevention ──────────────────
    if (now - this.globalLast < 5000) return none('Global cooldown');

    return {
      action:       signal === 'MULTUP' ? 'BUY' : 'SELL',
      contractType: signal,
      reason:       `${symbol}: momentum ${signal}`,
    };
  }

  shouldExit(trade, ticks) {
    if (!ticks || ticks.length < 8) return { exit: false };
    const dir   = trade.contractType;
    const ageMs = Date.now() - (trade.openTime || 0);

    if (ageMs >= MOMENTUM_EXIT_MS) {
      const last7 = ticks.slice(-7);
      let upC = 0, dnC = 0;
      for (let i = 1; i < last7.length; i++) {
        if (last7[i] > last7[i - 1]) upC++;
        if (last7[i] < last7[i - 1]) dnC++;
      }
      if (dir === 'MULTUP'   && dnC >= 6) return { exit: true, reason: 'Momentum reversed down 6/7' };
      if (dir === 'MULTDOWN' && upC >= 6) return { exit: true, reason: 'Momentum reversed up 6/7' };
    }

    if (ageMs >= SIGNAL_EXIT_MS) {
      const rev = this._momentum(ticks);
      if (dir === 'MULTUP'   && rev === 'MULTDOWN') return { exit: true, reason: 'Signal flipped to MULTDOWN' };
      if (dir === 'MULTDOWN' && rev === 'MULTUP')   return { exit: true, reason: 'Signal flipped to MULTUP' };
    }

    return { exit: false };
  }

  markEntry(symbol) {
    const now = Date.now();
    this.lastEntry[symbol] = now;
    this.globalLast        = now;
  }

  recordTradeResult(symbol, pnl) {
    this.aiScorer.recordResult({ symbol, pnl });
  }
}

module.exports = Strategy;
