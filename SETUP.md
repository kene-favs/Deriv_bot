# AutoCycle Deriv Bot — VPS Setup Guide

## Step 1: Upload the bot to your VPS

```bash
# From your local machine — zip and upload
zip -r deriv-bot.zip deriv-bot/
scp deriv-bot.zip root@YOUR_VPS_IP:/root/
```

Or use FileZilla / WinSCP to drag and drop the `deriv-bot` folder.

---

## Step 2: SSH into your VPS

```bash
ssh root@YOUR_VPS_IP
```

---

## Step 3: Install Node.js (if not already installed)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v   # Should print v20.x.x
```

---

## Step 4: Extract and install bot dependencies

```bash
cd /root
unzip deriv-bot.zip
cd deriv-bot
npm install
```

---

## Step 5: Install PM2 (keeps bot running 24/7)

```bash
npm install -g pm2
```

---

## Step 6: Test the bot first (run manually to verify connection)

```bash
node bot.js
```

You should see:
```
╔══════════════════════════════════════════╗
║     AutoCycle Deriv Bot  v1.0            ║
╚══════════════════════════════════════════╝
[Client] ✅ Authorized
[Client]    Account : VRTC1234567
[Client]    Balance : $10000.00 USD
[Client]    Type    : 🟡 DEMO
[Bot] ✅ All systems go — scanning markets...
```

Press Ctrl+C to stop after verifying.

---

## Step 7: Run with PM2 (permanent 24/7 operation)

```bash
cd /root/deriv-bot
pm2 start bot.js --name "deriv-bot"
pm2 save
pm2 startup   # Follow the printed command to enable auto-start on reboot
```

---

## Useful PM2 Commands

```bash
pm2 status              # See if bot is running
pm2 logs deriv-bot      # Watch live bot output
pm2 logs deriv-bot --lines 100  # Last 100 lines
pm2 restart deriv-bot   # Restart bot
pm2 stop deriv-bot      # Stop bot (closes all trades gracefully)
pm2 delete deriv-bot    # Remove from PM2
```

---

## Switching from DEMO to REAL account

1. Log into app.deriv.com
2. Switch to your REAL account
3. Go to Account Settings → API Token
4. Create a new token with Trade + Read + Payments permissions
5. Open `config.js` on the VPS:
   ```bash
   nano /root/deriv-bot/config.js
   ```
6. Replace the TOKEN value with your real account token
7. Restart the bot:
   ```bash
   pm2 restart deriv-bot
   ```

---

## Instruments being traded

| Symbol    | Strategy         | Direction       |
|-----------|-----------------|-----------------|
| CRASH1000 | Spike detection  | Sell only       |
| CRASH500  | Spike detection  | Sell only       |
| BOOM1000  | Spike detection  | Buy only        |
| BOOM500   | Spike detection  | Buy only        |
| R_25      | Mean reversion   | Buy & Sell      |
| R_75      | EMA crossover    | Buy & Sell      |

---

## Scaling (automatic — bot adjusts as balance grows)

| Balance     | Max Open Trades | Stake per Trade |
|-------------|----------------|-----------------|
| $2 – $19    | 2              | 5% of balance   |
| $20 – $29   | 3              | 5% of balance   |
| $30 – $49   | 4              | 5% of balance   |
| $50 – $99   | 5              | 6% of balance   |
| $100 – $199 | 6              | 7% of balance   |
| $200 – $499 | 7              | 7% of balance   |
| $500+       | 8              | 8% of balance   |
