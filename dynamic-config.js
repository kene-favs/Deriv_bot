// dynamic-config.js  v8
// Aggressive tiered stake scaling — mirrors the logic in bot.js v8.
// Import this anywhere you need live param calculations outside bot.js.
//
// Stake tiers:
//   < $20   → 50% of balance  (min $1)
//   < $150  → 45% of balance
//   < $400  → 35% of balance
//   < $1000 → 25% of balance
//   < $3000 → 15% of balance
//   $3000+  → 10% of balance  (max $200)
//
// TP  = 4% of stake
// SL  = 3.33% of stake
// maxTrades scales from 2 → 16

function getDynamicParams(balance) {
  let stake, maxTrades;

  if      (balance <   20) { stake = Math.floor(balance * 0.50); maxTrades = 2;  }
  else if (balance <  150) { stake = Math.floor(balance * 0.45); maxTrades = 4;  }
  else if (balance <  400) { stake = Math.floor(balance * 0.35); maxTrades = 6;  }
  else if (balance < 1000) { stake = Math.floor(balance * 0.25); maxTrades = 8;  }
  else if (balance < 3000) { stake = Math.floor(balance * 0.15); maxTrades = 12; }
  else                     { stake = Math.floor(balance * 0.10); maxTrades = 16; }

  stake = Math.max(1, Math.min(200, stake));

  const tp           = Math.max(0.01, parseFloat((stake * 0.04).toFixed(2)));
  const sl           = Math.max(0.01, parseFloat((stake * 0.0333).toFixed(2)));
  const maxPerSymbol = Math.max(1, Math.floor(maxTrades / 4));

  return { stake, tp, sl, maxTrades, maxPerSymbol };
}

// Quick reference table (for logging / UI display)
function getParamsSummary(balance) {
  const p = getDynamicParams(balance);
  return `Bal=$${balance.toFixed(2)}  Stake=$${p.stake}  TP=$${p.tp}  SL=$${p.sl}  MaxTrades=${p.maxTrades}`;
}

module.exports = { getDynamicParams, getParamsSummary };
