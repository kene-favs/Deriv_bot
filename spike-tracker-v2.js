// ============================================================
//  AutoCycle Deriv Bot — Spike Tracker  v3.1
//
//  SPIKE PROTECTION MODEL (no pre-spike positions):
//
//  NORMAL (0–50%):
//    Trade freely in both directions (MULTUP & MULTDOWN).
//
//  EARLY_ALERT (50%+):
//    Block ALL new entries. Close any open counter-spike
//    trades immediately (bot.js onModeChange handler).
//
//  PRE_SPIKE (85%+):
//    Safety net — counter trades should already be closed.
//    No new trades opened. Waiting for spike to fire.
//
//  SPIKE:
//    Spike detected. 5-second window, then POST_SPIKE.
//
//  POST_SPIKE (symbol-specific lockout):
//    20% of each symbol's average spike interval.
//    CRASH1000/BOOM1000 → 200 ticks (~3 min)
//    CRASH500 /BOOM500  → 100 ticks (~1.5 min)
//    After lockout expires, returns to NORMAL (0%) and
//    trading resumes.  FIX: old 300-tick constant caused
//    CRASH500/BOOM500 to jump straight to EARLY_ALERT (60%)
//    on lockout expiry — they NEVER got a NORMAL window.
//
//  TRADING WINDOWS PER CYCLE:
//    CRASH1000/BOOM1000: 300 ticks (20%→50%) ~5 min/cycle
//    CRASH500 /BOOM500 : 150 ticks (20%→50%) ~2.5 min/cycle
//
//  TICK AVERAGES:
//    CRASH1000 / BOOM1000 → 1 spike per ~1000 ticks (~17 min)
//    CRASH500  / BOOM500  → 1 spike per ~500 ticks  (~8 min)
// ============================================================

'use strict';

const AVERAGES = {
  CRASH1000: 1000,
  CRASH500:  500,
  BOOM1000:  1000,
  BOOM500:   500,
};

const L1_THRESHOLD           = 0.50;   // 50%  → EARLY_ALERT
const L2_THRESHOLD           = 0.85;   // 85%  → PRE_SPIKE
const SPIKE_MODE_DURATION_MS = 5000;   // ms to stay in SPIKE mode

// POST_SPIKE lockout = 20% of each symbol's average spike interval.
// BUG FIX: old constant 300 caused CRASH500/BOOM500 to exit POST_SPIKE
// at 60% (300/500) → jumping straight to EARLY_ALERT, never NORMAL.
const POST_SPIKE_LOCKOUT_TICKS = {
  CRASH1000: 200,   // 20% of 1000 → exits at 20%, NORMAL window 20–50% (300t)
  CRASH500:  100,   // 20% of  500 → exits at 20%, NORMAL window 20–50% (150t)
  BOOM1000:  200,
  BOOM500:   100,
};

const SPIKE_MIN_MOVE = {
  CRASH1000: 3.0,
  CRASH500:  2.0,
  BOOM1000:  3.0,
  BOOM500:   2.0,
};

class SpikeTracker {
  constructor() {
    this._state = {};
    this._cb    = null;
    for (const sym of Object.keys(AVERAGES)) {
      this._state[sym] = {
        tickCount:         0,   // ticks since last spike
        ticksSinceSpike:   0,   // same counter (for post-spike lockout)
        lastPrice:         null,
        mode:              'NORMAL',
        lastSpikeMs:       0,
        lastSpikeDir:      null,
      };
    }
  }

  onModeChange(fn) { this._cb = fn; }

  _setMode(symbol, newMode) {
    const s = this._state[symbol];
    if (s.mode === newMode) return;
    const old = s.mode;
    s.mode = newMode;
    console.log(`[SpikeTracker] ${symbol}: ${old} → ${newMode}`);
    if (this._cb) this._cb(symbol, old, newMode);
  }

  onTick(symbol, price) {
    const s = this._state[symbol];
    if (!s) return null;

    const avg     = AVERAGES[symbol];
    const minMove = SPIKE_MIN_MOVE[symbol];

    // ── Spike detection ──────────────────────────────────────
    let spikeDir = null;
    if (s.lastPrice !== null) {
      const move = price - s.lastPrice;
      if (symbol.includes('CRASH') && move <= -minMove) spikeDir = 'DOWN';
      else if (symbol.includes('BOOM') && move >= minMove)  spikeDir = 'UP';
    }
    s.lastPrice = price;

    if (spikeDir) {
      const prev = s.tickCount;
      s.tickCount        = 0;
      s.ticksSinceSpike  = 0;
      s.lastSpikeMs      = Date.now();
      s.lastSpikeDir     = spikeDir;
      const lockout = POST_SPIKE_LOCKOUT_TICKS[symbol] || 200;
      console.log(
        `[SpikeTracker] 🔥 SPIKE ${spikeDir} on ${symbol}` +
        ` | tick ${prev}/${avg} (${Math.round(prev / avg * 100)}%)` +
        ` | POST_SPIKE lockout starts (${lockout} ticks)`
      );
      this._setMode(symbol, 'SPIKE');
      return spikeDir;
    }

    // Normal tick
    s.tickCount++;
    s.ticksSinceSpike++;

    // ── Mode transitions ─────────────────────────────────────
    if (s.mode === 'SPIKE') {
      if (Date.now() - s.lastSpikeMs > SPIKE_MODE_DURATION_MS) {
        // Transition to POST_SPIKE lockout
        this._setMode(symbol, 'POST_SPIKE');
      }
      return null;
    }

    const pct = s.tickCount / avg;

    if (s.mode === 'POST_SPIKE') {
      const lockout = POST_SPIKE_LOCKOUT_TICKS[symbol] || 200;
      if (s.ticksSinceSpike >= lockout) {
        // Lockout expired — check if we're already in alert zone
        if (pct >= L2_THRESHOLD) {
          this._setMode(symbol, 'PRE_SPIKE');
        } else if (pct >= L1_THRESHOLD) {
          this._setMode(symbol, 'EARLY_ALERT');
        } else {
          this._setMode(symbol, 'NORMAL');
        }
      }
      // Stay in POST_SPIKE until lockout expires
      return null;
    }

    // NORMAL / EARLY_ALERT / PRE_SPIKE transitions
    if (pct >= L2_THRESHOLD) {
      this._setMode(symbol, 'PRE_SPIKE');
    } else if (pct >= L1_THRESHOLD) {
      this._setMode(symbol, 'EARLY_ALERT');
    } else {
      this._setMode(symbol, 'NORMAL');
    }

    return null;
  }

  getMode(symbol)      { return this._state[symbol]?.mode || 'NORMAL'; }
  getTickCount(symbol) { return this._state[symbol]?.tickCount || 0; }
  getAverage(symbol)   { return AVERAGES[symbol] || 1000; }

  // Returns true if counter-spike entries should be blocked
  isCounterBlocked(symbol) {
    const m = this.getMode(symbol);
    return m === 'POST_SPIKE' || m === 'EARLY_ALERT' || m === 'PRE_SPIKE' || m === 'SPIKE';
  }

  isPreSpike(symbol) { return this.getMode(symbol) === 'PRE_SPIKE'; }
}

module.exports = new SpikeTracker();
