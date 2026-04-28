// centris_auto_login.js — Login Centris automatique + push cookies au bot
//
// Usage: node scripts/centris_auto_login.js
//
// Flow:
// 1. Lance un VRAI Chromium (visible) — Centris voit un browser réel
// 2. Login auto avec credentials depuis env vars
// 3. Si MFA SMS arrive → terminal demande le code, tu le tapes
// 4. Cookies extraits (incl HttpOnly) → POST au bot /admin/centris-cookies
// 5. Bot valide + save 25 jours
//
// Avantages:
// - Browser réel = invisible aux yeux de Centris
// - Headed mode = tu vois ce qui se passe
// - Persistent context = pas besoin de refaire login chaque fois
// - Même mot de passe Centris peut être saved dans le profile Playwright

const { chromium } = require('/Users/signaturesb/Documents/github/mailing-masse/node_modules/playwright');
const readline = require('readline');
const path = require('path');
const fs = require('fs');

// Credentials lus depuis env vars ou fichier local sécurisé (jamais hardcodés).
// Source 1: process.env (export CENTRIS_USER=..., CENTRIS_PASS=...)
// Source 2: ~/.claude-bot-secrets.env (déjà chmod 600 dans ton home)
// Source 3: ~/Documents/github/mailing-masse/.env (existant)
function loadCreds() {
  if (process.env.CENTRIS_USER && process.env.CENTRIS_PASS) {
    return { user: process.env.CENTRIS_USER, pass: process.env.CENTRIS_PASS };
  }
  const sources = [
    path.join(process.env.HOME, '.claude-bot-secrets.env'),
    path.join(process.env.HOME, 'Documents/github/mailing-masse/.env'),
  ];
  for (const f of sources) {
    if (!fs.existsSync(f)) continue;
    const text = fs.readFileSync(f, 'utf8');
    const u = text.match(/CENTRIS_USER\s*=\s*"?([^"\n]+)"?/)?.[1]?.trim();
    const p = text.match(/CENTRIS_PASS\s*=\s*"?([^"\n]+)"?/)?.[1]?.trim();
    if (u && p) return { user: u, pass: p };
  }
  console.error('❌ CENTRIS_USER/CENTRIS_PASS introuvables (env vars ou fichiers .env)');
  console.error('   Set: export CENTRIS_USER=<broker_code> CENTRIS_PASS=<password>');
  process.exit(1);
}
const { user: CENTRIS_USER, pass: CENTRIS_PASS } = loadCreds();
const BOT_ENDPOINT = 'https://signaturesb-bot-s272.onrender.com/admin/centris-cookies';

const PROFILE_DIR = path.join(__dirname, '..', '.playwright-centris-profile');

// Plus de prompt() terminal — on attend que l'URL devienne loggée (max 5 min)
async function waitForLogin(page, maxMs = 5 * 60 * 1000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const url = page.url();
    // URLs de succès Matrix Centris
    if (/Matrix\/Default|Matrix\/Home|Matrix\/Search/i.test(url) && !/login/i.test(url)) {
      return true;
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

(async () => {
  console.log('🚀 Lance Chromium headed avec profile persistant...');
  console.log('   (Profile: ' + PROFILE_DIR + ')');
  console.log();

  // Persistent context — sauve les cookies + login state pour les prochaines fois
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
  });

  const page = context.pages()[0] || await context.newPage();

  // Step 1: navigate
  console.log('📍 Navigation vers matrix.centris.ca...');
  await page.goto('https://matrix.centris.ca/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Vérifier si déjà loggé
  const url = page.url();
  console.log('   URL: ' + url);

  if (url.includes('Default.aspx') && !url.toLowerCase().includes('login')) {
    console.log('✓ Déjà loggé! Skip login.');
  } else {
    console.log('🔐 Login flow...');
    // Try to find login fields
    try {
      await page.waitForSelector('input[type="text"], input[name*="user" i], input[id*="user" i]', { timeout: 10000 });
      // Detect input fields
      const userInput = await page.locator('input[type="text"], input[name*="user" i], input[id*="user" i]').first();
      const passInput = await page.locator('input[type="password"]').first();

      console.log('   Fill username: ' + CENTRIS_USER);
      await userInput.fill(CENTRIS_USER);
      console.log('   Fill password');
      await passInput.fill(CENTRIS_PASS);

      // Submit
      await page.keyboard.press('Enter');
      console.log('   ↩ Enter pressed, waiting...');

      // Attend redirection ou MFA
      try {
        await page.waitForURL(/Default|Matrix|Home/i, { timeout: 30000 });
        console.log('✓ Login réussi sans MFA!');
      } catch (e) {
        console.log('⏳ Login en cours... MFA possible.');
      }
    } catch (e) {
      console.log('⚠️ Login auto échoué: ' + e.message);
      console.log('   → Tu peux te logger manuellement dans la fenêtre browser.');
    }

    // Si MFA SMS demandé
    let needsMFA = false;
    try {
      const mfaPrompt = await page.locator('input[type="tel"], input[name*="otp" i], input[name*="code" i], input[name*="mfa" i]').first();
      if (await mfaPrompt.isVisible({ timeout: 5000 })) {
        needsMFA = true;
      }
    } catch {}

    if (needsMFA) {
      console.log();
      console.log('📱 MFA SMS demandé — code envoyé à ton iPhone');
      console.log('   → Tape le code 6-chiffres DANS LA FENÊTRE CHROME qui est ouverte');
      console.log('   → Le script détectera automatiquement quand tu es loggé');
    } else {
      console.log('   Pas de MFA détecté immédiatement — peut être manuel');
    }

    console.log();
    console.log('⏳ Attente login complete (max 5 min)...');
    console.log('   → INTERAGIS DIRECTEMENT avec la fenêtre Chrome ouverte');
    console.log('   → Si MFA: tape ton code SMS dans le champ de la page');
    console.log('   → Le script extrait automatiquement les cookies dès que tu es loggé');
    const ok = await waitForLogin(page);
    if (!ok) {
      console.log('⚠️ Timeout 5 min — login non détecté. Cookies extraits quand même.');
    } else {
      console.log('✅ Login détecté!');
    }
  }

  // Step 2: extract cookies
  console.log();
  console.log('🍪 Extraction cookies...');
  const cookies = await context.cookies();
  const centrisCookies = cookies.filter(c =>
    c.domain.includes('centris') || c.domain.includes('matrix') || c.domain.includes('auth0')
  );
  console.log('   ' + centrisCookies.length + ' cookies Centris extraits');

  const cookieString = centrisCookies.map(c => `${c.name}=${c.value}`).join('; ');
  console.log('   Length: ' + cookieString.length + ' chars');

  if (cookieString.length < 100) {
    console.log('❌ Cookies trop courts — le login a échoué.');
    await context.close();
    process.exit(1);
  }

  // Save locally pour debug
  fs.writeFileSync('/tmp/centris_cookies_playwright.txt', cookieString);
  console.log('   Saved /tmp/centris_cookies_playwright.txt');

  // Step 3: push au bot
  console.log();
  console.log('📲 Push au bot via /admin/centris-cookies...');
  try {
    const r = await fetch(BOT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: cookieString,
    });
    const txt = await r.text();
    if (r.ok) {
      const d = JSON.parse(txt);
      console.log('✅ Bot a accepté: ' + d.length + ' chars · valide ' + d.expiresInDays + ' jours');
    } else {
      console.log('❌ Bot a rejeté HTTP ' + r.status + ': ' + txt);
    }
  } catch (e) {
    console.log('❌ Push error: ' + e.message);
  }

  console.log();
  console.log('═══ TERMINÉ ═══');
  console.log('Tu peux maintenant taper dans Telegram:');
  console.log('  comparables terrains Rawdon 365 jours');
  console.log();
  console.log('Profile sauvegardé dans ' + PROFILE_DIR);
  console.log('Prochaine fois (dans 25 jours), re-run ce script — login auto sans MFA.');

  await context.close();
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
