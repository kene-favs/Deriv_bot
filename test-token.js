// ============================================================
//  test-token.js — tests any token against any App ID
//
//  Usage:
//    node test-token.js <TOKEN> <APP_ID>
//
//  Examples:
//    node test-token.js vBnGEfaD0Hbtb1g 1089
//    node test-token.js pat_e3a68184fb02ee486ea02034fe... 1089
//    node test-token.js pat_e3a68184fb02ee486ea02034fe... 67891
// ============================================================

const WebSocket = require('ws');

const TOKEN  = process.argv[2];
const APP_ID = process.argv[3] || 1089;

if (!TOKEN) {
  console.error('Usage: node test-token.js <TOKEN> [APP_ID]');
  process.exit(1);
}

console.log(`\nTesting token: ${TOKEN.slice(0, 20)}...`);
console.log(`App ID       : ${APP_ID}\n`);

const ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);

const timeout = setTimeout(() => {
  console.error('❌ Timed out — no response from Deriv after 10s');
  ws.close();
  process.exit(1);
}, 10000);

ws.on('open', () => {
  ws.send(JSON.stringify({ authorize: TOKEN, req_id: 1 }));
});

ws.on('message', (raw) => {
  clearTimeout(timeout);
  const msg = JSON.parse(raw);

  if (msg.error) {
    console.error('❌ ERROR:', msg.error.code, '—', msg.error.message);
    console.log('\nWhat this means:');
    if (msg.error.code === 'InvalidToken') {
      console.log('  → Token is rejected by App ID', APP_ID);
      console.log('  → If this is a pat_xxx token, try running with your new App ID:');
      console.log('     node test-token.js <TOKEN> <YOUR_NEW_APP_ID>');
    }
    if (msg.error.code === 'InvalidAppID') {
      console.log('  → App ID', APP_ID, 'does not exist or is not active');
    }
  } else {
    console.log('✅ SUCCESS!');
    console.log('   Login ID :', msg.authorize.loginid);
    console.log('   Name     :', msg.authorize.fullname);
    console.log('   Email    :', msg.authorize.email);
    console.log('   Balance  :', msg.authorize.balance, msg.authorize.currency);
    console.log('\nThis token + App ID combination WORKS.');
  }

  ws.close();
});

ws.on('error', (err) => {
  clearTimeout(timeout);
  console.error('❌ Connection error:', err.message);
});
