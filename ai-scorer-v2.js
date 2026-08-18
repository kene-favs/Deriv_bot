// ============================================================
//  AutoCycle Deriv Bot — AI Scorer  v2
//
//  v2 CHANGES (fixes score deadlock):
//  - MIN_AI_SCORE: 0.62 → 0.30
//      Old value caused a deadlock: spike losses drop score below
//      0.62, bot stops trading, score never recovers (needs wins
//      to recover but can't trade to get wins). 0.30 breaks the
//      deadlock and still protects against genuinely bad symbols.
//  - LOSS_DROP: 0.05 → 0.03
//      Spikes are now handled by spike-tracker protection, not
//      by the AI scorer. Reducing the penalty means a spike loss
//      costs 0.03 score instead of 0.05 — far less likely to
//      trigger a lockout from normal market behaviour.
//  - WIN_BUMP: 0.03 → 0.05
//      Score now recovers faster after wins, balancing the
//      asymmetry of crash/boom trading where losses can cluster.
// ============================================================

const MIN_SCORE     = 0.0;
const MAX_SCORE     = 1.0;
const DEFAULT_SCORE = 0.65;
const WIN_BUMP      = 0.05;           // was 0.03 — recovers faster after wins
const LOSS_DROP     = 0.03;           // was 0.05 — spikes don't crater score as hard
const MIN_AI_SCORE  = 0.30;           // was 0.62 — breaks score deadlock
const BLOCK_STREAK  = 3;             // consecutive losses → temp block
const BLOCK_MS      = 2 * 60 * 1000; // 2 minutes

class AIScorer {
  constructor() {
    this._scores  = {};   // symbol → score (0–1)
    this._streak  = {};   // symbol → consecutive loss count
    this._blocked = {};   // symbol → block-until timestamp
  }

  // Return score for a symbol (default 0.65)
  score(symbol) {
    if (!(symbol in this._scores)) this._scores[symbol] = DEFAULT_SCORE;
    return this._scores[symbol];
  }

  // Is entry allowed for this symbol right now?
  isAllowed(symbol) {
    const now = Date.now();
    if (this._blocked[symbol] && now < this._blocked[symbol]) {
      const secs = Math.ceil((this._blocked[symbol] - now) / 1000);
      console.log(`[AIScorer] ⛔ ${symbol} blocked for ${secs}s (loss streak)`);
      return false;
    }
    const s = this.score(symbol);
    if (s < MIN_AI_SCORE) {
      console.log(`[AIScorer] ⛔ ${symbol} score too low (${s.toFixed(2)} < ${MIN_AI_SCORE})`);
      return false;
    }
    return true;
  }

  // Record a trade result — call after every close
  recordResult({ symbol, pnl }) {
    if (!(symbol in this._scores)) this._scores[symbol] = DEFAULT_SCORE;
    if (!(symbol in this._streak)) this._streak[symbol] = 0;

    if (pnl > 0) {
      // Win — raise score, reset streak
      this._scores[symbol] = Math.min(MAX_SCORE, this._scores[symbol] + WIN_BUMP);
      this._streak[symbol] = 0;
      console.log(`[AIScorer] ✅ ${symbol} score → ${this._scores[symbol].toFixed(2)} (win)`);
    } else {
      // Loss — drop score, increment streak
      this._scores[symbol] = Math.max(MIN_SCORE, this._scores[symbol] - LOSS_DROP);
      this._streak[symbol]++;
      console.log(`[AIScorer] ❌ ${symbol} score → ${this._scores[symbol].toFixed(2)} (loss, streak ${this._streak[symbol]})`);

      if (this._streak[symbol] >= BLOCK_STREAK) {
        this._blocked[symbol] = Date.now() + BLOCK_MS;
        this._streak[symbol]  = 0;  // reset after triggering block
        console.log(`[AIScorer] 🚫 ${symbol} BLOCKED for 2 min (${BLOCK_STREAK} consecutive losses)`);
      }
    }
  }
}

module.exports = AIScorer;
