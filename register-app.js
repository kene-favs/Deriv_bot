// ============================================================
//  AutoCycle — Register Deriv App (run ONCE to get App ID)
//
//  Run:  node register-app.js
//  Then: copy the App ID printed and update config.js
// ============================================================

const WebSocket = require('ws');

const TOKEN  = 'vBnGEfaD0Hbtb1g';   // your existing token
const APP_ID = 1089;

const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);

ws.on('open', () => {
  console.log('Connecting to Deriv...');
  ws.send(JSON.stringify({ authorize: TOKEN, req_id: 1 }));
});

ws.on('message', (raw) => {
  const msg = JSON.parse(raw);

  // Step 1 — authorized
  if (msg.req_id === 1) {
    if (msg.error) {
      console.error('❌ Authorization failed:', msg.error.message);
      ws.close();
      return;
    }
    console.log('✅ Authorized as:', msg.authorize.loginid);
    console.log('Registering AutoCycle Pro app...');

    ws.send(JSON.stringify({
      app_register: 1,
      name:         'AutoCycle Pro',
      scopes:       ['read', 'trade'],
      redirect_uri: 'https://autocycle-pro.web.app',
      req_id:       2,
    }));
  }

  // Step 2 — app registered
  if (msg.req_id === 2) {
    if (msg.error) {
      console.error('❌ Registration failed:', msg.error.message);
      ws.close();
      return;
    }

    const appId = msg.app_register.app_id;
    console.log('\n════════════════════════════════════════');
    console.log('🎉  APP REGISTERED SUCCESSFULLY!');
    console.log('════════════════════════════════════════');
    console.log(`App ID : ${appId}`);
    console.log(`App Name : ${msg.app_register.name}`);
    console.log('\nNow update config.js — change this line:');
    console.log(`   APP_ID: ${appId},`);
    console.log('\nThen restart:  pm2 restart bot-manager');
    console.log('════════════════════════════════════════\n');
    ws.close();
  }
});

ws.on('error', (err) => console.error('WS error:', err.message));
