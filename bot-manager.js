// ============================================================
//  AutoCycle Pro — Bot Manager  v1.2
//
//  CHANGES v1.2:
//   - Added account deduplication guard (pre-flight WS check)
//   - Before starting any bot, validates token against Deriv API
//   - If two clients resolve to the same Deriv account loginid,
//     the second one is BLOCKED with a clear error — no more
//     doubled trades on the same account
//   - accountId stored in running map for ongoing duplicate checks
//
//  SETUP:
//   1. npm install firebase-admin ws  (already done)
//   2. firebase-service-account.json in same folder
//   3. pm2 restart bot-manager  (after replacing this file)
// ============================================================

'use strict';

const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore }        = require('firebase-admin/firestore');
const { spawn }               = require('child_process');
const path                    = require('path');
const WebSocket               = require('ws');

// ── Firebase Admin init ────────────────────────────────────
let serviceAccount;
try {
  serviceAccount = require('./firebase-service-account.json');
} catch (e) {
  console.error(
    '[Manager] ❌ firebase-service-account.json not found in bot folder.\n' +
    '  Fix: rename the file to exactly firebase-service-account.json\n' +
    '  (no double .json extension)\n' +
    '  Error: ' + e.message
  );
  process.exit(1);
}

try {
  initializeApp({ credential: cert(serviceAccount) });
} catch (e) {
  console.error('[Manager] ❌ Firebase init failed:', e.message);
  process.exit(1);
}

const db = getFirestore();
console.log('[Manager] ✅ Firebase connected');

// ── State ──────────────────────────────────────────────────
const running          = new Map(); // uid → { child, token, accountId }
const BOT_PATH         = path.join(__dirname, 'bot.js');
const SYNC_INTERVAL_MS = 60_000;
const DERIV_WS_URL     = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';

// ── Account ID pre-flight check ────────────────────────────
// Opens a temporary WebSocket, authorises with the token,
// returns the Deriv loginid (e.g. "VRTC4209523" or "CR1234567"),
// then closes the socket.  Rejects if token is invalid or times out.
function getAccountId(token) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.terminate(); } catch (_) {}
      reject(new Error('Token validation timed out after 10 s'));
    }, 10_000);

    let ws;
    try {
      ws = new WebSocket(DERIV_WS_URL);
    } catch (err) {
      clearTimeout(timer);
      return reject(err);
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ authorize: token }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }

      if (msg.msg_type !== 'authorize') return;

      clearTimeout(timer);
      settled = true;
      try { ws.close(); } catch (_) {}

      if (msg.error) {
        reject(new Error(`Deriv auth error: ${msg.error.message}`));
      } else {
        resolve(msg.authorize.loginid);
      }
    });

    ws.on('error', (err) => {
      if (settled) return;
      clearTimeout(timer);
      settled = true;
      reject(err);
    });
  });
}

// ── Main sync loop ─────────────────────────────────────────
async function syncClients() {
  console.log(`[Manager] 🔄 Syncing clients... (${running.size} running)`);

  let snap;
  try {
    snap = await db.collection('users').get();
  } catch (err) {
    console.error('[Manager] Firestore read failed:', err.message);
    return;
  }

  const activeUids = new Set();

  for (const docSnap of snap.docs) {
    const uid  = docSnap.id;
    const data = docSnap.data() || {};

    const derivSub = data?.subscription?.deriv || {};
    const token    = data?.credentials?.derivToken;

    if (!derivSub.active || !token) continue;

    // Check expiry
    if (derivSub.expiresAt) {
      const expiresAt = derivSub.expiresAt.toDate
        ? derivSub.expiresAt.toDate()
        : new Date(derivSub.expiresAt);
      if (expiresAt < new Date()) {
        console.log(`[Manager] ⏰ Expired: ${uid} — deactivating`);
        await db.collection('users').doc(uid).update({
          'subscription.deriv.active': false,
        }).catch(() => {});
        continue;
      }
    }

    activeUids.add(uid);

    // ── Token-change detection (existing logic) ────────────
    if (running.has(uid)) {
      const existing = running.get(uid);
      if (existing.token === token) continue; // no change, skip
      console.log(`[Manager] 🔁 Token changed for ${uid.slice(0, 8)} — restarting`);
      existing.child.kill('SIGTERM');
      running.delete(uid);
      // fall through to validate + start fresh
    }

    // ── Pre-flight: validate token & get Deriv account ID ──
    let accountId;
    try {
      accountId = await getAccountId(token);
      console.log(`[Manager] 🔍 ${uid.slice(0, 8)} → Deriv account: ${accountId}`);
    } catch (err) {
      console.error(
        `[Manager] ❌ Token invalid for ${uid.slice(0, 8)}: ${err.message}\n` +
        `          This client's token will be skipped until a valid token is saved.`
      );
      continue;
    }

    // ── Deduplication guard ────────────────────────────────
    // Check if any other RUNNING bot already owns this account
    let duplicate = false;
    for (const [otherUid, otherEntry] of running) {
      if (otherEntry.accountId === accountId) {
        console.error(
          `[Manager] ❌ DUPLICATE ACCOUNT BLOCKED\n` +
          `          Client ${uid.slice(0, 8)} token resolves to account ${accountId}\n` +
          `          which is ALREADY running under ${otherUid.slice(0, 8)}.\n` +
          `          This client MUST generate a token from their OWN Deriv account.\n` +
          `          (Real account = CR prefix  |  Demo account = VRTC prefix)\n` +
          `          Bot will NOT start until a different account token is provided.`
        );
        duplicate = true;
        break;
      }
    }
    if (duplicate) continue;

    // ── All clear — start the bot ──────────────────────────
    startBot(uid, token, accountId);
  }

  // Stop bots for inactive / removed clients
  for (const [uid] of running) {
    if (!activeUids.has(uid)) {
      console.log(`[Manager] 🛑 Stopping bot for ${uid.slice(0, 8)}`);
      running.get(uid).child.kill('SIGTERM');
      running.delete(uid);
    }
  }

  console.log(`[Manager] ✅ Sync done — ${running.size} bot(s) active`);
}

// ── Spawn bot.js for one client ────────────────────────────
function startBot(uid, token, accountId) {
  const short = uid.slice(0, 8);
  console.log(`[Manager] 🚀 Starting bot for ${short} (account: ${accountId})...`);

  const child = spawn('node', [BOT_PATH], {
    env: { ...process.env, CLIENT_TOKEN: token, CLIENT_UID: uid },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (d) => {
    String(d).split('\n').filter(Boolean).forEach(line =>
      process.stdout.write(`[${short}] ${line}\n`)
    );
  });
  child.stderr.on('data', (d) => {
    String(d).split('\n').filter(Boolean).forEach(line =>
      process.stderr.write(`[${short}] ERR: ${line}\n`)
    );
  });
  child.on('exit', (code, signal) => {
    console.log(`[Manager] ⚠️  Bot ${short} stopped (${signal || 'exit ' + code}) — restarts on next sync`);
    if (running.get(uid)?.child === child) running.delete(uid);
  });

  running.set(uid, { child, token, accountId });
  console.log(`[Manager] ✅ Bot running for ${short} | account: ${accountId} | PID: ${child.pid}`);
}

// ── Start ──────────────────────────────────────────────────
console.log('[Manager] 🤖 AutoCycle Bot Manager v1.2 starting...');
syncClients();
setInterval(syncClients, SYNC_INTERVAL_MS);

// ── Graceful shutdown ──────────────────────────────────────
function shutdown() {
  console.log('\n[Manager] Shutting down...');
  for (const [, { child }] of running) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);
