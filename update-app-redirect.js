// ============================================================
//  update-app-redirect.js
//  ONE-TIME SETUP — Run once to register your Netlify redirect
//  URI with Deriv App ID 138154.
//
//  Usage:
//    node update-app-redirect.js
//
//  After running: delete this file (it contains your token).
// ============================================================

const WebSocket = require('ws');

// ── FILL THESE IN ────────────────────────────────────────────
const TOKEN    = process.env.CLIENT_TOKEN || 'vBnGEfaD0Hbtb1g';
const APP_ID   = 138154;
const REDIRECT = 'https://YOUR-SITE.netlify.app/';  // <-- change to your actual Netlify URL
// ─────────────────────────────────────────────────────────────

if (REDIRECT.includes('YOUR-SITE')) {
  console.error('ERROR: Set your actual Netlify URL in REDIRECT before running.');
  process.exit(1);
}

const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);

ws.on('open', () => {
  console.log('Connected to Deriv...');
  ws.send(JSON.stringify({ authorize: TOKEN }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  if (msg.msg_type === 'authorize') {
    if (msg.error) { console.error('Auth failed:', msg.error.message); ws.close(); return; }
    console.log('Authorized as:', msg.authorize.loginid);
    ws.send(JSON.stringify({
      app_update:    APP_ID,
      name:          'AutoCycle Pro',
      redirect_uri:  REDIRECT,
      homepage:      REDIRECT,
      scopes:        ['read', 'trade', 'payments', 'admin'],
    }));
  }

  if (msg.msg_type === 'app_update') {
    if (msg.error) {
      console.error('app_update FAILED:', msg.error.message);
    } else {
      console.log('SUCCESS! App redirect_uri registered:');
      console.log('  App ID      :', msg.app_update.app_id);
      console.log('  Redirect URI:', msg.app_update.redirect_uri);
      console.log('');
      console.log('Deploy autocycle_oauth_v17.html to Netlify and test the OAuth button.');
    }
    ws.close();
  }
});

ws.on('error', (e) => console.error('WS error:', e.message));
