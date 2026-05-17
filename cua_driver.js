// cua_driver.js — Computer Use Agent Driver
// Pilote Playwright headless avec Claude Computer Use API pour naviguer
// agent.centris.ca, télécharger fiches PDF + annexes (DV, certificat, plans).
//
// Architecture:
//   screenshot → Claude CUA analyse → action (click/type/scroll) → repeat
//   jusqu'à PDF trouvé ou max 25 itérations
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
const CENTRIS_BASE   = 'https://agent.centris.ca';
const MATRIX_BASE    = 'https://matrix.agent.centris.ca';

// Lazy-load — Playwright optionnel (pas dans package.json par défaut)
let playwright = null;
let Anthropic   = null;

function loadDeps() {
  if (!playwright) {
    try { playwright = require('playwright'); }
    catch { throw new Error('Playwright non installé. Run: npm install playwright && npx playwright install chromium'); }
  }
  if (!Anthropic) {
    try { Anthropic = require('@anthropic-ai/sdk'); }
    catch { throw new Error('@anthropic-ai/sdk non installé'); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// VÉRIFIER DISPONIBILITÉ (sans throw)
// ═══════════════════════════════════════════════════════════════════════════

let _cuaAvailable = null;
function CUA_AVAILABLE() {
  if (_cuaAvailable !== null) return _cuaAvailable;
  try {
    require.resolve('playwright');
    require.resolve('@anthropic-ai/sdk');
    _cuaAvailable = true;
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

// ═══════════════════════════════════════════════════════════════════════════
// LOGIN CENTRIS (avec ou sans session cachée)
// ═══════════════════════════════════════════════════════════════════════════

async function loginCentris(context) {
  const user = process.env.CENTRIS_USER;
  const pass = process.env.CENTRIS_PASS;
  if (!user || !pass) throw new Error('CENTRIS_USER / CENTRIS_PASS manquants dans env vars');

  const page = await context.newPage();
  await page.setViewportSize(VIEWPORT);

  // Essayer session cachée d'abord
  const savedCookies = loadSession();
  if (savedCookies) {
    try {
      await context.addCookies(savedCookies);
      await page.goto(`${CENTRIS_BASE}/Matrix`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2000);

      // Vérifier qu'on est bien connecté (pas redirigé vers login)
      const url = page.url();
      if (!url.includes('/login') && !url.includes('/auth') && !url.includes('signin')) {
        console.log('[CUA] Session cachée valide ✅');
        return page;
      }
      console.log('[CUA] Session expirée, re-login...');
      clearSession();
    } catch (e) {
      console.warn('[CUA] Échec session cachée:', e.message);
      clearSession();
    }
  }

  // Login frais
  console.log('[CUA] Login Centris agent...');
  await page.goto(`${CENTRIS_BASE}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);

  // Auth0 flow — identifier puis password (split form)
  const currentUrl = page.url();
  console.log('[CUA] URL login:', currentUrl);

  // Step 1: email / identifiant
  try {
    const emailField = page.locator('input[name="username"], input[type="email"], #username, #identifier').first();
    await emailField.waitFor({ timeout: 8000 });
    await emailField.fill(user);

    // Chercher bouton Continue / Next
    const continueBtn = page.locator('button[type="submit"], button:has-text("Continue"), button:has-text("Continuer"), button:has-text("Next")').first();
    await continueBtn.click();
    await page.waitForTimeout(1500);
  } catch {
    // Peut-être form unique username+password
  }

  // Step 2: password
  try {
    const passField = page.locator('input[name="password"], input[type="password"], #password').first();
    await passField.waitFor({ timeout: 8000 });
    await passField.fill(pass);

    const submitBtn = page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Connexion"), button:has-text("Log In")').first();
    await submitBtn.click();
    await page.waitForTimeout(3000);
  } catch (e) {
    throw new Error(`Login step password échoué: ${e.message}`);
  }

  // Gérer MFA SMS si présent
  const mfaField = page.locator('input[name="code"], input[placeholder*="code"], input[placeholder*="Code"]').first();
  const mfaVisible = await mfaField.isVisible().catch(() => false);
  if (mfaVisible) {
    console.log('[CUA] MFA requis — attente code SMS (max 90s)...');
    // Le LaunchAgent Mac gère le SMS bridge — attendre que /data/centris_mfa.txt apparaisse
    const mfaCode = await waitForMFACode(90000);
    if (!mfaCode) throw new Error('MFA timeout — pas de code SMS reçu en 90s');
    await mfaField.fill(mfaCode);
    const mfaSubmit = page.locator('button[type="submit"]').first();
    await mfaSubmit.click();
    await page.waitForTimeout(3000);
    // Effacer le fichier MFA
    try { fs.unlinkSync(path.join(DATA_DIR, 'centris_mfa.txt')); } catch {}
  }

  // Vérifier login réussi
  const finalUrl = page.url();
  if (finalUrl.includes('/login') || finalUrl.includes('/auth')) {
    throw new Error(`Login Centris échoué — URL finale: ${finalUrl}`);
  }

  // Sauvegarder session
  const cookies = await context.cookies();
  saveSession(cookies);
  console.log('[CUA] Login Centris réussi ✅ Session sauvegardée.');
  return page;
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
        model: 'claude-opus-4-5',
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
    browser = await playwright.chromium.launch({
      headless: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--window-size=1280,900'
      ]
    });

    const context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      acceptDownloads: true,
      locale: 'fr-CA',
    });

    const page = await loginCentris(context);

    // Essayer URL directe Matrix d'abord
    try {
      await page.goto(`${MATRIX_BASE}/Listing/${centrisNum}`, {
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
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      acceptDownloads: true,
      locale: 'fr-CA',
    });

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

URL à essayer: ${MATRIX_BASE}/Listing/${centrisNum}
`.trim();

    try {
      await page.goto(`${MATRIX_BASE}/Listing/${centrisNum}`, {
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
    browser = await playwright.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });

    const context = await browser.newContext({
      viewport: VIEWPORT,
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      acceptDownloads: true,
      locale: 'fr-CA',
    });

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

  return {
    available,
    playwright: available ? 'installed' : 'missing (npm install playwright)',
    session: sessionAge !== null
      ? (sessionAge < SESSION_TTL / 60000 ? `active (${sessionAge}min ago)` : 'expired')
      : 'none',
    cachedPDFs,
    dataDir: DATA_DIR,
    maxSteps: MAX_STEPS
  };
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

module.exports = {
  cuaGetCentrisPDF,
  cuaGetCentrisAnnexes,
  cuaNavigate,
  cuaStatus,
  cuaCleanup,
  CUA_AVAILABLE,
  // Internals exposés pour tests
  _loginCentris: loginCentris,
  _runCUATask: runCUATask,
  _executeCUAAction: executeCUAAction,
};
