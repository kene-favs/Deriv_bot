// ============================================================
//  AutoCycle Deriv Bot — Technical Indicators  v2
//
//  Fix in detectSpike:
//    Old: compared first vs last tick in window (misses spikes
//         that partially recovered within the 3-tick window)
//    New: uses max single-tick move inside window so a spike
//         that happened and slightly recovered is still caught
// ============================================================

function calcSMA(prices, period) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcEMA(prices, period) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return null;
  const changes = [];
  for (let i = prices.length - period - 1; i < prices.length - 1; i++) {
    changes.push(prices[i + 1] - prices[i]);
  }
  const gains  = changes.filter(c => c > 0).reduce((a, b) => a + b, 0) / period;
  const losses = changes.filter(c => c < 0).map(Math.abs).reduce((a, b) => a + b, 0) / period;
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}

function calcBB(prices, period = 20, stdMult = 2) {
  if (prices.length < period) return null;
  const slice    = prices.slice(-period);
  const mean     = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / period;
  const std      = Math.sqrt(variance);
  return { upper: mean + stdMult * std, middle: mean, lower: mean - stdMult * std, std };
}

function emaCrossover(prices, fastPeriod, slowPeriod) {
  if (prices.length < slowPeriod + 2) return 'NEUTRAL';
  const currFast = calcEMA(prices, fastPeriod);
  const currSlow = calcEMA(prices, slowPeriod);
  const prevFast = calcEMA(prices.slice(0, -1), fastPeriod);
  const prevSlow = calcEMA(prices.slice(0, -1), slowPeriod);
  if (!currFast || !currSlow || !prevFast || !prevSlow) return 'NEUTRAL';
  if (prevFast <= prevSlow && currFast > currSlow) return 'BULLISH';
  if (prevFast >= prevSlow && currFast < currSlow) return 'BEARISH';
  return 'NEUTRAL';
}

// ── Spike Detector ────────────────────────────────────────────
//  Finds sudden large moves vs recent baseline.
//
//  FIX: Now uses the MAX single-tick move within the recent window
//  instead of comparing first-to-last.
//
//  Why it matters: On Boom/Crash indices a spike is ONE big tick.
//  If that spike happened and price slightly recovered within the
//  3-tick window, first-to-last shows a small net move and the
//  spike gets MISSED. Max-tick catches it every time.
//
function detectSpike(prices, threshold = 4, lookback = 10, recentWindow = 3) {
  if (prices.length < lookback + recentWindow) return { spike: false, direction: null, ratio: 0 };

  const recent   = prices.slice(-recentWindow);
  const baseline = prices.slice(-(lookback + recentWindow), -recentWindow);

  // ── FIXED: find the largest single-tick move in recent window ──
  let maxMove      = 0;
  let moveDirection = null;
  for (let i = 1; i < recent.length; i++) {
    const move = recent[i] - recent[i - 1];
    if (Math.abs(move) > maxMove) {
      maxMove       = Math.abs(move);
      moveDirection = move > 0 ? 'UP' : 'DOWN';
    }
  }

  // Average single-tick move in baseline (normal volatility reference)
  const baselineMoves = [];
  for (let i = 1; i < baseline.length; i++) {
    baselineMoves.push(Math.abs(baseline[i] - baseline[i - 1]));
  }
  const avgBaselineMove = baselineMoves.length
    ? baselineMoves.reduce((a, b) => a + b, 0) / baselineMoves.length
    : 0;

  if (avgBaselineMove === 0) return { spike: false, direction: null, ratio: 0 };

  const ratio   = maxMove / avgBaselineMove;
  const isSpike = ratio >= threshold;

  return {
    spike:     isSpike,
    direction: isSpike ? moveDirection : null,
    ratio,
  };
}

function momentum(prices, period = 10) {
  if (prices.length < period + 1) return 0;
  return prices[prices.length - 1] - prices[prices.length - 1 - period];
}

module.exports = { calcSMA, calcEMA, calcRSI, calcBB, emaCrossover, detectSpike, momentum };
