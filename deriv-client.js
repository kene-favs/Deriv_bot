// ============================================================
//  AutoCycle Deriv Bot — Deriv WebSocket Client  v8.2
//
//  CHANGES FROM reverted base:
//    1. subscribeContract(params) — dual-mode:
//       • Pass a contract_id (number/string) → monitors existing
//         contract via proposal_open_contract (fixes
//         InputValidationFailed when trade-manager calls it with
//         a contractId instead of a full params object)
//       • Pass an object → buys a new contract (legacy path)
//    2. sellContract(contractId) — race-condition safe:
//       BetExpired, AlreadySold, ContractSellValidationError etc.
//       are silently swallowed; caller sees { contract_id, sold_for:0 }
//       instead of an unhandled exception.
// ============================================================

const WebSocket    = require('ws');
const EventEmitter = require('events');

class DerivClient extends EventEmitter {
  constructor(token, appId = 1089) {
    super();
    this.token         = token;
    this.appId         = appId;
    this.ws            = null;
    this.authorized    = false;
    this.account       = null;
    this._reqId        = 1;
    this._pending      = new Map();   // reqId -> { resolve, reject, timer }
    this._reconnecting = false;
  }

  // ── Connect & Authorise ────────────────────────────────────
  connect() {
    return new Promise((resolve, reject) => {
      const url = `wss://ws.binaryws.com/websockets/v3?app_id=${this.appId}`;
      console.log('[Client] Connecting to Deriv WebSocket...');
      this.ws = new WebSocket(url);

      this.ws.on('open', async () => {
        console.log('[Client] WebSocket connected');
        try {
          await this._authorize();
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      this.ws.on('message', (raw) => {
        try {
          this._handleMessage(JSON.parse(raw));
        } catch (e) {
          console.error('[Client] Parse error:', e.message);
        }
      });

      this.ws.on('close', () => {
        if (!this._reconnecting) {
          this._reconnecting = true;
          console.log('[Client] Connection lost — reconnecting in 5s...');
          this.authorized = false;
          setTimeout(() => {
            this._reconnecting = false;
            this.connect().catch(console.error);
          }, 5000);
        }
      });

      this.ws.on('error', (err) => {
        console.error('[Client] WS error:', err.message);
      });
    });
  }

  // ── Internal message router ────────────────────────────────
  _handleMessage(msg) {
    const id = msg.req_id;

    // Resolve a one-shot request
    if (id && this._pending.has(id)) {
      const { resolve, reject, timer } = this._pending.get(id);
      clearTimeout(timer);
      this._pending.delete(id);
      if (msg.error) reject(new Error(`[${msg.error.code}] ${msg.error.message}`));
      else           resolve(msg);
      return;
    }

    // Ongoing subscription events (ticks, proposal_open_contract, etc.)
    if (msg.msg_type) {
      this.emit(msg.msg_type, msg);
    }
  }

  // ── Send with promise + timeout ────────────────────────────
  send(payload, timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('WebSocket not connected'));
      }
      const id    = this._reqId++;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Request timeout (req_id ${id})`));
      }, timeoutMs);

      payload.req_id = id;
      this._pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  // ── Authorise ──────────────────────────────────────────────
  async _authorize() {
    const res = await this.send({ authorize: this.token });
    this.authorized = true;
    this.account    = res.authorize;
    console.log(`[Client] ✅ Authorized`);
    console.log(`[Client]    Account : ${this.account.loginid}`);
    console.log(`[Client]    Balance : $${this.account.balance} ${this.account.currency}`);
    console.log(`[Client]    Type    : ${this.account.is_virtual ? '🟡 DEMO' : '🟢 REAL'}`);
    this.emit('authorized', this.account);
    return this.account;
  }

  // ── Balance ────────────────────────────────────────────────
  async getBalance() {
    const res = await this.send({ balance: 1 });
    return parseFloat(res.balance.balance);
  }

  // ── Tick history ───────────────────────────────────────────
  async getTickHistory(symbol, count = 150) {
    const res = await this.send({
      ticks_history: symbol,
      count,
      end:   'latest',
      style: 'ticks',
    });
    return (res.history?.prices || []).map(parseFloat);
  }

  // ── Live tick subscription ─────────────────────────────────
  async subscribeTicks(symbol) {
    await this.send({ ticks: symbol, subscribe: 1 });
    console.log(`[Client] 📡 Subscribed: ${symbol}`);
  }

  // ── Open a multiplier contract ─────────────────────────────
  // params: { symbol, contractType, stake, multiplier, takeProfit, stopLoss }
  async buyContract(params) {
    const payload = {
      buy:   '1',
      price: params.stake,
      parameters: {
        amount:        params.stake,
        basis:         'stake',
        contract_type: params.contractType,
        currency:      'USD',
        symbol:        params.symbol,
        multiplier:    params.multiplier,
        limit_order: {
          stop_loss:   params.stopLoss,
          take_profit: params.takeProfit,
        },
      },
    };
    const res = await this.send(payload, 15000);
    return res.buy;   // { contract_id, buy_price, longcode, ... }
  }

  // ── Subscribe to / monitor an existing contract ────────────
  //
  //  DUAL MODE (fixes InputValidationFailed):
  //    subscribeContract(contractId)   — number or string
  //      → subscribes to proposal_open_contract for that ID
  //      → returns { contract_id } immediately; updates come as
  //        'proposal_open_contract' events on this client
  //
  //    subscribeContract(paramsObj)    — object with stake etc.
  //      → buys a new contract (legacy path, kept for compat)
  //
  async subscribeContract(params) {
    if (typeof params === 'number' || typeof params === 'string') {
      // Monitor existing open contract
      const contractId = params;
      this.ws.send(JSON.stringify({
        proposal_open_contract: 1,
        contract_id:            contractId,
        subscribe:              1,
        req_id:                 this._reqId++,
      }));
      return { contract_id: contractId };
    }

    // Legacy: buy a new contract from a params object
    const res = await this.send({
      buy:   '1',
      price: params.stake,
      parameters: {
        amount:        params.stake,
        basis:         'stake',
        contract_type: params.contractType,
        currency:      'USD',
        symbol:        params.symbol,
        multiplier:    params.multiplier,
        limit_order: {
          stop_loss:   params.stopLoss,
          take_profit: params.takeProfit,
        },
      },
    }, 15000);
    return res.buy;
  }

  // ── Close a contract early — race-condition safe ───────────
  //
  //  Catches errors that are NOT worth rethrowing:
  //   • BetExpired            — contract already expired
  //   • AlreadySold           — TP/SL fired a millisecond before us
  //   • InvalidSellContractProposal
  //   • ContractSellValidationError
  //  All of these mean "it's already closed", so we return a
  //  zero-sold result rather than crashing the caller.
  //
  async sellContract(contractId) {
    try {
      const res = await this.send({ sell: contractId, price: 0 }, 15000);
      return res.sell;
    } catch (err) {
      const m = err.message || '';
      if (
        m.includes('InvalidSellContractProposal') ||
        m.includes('ContractSellValidationError') ||
        m.includes('AlreadySold')                  ||
        m.includes('BetExpired')                   ||
        m.includes('contract has expired')
      ) {
        console.log(`[Client] Sell ignored (${contractId}) — already closed: ${m}`);
        return { contract_id: contractId, sold_for: 0 };
      }
      throw err;   // unexpected error — re-throw so caller knows
    }
  }

  // ── Get all currently open contracts ──────────────────────
  async getPortfolio() {
    const res = await this.send({ portfolio: 1 });
    return res.portfolio?.contracts || [];
  }
}

module.exports = DerivClient;
