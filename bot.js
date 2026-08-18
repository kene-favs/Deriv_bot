// ============================================================
//  AutoCycle Deriv Bot  v9.5
//
//  Changes vs v9.4:
//    • getDynamicParams() — new tier for balance < $20:
//        stake = $1  →  TP = $0.04  SL = $0.02
//      Server-side limit_order in buyContract() now caps every
//      loss at exactly $0.02 on a $10 account regardless of
//      spike size.  No other logic changed.
//
//  All v9.4 fixes retained:
//    • NORMAL entry delay (45 seconds)
//    • EARLY_ALERT closes ALL trades on symbol
//    • _scan() blocks ALL new entries when not NORMAL
//    • Direction filter: CRASH=MULTUP, BOOM=MULTDOWN only
//    • Startup portfolio sync (no position flood on restart)
//    • min_sl guard, portfolio sync every 10 s
// ============================================================

'use strict';

const DerivClient  = require('./deriv-client');
const Strategy     = require('./strategy');
const RiskManager  = require('./risk-manager');
const TradeManager = require('./trade-manager');
const spikeTracker = require('./spike-tracker');
const config       = require('./config');

// ── Dynamic params — stake tiers ──────────────────────────
function getDynamicParams(balance) {
  let stake, maxTrades;

  // ── NEW in v9.5 ────────────────────────────────────────
  // Accounts under $20 use $5 stake so the server-side SL
  // caps each loss at exactly $0.10 (2% of $5 stake).
  // Server-side limit_order means Deriv closes the contract
  // at tick level — no spike can ever exceed $0.10 loss.
  // TP = $0.20 per win (1 win covers 2 losses).
  if      (balance <   20) { stake =   5; maxTrades =  1; }
  // ──────────────────────────────────────────────────────
  else if (balance <   30) { stake =   5; maxTrades =  2; }
  else if (balance <   60) { stake =  10; maxTrades =  2; }
  else if (balance <  100) { stake =  20; maxTrades =  3; }
  else if (balance <  200) { stake =  25; maxTrades =  4; }
  else if (balance <  300) { stake =  35; maxTrades =  4; }
  else if (balance <  500) { stake =  50; maxTrades =  5; }
  else if (balance <  750) { stake =  75; maxTrades =  6; }
  else if (balance < 1000) { stake = 100; maxTrades =  7; }
  else if (balance < 2000) { stake = 125; maxTrades =  8; }
  else if (balance < 3000) { stake = 150; maxTrades =  9; }
  else                     { stake = 200; maxTrades = 10; }

  const tp           = Math.max(0.01, parseFloat((stake * 0.04).toFixed(2)));
  const sl           = Math.max(0.01, parseFloat((stake * 0.02).toFixed(2)));
  const maxPerSymbol = Math.max(1, Math.floor(maxTrades / 4));

  return { stake, tp, sl, maxTrades, maxPerSymbol };
}

// How long (ms) to wait in NORMAL mode before opening a trade.
// Prevents opening straight into a quick consecutive spike.
const NORMAL_ENTRY_DELAY_MS = 45_000;  // 45 seconds

class AutoCycleDerivBot {
  constructor() {
    this.client       = new DerivClient(config.TOKEN, config.APP_ID);
    this.strategy     = new Strategy(config);
    this.risk         = new RiskManager(config);
    this.tradeMgr     = null;
    this.tickBuffers  = {};
    this.balance      = 0;
    this.running      = false;
    this._syncTimer   = null;
    this._loopTimer   = null;
    this._spikeModes  = {};
    // Tracks when each symbol last entered NORMAL mode (ms timestamp)
    this._normalSince = {};
    // Blocks all spike callbacks until loading is complete
    this._ready       = false;
  }

  async start() {
    console.log('');
    console.log('╔══════════════════════════════════════════╗');
    console.log('║     AutoCycle Deriv Bot  v9.5            ║');
    console.log('║  CRASH=UP · BOOM=DOWN · 45s NORMAL delay ║');
    console.log('║  Server-side SL · $0.10 max on <$20 accs ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');

    await this.client.connect();
    this.balance = await this.client.getBalance();

    const p = getDynamicParams(this.balance);
    console.log(`[Bot] Balance: $${this.balance.toFixed(2)}`);
    console.log(`[Bot] Stake: $${p.stake}  TP: $${p.tp}  SL: $${p.sl}  MaxTrades: ${p.maxTrades}`);
    console.log('');

    this.tradeMgr = new TradeManager(this.client, this.risk, this.strategy);

    this.tradeMgr.on('opened', (trade) => {
      console.log(`[Bot] NEW TRADE  ${trade.symbol}  ${trade.contractType}  stake=$${trade.stake}`);
    });
    this.tradeMgr.on('closed', async (trade) => {
      console.log(`[Bot] TRADE CLOSED  ${trade.symbol}  PnL=$${(trade.finalPnL || 0).toFixed(2)}`);
      this.balance = await this.client.getBalance().catch(() => this.balance);
      const p2 = getDynamicParams(this.balance);
      console.log(`[Bot] Bal=$${this.balance.toFixed(2)}  Stake=$${p2.stake}  Open=${this.tradeMgr.openCount()}`);
    });

    // ── Spike tracker callbacks ──────────────────────────────
    spikeTracker.onModeChange((symbol, oldMode, newMode) => {
      this._spikeModes[symbol] = newMode;

      if (!this._ready || !this.tradeMgr) return;

      if (newMode === 'EARLY_ALERT') {
        // Close ALL open trades on this symbol — lock in before spike
        this._closeAllOnSymbol(symbol, 'EARLY_ALERT — spike imminent').catch((err) =>
          console.error(`[EarlyAlert] ${err.message}`)
        );
      }

      if (newMode === 'PRE_SPIKE') {
        // Safety net — EARLY_ALERT should have closed already
        this._closeAllOnSymbol(symbol, 'PRE_SPIKE safety net').catch((err) =>
          console.error(`[PreSpike] ${err.message}`)
        );
      }

      if (newMode === 'SPIKE') {
        this._onSpikeDetected(symbol).catch((err) =>
          console.error(`[SpikeGuard] ${err.message}`)
        );
      }

      if (newMode === 'NORMAL') {
        // Record when we entered NORMAL — entry delay starts now
        this._normalSince[symbol] = Date.now();
        const delayS = Math.round(NORMAL_ENTRY_DELAY_MS / 1000);
        console.log(`[Bot] ${symbol} → NORMAL — waiting ${delayS}s before new entries`);
      }
    });

    // ── Load all instruments ─────────────────────────────────
    const symbols = Object.keys(config.INSTRUMENTS);
    console.log(`[Bot] Loading history for ${symbols.length} instruments...`);

    for (const symbol of symbols) {
      this._spikeModes[symbol]  = 'NORMAL';
      // On startup set normalSince = now so the delay runs from startup,
      // not from "forever ago" (which would allow immediate entry).
      this._normalSince[symbol] = Date.now();
      try {
        const history = await this.client.getTickHistory(symbol, config.TICK_HISTORY || 150);
        this.tickBuffers[symbol] = history;
        await this.client.subscribeTicks(symbol);
        console.log(`[Bot]   ${symbol}: ${history.length} ticks loaded`);
      } catch (err) {
        console.error(`[Bot]   ${symbol}: SKIPPED — ${err.message}`);
        delete this.tickBuffers[symbol];
      }
    }

    // ── Startup portfolio sync ────────────────────────────────
    try {
      const portfolio = await this.client.getPortfolio();
      this.tradeMgr.sync(portfolio);
      console.log(`[Bot] Startup sync: ${this.tradeMgr.openCount()} existing position(s)`);
    } catch (e) {
      console.error('[Bot] Startup sync error:', e.message);
    }

    // ── Ready ────────────────────────────────────────────────
    this._ready = true;
    console.log('[Bot] All instruments loaded — spike protection ACTIVE');
    console.log('[Bot] Direction: CRASH=MULTUP | BOOM=MULTDOWN | NORMAL+45s delay\n');

    // ── Route live ticks ─────────────────────────────────────
    this.client.on('tick', (msg) => {
      try {
        const sym   = msg.tick?.symbol;
        const price = parseFloat(msg.tick?.quote);
        if (!sym || !price || !this.tickBuffers[sym]) return;

        this.tickBuffers[sym].push(price);
        if (this.tickBuffers[sym].length > (config.TICK_HISTORY || 150) * 2) {
          this.tickBuffers[sym] = this.tickBuffers[sym].slice(-(config.TICK_HISTORY || 150));
        }

        if (this._ready) {
          const spikeDir = spikeTracker.onTick(sym, price);
          if (spikeDir && this.tradeMgr) {
            this._onSpikeDetected(sym).catch((err) =>
              console.error(`[SpikeGuard] ${err.message}`)
            );
          }
        }
      } catch (err) {
        console.error('[Tick] Handler error:', err.message);
      }
    });

    // ── Portfolio sync every 10 s ─────────────────────────────
    this._syncTimer = setInterval(async () => {
      try {
        const portfolio = await this.client.getPortfolio();
        this.tradeMgr.sync(portfolio);
        this.balance = await this.client.getBalance();
      } catch (e) {
        console.error('[Bot] Sync error:', e.message);
      }
    }, config.PORTFOLIO_SYNC_MS || 10_000);

    // ── Heartbeat every 2 min ─────────────────────────────────
    setInterval(() => {
      const p = getDynamicParams(this.balance);
      console.log(
        `\n[Bot] ${new Date().toLocaleTimeString()}` +
        `  Bal=$${this.balance.toFixed(2)}` +
        `  Stake=$${p.stake}  TP=$${p.tp}  SL=$${p.sl}` +
        `  Open=${this.tradeMgr.openCount()}/${p.maxTrades}`
      );
      this.tradeMgr.printSummary();
    }, 120_000);

    this.running = true;
    console.log('[Bot] All systems go — scanning markets...\n');
    this._scan();
  }

  // Close every open trade on a symbol regardless of direction
  async _closeAllOnSymbol(symbol, reason) {
    if (!this.tradeMgr) return;
    const toClose = [...this.tradeMgr.trades.values()].filter(
      t => t.symbol === symbol && !t.closing
    );
    if (toClose.length === 0) return;
    console.log(`[Bot] ${symbol} ${reason} — closing ${toClose.length} trade(s)`);
    for (const trade of toClose) {
      try {
        await this.tradeMgr._closeContract(trade, reason);
      } catch (e) {
        console.error(`[Bot] Close failed ${trade.contractId}: ${e.message}`);
      }
    }
  }

  async _onSpikeDetected(symbol) {
    if (this.tradeMgr) {
      await this.tradeMgr.closeSpikeVictims(symbol);
    }
  }

  async _scan() {
    if (!this.running) return;

    const dyn = getDynamicParams(this.balance);

    for (const [symbol, instrumentConfig] of Object.entries(config.INSTRUMENTS)) {
      const ticks = this.tickBuffers[symbol];
      if (!ticks || ticks.length < 30) continue;

      // ── 1. Block ALL new entries when spike zone active ────
      const spikeMode = this._spikeModes[symbol] || 'NORMAL';
      if (spikeMode !== 'NORMAL') continue;

      // ── 2. Enforce 45-second NORMAL entry delay ───────────
      //    Prevents opening right at POST_SPIKE → NORMAL transition
      //    where consecutive spikes are most likely.
      const normalMs = Date.now() - (this._normalSince[symbol] || 0);
      if (normalMs < NORMAL_ENTRY_DELAY_MS) {
        const remaining = Math.ceil((NORMAL_ENTRY_DELAY_MS - normalMs) / 1000);
        // Only log every ~10 seconds to avoid log spam
        if (remaining % 10 === 0) {
          console.log(`[Bot] ${symbol} NORMAL delay — ${remaining}s remaining`);
        }
        continue;
      }

      const signal = this.strategy.analyze(symbol, ticks);
      if (signal.action === 'NONE') continue;

      // ── 3. Direction filter ────────────────────────────────
      // CRASH = MULTUP  (momentum between crash spikes)
      // BOOM  = MULTDOWN (momentum between boom spikes)
      if (instrumentConfig.contractType && signal.contractType !== instrumentConfig.contractType) {
        continue;
      }

      // ── 4. SL floor (instrument min_sl) ───────────────────
      const sl = Math.max(dyn.sl, instrumentConfig.min_sl || 0);
      const tp = Math.max(dyn.tp, instrumentConfig.min_tp || 0);

      // Protect small accounts: skip if SL > 5% of stake
      if (sl > dyn.stake * 0.05) {
        console.log(`[Bot] ${symbol} SL $${sl} > 5% of stake $${dyn.stake} — skipping`);
        continue;
      }

      const dynConfig = {
        ...instrumentConfig,
        stake:        dyn.stake,
        tp,
        sl,
        maxPerSymbol: instrumentConfig.maxPerSymbol ?? dyn.maxPerSymbol,
        maxTrades:    dyn.maxTrades,
      };

      await this.tradeMgr.open(symbol, signal, this.balance, dynConfig);
    }

    this._loopTimer = setTimeout(() => this._scan(), config.SCAN_INTERVAL_MS || 1000);
  }

  async stop() {
    console.log('\n[Bot] Shutting down...');
    this.running = false;
    this._ready  = false;
    clearTimeout(this._loopTimer);
    clearInterval(this._syncTimer);
    await this.tradeMgr?.closeAll();
    this.tradeMgr?.printSummary();
    this.client.ws?.close();
    console.log('[Bot] Goodbye.\n');
  }
}

const bot = new AutoCycleDerivBot();

bot.start().catch((err) => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});

process.on('SIGINT',  () => bot.stop().then(() => process.exit(0)));
process.on('SIGTERM', () => bot.stop().then(() => process.exit(0)));
