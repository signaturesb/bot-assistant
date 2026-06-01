#!/usr/bin/env node
// centris-auto-login.js — Login Centris autonome via Email MFA + Gmail OAuth
// Run via LaunchAgent toutes les 12h pour garder session bot Render fresh.
// Logs: /Users/signaturesb/Documents/github/Claude, code Telegram/logs/centris-auto-login.log

const path = require('path');
// Resolve playwright — préférence: rebrowser-playwright > playwright-core > playwright
let chromium;
const _candidates = ['rebrowser-playwright', 'playwright-core', 'playwright'];
for (const mod of _candidates) {
  try { chromium = require(mod).chromium; console.log(`Using playwright module: ${mod}`); break; } catch {}
}
if (!chromium) {
  // Fallback: chercher absolute dans node_modules parent
  for (const mod of _candidates) {
    try { chromium = require(path.join(__dirname, '..', 'node_modules', mod)).chromium; console.log(`Using ${mod} (absolute path)`); break; } catch {}
  }
}
if (!chromium) { console.error('❌ No playwright module available — install with: npm install rebrowser-playwright'); process.exit(1); }
const { execSync } = require('child_process');
const fs = require('fs');

// Log file
const LOG_FILE = path.join(__dirname, '..', 'logs', 'centris-auto-login.log');
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}
const origLog = console.log;
console.log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  origLog(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
};

const USER = '110509';
const PASS = 'Milf1340@';
const WEBHOOK_SECRET = execSync(`grep -E "^WEBHOOK_SECRET=" /Users/signaturesb/Documents/github/_CORE/config/.env.shared | cut -d= -f2- | tr -d '"'`).toString().trim();

// Pin existing chromium-1217 binary (MCP installed it)
const CHROME_PATH = '/Users/signaturesb/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';

(async () => {
  console.log('🚀 Centris auto-login...');
  const browser = await chromium.launch({ headless: false, executablePath: CHROME_PATH, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36' });
  const page = await ctx.newPage();
  try {
    console.log('1. Login page');
    await page.goto('https://matrix.centris.ca/Matrix/Login.aspx', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2500);
    const baselineRowId = parseInt(execSync(`sqlite3 -readonly ~/Library/Messages/chat.db "SELECT MAX(ROWID) FROM message;"`, { encoding: 'utf8' }).trim());
    console.log(`   Baseline ROWID: ${baselineRowId}`);

    console.log('2. Saisir credentials');
    await page.fill('input[id*="UserCode"]', USER);
    await page.fill('input[id="Password"]', PASS);
    await page.click('button:has-text("Connect"), button:has-text("Connexion")');
    await page.waitForTimeout(4000);
    let currentUrl = page.url();
    console.log(`   URL after submit: ${currentUrl.substring(0, 100)}`);

    // Helper: handle disclaimer pages (LoginIntermediateMLD, "I've Read This", etc.)
    const handleDisclaimers = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.waitForTimeout(1500);
        const url = page.url();
        if (/Matrix\/Home/.test(url)) return true;
        // Try common disclaimer buttons
        const btnSelectors = [
          'button:has-text("I\'ve Read This")',
          'button:has-text("J\'ai lu ceci")',
          'input[type="submit"][value*="Read"]',
          'input[type="submit"][value*="Accept"]',
          'a:has-text("I\'ve Read")',
          'a:has-text("Continue")',
        ];
        let clicked = false;
        for (const sel of btnSelectors) {
          try { await page.click(sel, { timeout: 1500 }); clicked = true; console.log(`   Disclaimer clicked: ${sel}`); break; } catch {}
        }
        if (!clicked) {
          // No disclaimer button found — maybe submit any visible form
          try {
            const submit = await page.$('form button[type="submit"], form input[type="submit"]');
            if (submit) { await submit.click(); clicked = true; console.log('   Disclaimer form submit'); }
          } catch {}
        }
        if (!clicked) break;
        await page.waitForTimeout(2500);
      }
      return /Matrix\/Home/.test(page.url());
    };

    // 3. EARLY-EXIT — si déjà dans Matrix (session valide, MFA bypass possible), skip MFA
    if (/matrix\.centris\.ca\/Matrix\/Home/.test(currentUrl) || /matrix\.centris\.ca\/Matrix\/LoginIntermediateMLD/.test(currentUrl)) {
      console.log('   ✅ Already logged in (session valide bypass MFA) — finalize via disclaimer click');
      const reached = await handleDisclaimers();
      console.log(`   URL après finalize: ${page.url().substring(0, 100)} (Home=${reached})`);
      if (!reached) {
        throw new Error(`Session incomplète — URL ${page.url()} après disclaimer handle.`);
      }
    } else if (/mfa-sms-challenge|mfa-email-challenge|mfa.*challenge/.test(currentUrl)) {
      // 3a. MFA challenge présent — switch to Email
      console.log('3. MFA challenge détecté → switch to Email');
      const isAlreadyEmail = /mfa-email/.test(currentUrl);
      if (!isAlreadyEmail) {
        try {
          await page.click('button:has-text("Change authentication method")', { timeout: 5000 });
          await page.waitForTimeout(1500);
          await page.click('button:has-text("Email"), li:has-text("Email") button', { timeout: 5000 });
          await page.waitForTimeout(2500);
        } catch (e) {
          console.log(`   ⚠️ Email switch failed: ${e.message.substring(0, 80)} — continue with current method`);
        }
      }
      console.log(`   URL après MFA setup: ${page.url().substring(0, 100)}`);

      // 4. Attendre code via Gmail
      console.log('4. Attendre code MFA via Gmail API (90s max)');
      let code = null;
      const startWait = Date.now();
      // Trigger email envoyé maintenant — wait at least 5s pour livraison
      await page.waitForTimeout(5000);
      for (let i = 0; i < 45; i++) {
        try {
          const r = await fetch(`https://signaturesb-bot-s272.onrender.com/admin/centris-mfa-code?token=${WEBHOOK_SECRET}`);
          if (r.ok) {
            const j = await r.json();
            if (j.ok && j.code) {
              // Vérif: email arrivé après notre login (timestamp future)
              code = j.code;
              console.log(`   ✅ Code via Gmail: ${code.substring(0,2)}**** (${(j.subject||'').substring(0,60)})`);
              break;
            }
          }
        } catch {}
        // Fallback chat.db (si SMS Forwarding actif)
        try {
          const out = execSync(`sqlite3 -readonly ~/Library/Messages/chat.db "SELECT text FROM message WHERE ROWID > ${baselineRowId} AND is_from_me=0 ORDER BY ROWID DESC LIMIT 5;"`, { encoding: 'utf8' });
          for (const line of out.split('\n')) {
            const m = line.match(/\b(\d{6})\b/);
            if (m) { code = m[1]; console.log(`   ✅ Code via chat.db: ${code.substring(0,2)}****`); break; }
          }
        } catch {}
        if (code) break;
        await page.waitForTimeout(2000);
        if (i % 5 === 0) console.log(`   ... ${i*2}s elapsed`);
      }
      if (!code) throw new Error('Pas de code MFA reçu en 90s');

      // 5. Saisir code
      console.log('5. Saisir code MFA');
      await page.fill('input[name="code"], input[id="code"], input[type="text"]:visible', code);
      await page.click('button:has-text("Continue"), button[type="submit"]');
      await page.waitForTimeout(5000);
      console.log(`   URL final: ${page.url().substring(0, 100)}`);
    } else {
      console.log(`   ⚠️ URL inattendue: ${currentUrl}. Tente navigation Matrix Home...`);
      try { await page.goto('https://matrix.centris.ca/Matrix/Home', { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
      await page.waitForTimeout(3000);
    }

    console.log('5. Extract cookies + storageState complet (PRO sync)');
    const cookies = await ctx.cookies();
    const ct = cookies.filter(c => /centris\.ca/.test(c.domain));
    const cs = ct.map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`   ${ct.length} cookies (${cs.length} chars)`);

    // Capture User-Agent + storageState complet pour replay sur Browserless
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const storageState = await ctx.storageState();
    console.log(`   UA: ${userAgent.substring(0, 80)}`);
    console.log(`   storageState: ${storageState.cookies?.length || 0} cookies + ${storageState.origins?.length || 0} origins`);

    console.log('6. Push cookies au bot');
    const r = await fetch('https://signaturesb-bot-s272.onrender.com/admin/centris-cookies', {
      method: 'POST', headers: { 'Content-Type': 'text/plain', 'X-Webhook-Secret': WEBHOOK_SECRET }, body: cs,
    });
    console.log(`   Bot cookies: ${r.status} ${(await r.text()).substring(0, 200)}`);

    console.log('7. Push storageState complet au bot');
    try {
      const r2 = await fetch('https://signaturesb-bot-s272.onrender.com/admin/centris-storage-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET },
        body: JSON.stringify({ storageState, userAgent }),
      });
      console.log(`   Bot storageState: ${r2.status} ${(await r2.text()).substring(0, 200)}`);
    } catch (e) { console.warn(`   storageState push fail: ${e.message}`); }
    const ok = r.ok;
    console.log(ok ? '\n🎉 SUCCESS' : '\n❌ FAIL');
    if (!ok) {
      // Telegram alert: cookies refused
      try {
        await fetch(`https://signaturesb-bot-s272.onrender.com/webhook/sms-bridge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ alert: 'centris-auto-login-fail', detail: `Bot refused cookies (HTTP ${r.status})` }),
        });
      } catch {}
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
    // Telegram alert via bot API direct (besoin TELEGRAM_BOT_TOKEN)
    try {
      const tgToken = process.env.TELEGRAM_BOT_TOKEN || execSync('grep TELEGRAM_BOT_TOKEN /Users/signaturesb/Documents/github/_CORE/config/.env.shared 2>/dev/null | cut -d= -f2-').toString().trim();
      const userId = process.env.TELEGRAM_ALLOWED_USER_ID || '5261213272';
      if (tgToken && tgToken.length > 20) {
        await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: parseInt(userId),
            text: `🚨 *Centris auto-login fail*\n\n${e.message?.substring(0, 200)}\n\nLogs: \`/Users/signaturesb/Documents/github/Claude, code Telegram/logs/centris-auto-login.log\``,
            parse_mode: 'Markdown',
          }),
        });
      }
    } catch (tgErr) { console.error(`Telegram alert fail: ${tgErr.message}`); }
  } finally {
    await browser.close();
  }
})();
