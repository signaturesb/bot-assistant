// cua_driver.js — Computer Use Agent Driver
// Pilote Playwright (local OU Browserless externe) avec Claude Computer Use API
// pour naviguer agent.centris.ca, télécharger fiches PDF + annexes.
//
// Architecture:
//   screenshot → Claude CUA analyse → action (click/type/scroll) → repeat
//   jusqu'à PDF trouvé ou max 25 itérations
//
// MODE BROWSERLESS (recommandé Render free):
//   ENV: BROWSERLESS_WS=wss://chrome.browserless.io?token=<API_KEY>
//   → Connexion WebSocket à Chromium remote, isolé du bot.
//   → 1000 min/mois gratuit. Bot reste léger.
//
// MODE LOCAL:
//   Sans BROWSERLESS_WS → launch Chromium local (nécessite Render Starter +
//   `playwright install chromium --with-deps` dans Build Command).
//
// Cache: cookies Centris persistés /data/cua_session.json (12h)
// Fallback: si Playwright absent → erreur explicite (pas de crash silencieux)
//
// Usage dans bot.js:
//   const { cuaGetCentrisPDF, cuaGetCentrisAnnexes, CUA_AVAILABLE } = require('./cua_driver');

'use strict';

const fs   = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const DATA_DIR       = fs.existsSync('/data') ? '/data' : '/tmp';
const SESSION_FILE   = path.join(DATA_DIR, 'cua_session.json');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'cua_screenshots');
const PDF_DIR        = path.join(DATA_DIR, 'cua_pdfs');
const SESSION_TTL    = 12 * 60 * 60 * 1000;   // 12h — refresh auto
const MAX_STEPS      = 25;                      // iterations max par tâche
const VIEWPORT       = { width: 1280, height: 900 };
// Centris a migré 2026: agent.centris.ca retiré → matrix.centris.ca
const CENTRIS_BASE   = 'https://matrix.centris.ca';
const MATRIX_BASE    = 'https://matrix.centris.ca';
const PUBLIC_BASE    = 'https://www.centris.ca';

// Lazy-load Playwright — Préférence: rebrowser-playwright (anti-detect natif)
// > playwright-core > playwright (fallback)
let playwright = null;
let playwrightFlavor = 'none';
let Anthropic   = null;

function loadDeps() {
  if (!playwright) {
    // 1. Essai rebrowser-playwright (patches anti-detect: navigator.webdriver,
    //    chrome.runtime, source detection, etc.)
    try { playwright = require('rebrowser-playwright'); playwrightFlavor = 'rebrowser'; }
    catch {
      try { playwright = require('playwright-core'); playwrightFlavor = 'core'; }
      catch {
        try { playwright = require('playwright'); playwrightFlavor = 'full'; }
        catch { throw new Error('Playwright non installé. npm install rebrowser-playwright'); }
      }
    }
    console.log(`[CUA] Playwright flavor: ${playwrightFlavor}`);
  }
  if (!Anthropic) {
    try { Anthropic = require('@anthropic-ai/sdk'); }
    catch { throw new Error('@anthropic-ai/sdk non installé'); }
  }
}

// User-Agent pool — Chrome + Edge récents, rotation aléatoire pour pas patterner
const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
];
function pickUA() { return UA_POOL[Math.floor(Math.random() * UA_POOL.length)]; }

// Script anti-detect injecté dans CHAQUE page via addInitScript
// Override les properties que les détecteurs bot utilisent (navigator.webdriver,
// chrome.runtime, permissions.query, plugins, etc.)
const ANTI_DETECT_SCRIPT = `
// Mask navigator.webdriver
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
// Languages: réaliste fr-CA + en
Object.defineProperty(navigator, 'languages', { get: () => ['fr-CA', 'fr', 'en-CA', 'en'] });
// Plugins: au moins 3 (signature humaine)
Object.defineProperty(navigator, 'plugins', {
  get: () => [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', length: 1 },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', length: 1 },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', length: 1 },
  ],
});
// chrome.runtime existe (mais vide) — détecteurs vérifient présence
if (!window.chrome) window.chrome = {};
if (!window.chrome.runtime) window.chrome.runtime = {};
// Permissions: bypass notification check piège
const origQuery = window.navigator.permissions?.query;
if (origQuery) {
  window.navigator.permissions.query = (param) =>
    param.name === 'notifications' ? Promise.resolve({ state: Notification.permission }) : origQuery(param);
}
// WebGL vendor/renderer plausibles
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function (p) {
  if (p === 37445) return 'Intel Inc.';
  if (p === 37446) return 'Intel Iris OpenGL Engine';
  return getParameter.call(this, p);
};
`;

// Launch browser — Browserless externe (recommandé) OU local Chromium
// Si BROWSERLESS_WS env var défini → WebSocket connect (1000 min/mois free).
// Sinon → launch local (nécessite Chromium installé).
async function launchBrowser() {
  loadDeps();
  const wsEndpoint = process.env.BROWSERLESS_WS;
  if (wsEndpoint) {
    console.log('[CUA] Mode Browserless externe (WS)');
    // Audit P3 #10: retry 3× avec backoff 3s/8s/20s
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const browser = await playwright.chromium.connect(wsEndpoint, { timeout: 30000 });
        // Track disconnect pour visibilité
        browser.on('disconnected', () => console.warn('[CUA] Browser disconnected (Browserless)'));
        if (attempt > 1) console.log(`[CUA] Browserless connect OK (attempt ${attempt})`);
        return browser;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) {
          const delay = [3000, 8000, 20000][attempt - 1];
          console.warn(`[CUA] Browserless connect échoué (attempt ${attempt}/${3}, retry ${delay}ms): ${e.message}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    // 3 fails → reset cache disponibilité pour forcer re-check au prochain appel
    _cuaAvailable = null;
    throw new Error(`Browserless WS connect échoué 3× — last: ${lastErr?.message}. Vérifie BROWSERLESS_WS / quota.`);
  }
  console.log('[CUA] Mode local Chromium');
  return await playwright.chromium.launch({
    headless: true,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-blink-features=AutomationControlled', // bypass headless detection
      '--disable-features=IsolateOrigins,site-per-process',
      '--lang=fr-CA',
      '--window-size=1280,900'
    ]
  });
}

// Crée un context stealth — réutilisable par cuaGetCentrisPDF / Annexes / Navigate
async function newStealthContext(browser) {
  const ua = pickUA();
  const ctx = await browser.newContext({
    viewport: VIEWPORT,
    userAgent: ua,
    acceptDownloads: true,
    locale: 'fr-CA',
    timezoneId: 'America/Toronto',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    javaScriptEnabled: true,
    bypassCSP: true,
    extraHTTPHeaders: {
      'Accept-Language': 'fr-CA,fr;q=0.9,en-CA;q=0.8,en;q=0.7',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': ua.includes('Macintosh') ? '"macOS"' : '"Windows"',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': 'none',
      'sec-fetch-user': '?1',
      'upgrade-insecure-requests': '1',
    },
  });
  // Anti-detect script sur chaque page nouvelle
  await ctx.addInitScript(ANTI_DETECT_SCRIPT);
  return ctx;
}

// ═══════════════════════════════════════════════════════════════════════════
// VÉRIFIER DISPONIBILITÉ (sans throw)
// ═══════════════════════════════════════════════════════════════════════════

let _cuaAvailable = null;
function CUA_AVAILABLE() {
  if (_cuaAvailable !== null) return _cuaAvailable;
  try {
    require.resolve('@anthropic-ai/sdk');
    // Set flavor pour cuaStatus AVANT load réel
    try { require.resolve('rebrowser-playwright'); _cuaAvailable = true; if (playwrightFlavor === 'none') playwrightFlavor = 'rebrowser'; }
    catch {
      try { require.resolve('playwright-core'); _cuaAvailable = true; if (playwrightFlavor === 'none') playwrightFlavor = 'core'; }
      catch {
        try { require.resolve('playwright'); _cuaAvailable = true; if (playwrightFlavor === 'none') playwrightFlavor = 'full'; }
        catch { _cuaAvailable = false; }
      }
    }
  } catch {
    _cuaAvailable = false;
  }
  return _cuaAvailable;
}

// ═══════════════════════════════════════════════════════════════════════════
// INIT DOSSIERS
// ═══════════════════════════════════════════════════════════════════════════

function initDirs() {
  [SCREENSHOT_DIR, PDF_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION CENTRIS — cookies persistants
// ═══════════════════════════════════════════════════════════════════════════

function loadSession() {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (Date.now() - s.ts > SESSION_TTL) {
      fs.unlinkSync(SESSION_FILE);
      return null;
    }
    return s.cookies || null;
  } catch { return null; }
}

function saveSession(cookies) {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({ ts: Date.now(), cookies }));
  } catch (e) { console.warn('[CUA] session save error:', e.message); }
}

function clearSession() {
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch {}
}

// Récupère cookies du bot principal (centris_cookies.json) si CUA n'a pas sa propre session
// Le LaunchAgent Mac push les cookies fresh tous les 12h via /admin/centris-cookies
function loadBotCentrisCookies() {
  try {
    const botCookieFile = path.join(DATA_DIR, 'centris_cookies.json');
    if (!fs.existsSync(botCookieFile)) return null;
    const data = JSON.parse(fs.readFileSync(botCookieFile, 'utf8'));
    // Format bot.js: { cookies: "name1=val1; name2=val2", expiry: timestamp }
    // Format Playwright requis: [{ name, value, domain, path }, ...]
    if (!data.cookies || typeof data.cookies !== 'string') return null;
    if (data.expiry && Date.now() > data.expiry) return null;
    const pairs = data.cookies.split(';').map(s => s.trim()).filter(Boolean);
    return pairs.map(pair => {
      const idx = pair.indexOf('=');
      if (idx < 0) return null;
      return {
        name: pair.substring(0, idx).trim(),
        value: pair.substring(idx + 1).trim(),
        domain: '.centris.ca',
        path: '/',
        httpOnly: false,
        secure: true,
        sameSite: 'Lax',
      };
    }).filter(Boolean);
  } catch (e) { console.warn('[CUA] loadBotCentrisCookies:', e.message); return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOGIN CENTRIS (avec ou sans session cachée)
// ═══════════════════════════════════════════════════════════════════════════

async function loginCentris(context) {
  const user = process.env.CENTRIS_USER;
  const pass = process.env.CENTRIS_PASS;
  if (!user || !pass) throw new Error('CENTRIS_USER / CENTRIS_PASS manquants dans env vars');

  const page = await context.newPage();
  await page.setViewportSize(VIEWPORT);

  // Essayer session cachée d'abord (CUA propre OU cookies bot principal partagés)
  const savedCookies = loadSession() || loadBotCentrisCookies();
  if (savedCookies && savedCookies.length > 0) {
    try {
      await context.addCookies(savedCookies);
      await page.goto(`${MATRIX_BASE}/Matrix`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);
      const url = page.url();
      if (!/\/login|\/auth|signin|LoginIntermediate|accounts\.centris/i.test(url)) {
        console.log('[CUA] Session cachée valide ✅', url.substring(0, 80));
        return page;
      }
      console.log('[CUA] Session expirée, re-login...');
      clearSession();
    } catch (e) { console.warn('[CUA] Cookie session échouée:', e.message); clearSession(); }
  }

  // Login frais — page Centris Matrix qui redirige vers accounts.centris.ca
  console.log('[CUA] Login Centris matrix (fresh)...');
  await page.goto(`${MATRIX_BASE}/Matrix/Login.aspx`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  const currentUrl = page.url();
  console.log('[CUA] URL login:', currentUrl.substring(0, 100));

  // Centris form: UserCode + Password sur même page (pas Auth0 split)
  let loginDeterministicOK = false;
  try {
    const userField = page.locator('input[id*="UserCode"], input[name*="UserCode"], input[id="UserCode"], input[placeholder*="user" i], input[placeholder*="code" i]').first();
    await userField.waitFor({ timeout: 10000 });
    await userField.fill(user);

    const passField = page.locator('input[id="Password"], input[type="password"], input[name="Password"]').first();
    await passField.fill(pass);

    const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Connect"), button:has-text("Connexion"), button:has-text("Sign In"), button:has-text("Log In")').first();
    await submitBtn.click();
    console.log('[CUA] Login form rempli (deterministic) ✅');
    await page.waitForTimeout(4500);
    loginDeterministicOK = true;
  } catch (e) {
    console.warn(`[CUA] Login deterministic échoué: ${e.message}. Fallback CUA visuel...`);
  }

  // FALLBACK CUA — si selectors deterministic ratent (UI change), Claude voit l'écran et décide
  if (!loginDeterministicOK) {
    console.log('[CUA] Activation CUA pour login visuel...');
    const loginTask = `Tu es sur la page de login Centris/Matrix. Mes credentials:
- UserCode/Username: "${user}"
- Password: "${pass}"

Étapes:
1. Trouve le champ UserCode/Username et entre "${user}"
2. Trouve le champ Password et entre "${pass}"
3. Clique le bouton Connect/Connexion/Sign In/Log In
4. Attends que la page suivante charge

Termine quand tu vois soit un champ MFA (code à 6 chiffres) soit la page d'accueil Matrix.`;
    const visualResult = await runCUATask(page, loginTask);
    if (!visualResult.success) throw new Error(`CUA visual login échec: ${visualResult.message}`);
    console.log('[CUA] Login visuel réussi ✅');
  }

  // Handle MFA (Email ou SMS) — Centris envoie code par email après login basic
  for (let mfaAttempt = 0; mfaAttempt < 2; mfaAttempt++) {
    const mfaField = page.locator('input[name*="ode"], input[id*="ode"], input[placeholder*="code" i], input[placeholder*="vérif" i], input[type="tel"]').first();
    const mfaVisible = await mfaField.isVisible().catch(() => false);
    if (!mfaVisible) break;

    console.log(`[CUA] MFA requis (tentative ${mfaAttempt + 1}/2) — fetch code via Gmail (max 180s)...`);
    const mfaCode = await fetchMFACodeFromBot(180000);
    if (!mfaCode) throw new Error('MFA timeout — pas de code MFA reçu en 180s via Gmail/bot. Vérifier LaunchAgent sms-bridge actif sur Mac.');
    console.log(`[CUA] MFA code reçu: ${mfaCode.substring(0, 2)}****`);

    await mfaField.fill(mfaCode);
    const mfaSubmit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Vérif"), button:has-text("Submit"), button:has-text("Confirmer")').first();
    await mfaSubmit.click();
    await page.waitForTimeout(4000);
  }

  // Handle disclaimers "I've Read This" / "Continue"
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = page.url();
    if (!/LoginIntermediate|Disclaimer|Consent/i.test(url)) break;
    console.log('[CUA] Disclaimer detected, clicking continue...');
    const continueBtn = page.locator('button:has-text("Continue"), input[type="submit"][value*="Continue"], button:has-text("I.?ve Read")').first();
    const visible = await continueBtn.isVisible().catch(() => false);
    if (!visible) break;
    await continueBtn.click();
    await page.waitForTimeout(3000);
  }

  const finalUrl = page.url();
  if (/\/login|\/auth|signin|accounts\.centris/i.test(finalUrl)) {
    throw new Error(`Login Centris échoué — URL finale: ${finalUrl.substring(0, 200)}`);
  }

  // Sauvegarder session pour reuse 12h
  const cookies = await context.cookies();
  saveSession(cookies);
  // Push aussi vers bot principal pour partage
  try { pushCookiesToBot(cookies); } catch (e) { console.warn('[CUA] push cookies bot:', e.message); }
  console.log('[CUA] Login Centris réussi ✅ Cookies sauvegardés.', finalUrl.substring(0, 80));
  return page;
}

// Fetch MFA code depuis le bot Render qui lit Gmail automatiquement
// Fallback 1: /data/centris_mfa.txt (Mac LaunchAgent sms-bridge)
// Fallback 2: alerte Telegram à Shawn avec demande manuelle
async function fetchMFACodeFromBot(timeoutMs) {
  const botUrl = process.env.BOT_URL || 'https://signaturesb-bot-s272.onrender.com';
  const token = process.env.WEBHOOK_SECRET;
  if (!token) {
    console.warn('[CUA] WEBHOOK_SECRET manquant — fallback file /data/centris_mfa.txt');
    return await waitForMFACode(timeoutMs);
  }
  const start = Date.now();
  let alertSent = false;
  while (Date.now() - start < timeoutMs) {
    try {
      // 1. Try Gmail via bot endpoint
      const r = await fetch(`${botUrl}/admin/centris-mfa-code?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const d = await r.json();
        if (d.code && /^\d{4,8}$/.test(d.code)) {
          console.log(`[CUA] MFA from Gmail (${d.emails_checked} emails scanned, subject="${d.subject?.substring(0,40)}")`);
          return d.code;
        }
      }
      // 2. Try local file (Mac LaunchAgent sms-bridge)
      const mfaFile = path.join(DATA_DIR, 'centris_mfa.txt');
      if (fs.existsSync(mfaFile)) {
        const code = fs.readFileSync(mfaFile, 'utf8').trim();
        if (code && /^\d{4,8}$/.test(code)) {
          fs.unlinkSync(mfaFile);
          console.log('[CUA] MFA from local file (sms-bridge)');
          return code;
        }
      }
      // 3. Après 30s, alerter Shawn sur Telegram (1 fois)
      if (!alertSent && Date.now() - start > 30000) {
        alertSent = true;
        await alertShawnMFA(botUrl, token).catch(() => {});
      }
    } catch (e) { console.warn('[CUA] fetchMFA loop:', e.message); }
    await new Promise(r => setTimeout(r, 3000));
  }
  return null;
}

// Alerte Telegram à Shawn quand MFA tarde — il peut envoyer code via /mfa CMD
async function alertShawnMFA(botUrl, token) {
  try {
    await fetch(`${botUrl}/admin/notify?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: '🔐 *CUA Centris* attend code MFA\n\nCode pas trouvé dans Gmail en 30s.\n\n👉 Envoie le code via `/mfa 123456` ou réponds avec le code seul.\n\n_(timeout 60s total)_',
        parse_mode: 'Markdown',
      }),
      signal: AbortSignal.timeout(8000),
    });
    console.log('[CUA] Alerte MFA envoyée à Shawn');
  } catch (e) { console.warn('[CUA] alertShawn:', e.message); }
}

// Push cookies au bot principal pour qu'il bénéficie de la session CUA
async function pushCookiesToBot(playwrightCookies) {
  const botUrl = process.env.BOT_URL || 'https://signaturesb-bot-s272.onrender.com';
  const token = process.env.WEBHOOK_SECRET;
  if (!token) return;
  // Convert Playwright format → Cookie header string
  const cookieStr = playwrightCookies
    .filter(c => /centris\.ca$/i.test(c.domain || ''))
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
  if (!cookieStr) return;
  try {
    await fetch(`${botUrl}/admin/centris-cookies?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cookies: cookieStr, source: 'cua', ts: Date.now() }),
      signal: AbortSignal.timeout(10000),
    });
    console.log('[CUA] Cookies pushed to bot ✅');
  } catch (e) { console.warn('[CUA] pushCookies failed:', e.message); }
}

// Attendre code MFA dans /data/centris_mfa.txt (écrit par sms-bridge LaunchAgent)
async function waitForMFACode(timeoutMs) {
  const mfaFile = path.join(DATA_DIR, 'centris_mfa.txt');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(mfaFile)) {
      const code = fs.readFileSync(mfaFile, 'utf8').trim();
      if (code && /^\d{4,8}$/.test(code)) return code;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLAUDE CUA — boucle principale
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Exécute une tâche CUA avec Claude Computer Use.
 * Claude voit les screenshots, décide quoi cliquer/taper, on exécute.
 *
 * @param {Page} page — page Playwright active
 * @param {string} task — instruction en langage naturel
 * @param {Function} onPDF — callback(buffer, filename) quand PDF capturé
 * @returns {object} { success, message, pdfBuffers[] }
 */
async function runCUATask(page, task, onPDF = null) {
  loadDeps();
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const pdfBuffers = [];
  const messages = [];
  let stepCount = 0;
  let taskDone = false;

  // Intercepter les téléchargements PDF
  page.on('download', async download => {
    try {
      const tmpPath = path.join(PDF_DIR, `cua_${Date.now()}_${download.suggestedFilename()}`);
      await download.saveAs(tmpPath);
      const buf = fs.readFileSync(tmpPath);
      if (buf.length > 1000) {
        pdfBuffers.push({ buffer: buf, filename: download.suggestedFilename(), path: tmpPath });
        if (onPDF) onPDF(buf, download.suggestedFilename());
        console.log(`[CUA] PDF capturé: ${download.suggestedFilename()} (${Math.round(buf.length/1024)}KB)`);
      }
    } catch (e) { console.warn('[CUA] Download error:', e.message); }
  });

  // Screenshot initial
  const initScreenshot = await page.screenshot({ type: 'png', fullPage: false });
  const initB64 = initScreenshot.toString('base64');

  messages.push({
    role: 'user',
    content: [
      { type: 'text', text: task },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: initB64 }
      }
    ]
  });

  console.log(`[CUA] Tâche démarrée: ${task.substring(0, 80)}...`);

  while (stepCount < MAX_STEPS && !taskDone) {
    stepCount++;
    console.log(`[CUA] Step ${stepCount}/${MAX_STEPS}`);

    let response;
    try {
      response = await anthropic.beta.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 1024,
        tools: [
          {
            type: 'computer_20241022',
            name: 'computer',
            display_width_px: VIEWPORT.width,
            display_height_px: VIEWPORT.height,
            display_number: 1
          }
        ],
        messages,
        betas: ['computer-use-2024-10-22']
      });
    } catch (e) {
      console.error('[CUA] API error:', e.message);
      return { success: false, message: `Erreur API CUA: ${e.message}`, pdfBuffers };
    }

    // Ajouter réponse Claude à l'historique
    messages.push({ role: 'assistant', content: response.content });

    const toolUses = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');

    textBlocks.forEach(t => {
      if (t.text) console.log(`[CUA Claude] ${t.text.substring(0, 150)}`);
    });

    // Fin naturelle sans action
    if (response.stop_reason === 'end_turn' && toolUses.length === 0) {
      const lastText = textBlocks.map(t => t.text).join(' ');
      const success = pdfBuffers.length > 0 ||
                      /terminé|done|complete|found/i.test(lastText);
      taskDone = true;
      return {
        success,
        message: lastText || (success ? 'Tâche complétée' : 'Terminé sans résultat'),
        pdfBuffers
      };
    }

    // Exécuter actions
    const toolResults = [];
    for (const toolUse of toolUses) {
      if (toolUse.name !== 'computer') continue;

      let actionResult = null;
      try {
        actionResult = await executeCUAAction(page, toolUse.input);
      } catch (e) {
        console.error(`[CUA] Action ${toolUse.input.action} échouée:`, e.message);
        actionResult = { error: e.message };
      }

      await page.waitForTimeout(800);
      const screenshot = await page.screenshot({ type: 'png', fullPage: false });
      const screenshotB64 = screenshot.toString('base64');

      try {
        fs.writeFileSync(
          path.join(SCREENSHOT_DIR, `step_${stepCount}_${toolUse.input.action}.png`),
          screenshot
        );
      } catch {}

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: [{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: screenshotB64 }
        }]
      });

      if (pdfBuffers.length > 0) taskDone = true;
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }

    if (taskDone) {
      return {
        success: true,
        message: `PDF capturé en ${stepCount} étapes`,
        pdfBuffers
      };
    }
  }

  return {
    success: pdfBuffers.length > 0,
    message: pdfBuffers.length > 0
      ? `${pdfBuffers.length} PDF(s) capturés en ${stepCount} étapes`
      : `Max ${MAX_STEPS} étapes atteint sans PDF`,
    pdfBuffers
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// EXÉCUTER UNE ACTION CUA
// ═══════════════════════════════════════════════════════════════════════════

async function executeCUAAction(page, input) {
  const { action, coordinate, text, key, direction, amount } = input;

  switch (action) {
    case 'screenshot':
      return { ok: true };

    case 'left_click':
    case 'click': {
      const [x, y] = coordinate;
      await page.mouse.click(x, y);
      await page.waitForTimeout(500);
      return { ok: true, x, y };
    }

    case 'double_click': {
      const [x, y] = coordinate;
      await page.mouse.dblclick(x, y);
      await page.waitForTimeout(500);
      return { ok: true };
    }

    case 'right_click': {
      const [x, y] = coordinate;
      await page.mouse.click(x, y, { button: 'right' });
      await page.waitForTimeout(500);
      return { ok: true };
    }

    case 'type': {
      await page.keyboard.type(text || '', { delay: 40 });
      return { ok: true };
    }

    case 'key': {
      const k = (key || '')
        .replace('Return', 'Enter')
        .replace('ctrl+', 'Control+')
        .replace('cmd+', 'Meta+')
        .replace('alt+', 'Alt+')
        .replace('shift+', 'Shift+');
      await page.keyboard.press(k);
      await page.waitForTimeout(300);
      return { ok: true, key: k };
    }

    case 'scroll': {
      const [x, y] = coordinate || [VIEWPORT.width / 2, VIEWPORT.height / 2];
      const delta = (amount || 3) * (direction === 'up' ? -100 : 100);
      await page.mouse.wheel(0, delta);
      await page.waitForTimeout(400);
      return { ok: true };
    }

    case 'mouse_move': {
      const [x, y] = coordinate;
      await page.mouse.move(x, y);
      return { ok: true };
    }

    case 'left_click_drag': {
      const [sx, sy] = coordinate;
      const [ex, ey] = input.end_coordinate || coordinate;
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(ex, ey, { steps: 10 });
      await page.mouse.up();
      return { ok: true };
    }

    default:
      console.warn(`[CUA] Action inconnue: ${action}`);
      return { ok: false, error: `Action inconnue: ${action}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API PUBLIQUE — cuaGetCentrisPDF
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Télécharge la fiche PDF officielle d'un listing Centris via CUA.
 * @param {string} centrisNum
 * @returns {Promise<{success, buffer, filename, message, fromCache}>}
 */
async function cuaGetCentrisPDF(centrisNum) {
  if (!CUA_AVAILABLE()) {
    return {
      success: false,
      message: 'Playwright non disponible — install: npm install playwright && npx playwright install chromium',
      buffer: null
    };
  }

  loadDeps();
  initDirs();

  // Cache 24h
  const pdfCacheFile = path.join(PDF_DIR, `centris_${centrisNum}_fiche.pdf`);
  if (fs.existsSync(pdfCacheFile)) {
    const stat = fs.statSync(pdfCacheFile);
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000 && stat.size > 10000) {
      console.log(`[CUA] PDF en cache: ${pdfCacheFile}`);
      return {
        success: true,
        buffer: fs.readFileSync(pdfCacheFile),
        filename: `Centris_${centrisNum}_fiche.pdf`,
        message: 'PDF depuis cache (24h)',
        fromCache: true
      };
    }
  }

  let browser = null;
  try {
    console.log(`[CUA] Démarrage browser pour listing #${centrisNum}...`);
    browser = await launchBrowser();
    const context = await newStealthContext(browser);
    const page = await loginCentris(context);

    // Essayer URL directe Matrix d'abord
    try {
      await page.goto(`${MATRIX_BASE}/Matrix/Public/Portal.aspx?L=1&K=1&p=DE-1-1-${centrisNum}`, {
        waitUntil: 'domcontentloaded', timeout: 15000
      });
      await page.waitForTimeout(2000);
    } catch {}

    const task = `
Tu es sur le portail agent Centris.ca. Ta mission: télécharger le PDF de la fiche du listing #${centrisNum}.

Étapes:
1. Cherche un champ de recherche MLS/Centris sur la page ou dans le menu
2. Entre le numéro "${centrisNum}" dans ce champ et valide
3. Une fois le listing affiché, cherche un bouton ou lien "Imprimer", "Print", "PDF", "Fiche", "Sheet"
4. Clique dessus pour lancer le téléchargement
5. Si un dialogue s'ouvre, confirme "Enregistrer en PDF"

Le PDF sera capturé automatiquement dès que le téléchargement commence.
`.trim();

    const result = await runCUATask(page, task);

    if (result.success && result.pdfBuffers.length > 0) {
      const { buffer, filename } = result.pdfBuffers[0];
      fs.writeFileSync(pdfCacheFile, buffer);
      return {
        success: true,
        buffer,
        filename: filename || `Centris_${centrisNum}_fiche.pdf`,
        message: result.message,
        fromCache: false
      };
    }

    // Fallback: capture PDF via page.pdf()
    const printResult = await tryCUAPrintCapture(page, centrisNum);
    if (printResult.success) {
      fs.writeFileSync(pdfCacheFile, printResult.buffer);
      return printResult;
    }

    return { success: false, buffer: null, message: result.message || 'PDF introuvable via CUA' };

  } catch (e) {
    console.error('[CUA] cuaGetCentrisPDF error:', e.message);
    if (/session|login|auth/i.test(e.message)) clearSession();
    return { success: false, buffer: null, message: e.message };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// FALLBACK: page.pdf() via Playwright direct
// ═══════════════════════════════════════════════════════════════════════════

async function tryCUAPrintCapture(page, centrisNum) {
  try {
    console.log(`[CUA] Fallback page.pdf()...`);
    const pdfBuffer = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
    });
    if (pdfBuffer && pdfBuffer.length > 5000) {
      return {
        success: true,
        buffer: pdfBuffer,
        filename: `Centris_${centrisNum}_capture.pdf`,
        message: 'PDF capturé via rendu page',
        fromCapture: true
      };
    }
  } catch (e) { console.warn('[CUA] page.pdf() échoué:', e.message); }
  return { success: false, buffer: null, message: 'Capture PDF échouée' };
}

// ═══════════════════════════════════════════════════════════════════════════
// API PUBLIQUE — cuaGetCentrisAnnexes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Télécharge toutes les annexes (DV, certificat, plans) d'un listing via CUA.
 * @param {string} centrisNum
 * @param {string} [filtre] — mot-clé (ex: "DV", "déclaration", "localisation")
 * @returns {Promise<{success, annexes: [{buffer, filename}], message}>}
 */
async function cuaGetCentrisAnnexes(centrisNum, filtre = null) {
  if (!CUA_AVAILABLE()) {
    return { success: false, annexes: [], message: 'Playwright non disponible' };
  }

  loadDeps();
  initDirs();

  let browser = null;
  try {
    browser = await launchBrowser();

    const context = await newStealthContext(browser);
    const page = await loginCentris(context);

    const filtreStr = filtre ? `en priorité "${filtre}"` : 'toutes';
    const task = `
Tu es sur le portail agent Centris. Mission: trouver et télécharger les annexes du listing #${centrisNum}.

Les annexes peuvent inclure: Déclaration du vendeur (DV), Certificat de localisation, Plans, Rapport d'inspection.

Étapes:
1. Navigue vers le listing #${centrisNum}
2. Cherche un onglet "Annexes", "Documents", "Fichiers" ou "Attachments"
3. Télécharge ${filtreStr} les annexes disponibles
4. Confirme chaque téléchargement

URL à essayer: ${MATRIX_BASE}/Matrix/Public/Portal.aspx?L=1&K=1&p=DE-1-1-${centrisNum}
`.trim();

    try {
      await page.goto(`${MATRIX_BASE}/Matrix/Public/Portal.aspx?L=1&K=1&p=DE-1-1-${centrisNum}`, {
        waitUntil: 'domcontentloaded', timeout: 15000
      });
      await page.waitForTimeout(2000);
    } catch {}

    const result = await runCUATask(page, task);

    let annexes = result.pdfBuffers || [];
    if (filtre && annexes.length > 0) {
      const filtreLC = filtre.toLowerCase();
      const filtered = annexes.filter(a =>
        a.filename.toLowerCase().includes(filtreLC) ||
        filtreLC.split(' ').some(w => a.filename.toLowerCase().includes(w))
      );
      if (filtered.length > 0) annexes = filtered;
    }

    return {
      success: annexes.length > 0,
      annexes,
      message: annexes.length > 0 ? `${annexes.length} annexe(s) trouvée(s)` : 'Aucune annexe trouvée',
      rawResult: result
    };

  } catch (e) {
    console.error('[CUA] cuaGetCentrisAnnexes error:', e.message);
    if (/login|auth/i.test(e.message)) clearSession();
    return { success: false, annexes: [], message: e.message };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// API PUBLIQUE — cuaNavigate (tâche générique)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Exécute une tâche CUA générique sur agent.centris.ca.
 * @param {string} task
 * @param {string} [startUrl]
 * @returns {Promise<{success, message, pdfBuffers, screenshots}>}
 */
async function cuaNavigate(task, startUrl = null) {
  if (!CUA_AVAILABLE()) {
    return { success: false, message: 'Playwright non disponible', pdfBuffers: [], screenshots: [] };
  }

  loadDeps();
  initDirs();

  let browser = null;
  try {
    browser = await launchBrowser();

    const context = await newStealthContext(browser);
    const page = await loginCentris(context);

    if (startUrl) {
      try {
        await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(1500);
      } catch {}
    }

    return await runCUATask(page, task);

  } catch (e) {
    console.error('[CUA] cuaNavigate error:', e.message);
    return { success: false, message: e.message, pdfBuffers: [], screenshots: [] };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// STATUS — pour /health endpoint
// ═══════════════════════════════════════════════════════════════════════════

function cuaStatus() {
  const available = CUA_AVAILABLE();
  const sessionAge = (() => {
    try {
      if (!fs.existsSync(SESSION_FILE)) return null;
      const s = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      return Math.round((Date.now() - s.ts) / 60000);
    } catch { return null; }
  })();

  const cachedPDFs = (() => {
    try {
      if (!fs.existsSync(PDF_DIR)) return 0;
      return fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf')).length;
    } catch { return 0; }
  })();

  const useBrowserless = !!process.env.BROWSERLESS_WS;
  return {
    available,
    playwright: available ? `installed (${playwrightFlavor || 'unknown'})` : 'missing (npm install rebrowser-playwright)',
    playwright_flavor: playwrightFlavor,
    stealth: playwrightFlavor === 'rebrowser' ? 'rebrowser anti-detect ON' : 'basic',
    pdf_parse: (() => { try { require.resolve('pdf-parse'); return true; } catch { return false; }})(),
    browser_mode: useBrowserless ? 'browserless (remote)' : 'local Chromium',
    browserless_configured: useBrowserless,
    anthropic_key: !!process.env.ANTHROPIC_API_KEY,
    centris_creds: !!(process.env.CENTRIS_USER && process.env.CENTRIS_PASS),
    session: sessionAge !== null
      ? (sessionAge < SESSION_TTL / 60000 ? `active (${sessionAge}min ago)` : 'expired')
      : 'none',
    cachedPDFs,
    dataDir: DATA_DIR,
    maxSteps: MAX_STEPS
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PARSE PDF — extract data from Centris fiche/annexes PDFs
// ═══════════════════════════════════════════════════════════════════════════

let _pdfParse = null;
function getPdfParse() {
  if (_pdfParse === null) {
    try { _pdfParse = require('pdf-parse'); }
    catch (e) { _pdfParse = false; console.warn('[CUA] pdf-parse indispo:', e.message); }
  }
  return _pdfParse || null;
}

/**
 * Extrait du texte + données structurées d'un PDF Centris.
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{text, pages, info, parsed}>}
 */
async function parsePDFText(pdfBuffer) {
  const pdfParse = getPdfParse();
  if (!pdfParse) throw new Error('pdf-parse non installé');
  try {
    const data = await pdfParse(pdfBuffer);
    return {
      text: data.text,
      pages: data.numpages,
      info: data.info,
      length: data.text.length,
    };
  } catch (e) {
    console.error('[CUA] parsePDF error:', e.message);
    throw e;
  }
}

/**
 * Extract structured data from Centris fiche PDF text (prix, MLS, adresse, taxes, etc).
 * @param {Buffer} pdfBuffer
 * @returns {Promise<{prix, adresse, mls, taxes_municipales, taxes_scolaires, terrain_dim, batiment_dim, year_built, raw_text}>}
 */
async function extractCentrisPDFData(pdfBuffer) {
  const { text } = await parsePDFText(pdfBuffer);
  const data = { raw_text: text.substring(0, 2000) };
  // Prix demandé
  const prixM = text.match(/(?:prix|asking|demand[ée]?)\s*[:\s$]*?([\d\s,]+)\s*\$/i)
    || text.match(/\$\s*([\d\s,]+)\b/);
  if (prixM) data.prix = parseFloat(prixM[1].replace(/[\s,]/g, ''));
  // MLS / Centris #
  const mlsM = text.match(/(?:MLS|Centris)\s*#?\s*:?\s*(\d{7,9})/i);
  if (mlsM) data.mls = mlsM[1];
  // Adresse (heuristique: ligne avec numéro civique)
  const adrM = text.match(/(\d{1,5}[A-Za-z]?[,\s]+(?:rue|avenue|av\.|boul\.|boulevard|chemin|ch\.|route|rang|rte)\s+[^\n]{3,80})/i);
  if (adrM) data.adresse = adrM[1].trim().substring(0, 200);
  // Taxes municipales (annuelles)
  const taxMuniM = text.match(/taxes?\s*municipal[ea]s?\s*[:\s]*\$?\s*([\d\s,]+)/i);
  if (taxMuniM) data.taxes_municipales = parseFloat(taxMuniM[1].replace(/[\s,]/g, ''));
  // Taxes scolaires
  const taxScolM = text.match(/taxes?\s*scolair[es]+\s*[:\s]*\$?\s*([\d\s,]+)/i);
  if (taxScolM) data.taxes_scolaires = parseFloat(taxScolM[1].replace(/[\s,]/g, ''));
  // Année construction
  const yearM = text.match(/(?:ann[ée]?e?\s*(?:de\s*)?construction|built|construit)\s*[:\s]*(\d{4})/i);
  if (yearM) data.year_built = parseInt(yearM[1]);
  // Dimensions terrain (m²)
  const terrainM = text.match(/(?:terrain|lot|superficie)\s*[:\s]*([\d\s,]+)\s*(?:m²|m2|pi²|pi2)/i);
  if (terrainM) data.terrain_superficie = terrainM[1].replace(/[\s,]/g, '');
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// NETTOYAGE — screenshots + vieux PDFs (> 7j)
// ═══════════════════════════════════════════════════════════════════════════

function cuaCleanup() {
  const TTL_7D = 7 * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  [SCREENSHOT_DIR, PDF_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(f => {
      try {
        const fp = path.join(dir, f);
        const stat = fs.statSync(fp);
        if (Date.now() - stat.mtimeMs > TTL_7D) {
          fs.unlinkSync(fp);
          cleaned++;
        }
      } catch {}
    });
  });
  return cleaned;
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// SEND CENTRIS LISTING VIA MATRIX UI (FLOW NATIF — captured 2026-05-19)
// Reproduit exactement le flow que Shawn fait manuellement:
// Login → recherche #MLS → click listing → Imprimer → "Detaillé client avec
// album de photos (Impérial)" → Envoyer le PDF par courriel → form → Envoyer
// PDF natif Matrix + photos + signature Shawn = delivery garantie
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Envoie la fiche Centris officielle (PDF natif + photos) à un destinataire
 * via l'UI Matrix native. Plus fiable que CUA Claude Computer Use.
 *
 * @param {object} opts
 * @param {string} opts.centris_num — numéro Centris/MLS
 * @param {string} opts.email — destinataire
 * @param {string} [opts.cc] — défaut shawn@signaturesb.com
 * @param {string} [opts.sujet] — défaut auto-généré
 * @param {string} [opts.message] — défaut message standard
 * @param {string} [opts.format] — 'detaille_client_album_imperial' (défaut), 'detaille_client_imperial', etc
 * @returns {Promise<{success, message, email_sent_to, cc, listing_url, screenshots?}>}
 */
async function sendCentrisListingByEmail(opts) {
  if (!CUA_AVAILABLE()) return { success: false, message: 'Playwright non disponible' };
  loadDeps();
  initDirs();
  const { centris_num, email, cc = 'shawn@signaturesb.com', sujet, message, format = 'detaille_client_album_imperial' } = opts;
  if (!centris_num || !email) return { success: false, message: 'centris_num + email requis' };

  // Mapping format → titre exact du <li> dans listbox Matrix
  const FORMAT_TITLES = {
    detaille_client_album_imperial: 'Detaillé client avec album de photos (Impérial)',
    detaille_client_imperial: 'Detaillé client (Impérial)',
    detaille_courtier_album_imperial: 'Detaillé courtier avec album de photos (Impérial)',
    detaille_courtier_imperial: 'Detaillé courtier (Impérial)',
    sommaire_imperial: 'Sommaire (Impérial)',
    partiel_imperial: 'Partiel (Impérial)',
    detaille_client_album_metrique: 'Detaillé client avec album de photos (Métrique)',
  };
  const formatTitle = FORMAT_TITLES[format] || FORMAT_TITLES.detaille_client_album_imperial;

  let browser = null;
  try {
    browser = await launchBrowser();
    const context = await newStealthContext(browser);
    const page = await loginCentris(context);

    // 1. Recherche listing via search bar
    console.log(`[CENTRIS-NATIVE] Recherche #${centris_num}`);
    await page.fill('#QueryText', String(centris_num));
    await page.locator('#QueryText').press('Enter');
    await page.waitForTimeout(3000);

    // 2. Vérifier qu'on a 1 résultat puis cliquer sur le lien (numéro Centris en bleu)
    const linkClicked = await page.evaluate((num) => {
      const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === String(num));
      if (a) { a.click(); return true; }
      return false;
    }, centris_num);
    if (!linkClicked) throw new Error(`Listing #${centris_num} non trouvé dans résultats`);
    await page.waitForTimeout(3000);

    // 3. Click Imprimer (onglet Actions en bas)
    console.log('[CENTRIS-NATIVE] Click Imprimer');
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a,button,input')]
        .find(b => /^imprimer$/i.test((b.textContent || b.value || '').trim()));
      if (btn) btn.click();
    });
    await page.waitForURL(/PrintOptions/, { timeout: 15000 });
    await page.waitForTimeout(2000);

    // 4. Sélectionner format (checkbox dans <li> avec title)
    console.log(`[CENTRIS-NATIVE] Format: ${formatTitle}`);
    const formatSelected = await page.evaluate((title) => {
      const li = [...document.querySelectorAll('li')].find(l => l.title === title);
      const cb = li?.querySelector('input[type=checkbox]');
      if (cb) { cb.checked = true; cb.click(); return true; }
      return false;
    }, formatTitle);
    if (!formatSelected) throw new Error(`Format "${formatTitle}" non trouvé dans listbox`);
    await page.waitForTimeout(800);

    // 5. Click "Envoyer le PDF par courriel"
    console.log('[CENTRIS-NATIVE] Click Envoyer le PDF par courriel');
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a,button,input')]
        .find(b => /envoyer.*pdf.*courriel/i.test(b.textContent || b.value || ''));
      if (btn) btn.click();
    });
    await page.waitForURL(/EmailOptions/, { timeout: 15000 });
    await page.waitForTimeout(2000);

    // 6. Remplir form
    console.log('[CENTRIS-NATIVE] Remplir form email');
    await page.evaluate((data) => {
      const setVal = (id, val) => {
        const el = document.getElementById(id);
        if (!el) return false;
        el.focus();
        const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      setVal('m_EmailContactSelectReport_m_ucTo_m_tbx', data.email);
      setVal('m_EmailContactSelectReport_m_ucCC_m_tbx', data.cc);
      setVal('m_tbxSubject', data.sujet);
      setVal('m_tbxMessage', data.message);
    }, {
      email, cc,
      sujet: sujet || `Propriété Centris #${centris_num}`,
      message: message || `Bonjour,\n\nVoici la fiche détaillée de la propriété Centris #${centris_num} que vous m'avez demandée. Le PDF inclut toutes les photos et informations complètes du listing.\n\nN'hésitez pas si vous avez des questions.\n\nAu plaisir,`,
    });
    await page.waitForTimeout(800);

    // 7. Click Envoyer
    console.log('[CENTRIS-NATIVE] Click Envoyer (final)');
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a')].find(a => a.textContent.trim() === 'Envoyer');
      if (btn) btn.click();
    });

    // 8. Wait confirmation banner "Courriel envoyé à"
    await page.waitForTimeout(3000);
    const confirmed = await page.evaluate(() => /Courriel envoyé à/.test(document.body.innerText));
    if (!confirmed) throw new Error('Confirmation Centris "Courriel envoyé à" non détectée');

    console.log(`[CENTRIS-NATIVE] ✅ Envoyé à ${email}`);
    return {
      success: true,
      message: `Fiche Centris #${centris_num} envoyée à ${email} via Matrix natif (PDF + photos)`,
      email_sent_to: email,
      cc,
      format,
      via: 'matrix-native',
    };
  } catch (e) {
    console.error('[CENTRIS-NATIVE] error:', e.message);
    return { success: false, message: e.message };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SEARCH CENTRIS COMPARABLES — Recherche Personnalisée
// Reproduit le flow: Menu Recherche → {Type} → Personnalisée → filtres → Résultats
// Permet: maisons vendues, terrains à vendre, condos avec accès eau, etc.
// ═══════════════════════════════════════════════════════════════════════════

// MATRIX_SELECTORS par TYPE de propriété — prefix Fm{N}_ varie
// Capturé live 2026-05-19, confirmé fonctionnel (32 terrains Rawdon 6 mois)
//
// TYPE FORM PREFIXES:
// - Unifamiliale: Fm43_
// - TerreTerrain: Fm105_
// - Autres types à découvrir au runtime ou via crawl ultérieur
//
// CTRL NUMBERS — partagés sauf changement de statut:
// 3565=région, 3567=muni, 3568=quartier, 3227=statut, 3386=prix, 5517=expiration
// 3416=Changement de statut (Unifam) / 3425=Changement de statut (Terrain)

const MATRIX_PREFIXES = {
  unifamiliale: 'Fm43_',
  copropriete: 'Fm44_',  // à confirmer
  ferme: 'Fm45_',         // à confirmer
  commercial: 'Fm46_',    // à confirmer
  revenus: 'Fm47_',       // à confirmer
  terrain: 'Fm105_',      // CONFIRMÉ
  multicategories: 'Fm48_', // à confirmer
};

// Ctrl numbers partagés (CONFIRMÉ communs entre Fm43_ Unifam et Fm105_ Terrain)
const MATRIX_CTRL = {
  region: '3565_LB',
  municipalite: '3567_LB',
  municipalite_filter: '3567_LB_TB',
  quartier: '3568_LB',
  statut: '3227_LB',
  prix_demande_vendu: '3386_TB',
  prix_loc: '3387_TB',
  date_nouvelle: '3381_TB',
  date_modif_prix: '3382_TB',
  date_inscript_modif: '3385_TB',
  date_expiration: '5517_TB',
  eau: '3530_LB',
  vue: '3531_LB',
  // CHANGEMENT DE STATUT — diffère selon type
  date_changement_statut_unifamiliale: '3416_TB',
  date_changement_statut_terrain: '3425_TB',
  // Unifamiliale-spécifique (Fm43_)
  genre_propriete: '792_LB',         // Plain-pied, À étages, ...
  type_batiment: '794_LB',           // Isolé, Jumelé, ...
  annee_construction: '3517_TB',
  superficie_habitable_tb: '3520_TB',
  superficie_habitable_unit: '3520_DD',
  superficie_terrain_tb: '3521_TB',
  superficie_terrain_unit: '3521_DD',
  sous_sol: '3529_LB',
  equipements: '3532_LB',
  foyer: '3527_LB',
  piscine: '3528_LB',
  fondation: '5705_LB',
  // Terrain-spécifique (Fm105_)
  type_terrain: '5638_LB',           // Terre / Terrain
  zonage_terrain: '5627_LB',
  systeme_egouts: '5639_LB',
  aqueduc: '5610_LB',
};

// Helper: get sélecteur complet pour un type + champ
function matrixSel(type, ctrlKey) {
  const prefix = MATRIX_PREFIXES[type] || MATRIX_PREFIXES.unifamiliale;
  let ctrl;
  if (ctrlKey === 'date_changement_statut') {
    ctrl = type === 'terrain' ? MATRIX_CTRL.date_changement_statut_terrain : MATRIX_CTRL.date_changement_statut_unifamiliale;
  } else {
    ctrl = MATRIX_CTRL[ctrlKey];
  }
  return prefix + 'Ctrl' + ctrl;
}

// Legacy alias (backward compat)
const MATRIX_SELECTORS = {
  region: 'Fm43_Ctrl3565_LB',
  municipalite: 'Fm43_Ctrl3567_LB',
  municipalite_filter: 'Fm43_Ctrl3567_LB_TB',
  quartier: 'Fm43_Ctrl3568_LB',
  statut: 'Fm43_Ctrl3227_LB',
  prix_demande_vendu: 'Fm43_Ctrl3386_TB',
  date_changement_statut: 'Fm43_Ctrl3416_TB',
  genre_propriete: 'Fm43_Ctrl792_LB',
  type_batiment: 'Fm43_Ctrl794_LB',
};

/**
 * Recherche dans Matrix Centris avec filtres avancés (mode Générale).
 * Tous les sélecteurs DOM capturés live 2026-05-19.
 *
 * @param {object} opts
 * @param {string} opts.type — 'unifamiliale' | 'copropriete' | 'ferme' | 'commercial' | 'revenus' | 'terrain' | 'multicategories'
 * @param {string} [opts.region] — Lanaudière, Laurentides, Montréal, etc.
 * @param {string} [opts.municipalite] — Rawdon, Sainte-Julienne, Joliette, etc. (67 options Lanaudière)
 * @param {string} [opts.statut] — 'En vigueur' (défaut) | 'Vendu' | 'Expiré' | 'Hors marché' | 'Annulé'
 * @param {number} [opts.prixMin] — fourchette prix min (ex 400000)
 * @param {number} [opts.prixMax] — fourchette prix max (ex 600000)
 * @param {number} [opts.joursVendus] — pour statut Vendu: derniers N jours (ex 180=6 mois, 90=3 mois, 14=2 sem)
 * @param {string} [opts.genrePropriete] — 'Maison de plain-pied' | 'Maison à étages' | 'Maison à paliers multiples' | 'Maison à un étage et demi' | 'Maison mobile'
 * @param {string} [opts.typeBatiment] — 'Isolé (détaché)' | 'Jumelé' | 'En rangée' | 'En rangée sur coin' | 'Quadrex'
 * @returns {Promise<{success, count, listings: [{mls, adresse, prix, ville}], message}>}
 */
// Helper: select dans listbox Matrix par texte exact (avec change event)
async function selectMatrixListbox(page, listboxId, value, multi = false) {
  return await page.evaluate(({ id, val, m }) => {
    const lb = document.getElementById(id);
    if (!lb) return false;
    if (lb.tagName !== 'SELECT') {
      const li = [...lb.children].find(c => (c.textContent || '').trim() === val);
      if (li) { li.click(); return true; }
      return false;
    }
    if (!m) [...lb.options].forEach(o => o.selected = false);
    const opt = [...lb.options].find(o => (o.text || '').trim() === val);
    if (!opt) return false;
    opt.selected = true;
    lb.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { id: listboxId, val: value, m: multi });
}

async function searchCentrisVendus(opts = {}) {
  if (!CUA_AVAILABLE()) return { success: false, message: 'Playwright non disponible' };
  loadDeps();
  initDirs();
  const { type = 'unifamiliale', region, municipalite, statut = 'En vigueur',
          prixMin, prixMax, joursVendus, genrePropriete, typeBatiment } = opts;

  const TYPE_URLS = {
    unifamiliale: 'Unifamiliale',
    copropriete: 'Copropriété%2FAppartement%20résidentiel',
    ferme: 'Ferme%2FFermette',
    commercial: 'Propriété%20commerciale%20ou%20industrielle',
    revenus: 'Propriété%20à%20revenus',
    terrain: 'Terre%2FTerrain',
    multicategories: 'Multicatégories',
  };
  const typeSlug = TYPE_URLS[type] || TYPE_URLS.unifamiliale;

  // Fix URLs Centris: pas de / dans le path (URL encoding direct)
  const TYPE_PATH_FIX = {
    unifamiliale: 'Unifamiliale',
    copropriete: 'Copropri%C3%A9t%C3%A9Appartementr%C3%A9sidentiel',
    ferme: 'FermeFermette',
    commercial: 'Propri%C3%A9t%C3%A9commercialeouindustrielle',
    revenus: 'Propri%C3%A9t%C3%A9%C3%A0revenus',
    terrain: 'TerreTerrain',
    multicategories: 'Multicat%C3%A9gories',
  };
  const urlPath = TYPE_PATH_FIX[type] || TYPE_PATH_FIX.unifamiliale;

  let browser = null;
  try {
    browser = await launchBrowser();
    const context = await newStealthContext(browser);
    const page = await loginCentris(context);

    // 1. Navigate Recherche GÉNÉRALE
    const searchUrl = `https://matrix.centris.ca/Matrix/Recherche/${urlPath}/G%C3%A9n%C3%A9rale`;
    console.log(`[CENTRIS-SEARCH] Type=${type} URL=${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    // 2. Région via selectOption (vraie postback ASP.NET)
    if (region) {
      try {
        await page.locator(`#${matrixSel(type, 'region')}`).selectOption([region]);
        console.log(`[CENTRIS-SEARCH] Région ${region} ✓`);
      } catch (e) { console.warn(`[CENTRIS-SEARCH] Région ${region}: ${e.message}`); }
      await page.waitForTimeout(2000);
    }

    // 3. Municipalité (après postback région)
    if (municipalite) {
      try {
        await page.locator(`#${matrixSel(type, 'municipalite')}`).selectOption([municipalite]);
        console.log(`[CENTRIS-SEARCH] Muni ${municipalite} ✓`);
      } catch (e) { console.warn(`[CENTRIS-SEARCH] Muni ${municipalite}: ${e.message}`); }
      await page.waitForTimeout(1500);
    }

    // 4. Statut
    try {
      await page.locator(`#${matrixSel(type, 'statut')}`).selectOption([statut]);
      console.log(`[CENTRIS-SEARCH] Statut ${statut} ✓`);
    } catch (e) { console.warn(`[CENTRIS-SEARCH] Statut ${statut}: ${e.message}`); }
    await page.waitForTimeout(1000);

    // 5. Prix fourchette
    if (prixMin || prixMax) {
      const range = `${prixMin || 0}-${prixMax || 99999999}`;
      try {
        await page.fill(`#${matrixSel(type, 'prix_demande_vendu')}`, range);
        console.log(`[CENTRIS-SEARCH] Prix range: ${range}`);
      } catch (e) { console.warn(`[CENTRIS-SEARCH] Prix: ${e.message}`); }
    }

    // 6. Date changement statut (jours arrière)
    if (joursVendus) {
      try {
        await page.fill(`#${matrixSel(type, 'date_changement_statut')}`, `0-${joursVendus}`);
        console.log(`[CENTRIS-SEARCH] Date changement statut: 0-${joursVendus} jours`);
      } catch (e) { console.warn(`[CENTRIS-SEARCH] Date: ${e.message}`); }
    }

    // 7. Genre propriété (Unifamiliale-spécifique)
    if (genrePropriete && type === 'unifamiliale') {
      try {
        await page.locator(`#${matrixSel(type, 'genre_propriete')}`).selectOption([genrePropriete]);
        console.log(`[CENTRIS-SEARCH] Genre ${genrePropriete} ✓`);
      } catch (e) { console.warn(`[CENTRIS-SEARCH] Genre: ${e.message}`); }
    }

    // 8. Type bâtiment
    if (typeBatiment && type === 'unifamiliale') {
      try {
        await page.locator(`#${matrixSel(type, 'type_batiment')}`).selectOption([typeBatiment]);
        console.log(`[CENTRIS-SEARCH] Type bât ${typeBatiment} ✓`);
      } catch (e) { console.warn(`[CENTRIS-SEARCH] Type bât: ${e.message}`); }
    }
    await page.waitForTimeout(1500);

    // 9. Click "Résultats"
    console.log('[CENTRIS-SEARCH] Click Résultats');
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a,button,input')]
        .find(b => /^résultats$/i.test((b.textContent || b.value || '').trim()));
      if (btn) btn.click();
    });
    await page.waitForURL(/Results/, { timeout: 20000 });
    await page.waitForTimeout(3500);

    // 10. Parse: count total + premiers listings
    const data = await page.evaluate(() => {
      const text = document.body.innerText;
      const m = text.match(/1\s*[àto-]\s*\d+\s*de\s*(\d+)/i) || text.match(/(\d+)\s*r[ée]sultats?/i);
      const totalCount = m ? parseInt(m[1]) : null;
      const rows = [...document.querySelectorAll('table tr')].filter(r => {
        const cells = r.querySelectorAll('td');
        return cells.length > 5 && [...cells].some(c => /^\d{7,9}$/.test(c.textContent.trim()));
      });
      const listings = rows.slice(0, 100).map(r => {
        const cells = [...r.querySelectorAll('td')].map(c => c.textContent.trim());
        return {
          mls: cells.find(c => /^\d{7,9}$/.test(c)),
          ville: cells[2] || '',
          adresse: cells[3] || '',
          prix_raw: cells.find(c => /\$/.test(c)),
          all_cells: cells,
        };
      });
      return { totalCount, listings };
    });

    return {
      success: true,
      count: data.totalCount || data.listings.length,
      total_displayed: data.listings.length,
      listings: data.listings,
      filters_applied: { type, region, municipalite, statut, prixMin, prixMax, joursVendus, genrePropriete, typeBatiment },
      message: `${data.totalCount || data.listings.length} résultats trouvés (${type}, ${statut}${region ? ', ' + region : ''}${municipalite ? ', ' + municipalite : ''})`,
    };
  } catch (e) {
    console.error('[CENTRIS-SEARCH] error:', e.message);
    return { success: false, message: e.message };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ZONE CENTRIS — Partager TOUS les documents d'un listing via courtier inscripteur
// Capturé live 2026-05-20 avec Shawn (listing #18366287, Johnathan Cloutier)
// Référence: memory reference_centris_zone_share_documents_flow.md
// ═══════════════════════════════════════════════════════════════════════════

// Login Zone Centris (différent de Matrix — portail courtier read-only)
async function loginCentrisZone(context) {
  const user = process.env.CENTRIS_USER;
  const pass = process.env.CENTRIS_PASS;
  if (!user || !pass) throw new Error('CENTRIS_USER / CENTRIS_PASS manquants');
  const page = await context.newPage();
  await page.setViewportSize(VIEWPORT);

  // Cookies cachés réutilisables (partagent souvent session Auth0 avec Matrix)
  const savedCookies = loadBotCentrisCookies();
  if (savedCookies?.length) {
    try {
      await context.addCookies(savedCookies);
      await page.goto('https://zone.centris.ca/Dashboard', { waitUntil: 'domcontentloaded', timeout: 20000 });
      const u = page.url();
      if (/Dashboard|Directory|Listings/i.test(u) && !/login|signin/i.test(u)) {
        console.log('[ZONE] Session cachée valide ✅');
        return page;
      }
    } catch {}
  }

  // Login frais
  console.log('[ZONE] Login frais Zone Centris...');
  await page.goto('https://zone.centris.ca/signin?1=1&langue=fr&fromExternal=ConsumerSiteMenu', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);
  await page.locator('input[type=text]').first().fill(user);
  await page.locator('input[type=password]').first().fill(pass);
  await page.locator('button:has-text("Connexion"), button[type=submit]').first().click();
  await page.waitForTimeout(4000);

  // MFA — prefer Email (SMS souvent rate-limited)
  const currentUrl = page.url();
  if (/mfa-sms-challenge|mfa-email-challenge|mfa-login-options/i.test(currentUrl)) {
    if (/mfa-sms-challenge/.test(currentUrl)) {
      // Switch à Email (SMS rate-limited souvent)
      const changeBtn = page.locator('a:has-text("Changer de méthode"), button:has-text("Changer")').first();
      if (await changeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await changeBtn.click();
        await page.waitForTimeout(2000);
        await page.locator('a:has-text("Courriel"), button:has-text("Courriel")').first().click();
        await page.waitForTimeout(2000);
      }
    }
    // Fetch code via Gmail bot endpoint
    const code = await fetchMFACodeFromBot(90000);
    if (!code) throw new Error('MFA timeout — aucun code Gmail Centris reçu en 90s');
    await page.locator('input[type=text], input[type=tel]').first().fill(code);
    await page.locator('button:has-text("Continuer"), button[type=submit]').first().click();
    await page.waitForTimeout(4000);
  }

  // Vérif logged
  if (!/Dashboard|Directory|Listings/i.test(page.url())) {
    throw new Error(`Zone login échoué — URL: ${page.url().substring(0, 100)}`);
  }
  console.log('[ZONE] Logged ✅');
  // Save cookies pour reuse
  try {
    const cookies = await context.cookies();
    pushCookiesToBot(cookies).catch(() => {});
  } catch {}
  return page;
}

/**
 * Identifie le courtier inscripteur d'un listing Centris (sans login requis).
 * @param {string} centrisNum
 * @returns {Promise<{name, agency, phone, source}>}
 */
async function getListingBroker(centrisNum, opts = {}) {
  // Strategy A — si page Zone déjà accessible (via context loggé), scrape l'onglet Courtiers
  // Strategy B — fallback Centris.ca public (URL og:title + meta)
  if (opts.page) {
    try {
      const url = `https://zone.centris.ca/Listings/${centrisNum}/Brokers`;
      await opts.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await opts.page.waitForTimeout(1500);
      const data = await opts.page.evaluate(() => {
        // Trouve le bloc "Inscripteur" (sur Zone, la section Courtiers)
        const blocks = [...document.querySelectorAll('*')].filter(el => /inscripteur/i.test(el.innerText?.substring(0, 200) || ''));
        if (blocks.length === 0) return null;
        const ctx = blocks[0].closest('section, div, article') || blocks[0];
        const txt = ctx.innerText || '';
        // Patterns nom courtier (2-4 mots, première lettre maj)
        const nameMatch = txt.match(/([A-ZÀ-Ÿ][a-zà-ÿ\-']+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ\-']+){1,3})\s+Courtier/);
        const agencyMatch = txt.match(/(RE\/?MAX[^\n]{0,50}|Royal LePage[^\n]{0,40}|Sutton[^\n]{0,40}|Via Capitale[^\n]{0,40}|Century 21[^\n]{0,40}|Keller Williams[^\n]{0,40}|Sotheby[^\n]{0,40})/);
        const phoneMatch = txt.match(/(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/);
        return {
          name: nameMatch?.[1]?.trim() || null,
          agency: agencyMatch?.[1]?.trim() || null,
          phone: phoneMatch?.[1] || null,
          source: 'zone-brokers-tab',
        };
      });
      if (data && (data.name || data.agency)) return data;
    } catch (e) { console.warn('[ZONE] broker via Zone fail:', e.message); }
  }
  // Strategy B — fallback Centris.ca public
  try {
    const r = await fetch(`https://www.centris.ca/fr/properties~a-vendre/${centrisNum}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (r.ok) {
      const html = await r.text();
      // og:title contient typiquement "{Adresse} | Courtier {Nom Prenom}"
      const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i)?.[1] || '';
      const ogDesc  = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)/i)?.[1] || '';
      // Cherche pattern "Courtier {Nom Prenom}" dans og:title / og:description
      const brokerMatch = (ogTitle + ' ' + ogDesc).match(/(?:Courtier(?:\s+immobilier)?(?:\s+r[eé]sidentiel)?\s+|inscripteur[\s:]+)([A-ZÀ-Ÿ][a-zà-ÿ\-']+(?:\s+[A-ZÀ-Ÿ][a-zà-ÿ\-']+){1,3})/);
      const agencyMatch = html.match(/(RE\/?MAX[^<>]{0,40}|Royal LePage[^<>]{0,40}|Sutton[^<>]{0,40}|Via Capitale[^<>]{0,40}|Century 21[^<>]{0,40}|Keller Williams[^<>]{0,40}|Sotheby[^<>]{0,40})/);
      const phoneMatch = (ogDesc || html).match(/(\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4})/);
      return {
        name: brokerMatch?.[1]?.trim() || null,
        agency: agencyMatch?.[1]?.replace(/<[^>]+>/g, '').trim() || null,
        phone: phoneMatch?.[1] || null,
        source: 'centris.ca-public',
        debug_og_title: ogTitle.substring(0, 120),
      };
    }
  } catch (e) { console.warn('[ZONE] getListingBroker public fail:', e.message); }
  return { name: null, agency: null, phone: null, source: 'unknown' };
}

/**
 * Partage TOUS les documents d'un listing via Zone Centris (cherche courtier auto).
 * @param {object} opts
 * @param {string} opts.centris_num — # MLS
 * @param {string} opts.email — email destinataire (ignoré si dry_run=true)
 * @param {boolean} [opts.dry_run] — preview-only: identifie courtier + liste docs SANS envoyer
 * @param {boolean} [opts.sendSelfCopy] — défaut false
 * @param {string} [opts.langue] — 'fr' (défaut) | 'en'
 * @param {string} [opts.message] — message custom (sinon défaut Centris)
 * @returns {Promise<{success, broker_info, docs_shared, docs_list?, sent_to, listing_url, dry_run?}>}
 */
async function shareCentrisZoneDocuments(opts = {}) {
  if (!CUA_AVAILABLE()) return { success: false, message: 'Playwright non disponible' };
  loadDeps();
  initDirs();
  const { centris_num, email, dry_run = false, sendSelfCopy = false, langue = 'fr', message } = opts;
  if (!centris_num) return { success: false, message: 'centris_num requis' };
  if (!dry_run && !email) return { success: false, message: 'email requis (sauf dry_run=true)' };

  let browser = null;
  try {
    browser = await launchBrowser();
    const context = await newStealthContext(browser);
    const page = await loginCentrisZone(context);

    // 1. Get broker info VIA Zone (onglet Courtiers, plus fiable que centris.ca public)
    const broker = await getListingBroker(centris_num, { page });
    console.log(`[ZONE${dry_run?'-DRY':''}] Listing #${centris_num} → courtier inscripteur: ${broker.name || '?'} (${broker.agency || '?'}) source=${broker.source}`);

    // 2. URL directe page Documents
    console.log(`[ZONE${dry_run?'-DRY':''}] Navigate /Listings/${centris_num}/Documents`);
    await page.goto(`https://zone.centris.ca/Listings/${centris_num}/Documents`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3500);

    // 3. Liste les docs (et coche pour count) — capture noms+tailles
    const docsInfo = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('tr, [role=row], li')].filter(r => r.querySelector('input[type=checkbox]'));
      const docs = [];
      for (const row of rows) {
        const cb = row.querySelector('input[type=checkbox]');
        if (!cb || cb.disabled) continue;
        const txt = row.innerText || row.textContent || '';
        // Filtre: skip header table "Description Taille"
        if (/^(Description\s+Taille|Description\tTaille)$/i.test(txt.trim())) continue;
        // Capture: nom doc + taille KB/MB si visible
        const sizeMatch = txt.match(/([\d,.]+)\s*(KB|MB|Mo|Ko)/i);
        const name = txt.split('\n').filter(Boolean)[0]?.substring(0, 120) || '(sans nom)';
        // Skip ligne sans contenu utile
        if (!name || name.toLowerCase().includes('description')) continue;
        docs.push({ name: name.trim(), size: sizeMatch?.[0] || null });
        if (!cb.checked) cb.click();
      }
      return docs;
    });
    const checkedCount = docsInfo.length;
    console.log(`[ZONE${dry_run?'-DRY':''}] ${checkedCount} documents listés${dry_run?' (DRY-RUN)':' cochés'}`);
    if (checkedCount === 0) {
      return { success: false, message: `Aucun document trouvé pour #${centris_num} (listing inexistant ou pas de docs)`, broker_info: broker };
    }

    // DRY-RUN: short-circuit ici, pas d'envoi
    if (dry_run) {
      return {
        success: true,
        dry_run: true,
        broker_info: broker,
        docs_count: checkedCount,
        docs_list: docsInfo,
        listing_url: `https://zone.centris.ca/Listings/${centris_num}/Documents`,
        message: `PREVIEW — ${checkedCount} docs prêts à partager. Confirme avec envoyer_tous_documents_zone pour livrer.`,
      };
    }

    // 4. Click "Partager les documents"
    await page.locator('button[title="Partager les documents"]').click();
    await page.waitForTimeout(2000);

    // 5. Étape 1/2: garder defaults (Client + Impérial) → Suivant
    await page.locator('button:has-text("Suivant")').click();
    await page.waitForTimeout(2000);

    // 6. Étape 2/2: fill destinataire + options
    console.log(`[ZONE] Remplir email destinataire: ${email}`);
    await page.fill('#to', email);
    await page.waitForTimeout(800);
    await page.locator('#to').press('Enter');
    await page.waitForTimeout(500);

    if (sendSelfCopy) {
      await page.locator('input[name=sendSelfCopy]').check();
    }
    if (langue === 'en') {
      await page.locator('#language-0').click();
    }
    if (message) {
      await page.fill('#message', message);
    }

    // 7. Click Partager (N)
    console.log('[ZONE] Click Partager');
    await page.locator('button:has-text("Partager (")').click();

    // 8. Wait confirmation (toast, modal closed, ou redirect)
    await page.waitForTimeout(4000);
    const modalGone = await page.evaluate(() => !document.querySelector('[role=dialog]:has(button:contains("Partager"))'));

    return {
      success: true,
      broker_info: broker,
      docs_shared: checkedCount,
      sent_to: email,
      send_self_copy: sendSelfCopy,
      langue,
      listing_url: `https://zone.centris.ca/Listings/${centris_num}/Documents`,
      via: 'zone-centris-share',
    };
  } catch (e) {
    console.error('[ZONE] shareCentrisZoneDocuments error:', e.message);
    return { success: false, message: e.message };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

/**
 * Extract photos URLs haute-résolution depuis page publique Centris.
 * Source: www.centris.ca/fr/properties~a-vendre/{N} (zero login, fetch HTTP simple).
 * Returns: { success, photos: [urls...], main: url, count, broker_info: {} }
 *
 * Anticipations proactives:
 * - 404 si listing pas en ligne / retiré → return success:false
 * - Photos URL pattern Centris CDN: mspublic.centris.ca/media.ashx?id=X&t=pi&sm=l&w=1024
 * - Fallback: si pas de photos extraites, return [] (HTML email garde placeholders)
 */
async function getCentrisListingPhotos(centrisNum) {
  try {
    const url = `https://www.centris.ca/fr/properties~a-vendre/${centrisNum}`;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'fr-CA,fr;q=0.9',
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow',
    });
    if (!r.ok) return { success: false, message: `HTTP ${r.status} pour listing #${centrisNum}` };
    const html = await r.text();

    // Extract photos URLs — Centris CDN pattern: mspublic.centris.ca/media.ashx?id=X&t=pi
    // FILTRE STRICT: garder UNIQUEMENT t=pi (type photo listing), exclure boutons/icônes
    const photoRegex = /(https?:\/\/mspublic\.centris\.ca\/media\.ashx\?[^"'\s]+)/gi;
    const allMatches = [...html.matchAll(photoRegex)].map(m => m[1]);
    const seen = new Set();
    const photos = [];
    for (const u of allMatches) {
      const clean = u.replace(/&amp;/g, '&');
      if (seen.has(clean)) continue;
      seen.add(clean);
      // GARDER UNIQUEMENT les photos du listing (t=pi = property image)
      if (!/[?&]t=pi(?:&|$)/i.test(clean)) continue;
      // Préférer grandes versions (w=1024 ou plus) — upgrade URL si possible
      let upgraded = clean;
      if (!/[?&]w=/i.test(upgraded)) upgraded += '&w=1024';
      else upgraded = upgraded.replace(/([?&])w=\d+/i, '$1w=1024');
      photos.push(upgraded);
    }

    // Extract broker name from page (souvent dans og:description ou meta)
    const ogDesc = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)/i)?.[1] || '';
    const ogTitle = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i)?.[1] || '';
    // Decode HTML entities (à é è ô etc.) — anti-fragilité Shawn 2026-06-01
    const decodeEntities = s => String(s||'')
      .replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');
    // Extract adresse complète — chercher dans body HTML (h1, h2, address tags + structured data)
    // Priorité: JSON-LD > h1/h2 > og:title fallback
    let adresseRaw = '';
    // 1. JSON-LD structured data
    const jsonLdMatch = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const ld = JSON.parse(jsonLdMatch[1]);
        const addr = ld.address || ld.location?.address || (Array.isArray(ld) ? ld[0]?.address : null);
        if (addr) {
          adresseRaw = [addr.streetAddress, addr.addressLocality, addr.addressRegion].filter(Boolean).join(', ');
        } else if (ld.name) {
          adresseRaw = ld.name;
        }
      } catch {}
    }
    // 2. h1/h2 avec une adresse type "XXX Rue/Ch/Av/Boul ..., Ville"
    if (!adresseRaw) {
      const h1Match = html.match(/<h[12][^>]*>([^<]*(?:Rue|Ch\.|Chemin|Av\.|Avenue|Boul|Rang|Route|Mont[ée]e|Place|Cr\.|Croissant)[^<]*)<\/h[12]>/i);
      if (h1Match) adresseRaw = h1Match[1];
    }
    // 3. Span/div avec class adresse
    if (!adresseRaw) {
      const spanMatch = html.match(/<(?:span|div)[^>]*class=["'][^"']*(?:address|adresse)[^"']*["'][^>]*>([^<]+)<\/(?:span|div)>/i);
      if (spanMatch) adresseRaw = spanMatch[1];
    }
    // 4. Fallback og:title
    if (!adresseRaw) adresseRaw = ogTitle.match(/^([^|]+)/)?.[1]?.trim() || '';
    const adresseMatch = decodeEntities(adresseRaw.replace(/\s+/g, ' ').trim());
    const prixMatch = ogDesc.match(/(\d[\d\s]*\$)/)?.[1] || '';
    // Extract description (souvent dans og:description après le prix)
    const descMatch = decodeEntities(ogDesc.replace(/^\d[\d\s]*\$\s*/, '').substring(0, 1000));
    // Extract specs si visible (chambres, sdb)
    const chambresMatch = html.match(/(\d+)\s*chambres?/i)?.[1] || '';
    const sdbMatch = html.match(/(\d+)\s*salles?\s+de\s+bain/i)?.[1] || '';

    return {
      success: photos.length > 0,
      photos: photos.slice(0, 50), // cap à 50
      main: photos[0] || null,
      count: photos.length,
      url_source: url,
      og_title: decodeEntities(ogTitle.substring(0, 200)),
      og_description: decodeEntities(ogDesc.substring(0, 500)),
      adresse: adresseMatch,
      prix: prixMatch,
      description: descMatch,
      chambres: chambresMatch,
      sdb: sdbMatch,
    };
  } catch (e) {
    return { success: false, message: `Exception getCentrisListingPhotos: ${e.message?.substring(0, 200)}` };
  }
}

/**
 * Télécharge la fiche descriptive PDF officielle Centris (Detaillé client avec album photos · Impérial)
 * Flow: Matrix UI direct (sans CUA agent — économique + fiable).
 * Login → Search → Click result → Imprimer → format → "Imprimer en PDF" → capture download
 *
 * Anticipations proactives:
 * - MFA timeout: 180s (vs 60s default cuaGetCentrisPDF)
 * - Cache 24h: skip re-download si fichier récent dispo
 * - Fallback: si "Imprimer en PDF" introuvable, use page.pdf() printBackground
 *
 * @param {string} centrisNum — # MLS (7-9 chiffres)
 * @param {object} opts — { format='detaille_client_album_imperial' }
 * @returns {Promise<{success, buffer, filename, fromCache, size, message}>}
 */
async function downloadCentrisFichePDF(centrisNum, opts = {}) {
  if (!CUA_AVAILABLE()) return { success: false, message: 'Playwright non disponible' };
  loadDeps();
  initDirs();
  const { format = 'detaille_client_album_imperial' } = opts;

  // Cache 24h
  const pdfCacheFile = path.join(PDF_DIR, `centris_${centrisNum}_fiche_${format}.pdf`);
  if (fs.existsSync(pdfCacheFile)) {
    const stat = fs.statSync(pdfCacheFile);
    if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000 && stat.size > 10000) {
      console.log(`[FICHE-PDF] Cache hit: ${pdfCacheFile} (${Math.round(stat.size/1024)}KB)`);
      return {
        success: true,
        buffer: fs.readFileSync(pdfCacheFile),
        filename: `Fiche_Centris_${centrisNum}.pdf`,
        fromCache: true,
        size: stat.size,
      };
    }
  }

  const FORMAT_TITLES = {
    detaille_client_album_imperial: 'Detaillé client avec album de photos (Impérial)',
    detaille_client_imperial: 'Detaillé client (Impérial)',
    sommaire_imperial: 'Sommaire (Impérial)',
  };
  const formatTitle = FORMAT_TITLES[format] || FORMAT_TITLES.detaille_client_album_imperial;

  let browser = null;
  try {
    browser = await launchBrowser();
    const context = await newStealthContext(browser);
    // Capture downloads
    let downloadedBuffer = null;
    let downloadedFilename = `Fiche_Centris_${centrisNum}.pdf`;
    context.on('page', p => {
      p.on('download', async (d) => {
        try {
          const tmpPath = path.join(PDF_DIR, `dl_${Date.now()}_${d.suggestedFilename()}`);
          await d.saveAs(tmpPath);
          downloadedBuffer = fs.readFileSync(tmpPath);
          downloadedFilename = d.suggestedFilename() || downloadedFilename;
          fs.unlinkSync(tmpPath);
        } catch (e) { console.warn('[FICHE-PDF] download error:', e.message); }
      });
    });

    const page = await loginCentris(context);

    // 1. Search listing
    console.log(`[FICHE-PDF] Search #${centrisNum}`);
    await page.fill('#QueryText', String(centrisNum));
    await page.locator('#QueryText').press('Enter');
    await page.waitForTimeout(3000);

    // 2. Click result link
    const clicked = await page.evaluate((n) => {
      const a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === String(n));
      if (a) { a.click(); return true; }
      return false;
    }, centrisNum);
    if (!clicked) throw new Error(`Listing #${centrisNum} non trouvé`);
    await page.waitForTimeout(3000);

    // 3. Click Imprimer
    console.log('[FICHE-PDF] Click Imprimer');
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a,button,input')]
        .find(b => /^imprimer$/i.test((b.textContent || b.value || '').trim()));
      if (btn) btn.click();
    });
    await page.waitForURL(/PrintOptions/, { timeout: 20000 });
    await page.waitForTimeout(2000);

    // 4. Select format
    console.log(`[FICHE-PDF] Format: ${formatTitle}`);
    const formatSelected = await page.evaluate((title) => {
      const li = [...document.querySelectorAll('li')].find(l => l.title === title);
      const cb = li?.querySelector('input[type=checkbox]');
      if (cb) { cb.checked = true; cb.click(); return true; }
      return false;
    }, formatTitle);
    if (!formatSelected) throw new Error(`Format "${formatTitle}" non trouvé`);
    await page.waitForTimeout(1000);

    // 5. Click "Imprimer en PDF" (PAS "Envoyer par courriel")
    console.log('[FICHE-PDF] Click Imprimer en PDF');
    const printClicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll('a,button,input')]
        .find(b => /imprimer\s+en\s+pdf/i.test((b.textContent || b.value || '').trim()));
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (!printClicked) throw new Error('Bouton "Imprimer en PDF" non trouvé');

    // 6. Wait for download
    const startWait = Date.now();
    while (!downloadedBuffer && (Date.now() - startWait) < 45000) {
      await page.waitForTimeout(500);
    }

    if (!downloadedBuffer) {
      // Fallback page.pdf() si pas de download capturé
      console.log('[FICHE-PDF] Fallback page.pdf()');
      try {
        const pdfBuffer = await page.pdf({ format: 'Letter', printBackground: true });
        if (pdfBuffer && pdfBuffer.length > 5000) {
          fs.writeFileSync(pdfCacheFile, pdfBuffer);
          return { success: true, buffer: pdfBuffer, filename: downloadedFilename, fromCache: false, size: pdfBuffer.length, via: 'page.pdf' };
        }
      } catch {}
      throw new Error('Timeout download PDF (45s) + fallback page.pdf échoué');
    }

    fs.writeFileSync(pdfCacheFile, downloadedBuffer);
    console.log(`[FICHE-PDF] ✅ ${Math.round(downloadedBuffer.length/1024)}KB`);
    return {
      success: true,
      buffer: downloadedBuffer,
      filename: downloadedFilename,
      fromCache: false,
      size: downloadedBuffer.length,
      via: 'matrix-direct',
    };
  } catch (e) {
    console.error('[FICHE-PDF] error:', e.message);
    return { success: false, message: e.message?.substring(0, 200) };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

module.exports = {
  getCentrisListingPhotos,
  downloadCentrisFichePDF,
  cuaGetCentrisPDF,
  cuaGetCentrisAnnexes,
  cuaNavigate,
  cuaStatus,
  cuaCleanup,
  CUA_AVAILABLE,
  parsePDFText,
  extractCentrisPDFData,
  sendCentrisListingByEmail,
  searchCentrisVendus,
  shareCentrisZoneDocuments,
  getListingBroker,
  _loginCentrisZone: loginCentrisZone,
  // Internals exposés pour tests
  _loginCentris: loginCentris,
  _runCUATask: runCUATask,
  _executeCUAAction: executeCUAAction,
  _newStealthContext: newStealthContext,
};
