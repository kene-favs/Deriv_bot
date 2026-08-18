// ============================================================
//  AutoCycle Deriv Bot — Configuration  v2.5
//
//  KEY FIXES vs v2.1:
//    • CRASH instruments = MULTUP  (ride UP between crash spikes)
//    • BOOM  instruments = MULTDOWN (ride DOWN between boom spikes)
//    • CRASH500 / BOOM500 multiplier corrected to 100 (min per Deriv API)
//    • R_25 and R_50 removed (Deriv min multipliers too high for fixed SL)
//    • R_75 removed (user request)
//    • TIERS array added (required by risk-manager.js)
//    • PORTFOLIO_SYNC_MS = 10 s (was 30 s)
// ============================================================

module.exports = {
  // --- Account ---
  TOKEN:   'PASTE_YOUR_TOKEN_HERE',   // <-- replace with your Deriv API token
  APP_ID:  1089,
  WS_URL:  'wss://ws.binaryws.com/websockets/v3',

  // --- Instruments ---
  INSTRUMENTS: {

    // ── CRASH 1000 ─────────────────────────────────────────
    // Strategy: ride UPWARD momentum between crash spikes
    CRASH1000: {
      type:           'CRASH',
      contractType:   'MULTUP',       // UP: momentum between spikes
      multiplier:     100,
      maxPerSymbol:   1,              // Never stack — spike risk
      ma_period:      20,
      rsi_period:     14,
      rsiOversold:    35,             // Enter when oversold (after small dip)
      tp_pct:         0.04,
      sl_pct:         0.02,
      spikeThreshold: 4,
      postSpikeWait:  5000,
    },

    // ── BOOM 1000 ──────────────────────────────────────────
    // Strategy: ride DOWNWARD momentum between boom spikes
    BOOM1000: {
      type:           'BOOM',
      contractType:   'MULTDOWN',     // DOWN: momentum between spikes
      multiplier:     100,
      maxPerSymbol:   1,
      ma_period:      20,
      rsi_period:     14,
      rsiOverbought:  65,             // Enter when overbought (after small rise)
      tp_pct:         0.04,
      sl_pct:         0.02,
      spikeThreshold: 4,
      postSpikeWait:  5000,
    },

    // ── CRASH 500 ──────────────────────────────────────────
    CRASH500: {
      type:           'CRASH',
      contractType:   'MULTUP',       // UP: same momentum logic as CRASH1000
      multiplier:     100,            // FIXED: Deriv API minimum is 100 (was 50)
      maxPerSymbol:   1,
      ma_period:      20,
      rsi_period:     14,
      rsiOversold:    32,
      tp_pct:         0.04,
      sl_pct:         0.02,
      spikeThreshold: 3,
      postSpikeWait:  4000,
    },

    // ── BOOM 500 ───────────────────────────────────────────
    BOOM500: {
      type:           'BOOM',
      contractType:   'MULTDOWN',     // DOWN: same momentum logic as BOOM1000
      multiplier:     100,            // FIXED: Deriv API minimum is 100 (was 50)
      maxPerSymbol:   1,
      ma_period:      20,
      rsi_period:     14,
      rsiOverbought:  68,
      tp_pct:         0.04,
      sl_pct:         0.02,
      spikeThreshold: 3,
      postSpikeWait:  4000,
    },

  },

  // --- Risk / Stake Tiers ---
  // Used by risk-manager.js getTier() — required, do not remove
  TIERS: [
    { minBalance:    2, maxBalance:  19.99,  maxTrades: 2, stakePct: 0.05 },
    { minBalance:   20, maxBalance:  29.99,  maxTrades: 3, stakePct: 0.05 },
    { minBalance:   30, maxBalance:  49.99,  maxTrades: 4, stakePct: 0.05 },
    { minBalance:   50, maxBalance:  99.99,  maxTrades: 5, stakePct: 0.06 },
    { minBalance:  100, maxBalance: 199.99,  maxTrades: 6, stakePct: 0.07 },
    { minBalance:  200, maxBalance: 499.99,  maxTrades: 7, stakePct: 0.07 },
    { minBalance:  500, maxBalance: 999999,  maxTrades: 8, stakePct: 0.08 },
  ],

  MIN_STAKE: 1,

  // --- Tick / Timing ---
  TICK_HISTORY:      150,
  SCAN_INTERVAL_MS:  1000,
  PORTFOLIO_SYNC_MS: 10000,   // Sync every 10 s (was 30 s)
  ENTRY_COOLDOWN_MS: 10000,
};
