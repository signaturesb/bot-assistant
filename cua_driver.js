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
const nodeCrypto = require('crypto');
const {
  readSessionFile,
  removeSessionFile,
  writeSessionFile,
} = require('./lib/centris_session_store');

// ═══════════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════════

const DATA_DIR       = fs.existsSync('/data') ? '/data' : '/tmp';
const SESSION_FILE   = path.join(DATA_DIR, 'cua_session.json');
const STORAGE_STATE_FILE = path.join(DATA_DIR, 'centris_storage_state.json');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'cua_screenshots');
const PDF_DIR        = path.join(DATA_DIR, 'cua_pdfs');
const SESSION_TTL    = clampDurationMs(process.env.CENTRIS_SESSION_TTL_MS, 25 * 24 * 60 * 60 * 1000, 60 * 60 * 1000, 30 * 24 * 60 * 60 * 1000);
const MAX_STEPS      = 25;                      // iterations max par tâche
const VIEWPORT       = { width: 1280, height: 900 };
// Centris a migré 2026: agent.centris.ca retiré → matrix.centris.ca
const CENTRIS_BASE   = 'https://matrix.centris.ca';
const MATRIX_BASE    = 'https://matrix.centris.ca';
const PUBLIC_BASE    = 'https://www.centris.ca';
const MANUAL_MFA_TTL = 2 * 60 * 1000;
const MATRIX_DOCUMENT_FILE_MAX_BYTES = 25 * 1024 * 1024;
const MATRIX_DOCUMENT_TOTAL_MAX_BYTES = 120 * 1024 * 1024;
const MATRIX_DOCUMENT_DOWNLOAD_ATTEMPTS = 3;
const EXPLICIT_CENTRIS_SEND_RE = /^(?:envoie|envoie-le|send)[!.]?$/i;

function clampDurationMs(value, fallback, min, max) {
  const parsed = Number(value);
  return Math.max(min, Math.min(Number.isFinite(parsed) && parsed > 0 ? parsed : fallback, max));
}

// Pont MFA en mémoire entre Telegram (/mfa) et la session Playwright active.
// Le code est accepté uniquement pendant une attente MFA, consommé une fois,
// puis oublié. Il n'est jamais écrit sur disque ni journalisé.
let centrisMFAWaiting = false;
let pendingManualMFACode = null;
let activeCentrisLoginPromise = null;
const zonePreviewInFlight = new Map();

function isAwaitingCentrisMFA() {
  return centrisMFAWaiting;
}

function ingestManualMFACode(code) {
  const normalized = String(code || '').trim();
  if (!centrisMFAWaiting || !/^\d{6}$/.test(normalized)) return false;
  pendingManualMFACode = { code: normalized, receivedAt: Date.now() };
  return true;
}

function takeManualMFACode() {
  const pending = pendingManualMFACode;
  pendingManualMFACode = null;
  if (!pending || Date.now() - pending.receivedAt > MANUAL_MFA_TTL) return null;
  return pending.code;
}

function hasExplicitCentrisSendConfirmation(value) {
  return EXPLICIT_CENTRIS_SEND_RE.test(String(value || '').trim());
}

const CENTRIS_DASH_RE = /[\u2010-\u2015\u2212]/g;

function normalizeCentrisLabel(label, { stripAccents = false } = {}) {
  let normalized = String(label || '')
    .normalize('NFC')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(CENTRIS_DASH_RE, '-')
    .replace(/[\u00A0\u2000-\u200B\s]+/g, ' ')
    .trim();
  if (stripAccents) {
    normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  return normalized;
}

function normalizeCentrisMatchKey(label) {
  return normalizeCentrisLabel(label, { stripAccents: true }).toLowerCase();
}

function extractCentrisLotNumber(label) {
  const match = normalizeCentrisLabel(label).match(/\blot\s*([0-9][0-9\s]*[0-9]|[0-9])\b/i);
  return match ? match[1].replace(/\s+/g, '') : null;
}

function parseCentrisDisplaySize(sizeDisplay) {
  if (sizeDisplay === null || sizeDisplay === undefined || sizeDisplay === '') return null;
  const match = String(sizeDisplay).trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*([kmg])(?:o|b)?$/i);
  if (!match) return null;
  const amount = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(amount)) return null;
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'k' ? 1024 : unit === 'm' ? 1024 ** 2 : 1024 ** 3;
  return Math.round(amount * multiplier);
}

const CENTRIS_DOCUMENT_CATEGORIES = Object.freeze([
  {
    key: 'declaration_vendeur_principale',
    label: 'Déclaration du vendeur (principale)',
    test: (doc) => doc.source_section === 'principal_dv' || (
      doc.source_section !== 'additional_documents' &&
      !/modification/.test(doc.match_key) &&
      (/declaration.*vendeur/.test(doc.match_key) || /(^|\s)oui\s+dv[-\s]?\d+/.test(doc.match_key) || /^dv[-\s]?\d+/.test(doc.match_key) || /\bdv\b/.test(doc.match_key))
    ),
  },
  { key: 'modification_dv', label: 'Modification de la déclaration du vendeur', test: (doc) => /modification/.test(doc.match_key) && (/\bdv\b/.test(doc.match_key) || /declaration/.test(doc.match_key)) },
  { key: 'fiche_detaillee', label: 'Fiche détaillée', test: (doc) => /fiche/.test(doc.match_key) || /descriptive/.test(doc.match_key) || /\bdetail/.test(doc.match_key) },
  { key: 'plan_cadastral', label: 'Plan cadastral', test: (doc) => /cadastr/.test(doc.match_key) },
  { key: 'plan_autre', label: 'Autre plan', test: (doc) => /\bplan\b/.test(doc.match_key) || /implantation/.test(doc.match_key) },
  { key: 'certificat_localisation', label: 'Certificat de localisation', test: (doc) => /certificat.*localisation/.test(doc.match_key) || /\bcert\.?\s*loc/.test(doc.match_key) },
  { key: 'taxes_scolaires', label: 'Taxes scolaires', test: (doc) => /taxe.*scolair/.test(doc.match_key) },
  { key: 'taxes_municipales', label: 'Taxes municipales', test: (doc) => /taxe.*municip/.test(doc.match_key) },
  { key: 'role_evaluation', label: "Rôle d'évaluation", test: (doc) => /role.*evaluation/.test(doc.match_key) },
  { key: 'obligation_courtier', label: 'Obligation du courtier', test: (doc) => /obligation.*courtier/.test(doc.match_key) },
]);

const CENTRIS_CATEGORY_LABELS = Object.freeze(Object.fromEntries(
  CENTRIS_DOCUMENT_CATEGORIES.map((category) => [category.key, category.label])
));

function stableCentrisManifestId(payload) {
  return nodeCrypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function canonicalManifestDocs(docs, { includeContent = false } = {}) {
  return docs.map((doc) => {
    const item = {
      category: doc.category,
      label_key: doc.match_key,
      lot: doc.lot,
      size_bytes: doc.size_bytes,
    };
    if (includeContent) {
      item.actual_size_bytes = doc.actual_size_bytes;
      item.page_count = doc.page_count;
      item.sha256 = doc.sha256;
    }
    return item;
  }).sort((a, b) => {
    const left = JSON.stringify(a);
    const right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

function buildCentrisContentManifest(centrisNum, docs = []) {
  const list = Array.isArray(docs) ? docs : [];
  if (!list.length) {
    return {
      complete: false,
      content_manifest_id: null,
      incomplete_document_ids: [],
      error_code: 'CENTRIS_DOCUMENT_LIST_EMPTY',
    };
  }
  const incomplete = list.filter((doc) =>
    !/^[a-f0-9]{64}$/i.test(String(doc?.sha256 || '')) ||
    !Number.isInteger(doc?.page_count) || doc.page_count < 1 ||
    !Number.isInteger(doc?.actual_size_bytes) || doc.actual_size_bytes < 1
  );
  if (incomplete.length) {
    return {
      complete: false,
      content_manifest_id: null,
      incomplete_document_ids: incomplete.map((doc) => doc?.id || null),
    };
  }
  return {
    complete: true,
    content_manifest_id: stableCentrisManifestId({
      centris_num: String(centrisNum || ''),
      docs: canonicalManifestDocs(list, { includeContent: true }),
    }),
    incomplete_document_ids: [],
  };
}

function addCentrisContentMetadata(doc, bytes, pageCount) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  if (!buffer.length) throw new Error('CENTRIS_DOCUMENT_EMPTY');
  if (buffer.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) === -1) {
    throw new Error('CENTRIS_DOCUMENT_NOT_PDF');
  }
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error('CENTRIS_DOCUMENT_PAGE_COUNT_INVALID');
  return {
    ...doc,
    actual_size_bytes: buffer.length,
    page_count: pageCount,
    sha256: nodeCrypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function buildCentrisDocumentInventory(centrisNum, docs = [], options = {}) {
  const rawList = Array.isArray(docs) ? docs : [];
  const normalizedDocs = rawList.map((doc, index) => {
    const labelOriginal = String(doc?.label_original || doc?.name || '').trim();
    const sizeDisplay = doc?.size_display ?? doc?.size ?? null;
    const labelNormalized = normalizeCentrisLabel(labelOriginal);
    const sourceSection = String(doc?.source_section || '').trim() || null;
    const provenance = String(doc?.provenance || '').trim() || 'unknown';
    return {
      id: nodeCrypto.createHash('sha256').update(`${index}|${labelOriginal}|${sizeDisplay || ''}`).digest('hex').slice(0, 16),
      name: labelOriginal,
      size: sizeDisplay === null ? null : String(sizeDisplay).trim(),
      label_original: labelOriginal,
      label_normalized: labelNormalized,
      match_key: normalizeCentrisMatchKey(labelOriginal),
      category: null,
      subtype: doc?.subtype || null,
      size_display: sizeDisplay === null ? null : String(sizeDisplay).trim(),
      size_bytes: parseCentrisDisplaySize(sizeDisplay),
      actual_size_bytes: Number.isInteger(doc?.actual_size_bytes) ? doc.actual_size_bytes : null,
      lot: extractCentrisLotNumber(labelOriginal),
      order: index,
      provenance,
      source_section: sourceSection,
      url: doc?.url || null,
      action_id: doc?.action_id || null,
      page_count: Number.isInteger(doc?.page_count) ? doc.page_count : null,
      sha256: /^[a-f0-9]{64}$/i.test(String(doc?.sha256 || '')) ? String(doc.sha256).toLowerCase() : null,
    };
  }).filter((doc) => doc.label_original);

  const claimed = new Set();
  const byCategory = new Map(CENTRIS_DOCUMENT_CATEGORIES.map((category) => [category.key, []]));
  for (const category of CENTRIS_DOCUMENT_CATEGORIES) {
    for (const doc of normalizedDocs) {
      if (claimed.has(doc.id) || !category.test(doc)) continue;
      doc.category = category.key;
      claimed.add(doc.id);
      byCategory.get(category.key).push(doc);
    }
  }

  const unclassified = normalizedDocs.filter((doc) => !claimed.has(doc.id));
  for (const doc of unclassified) doc.category = 'document_autre';

  const present = CENTRIS_DOCUMENT_CATEGORIES.flatMap((category) => {
    const categoryDocs = byCategory.get(category.key);
    return categoryDocs.length ? [{
      key: category.key,
      label: category.label,
      docs: categoryDocs,
      matches: categoryDocs.map((doc) => doc.label_original),
    }] : [];
  });
  if (unclassified.length) {
    present.push({
      key: 'document_autre',
      label: 'Autre document',
      docs: unclassified,
      matches: unclassified.map((doc) => doc.label_original),
    });
  }

  const requestedExpectedCategories = [...new Set(
    Array.isArray(options.expectedCategories) ? options.expectedCategories : []
  )];
  const invalidExpectedCategories = requestedExpectedCategories
    .filter((key) => !Object.prototype.hasOwnProperty.call(CENTRIS_CATEGORY_LABELS, key));
  const expectedCategories = requestedExpectedCategories
    .filter((key) => Object.prototype.hasOwnProperty.call(CENTRIS_CATEGORY_LABELS, key));
  const missingExpectedDocuments = expectedCategories
    .filter((key) => !(byCategory.get(key) || []).length)
    .map((key) => ({ key, label: CENTRIS_CATEGORY_LABELS[key] }));

  const inventoryManifestId = stableCentrisManifestId({
    centris_num: String(centrisNum || ''),
    docs: canonicalManifestDocs(normalizedDocs),
  });
  const contentManifest = buildCentrisContentManifest(centrisNum, normalizedDocs);
  return {
    docs: normalizedDocs,
    present,
    known_categories: Object.keys(CENTRIS_CATEGORY_LABELS),
    expected_documents: expectedCategories,
    invalid_expected_categories: invalidExpectedCategories,
    inventory_valid: invalidExpectedCategories.length === 0,
    missing_expected_documents: missingExpectedDocuments,
    missing: missingExpectedDocuments,
    inventory_manifest_id: inventoryManifestId,
    manifest_id: inventoryManifestId,
    content_manifest_id: contentManifest.content_manifest_id,
    content_validation_complete: contentManifest.complete,
  };
}

function classifyZonePageSnapshot(snapshot = {}, centrisNum = '') {
  const url = String(snapshot.url || '');
  const title = String(snapshot.title || '');
  const text = String(snapshot.text || '');
  const combined = `${title}\n${text}`;
  const num = String(centrisNum || '').replace(/\D/g, '');
  const listingMentioned = num ? new RegExp(`(^|\\D)${num}(\\D|$)`).test(combined) : false;

  if (/accounts\.centris\.ca|\/signin|\/login/i.test(url) || snapshot.passwordInputs > 0 ||
      /connectez-vous|ouvrir une session|mot de passe/i.test(combined)) {
    return { code: 'ZONE_AUTH_REQUIRED', listingMentioned };
  }
  if (/acc[eè]s refus[ée]|non autoris[ée]|forbidden|permission insuffisante/i.test(combined)) {
    return { code: 'ZONE_FORBIDDEN', listingMentioned };
  }
  if (/page introuvable|listing introuvable|inscription introuvable|aucun r[ée]sultat|not found|erreur 404/i.test(combined)) {
    return { code: 'ZONE_LISTING_NOT_FOUND', listingMentioned };
  }
  if ((snapshot.checkboxCount > 0 || snapshot.shareButtonCount > 0) &&
      (listingMentioned || /\/Listings\//i.test(url))) {
    return { code: 'ZONE_DOCUMENTS_READY', listingMentioned };
  }
  if (/aucun document|pas de document|no documents/i.test(combined) &&
      (listingMentioned || /\/Listings\//i.test(url))) {
    return { code: 'ZONE_NO_DOCUMENTS', listingMentioned };
  }
  return { code: 'ZONE_NAVIGATION_UNVERIFIED', listingMentioned };
}

async function inspectZonePage(page, centrisNum) {
  const snapshot = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    text: String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().substring(0, 1200),
    passwordInputs: document.querySelectorAll('input[type=password]').length,
    checkboxCount: document.querySelectorAll('input[type=checkbox]:not([disabled])').length,
    shareButtonCount: [...document.querySelectorAll('button,a')]
      .filter((el) => /partager les documents/i.test(el.textContent || el.getAttribute('title') || '')).length,
    controls: [...document.querySelectorAll('input,button,a')]
      .filter((el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
      })
      .slice(0, 40)
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || '',
        text: String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').replace(/\s+/g, ' ').trim().substring(0, 80),
        href: String(el.getAttribute('href') || '').substring(0, 120),
      })),
  }));
  return { ...snapshot, ...classifyZonePageSnapshot(snapshot, centrisNum) };
}

async function waitForZoneAppReady(page, timeoutMs = 15000) {
  try {
    await page.waitForFunction(() => {
      const body = document.body;
      if (!body) return false;
      const textReady = String(body.innerText || '').trim().length > 0;
      const uiReady = !!body.querySelector('input, button, a, table, [role="button"], [role="row"], [role="main"]');
      return textReady || uiReady;
    }, null, { timeout: timeoutMs, polling: 250 });
    return true;
  } catch {
    return false;
  }
}

async function navigateToZoneDocuments(page, centrisNum) {
  const attempts = [];
  const inspect = async (label) => {
    const state = await inspectZonePage(page, centrisNum);
    attempts.push({ label, code: state.code, url: state.url, title: state.title });
    console.log(`[ZONE-NAV] ${label}: ${state.code} url=${String(state.url).substring(0, 140)}`);
    if (state.code === 'ZONE_NAVIGATION_UNVERIFIED') {
      // Diagnostic sans secret: seulement titre, extrait de texte et contrôles
      // visibles. Permet d'adapter les sélecteurs si Centris change son UI.
      console.log(`[ZONE-DIAG] ${label}: ${JSON.stringify({
        title: state.title,
        text: String(state.text || '').substring(0, 500),
        controls: state.controls,
      })}`);
    }
    return state;
  };

  const directUrl = `https://zone.centris.ca/Listings/${centrisNum}/Documents`;
  const response = await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const directReady = await waitForZoneAppReady(page);
  let state = await inspect('direct-documents');
  state.httpStatus = response?.status?.() || null;
  if (!directReady) state = { ...state, code: 'ZONE_APP_BLANK' };
  if (['ZONE_DOCUMENTS_READY', 'ZONE_NO_DOCUMENTS', 'ZONE_AUTH_REQUIRED', 'ZONE_FORBIDDEN'].includes(state.code)) {
    return { state, attempts };
  }

  // If a bookmarked route changed, use Zone's own Dashboard search and follow
  // the exact listing instead of guessing alternate Centris numbers.
  await page.goto('https://zone.centris.ca/Dashboard', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const dashboardReady = await waitForZoneAppReady(page);
  state = await inspect('dashboard');
  if (!dashboardReady) {
    return { state: { ...state, code: 'ZONE_APP_BLANK' }, attempts };
  }
  if (['ZONE_AUTH_REQUIRED', 'ZONE_FORBIDDEN'].includes(state.code)) return { state, attempts };

  const search = page.locator([
    'input[type=search]',
    'input[placeholder*="recherch" i]',
    'input[placeholder*="centris" i]',
    'input[placeholder*="inscription" i]',
    'input[name*="search" i]',
  ].join(',')).first();
  if (!(await search.isVisible({ timeout: 2500 }).catch(() => false))) {
    return { state: { ...state, code: 'ZONE_SEARCH_CONTROL_MISSING' }, attempts };
  }
  await search.fill(String(centrisNum));
  await search.press('Enter');
  await page.waitForTimeout(3000);
  state = await inspect('dashboard-search');
  if (['ZONE_AUTH_REQUIRED', 'ZONE_FORBIDDEN', 'ZONE_LISTING_NOT_FOUND'].includes(state.code)) return { state, attempts };

  const exactListingLink = page.locator(`a[href*="/Listings/${centrisNum}"]`).first();
  if (await exactListingLink.isVisible({ timeout: 2000 }).catch(() => false)) {
    await exactListingLink.click();
    await page.waitForTimeout(2500);
    state = await inspect('exact-listing');
  } else if (!state.listingMentioned) {
    return { state: { ...state, code: 'ZONE_LISTING_NOT_FOUND' }, attempts };
  }

  const documentsTab = page.locator('a[href*="/Documents"], a:has-text("Documents"), button:has-text("Documents")').first();
  if (!(await documentsTab.isVisible({ timeout: 2500 }).catch(() => false))) {
    return { state: { ...state, code: 'ZONE_DOCUMENTS_TAB_MISSING' }, attempts };
  }
  await documentsTab.click();
  await page.waitForTimeout(2500);
  state = await inspect('documents-tab');
  return { state, attempts };
}

function classifyMatrixPageSnapshot(snapshot = {}, centrisNum = '') {
  const url = String(snapshot.url || '');
  const text = String(snapshot.text || '');
  const num = String(centrisNum || '').replace(/\D/g, '');
  const exactListingMentioned = snapshot.exactListingMentioned === true ||
    (num ? new RegExp(`(^|\\D)${num}(\\D|$)`).test(text) : false);
  if (/accounts\.centris\.ca|\/signin|\/login/i.test(url) || snapshot.passwordInputs > 0) {
    return { code: 'MATRIX_AUTH_REQUIRED', exactListingMentioned };
  }
  if (/aucun r[ée]sultat|no results|inscription introuvable/i.test(text)) {
    return { code: 'MATRIX_LISTING_NOT_FOUND', exactListingMentioned };
  }
  if (exactListingMentioned && snapshot.mediaLinkCount > 0) {
    return { code: 'MATRIX_DOCUMENTS_READY', exactListingMentioned };
  }
  if (exactListingMentioned && /document\(s\) additionnel\(s\)|d[ée]claration du vendeur/i.test(text)) {
    return { code: 'MATRIX_LISTING_READY_NO_DOCUMENTS', exactListingMentioned };
  }
  return { code: 'MATRIX_NAVIGATION_UNVERIFIED', exactListingMentioned };
}

async function findMatrixGlobalSearch(page) {
  const selectors = [
    '#QueryText',
    'input[id*="Query"]',
    'input[id*="Search" i]',
    'input[name*="Query" i]',
    'input[name*="Search" i]',
    'input[type="search"]',
    'input[placeholder*="recherch" i]',
    'input[placeholder*="centris" i]',
    'input[placeholder*="mls" i]',
  ];

  // Matrix est une application ASP.NET dont l'identifiant du champ global
  // peut varier entre les déploiements. Chercher d'abord les attributs
  // sémantiques, puis choisir le grand champ éditable placé dans l'en-tête.
  // Le parcours est répété pendant l'hydratation et inclut les frames.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const selector of selectors) {
        const locator = frame.locator(selector).first();
        if (await locator.isVisible().catch(() => false) &&
            await locator.isEnabled().catch(() => false) &&
            await locator.isEditable().catch(() => false)) return locator;
      }

      const inputs = frame.locator('input:not([type]), input[type="text"], input[type="search"]');
      const count = Math.min(await inputs.count().catch(() => 0), 50);
      let best = null;
      let bestScore = -1;
      for (let index = 0; index < count; index += 1) {
        const input = inputs.nth(index);
        if (!(await input.isVisible().catch(() => false)) ||
            !(await input.isEnabled().catch(() => false)) ||
            !(await input.isEditable().catch(() => false))) continue;
        const box = await input.boundingBox().catch(() => null);
        if (!box || box.width < 240 || box.height < 18) continue;
        const meta = await input.evaluate((el) => [
          el.id, el.getAttribute('name'), el.getAttribute('placeholder'),
          el.getAttribute('aria-label'), el.getAttribute('class'), el.getAttribute('type'),
        ].filter(Boolean).join(' ')).catch(() => '');
        let score = 0;
        if (/query|search|recherch|centris|mls|quick|global|keyword|crit[eè]re/i.test(meta)) score += 100;
        if (/\bsearch\b/i.test(meta)) score += 50;
        if (box.width >= 600) score += 50;
        if (box.y >= 40 && box.y <= 450) score += 30;
        if (String(meta).includes('password')) score -= 500;
        if (score > bestScore) { best = input; bestScore = score; }
      }
      if (best && bestScore >= 50) return best;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

function matrixTextContainsExactNumber(value, centrisNum) {
  const number = String(centrisNum || '').replace(/\D/g, '');
  if (!number) return false;
  return new RegExp(`(^|\\D)${number}(\\D|$)`).test(String(value || ''));
}

async function openExactMatrixListing(page, centrisNum) {
  let state = await inspectMatrixListingPage(page, centrisNum);
  if (state.exactListingMentioned &&
      ['MATRIX_DOCUMENTS_READY', 'MATRIX_LISTING_READY_NO_DOCUMENTS'].includes(state.code)) return state;

  for (const frame of page.frames()) {
    const candidates = frame.locator('a,button,[role="link"],[data-href]');
    const count = Math.min(await candidates.count().catch(() => 0), 300);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!(await candidate.isVisible().catch(() => false))) continue;
      const metadata = await candidate.evaluate((element) => [
        element.innerText, element.textContent, element.getAttribute('aria-label'),
        element.getAttribute('title'), element.getAttribute('href'),
        element.getAttribute('data-href'), element.closest('tr,[role="row"]')?.innerText,
      ].filter(Boolean).join(' ')).catch(() => '');
      if (!matrixTextContainsExactNumber(metadata, centrisNum)) continue;
      await candidate.click().catch(() => null);
      await page.waitForTimeout(3000);
      state = await inspectMatrixListingPage(page, centrisNum);
      if (state.exactListingMentioned) return state;
    }
  }
  return state;
}

async function inspectMatrixListingPage(page, centrisNum) {
  const inspectFrame = async (frame) => frame.evaluate((expectedNum) => {
    const clean = (value) => String(value || '').replace(/[\u00A0\u2000-\u200B\s]+/g, ' ').trim();
    const bodyText = clean(document.body?.innerText || '');
    const allElements = [...document.querySelectorAll('h1,h2,h3,h4,h5,div,span,strong')];
    const additionalHeading = allElements.find((el) => /^document\(s\) additionnel\(s\)$/i.test(clean(el.textContent)));
    const afterHeading = (element) => !!additionalHeading &&
      !!(additionalHeading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    const mediaAnchors = [...document.querySelectorAll('a[href], [data-href]')].filter((element) => {
      const href = element.href || element.getAttribute('href') || element.getAttribute('data-href') || '';
      const label = clean(element.textContent || element.getAttribute('title') || element.getAttribute('aria-label') || '');
      return /media\.ashx|annex|document|download|\.pdf(?:$|[?#])/i.test(href) ||
        (/d[ée]claration du vendeur|\bDV[-\s]?\d+|certificat|plan cadastral|taxes|r[oô]le d['’]?[ée]valuation/i.test(label) && /^https?:/i.test(href));
    });
    const seen = new Set();
    const docs = [];
    for (const anchor of mediaAnchors) {
      const href = anchor.href || anchor.getAttribute('href') || anchor.getAttribute('data-href') || '';
      const label = clean(anchor.textContent || anchor.getAttribute('title') || anchor.getAttribute('aria-label') || '');
      if (!href || !label) continue;
      const row = anchor.closest('tr,li,[role="row"]') || anchor.parentElement?.parentElement || anchor.parentElement;
      const rowText = clean(row?.innerText || row?.textContent || label);
      const sizeMatch = rowText.match(/([0-9]+(?:[.,][0-9]+)?)\s*([kmg])(?:o|b)?\b/i);
      const key = `${label}|${sizeMatch?.[0] || ''}|${href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const additional = afterHeading(anchor);
      docs.push({
        name: label,
        size: sizeMatch?.[0] || null,
        url: href,
        provenance: additional ? 'matrix_additional_documents' : 'matrix_principal_dv',
        source_section: additional ? 'additional_documents' : 'principal_dv',
      });
    }
    const postbackAnchors = [...document.querySelectorAll('a[id]')].filter((anchor) => {
      const label = clean(anchor.textContent || anchor.getAttribute('title') || anchor.getAttribute('aria-label') || '');
      const action = `${anchor.getAttribute('href') || ''} ${anchor.getAttribute('onclick') || ''}`;
      return /(?:oui\s+)?dv[-\s]?\d+|d[ée]claration du vendeur/i.test(label) &&
        /__doPostBack|javascript:|download|media\.ashx/i.test(action);
    });
    for (const anchor of postbackAnchors) {
      const label = clean(anchor.textContent || anchor.getAttribute('title') || anchor.getAttribute('aria-label') || '');
      if (!label || docs.some((doc) => doc.name === label && doc.source_section === 'principal_dv')) continue;
      docs.unshift({
        name: label, size: null, url: null, action_id: anchor.id,
        provenance: 'matrix_principal_dv', source_section: 'principal_dv',
      });
    }
    const principalMatch = bodyText.match(/D[ée]claration du vendeur\s+(?:Oui\s+)?(DV[-\s]?\d+)/i);
    if (principalMatch && !docs.some((doc) => doc.source_section === 'principal_dv' && !/modification/i.test(doc.name))) {
      docs.unshift({
        name: principalMatch[1].replace(/\s+/g, ''), size: null, url: null,
        provenance: 'matrix_principal_dv', source_section: 'principal_dv',
      });
    }
    const price = bodyText.match(/(?:^|\s)([0-9][0-9\s]*\$)(?:\s|$)/)?.[1] || null;
    const address = bodyText.match(/\b\d{1,6}\s+(?:rue|avenue|boulevard|chemin|rang|route)\s+[^\n]{3,100}/i)?.[0] || null;
    return {
      url: location.href, title: document.title, text: bodyText.substring(0, 4000),
      exactListingMentioned: new RegExp(`(^|\\D)${String(expectedNum).replace(/\\D/g, '')}(\\D|$)`).test(bodyText),
      passwordInputs: document.querySelectorAll('input[type=password]').length,
      mediaLinkCount: mediaAnchors.length, docs,
      listing: { centris_num: expectedNum, price: clean(price), address: clean(address) },
    };
  }, String(centrisNum));
  const snapshots = [];
  for (const frame of page.frames()) {
    const snapshot = await inspectFrame(frame).catch(() => null);
    if (snapshot) snapshots.push(snapshot);
  }
  const snapshot = snapshots.sort((left, right) => {
    const score = (item) => (item.exactListingMentioned || matrixTextContainsExactNumber(item.text, centrisNum) ? 1000 : 0) + (item.docs?.length || 0) * 10;
    return score(right) - score(left);
  })[0] || { url: page.url(), text: '', docs: [], mediaLinkCount: 0, passwordInputs: 0 };
  return { ...snapshot, ...classifyMatrixPageSnapshot(snapshot, centrisNum) };
}

// Recherche globale Matrix: fonctionne aussi pour les inscriptions d'autres
// courtiers. Zone Courtier demeure un chemin séparé pour l'inventaire de Shawn.
async function previewCentrisMatrixDocuments(opts = {}) {
  if (!CUA_AVAILABLE()) return { success: false, error_code: 'MATRIX_PLAYWRIGHT_UNAVAILABLE', message: 'Playwright non disponible' };
  loadDeps();
  initDirs();
  const centrisNum = String(opts.centris_num || '').replace(/\D/g, '');
  if (!/^\d{7,9}$/.test(centrisNum)) {
    return { success: false, error_code: 'MATRIX_INVALID_CENTRIS_NUMBER', message: 'Numéro Centris invalide (7-9 chiffres)' };
  }
  let browser = null;
  try {
    browser = await launchBrowser();
    const context = await newStealthContext(browser);
    const page = await loginCentris(context);
    await page.goto(`${MATRIX_BASE}/Matrix/Recherche`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const search = await findMatrixGlobalSearch(page);
    if (!search) return { success: false, error_code: 'MATRIX_SEARCH_CONTROL_MISSING', message: 'Barre de recherche globale Matrix introuvable. Aucun envoi effectué.' };

    console.log(`[MATRIX-PREVIEW] Recherche globale exacte #${centrisNum}`);
    await search.fill(centrisNum);
    await search.press('Enter');
    await page.waitForTimeout(3500);
    const state = await openExactMatrixListing(page, centrisNum);
    if (!state.exactListingMentioned) {
      return {
        success: false,
        error_code: state.code === 'MATRIX_AUTH_REQUIRED' ? state.code : 'MATRIX_LISTING_NOT_FOUND',
        message: `Le résultat exact #${centrisNum} n'a pas été trouvé dans Matrix. Aucun numéro substitut n'a été utilisé.`,
        final_url: state.url,
      };
    }
    if (!['MATRIX_DOCUMENTS_READY', 'MATRIX_LISTING_READY_NO_DOCUMENTS'].includes(state.code)) {
      return { success: false, error_code: state.code, message: `Listing #${centrisNum} ouvert, mais la section des documents n'a pas pu être vérifiée. Aucun envoi effectué.`, final_url: state.url };
    }
    const inventory = buildCentrisDocumentInventory(centrisNum, state.docs);
    return {
      success: true, dry_run: true, via: 'matrix-global', listing: state.listing,
      docs_count: inventory.docs.length, docs_list: inventory.docs,
      document_inventory: inventory, manifest_id: inventory.manifest_id,
      listing_url: state.url,
      message: inventory.docs.length
        ? `PREVIEW Matrix — ${inventory.docs.length} document(s) trouvé(s). Aucun envoi effectué.`
        : `Listing #${centrisNum} trouvé dans Matrix, mais aucun document n'est affiché. Aucun envoi effectué.`,
    };
  } catch (error) {
    return { success: false, error_code: 'MATRIX_PREVIEW_TECHNICAL_ERROR', message: safeErrorMessage(error).substring(0, 240) };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

function extractTaxCandidatesFromText(text, labelPattern) {
  const source = String(text || '');
  const candidates = [];
  const labelRegex = new RegExp(labelPattern, 'i');
  for (const line of source.split(/\r?\n/)) {
    if (!labelRegex.test(line)) continue;
    const afterLabel = line.replace(labelRegex, ' ');
    const dollarMatches = [...afterLabel.matchAll(/(?:\$\s*([0-9][0-9 \,\.]*))|(?:([0-9][0-9 \,\.]*)\s*\$)/g)];
    const lastAmount = dollarMatches[dollarMatches.length - 1];
    const raw = String(lastAmount?.[1] || lastAmount?.[2] || '').trim();
    if (!raw) continue;
    const value = Number(raw.replace(/\s/g, '').replace(/,/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, ''));
    if (Number.isFinite(value) && value >= 0 && value < 1000000 && !candidates.includes(value)) candidates.push(value);
  }
  return candidates;
}

function browserlessEndpointWithTimeout(endpoint, timeoutMs = 60000) {
  let url;
  try { url = new URL(endpoint); }
  catch { throw new Error('BROWSERLESS_WS invalide'); }
  // Browserless production currently rejects values above 60,000 ms.
  // Clamp locally so a stale environment value cannot prevent Chrome from
  // opening before the Centris/MFA flow even starts.
  const safeTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 60000, 60000));
  url.searchParams.set('timeout', String(safeTimeout));
  return url.toString();
}

function safeErrorMessage(error) {
  return String(error?.message || error || 'erreur inconnue')
    .replace(/([?&](?:token|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

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
  const configuredEndpoint = process.env.BROWSERLESS_WS;
  if (configuredEndpoint) {
    console.log('[CUA] Mode Browserless externe (WS)');
    const sessionTimeoutMs = Number(process.env.BROWSERLESS_SESSION_TIMEOUT_MS) || 60000;
    const wsEndpoint = browserlessEndpointWithTimeout(configuredEndpoint, sessionTimeoutMs);
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
          console.warn(`[CUA] Browserless connect échoué (attempt ${attempt}/${3}, retry ${delay}ms): ${safeErrorMessage(e)}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    // 3 fails → reset cache disponibilité pour forcer re-check au prochain appel
    _cuaAvailable = null;
    throw new Error(`Browserless WS connect échoué 3× — last: ${safeErrorMessage(lastErr)}. Vérifie BROWSERLESS_WS / quota.`);
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
async function newStealthContext(browser, opts = {}) {
  // PRIORITY: si storageState dispo (push depuis LaunchAgent Mac), l'utiliser
  // → cookies + localStorage + sessionStorage + UA matching = session valide
  const stored = opts.storageState ? null : loadBotCentrisStorageState();
  const ua = (stored?.userAgent) || opts.userAgent || pickUA();
  const contextOpts = {
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
    },
  };
  // Inject storageState si dispo (skip MFA, session valide direct)
  if (stored?.storageState) {
    contextOpts.storageState = stored.storageState;
    console.log('[CUA] storageState applied to context — should skip MFA');
  } else if (opts.storageState) {
    contextOpts.storageState = opts.storageState;
  }
  const ctx = await browser.newContext(contextOpts);
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
    const s = readSessionFile(SESSION_FILE);
    const expiresAt = Number(s?.expiry || ((s?.ts || 0) + SESSION_TTL));
    if (!s || !Array.isArray(s.cookies) || Date.now() > expiresAt) {
      removeSessionFile(SESSION_FILE);
      return null;
    }
    return s.cookies || null;
  } catch { return null; }
}

function saveSession(cookies) {
  try {
    const capturedAt = Date.now();
    writeSessionFile(SESSION_FILE, { ts: capturedAt, capturedAt, expiry: capturedAt + SESSION_TTL, cookies });
  } catch (e) { console.warn('[CUA] session save error:', safeErrorMessage(e)); }
}

function isAuthenticatedCentrisUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();
    if (!new Set(['matrix.centris.ca', 'zone.centris.ca']).has(host)) return false;
    return !/\/(?:login|auth|signin|error|accessdenied)(?:[/.?]|$)|LoginIntermediate/i.test(`${url.pathname}${url.search}`);
  } catch {
    return false;
  }
}

function cookieHeaderFromPlaywrightCookies(cookies, targetHost = 'matrix.centris.ca') {
  const host = String(targetHost || '').toLowerCase();
  return (Array.isArray(cookies) ? cookies : [])
    .filter(c => {
      const domain = String(c.domain || '').replace(/^\./, '').toLowerCase();
      return /(?:^|\.)centris\.ca$/.test(domain)
        && (host === domain || host.endsWith(`.${domain}`));
    })
    .map(c => `${c.name}=${c.value}`)
    .join('; ');
}

async function saveBrowserStorageState(context, page) {
  try {
    const storageState = await context.storageState();
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => null);
    writeSessionFile(STORAGE_STATE_FILE, {
      storageState,
      userAgent,
      capturedAt: Date.now(),
      expiry: Date.now() + SESSION_TTL,
    });
  } catch (e) {
    console.warn('[CUA] storageState save error:', safeErrorMessage(e));
  }
}

function clearSession(options = {}) {
  removeSessionFile(SESSION_FILE);
  if (options.includeStorageState) removeSessionFile(STORAGE_STATE_FILE);
}

// Récupère cookies du bot principal (centris_cookies.json) si CUA n'a pas sa propre session
// Le LaunchAgent Mac push les cookies fresh tous les 12h via /admin/centris-cookies
// Charge storageState Playwright complet (cookies + localStorage + sessionStorage + UA)
// Plus fiable que juste cookies. Source: LaunchAgent Mac centris-auto-login push.
function loadBotCentrisStorageState() {
  try {
    const data = readSessionFile(STORAGE_STATE_FILE);
    if (!data) return null;
    if (data.expiry && Date.now() > data.expiry) {
      console.log('[CUA] storageState expiré');
      removeSessionFile(STORAGE_STATE_FILE);
      return null;
    }
    if (!data.storageState || !data.storageState.cookies) return null;
    console.log(`[CUA] storageState loaded: ${data.storageState.cookies.length} cookies + ${data.storageState.origins?.length || 0} origins, UA=${(data.userAgent||'').substring(0,80)}`);
    return { storageState: data.storageState, userAgent: data.userAgent };
  } catch (e) { console.warn('[CUA] loadBotCentrisStorageState:', e.message); return null; }
}

function loadBotCentrisCookies() {
  try {
    // Le bot principal sauve dans centris_session.json (bot.js CENTRIS_SESSION_FILE).
    // Fallback compat: ancien nom centris_cookies.json.
    const candidates = [
      path.join(DATA_DIR, 'centris_session.json'),
      path.join(DATA_DIR, 'centris_cookies.json'),
    ];
    const botCookieFile = candidates.find(f => fs.existsSync(f));
    if (!botCookieFile) return null;
    const data = readSessionFile(botCookieFile);
    console.log(`[CUA] Loaded cookies from ${path.basename(botCookieFile)}`);
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

  // Essayer toute session persistée d'abord. Le storageState complet a déjà
  // été injecté par newStealthContext; les cookies simples restent un fallback.
  const savedCookies = loadSession() || loadBotCentrisCookies();
  if (savedCookies && savedCookies.length > 0) {
    try { await context.addCookies(savedCookies); }
    catch (e) { console.warn('[CUA] Injection cookies échouée:', safeErrorMessage(e)); }
  }
  try {
    await page.goto(`${MATRIX_BASE}/Matrix/Recherche`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1800);
    const probeUrl = page.url();
    const passwordVisible = await page.locator('input[type="password"]:visible').count().catch(() => 0);
    if (!passwordVisible && isAuthenticatedCentrisUrl(probeUrl)) {
      const cookies = await context.cookies();
      saveSession(cookies);
      await saveBrowserStorageState(context, page);
      console.log('[CUA] Session persistante vérifiée dans Matrix ✅', probeUrl.substring(0, 80));
      return page;
    }
    console.log('[CUA] Session persistante refusée par Matrix — renouvellement automatique');
    clearSession({ includeStorageState: true });
  } catch (e) {
    console.warn('[CUA] Vérification session échouée:', safeErrorMessage(e));
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
    console.warn(`[CUA] Login deterministic échoué: ${safeErrorMessage(e)}. Fallback DOM...`);
  }

  // Fallback DOM large — les identifiants restent dans Playwright et ne sont
  // jamais envoyés à un modèle externe.
  if (!loginDeterministicOK) {
    console.log('[CUA] Fallback DOM pour login...');
    const passField = page.locator('input[type="password"]:visible').first();
    const userField = page.locator('input:visible:not([type="password"]):not([type="hidden"]):not([type="submit"]):not([type="button"])').first();
    await userField.fill(user);
    await passField.fill(pass);
    await page.locator('button[type="submit"], input[type="submit"]').first().click();
    await page.waitForTimeout(4500);
    console.log('[CUA] Login DOM fallback soumis ✅');
  }

  // Si Centris propose le courriel, le privilégier: le bot peut lire le code
  // automatiquement dans Gmail. Sinon, le SMS reste disponible via /mfa.
  if (/mfa-sms-challenge/i.test(page.url())) {
    try {
      const changeMethod = page.locator('a,button').filter({
        hasText: /changer.*méthode|change.*method|autre.*méthode|another.*method|try another/i,
      }).first();
      if (await changeMethod.isVisible().catch(() => false)) {
        await changeMethod.click();
        await page.waitForTimeout(1200);
        const emailMethod = page.locator('a,button,label').filter({ hasText: /courriel|e-?mail/i }).first();
        if (await emailMethod.isVisible().catch(() => false)) {
          await emailMethod.click();
          await page.waitForTimeout(1800);
          console.log('[CUA] MFA basculé vers courriel');
        }
      }
    } catch (e) {
      console.warn('[CUA] MFA courriel indisponible, conserve SMS:', safeErrorMessage(e));
    }
  }

  // Handle MFA (Email ou SMS)
  for (let mfaAttempt = 0; mfaAttempt < 2; mfaAttempt++) {
    const mfaField = page.locator('input[autocomplete="one-time-code"], input[name="code"], input[id="code"], input[name*="verification" i], input[id*="verification" i], input[placeholder*="code" i], input[placeholder*="vérif" i], input[type="tel"]').first();
    const mfaVisible = await mfaField.isVisible().catch(() => false);
    if (!mfaVisible) break;

    // Browserless limite la session Playwright à 60 s. Conserver une marge
    // pour soumettre le code et vérifier Matrix avant la fermeture du socket.
    const mfaWaitMs = process.env.BROWSERLESS_WS ? 40000 : 180000;
    console.log(`[CUA] MFA requis (tentative ${mfaAttempt + 1}/2) — Gmail, pont Messages ou /mfa (max ${Math.round(mfaWaitMs / 1000)}s)...`);
    const mfaCode = await fetchMFACodeFromBot(mfaWaitMs);
    if (!mfaCode) throw new Error(`MFA timeout — aucun code reçu en ${Math.round(mfaWaitMs / 1000)}s via Gmail, Telegram ou pont Messages.`);
    console.log(`[CUA] MFA code reçu: ${mfaCode.substring(0, 2)}****`);

    await mfaField.fill(mfaCode);
    const mfaSubmit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Verify"), button:has-text("Vérif"), button:has-text("Submit"), button:has-text("Confirmer")').first();
    await mfaSubmit.click();
    await page.waitForTimeout(4500);
  }

  // Handle disclaimers "I've Read This" / "Continue"
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = page.url();
    if (!/LoginIntermediate|Disclaimer|Consent/i.test(url)) break;
    console.log('[CUA] Disclaimer detected, clicking continue...');
    const continueBtn = page.locator('button,a').filter({ hasText: /continue|i.?ve read|j.?ai lu|accepter/i }).first()
      .or(page.locator('input[type="submit"][value*="Continue" i], input[type="submit"][value*="Accept" i]')).first();
    const visible = await continueBtn.isVisible().catch(() => false);
    if (!visible) break;
    await continueBtn.click();
    await page.waitForTimeout(3000);
  }

  const finalUrl = page.url();
  if (!isAuthenticatedCentrisUrl(finalUrl)) {
    throw new Error(`Login Centris échoué — URL finale: ${finalUrl.substring(0, 200)}`);
  }

  // Sauvegarder la session sur le disque persistant. La durée locale est un
  // plafond; chaque réutilisation est d'abord vérifiée réellement dans Matrix.
  const cookies = await context.cookies();
  saveSession(cookies);
  await saveBrowserStorageState(context, page);
  // Push aussi vers bot principal pour partage
  try { await pushCookiesToBot(cookies); } catch (e) { console.warn('[CUA] push cookies bot:', safeErrorMessage(e)); }
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
    console.warn('[CUA] WEBHOOK_SECRET manquant — MFA manuel/fichier seulement');
  }
  const start = Date.now();
  let alertSent = false;
  centrisMFAWaiting = true;
  pendingManualMFACode = null;
  try {
    while (Date.now() - start < timeoutMs) {
      try {
        // 1. Code envoyé manuellement par /mfa dans Telegram.
        const manualCode = takeManualMFACode();
        if (manualCode) {
          console.log('[CUA] MFA reçu depuis Telegram');
          return manualCode;
        }

        // 2. Gmail via l'endpoint interne authentifié du bot.
        if (token) {
          const r = await fetch(`${botUrl}/admin/centris-mfa-code?after=${start}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
          });
          if (r.ok) {
            const d = await r.json();
            if (d.code && /^\d{4,8}$/.test(d.code)) {
              console.log(`[CUA] MFA from Gmail (${d.emails_checked} emails scanned)`);
              return d.code;
            }
          }
        }

        // 3. Fichier local écrit par le bridge SMS.
        const mfaFile = path.join(DATA_DIR, 'centris_mfa.txt');
        if (fs.existsSync(mfaFile)) {
          const code = fs.readFileSync(mfaFile, 'utf8').trim();
          if (code && /^\d{4,8}$/.test(code)) {
            fs.unlinkSync(mfaFile);
            console.log('[CUA] MFA from local file (sms-bridge)');
            return code;
          }
        }

        // 4. Alerte immédiatement l'utilisateur: Browserless peut avoir une
        // limite de session courte et il faut laisser le maximum de temps utile.
        if (!alertSent && token) {
          alertSent = true;
          await alertShawnMFA(botUrl, token, timeoutMs).catch(() => {});
        }
      } catch (e) { console.warn('[CUA] fetchMFA loop:', safeErrorMessage(e)); }
      await new Promise(r => setTimeout(r, 2000));
    }
    return null;
  } finally {
    centrisMFAWaiting = false;
    pendingManualMFACode = null;
  }
}

// Alerte Telegram à Shawn quand MFA tarde — il peut envoyer code via /mfa CMD
async function alertShawnMFA(botUrl, token, timeoutMs) {
  try {
    await fetch(`${botUrl}/admin/notify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        text: `🔐 *CUA Centris* attend le code MFA\n\n👉 Envoie immédiatement le code via \`/mfa 123456\`.\n\n_(fenêtre maximale: ${Math.round(timeoutMs / 1000)}s)_`,
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
  const cookieStr = cookieHeaderFromPlaywrightCookies(playwrightCookies);
  if (!cookieStr) return;
  try {
    await fetch(`${botUrl}/admin/centris-cookies`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        Authorization: `Bearer ${token}`,
      },
      body: cookieStr,
      signal: AbortSignal.timeout(10000),
    });
    console.log('[CUA] Cookies pushed to bot ✅');
  } catch (e) { console.warn('[CUA] pushCookies failed:', e.message); }
}

// Connexion Playwright explicite pour Telegram et les appels Centris du bot.
// Les appels concurrents partagent la même tentative pour éviter plusieurs SMS.
async function cuaLoginCentris() {
  if (activeCentrisLoginPromise) return activeCentrisLoginPromise;
  activeCentrisLoginPromise = (async () => {
    if (!CUA_AVAILABLE()) return { ok: false, error: 'Playwright non disponible' };
    initDirs();
    let browser = null;
    try {
      browser = await launchBrowser();
      const context = await newStealthContext(browser);
      const page = await loginCentris(context);
      const passwordVisible = await page.locator('input[type="password"]:visible').count().catch(() => 0);
      if (passwordVisible || !isAuthenticatedCentrisUrl(page.url())) {
        throw new Error('Vérification de session Centris échouée après le login');
      }
      const cookies = await context.cookies();
      const cookieHeader = cookieHeaderFromPlaywrightCookies(cookies);
      if (cookieHeader.length < 100) throw new Error('Session Centris créée sans cookies suffisants');
      await saveBrowserStorageState(context, page);
      return {
        ok: true,
        cookieCount: cookieHeader.split(';').filter(Boolean).length,
        cookieHeader,
        expiresAt: Date.now() + SESSION_TTL,
      };
    } catch (e) {
      return { ok: false, error: safeErrorMessage(e).substring(0, 240) };
    } finally {
      if (browser) try { await browser.close(); } catch {}
    }
  })();
  try { return await activeCentrisLoginPromise; }
  finally { activeCentrisLoginPromise = null; }
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
    const exactNum = String(centrisNum || '').replace(/\D/g, '');
    if (!/^\d{7,9}$/.test(exactNum)) throw new Error('Numéro Centris invalide');

    // Chemin déterministe identique au geste humain montré par Shawn:
    // recherche globale blanche → numéro exact → fiche détaillée → liens PDF.
    await page.goto(`${MATRIX_BASE}/Matrix/Recherche`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2500);
    const search = await findMatrixGlobalSearch(page);
    if (!search) throw new Error('MATRIX_SEARCH_CONTROL_MISSING');
    await search.fill(exactNum);
    await search.press('Enter');
    await page.waitForTimeout(3500);
    const state = await openExactMatrixListing(page, exactNum);
    if (!state.exactListingMentioned) throw new Error(`MATRIX_EXACT_LISTING_NOT_VERIFIED:${exactNum}`);

    let matchedDocs = state.docs;
    if (filtre) {
      const terms = normalizeCentrisMatchKey(filtre).split(/\s+/).filter(Boolean);
      matchedDocs = matchedDocs.filter((doc) => terms.every((term) => doc.match_key?.includes(term) || normalizeCentrisMatchKey(doc.name).includes(term)));
    }
    if (!matchedDocs.length) {
      return { success: false, annexes: [], message: filtre ? `Aucune annexe correspondant à « ${filtre} »` : 'Aucune annexe téléchargeable trouvée dans Matrix' };
    }

    const selectedDocs = matchedDocs.filter((doc) => doc.url || doc.action_id);
    // Fail closed: un document affiché dans Matrix mais dont le lien n'a pas
    // été résolu (notamment une DV principale rendue en postback) ne doit
    // jamais disparaître silencieusement du lot envoyé au client.
    const unresolvedDocs = matchedDocs.filter((doc) => !doc.url && !doc.action_id);

    const annexes = [];
    const failures = unresolvedDocs.map((doc) => ({
      label: doc.name,
      error: 'lien de téléchargement Matrix non résolu',
    }));
    // mediaserver.centris.ca refuse parfois les requêtes API directes même si
    // elles partagent les cookies. Ouvrir le lien comme un vrai onglet Matrix
    // conserve la navigation authentifiée utilisée par un clic manuel.
    const candidates = selectedDocs.slice(0, 20);
    // Séquentiel volontairement: Matrix ouvre les documents depuis la fiche
    // et certains contrôles de session sont propres à l'onglet parent.
    let downloadAbortReason = null;
    const downloaded = await mapWithConcurrency(candidates, 1, async (doc, index) => {
      if (downloadAbortReason) {
        return { ok: false, failure: {
          label: doc.name,
          error: `non tenté après erreur de session: ${downloadAbortReason}`.substring(0, 120),
        } };
      }
      try {
        let buffer;
        let lastError;
        for (let attempt = 1; attempt <= MATRIX_DOCUMENT_DOWNLOAD_ATTEMPTS; attempt += 1) {
          try {
            buffer = doc.url
              ? await downloadMatrixPdfAuthenticated(context, doc.url, state.url, page)
              : await downloadMatrixPdfByAction(context, page, doc.action_id);
            break;
          } catch (error) {
            lastError = error;
            if (attempt < MATRIX_DOCUMENT_DOWNLOAD_ATTEMPTS) await page.waitForTimeout(400 * attempt);
          }
        }
        if (!buffer) throw lastError || new Error('MATRIX_DOWNLOAD_FAILED');
        const magicIndex = buffer.subarray(0, 4096).indexOf(Buffer.from('%PDF-'));
        if (buffer.length < 1000 || magicIndex === -1) {
          const signature = buffer.subarray(0, 16).toString('hex');
          throw new Error(`réponse non-PDF (bytes=${buffer.length}, signature=${signature || 'vide'})`);
        }
        if (magicIndex > 0) buffer = buffer.subarray(magicIndex);
        const parsed = await parsePDFText(buffer);
        const enriched = addCentrisContentMetadata(doc, buffer, parsed.pages);
        const safeBase = normalizeCentrisMatchKey(doc.name).replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 70) || `document_${index + 1}`;
        return { ok: true, document: {
          buffer,
          filename: `${safeBase}_${exactNum}.pdf`,
          label: doc.name,
          size: buffer.length,
          page_count: enriched.page_count,
          sha256: enriched.sha256,
          source: 'matrix-global',
        } };
      } catch (error) {
        const message = safeErrorMessage(error).substring(0, 120);
        if (/MATRIX_DOCUMENT_PDF_TIMEOUT|Target page|context or browser has been closed|Browser disconnected/i.test(message)) {
          downloadAbortReason = message;
        }
        return { ok: false, failure: { label: doc.name, error: message } };
      }
    });
    for (const item of downloaded) {
      if (item.ok) annexes.push(item.document);
      else {
        failures.push(item.failure);
        console.warn(`[MATRIX-PDF] ${item.failure.label}: ${item.failure.error}`);
      }
    }
    const totalDownloadedBytes = annexes.reduce((total, doc) => total + Number(doc.size || 0), 0);
    if (totalDownloadedBytes > MATRIX_DOCUMENT_TOTAL_MAX_BYTES) {
      return {
        success: false, annexes: [], failures,
        discovered_count: matchedDocs.length, validated_count: 0,
        message: `Lot Matrix trop volumineux (${Math.ceil(totalDownloadedBytes / 1024 / 1024)} MB; maximum 120 MB). Aucun envoi effectué.`,
      };
    }
    return {
      success: annexes.length > 0,
      annexes,
      failures,
      discovered_count: matchedDocs.length,
      validated_count: annexes.length,
      message: annexes.length > 0
        ? `${annexes.length}/${matchedDocs.length} annexe(s) Matrix téléchargée(s) et validée(s)`
        : `Aucune annexe PDF validée (${failures.length} échec(s)): ${failures.slice(0, 3).map((item) => item.error).join(' | ')}`,
    };

  } catch (e) {
    console.error('[CUA] cuaGetCentrisAnnexes error:', e.message);
    if (/login|auth/i.test(e.message)) clearSession();
    return { success: false, annexes: [], message: e.message };
  } finally {
    if (browser) try { await browser.close(); } catch {}
  }
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function waitForMatrixPdfResponse(context, trigger, timeoutMs = 30000) {
  let lastDiagnostic = 'aucune réponse candidate';
  let settled = false;
  let timer;
  let handler;
  const removeHandler = () => {
    try { context.off?.('response', handler); } catch {}
  };
  const result = new Promise((resolve, reject) => {
    const finish = (error, buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeHandler();
      if (error) reject(error); else resolve(buffer);
    };
    handler = async (response) => {
      try {
        const responseUrl = new URL(response.url());
        if (!/(^|\.)centris\.ca$/i.test(responseUrl.hostname)) return;
        const contentType = String(response.headers()['content-type'] || '').toLowerCase();
        if (!contentType.includes('pdf') && !/media\.ashx/i.test(responseUrl.pathname)) return;
        const contentLength = Number(response.headers()['content-length'] || 0);
        if (contentLength > MATRIX_DOCUMENT_FILE_MAX_BYTES) {
          finish(new Error('MATRIX_DOCUMENT_TOO_LARGE'));
          return;
        }
        const buffer = await response.body();
        if (buffer.length > MATRIX_DOCUMENT_FILE_MAX_BYTES) {
          finish(new Error('MATRIX_DOCUMENT_TOO_LARGE'));
          return;
        }
        const magicIndex = buffer.subarray(0, 4096).indexOf(Buffer.from('%PDF-'));
        if (buffer.length >= 1000 && magicIndex >= 0) {
          finish(null, magicIndex ? buffer.subarray(magicIndex) : buffer);
          return;
        }
        const htmlHead = buffer.subarray(0, Math.min(buffer.length, 32768)).toString('utf8');
        const title = String(htmlHead.match(/<title[^>]*>([^<]{0,120})<\/title>/i)?.[1] || '')
          .replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 80);
        const status = typeof response.status === 'function' ? response.status() : 'inconnu';
        // Ne jamais journaliser la query media.ashx: elle contient des
        // identifiants propres à la session. Hôte + chemin + titre suffisent.
        lastDiagnostic = [
          `status=${status}`,
          `type=${contentType || 'inconnu'}`,
          `url=${responseUrl.hostname}${responseUrl.pathname}`,
          `bytes=${buffer.length}`,
          `signature=${buffer.subarray(0, 16).toString('hex') || 'vide'}`,
          title ? `title=${title}` : null,
        ].filter(Boolean).join(',');
      } catch (error) {
        lastDiagnostic = safeErrorMessage(error).substring(0, 100);
      }
    };
    try { context.on('response', handler); }
    catch (error) { finish(error); return; }
    timer = setTimeout(() => finish(new Error(`MATRIX_DOCUMENT_PDF_TIMEOUT:${lastDiagnostic}`)), timeoutMs);
  });
  try {
    await trigger();
  } catch (error) {
    if (!settled) {
      settled = true;
      clearTimeout(timer);
      removeHandler();
    }
    throw error;
  }
  return result;
}

async function downloadMatrixPdfByAction(context, page, actionId) {
  const id = String(actionId || '').trim();
  if (!id || id.length > 300) throw new Error('MATRIX_DOCUMENT_ACTION_INVALID');
  let control = null;
  for (const frame of page.frames()) {
    // XPath avec chaîne JSON évite d'interpréter l'id ASP.NET comme CSS.
    const direct = frame.locator(`xpath=//*[@id=${JSON.stringify(id)}]`).first();
    if (await direct.isVisible().catch(() => false)) { control = direct; break; }
  }
  if (!control) throw new Error('MATRIX_DOCUMENT_ACTION_MISSING');
  return waitForMatrixPdfResponse(context, () => control.click(), 45000);
}

async function clickMatrixMediaAnchor(openerPage, targetHref) {
  const anchors = openerPage.locator?.('a[href*="media.ashx" i]');
  if (anchors) {
    const count = Math.min(await anchors.count().catch(() => 0), 100);
    for (let index = 0; index < count; index += 1) {
      const anchor = anchors.nth(index);
      const rawHref = await anchor.getAttribute('href').catch(() => null);
      if (!rawHref) continue;
      let absoluteHref = rawHref;
      try { absoluteHref = new URL(rawHref, openerPage.url()).href; } catch {}
      if (absoluteHref !== targetHref) continue;
      await anchor.click({ timeout: 10000, noWaitAfter: true });
      return;
    }
    throw new Error('MATRIX_DOCUMENT_ANCHOR_MISSING');
  }
  // Compatibilité des doubles de test; en production, le clic Playwright
  // ci-dessus est toujours utilisé afin de reproduire le geste humain.
  await openerPage.evaluate((href) => { window.open(href, '_blank'); }, targetHref);
}

async function downloadMatrixPdfInBrowser(context, url, referer, openerPage = null) {
  const target = new URL(String(url));
  if (target.protocol !== 'https:' || !/(^|\.)centris\.ca$/i.test(target.hostname)) {
    throw new Error('MATRIX_DOCUMENT_URL_REJECTED');
  }
  if (openerPage) {
    let popup = null;
    let popupPromise = null;
    try {
      popupPromise = openerPage.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
      const bufferPromise = waitForMatrixPdfResponse(context, () =>
        clickMatrixMediaAnchor(openerPage, target.href), 12000);
      // Attacher immédiatement le gestionnaire de rejet: attendre d'abord le
      // popup créait une fenêtre de 10 s où un échec rapide devenait une
      // unhandledRejection en production.
      const buffer = await bufferPromise;
      popup = await popupPromise;
      return buffer;
    } finally {
      if (!popup && popupPromise) popup = await popupPromise.catch(() => null);
      try { await popup?.close(); } catch {}
    }
  }
  const tab = await context.newPage();
  try {
    const response = await tab.goto(target.href, { referer, waitUntil: 'commit', timeout: 30000 });
    if (!response) throw new Error('MATRIX_DOCUMENT_NO_RESPONSE');
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const contentType = String(response.headers()['content-type'] || '').toLowerCase();
    const contentLength = Number(response.headers()['content-length'] || 0);
    if (contentLength > MATRIX_DOCUMENT_FILE_MAX_BYTES) throw new Error('MATRIX_DOCUMENT_TOO_LARGE');
    const buffer = await response.body();
    if (buffer.length > MATRIX_DOCUMENT_FILE_MAX_BYTES) throw new Error('MATRIX_DOCUMENT_TOO_LARGE');
    if (buffer.length < 1000 || buffer.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) === -1) {
      throw new Error(`MATRIX_DOCUMENT_NOT_PDF:${contentType || 'unknown'}`);
    }
    return buffer;
  } finally {
    await tab.close().catch(() => {});
  }
}

async function downloadMatrixPdfAuthenticated(context, url, referer, openerPage = null) {
  const target = new URL(String(url));
  if (target.protocol !== 'https:' || !/(^|\.)centris\.ca$/i.test(target.hostname)) {
    throw new Error('MATRIX_DOCUMENT_URL_REJECTED');
  }
  let requestError = null;
  try {
    const response = await context.request.get(target.href, {
      headers: { Referer: referer, Accept: 'application/pdf,*/*' },
      timeout: 30000,
    });
    if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
    const contentLength = Number(response.headers()['content-length'] || 0);
    if (contentLength > MATRIX_DOCUMENT_FILE_MAX_BYTES) throw new Error('MATRIX_DOCUMENT_TOO_LARGE');
    const buffer = await response.body();
    if (buffer.length > MATRIX_DOCUMENT_FILE_MAX_BYTES) throw new Error('MATRIX_DOCUMENT_TOO_LARGE');
    if (buffer.length < 1000 || buffer.subarray(0, 1024).indexOf(Buffer.from('%PDF-')) === -1) {
      throw new Error(`MATRIX_DOCUMENT_NOT_PDF:${String(response.headers()['content-type'] || 'unknown')}`);
    }
    return buffer;
  } catch (error) {
    requestError = safeErrorMessage(error).substring(0, 100);
  }
  try {
    return await downloadMatrixPdfInBrowser(context, target.href, referer, openerPage);
  } catch (browserError) {
    throw new Error(`MATRIX_DOWNLOAD_FAILED:request=${requestError};browser=${safeErrorMessage(browserError).substring(0, 100)}`);
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

async function parsePdfBufferWithModule(pdfModule, pdfBuffer) {
  const legacyParser = typeof pdfModule === 'function'
    ? pdfModule
    : typeof pdfModule?.default === 'function'
      ? pdfModule.default
      : null;
  if (legacyParser) return legacyParser(pdfBuffer);

  if (typeof pdfModule?.PDFParse === 'function') {
    const parser = new pdfModule.PDFParse({ data: pdfBuffer });
    try {
      // pdf-parse 2.4.x expose getText(); getRaw() n'existe pas dans cette API.
      if (typeof parser.getText !== 'function') throw new Error('API pdf-parse v2 getText absente');
      return await parser.getText();
    } finally {
      await parser.destroy?.();
    }
  }
  throw new Error('API pdf-parse non supportée');
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
    const data = await parsePdfBufferWithModule(pdfParse, pdfBuffer);
    const text = String(data?.text || '');
    const pages = Number(data?.numpages || data?.numPages || data?.total || data?.pages?.length || 0);
    return {
      text,
      pages,
      info: data?.info || data?.infoData || null,
      length: text.length,
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
  // Taxes: PDF texte = fallback seulement. Ne jamais choisir arbitrairement
  // entre plusieurs montants (année courante, historique, estimé, etc.).
  const municipalCandidates = extractTaxCandidatesFromText(text, 'taxes?\\s*municipal(?:e|es|aux)?');
  const schoolCandidates = extractTaxCandidatesFromText(text, 'taxes?\\s*scolair(?:e|es)?');
  data.taxes_provenance = 'pdf-text-fallback';
  data.taxes_municipales_candidates = municipalCandidates;
  data.taxes_scolaires_candidates = schoolCandidates;
  if (municipalCandidates.length === 1) data.taxes_municipales = municipalCandidates[0];
  if (schoolCandidates.length === 1) data.taxes_scolaires = schoolCandidates[0];
  data.taxes_ambiguous = municipalCandidates.length > 1 || schoolCandidates.length > 1;
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
 * @param {string} opts.confirmationMessage — confirmation exacte et courante de Shawn
 * @returns {Promise<{success, message, email_sent_to, cc, listing_url, screenshots?}>}
 */
async function sendCentrisListingByEmail(opts) {
  if (!hasExplicitCentrisSendConfirmation(opts?.confirmationMessage)) {
    return { success: false, blocked: true, message: 'Envoi Centris bloqué: confirmation exacte « envoie » requise' };
  }
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
      const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const li = [...document.querySelectorAll('li')].find(l => norm(l.title || l.textContent) === norm(title));
      const cb = li?.querySelector('input[type=checkbox]');
      if (cb) { if (!cb.checked) cb.click(); return true; }
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
      const appReady = await waitForZoneAppReady(page);
      const u = page.url();
      const state = await inspectZonePage(page, '');
      if (appReady && /Dashboard|Directory|Listings/i.test(u) && !/login|signin/i.test(u) && state.code !== 'ZONE_AUTH_REQUIRED') {
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

  // Vérif logged: une URL Dashboard avec une application vide n'est pas une
  // session valide. Attendre le rendu réel de Zone avant de continuer.
  const appReady = await waitForZoneAppReady(page);
  const loggedState = await inspectZonePage(page, '');
  if (!appReady) {
    throw new Error(`ZONE_APP_BLANK — Centris Zone n'a rendu aucun contrôle après la connexion`);
  }
  if (!/Dashboard|Directory|Listings/i.test(page.url()) || loggedState.code === 'ZONE_AUTH_REQUIRED') {
    throw new Error(`Zone login échoué — URL: ${page.url().substring(0, 100)}`);
  }
  console.log('[ZONE] Logged ✅');
  // Save cookies pour reuse
  try {
    const cookies = await context.cookies();
    await saveBrowserStorageState(context, page);
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
 * @param {string} [opts.confirmationMessage] — requis pour tout envoi réel
 * @param {string} [opts.expectedManifestId] — empreinte du dry-run; requise pour lier l'envoi au même dossier
 * @returns {Promise<{success, broker_info, docs_shared, docs_list?, sent_to, listing_url, dry_run?}>}
 */
async function runCentrisZoneDocuments(opts = {}) {
  if (!opts.dry_run && !hasExplicitCentrisSendConfirmation(opts.confirmationMessage)) {
    return { success: false, blocked: true, message: 'Partage Zone bloqué: confirmation exacte « envoie » requise' };
  }
  if (!CUA_AVAILABLE()) return { success: false, message: 'Playwright non disponible' };
  loadDeps();
  initDirs();
  const { centris_num, email, dry_run = false, sendSelfCopy = false, langue = 'fr', message, expectedManifestId } = opts;
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

    // 2. Navigation vérifiée. Zéro document n'est jamais interprété comme
    // listing inexistant sans un état explicite rendu par Zone.
    const navigation = await navigateToZoneDocuments(page, centris_num);
    const zoneState = navigation.state;
    if (zoneState.code !== 'ZONE_DOCUMENTS_READY' && zoneState.code !== 'ZONE_NO_DOCUMENTS') {
      return {
        success: false,
        error_code: zoneState.code,
        message: `Accès Zone non confirmé (${zoneState.code}). Aucun envoi effectué.`,
        broker_info: broker,
        listing_public_found: broker.source === 'centris.ca-public',
        final_url: zoneState.url,
        navigation_attempts: navigation.attempts,
      };
    }

    // 3. Liste les docs (et coche pour count) — capture noms+tailles
    const docsInfo = await page.evaluate((isDryRun) => {
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
        docs.push({
          name: name.trim(),
          size: sizeMatch?.[0] || null,
          provenance: 'zone',
          source_section: 'zone_documents',
        });
        if (!isDryRun && !cb.checked) cb.click();
      }
      return docs;
    }, dry_run);
    const checkedCount = docsInfo.length;
    const inventory = buildCentrisDocumentInventory(centris_num, docsInfo);
    console.log(`[ZONE${dry_run?'-DRY':''}] ${checkedCount} documents listés${dry_run?' (DRY-RUN)':' cochés'}`);
    if (checkedCount === 0) {
      return {
        success: false,
        error_code: zoneState.code === 'ZONE_NO_DOCUMENTS' ? 'ZONE_NO_DOCUMENTS' : 'ZONE_DOCUMENT_SELECTORS_CHANGED',
        message: zoneState.code === 'ZONE_NO_DOCUMENTS'
          ? `Listing #${centris_num} trouvé dans Zone, mais aucun document n’y est disponible.`
          : `Page Documents trouvée pour #${centris_num}, mais l’inventaire n’a pas pu être lu. Aucun envoi effectué.`,
        broker_info: broker,
        listing_public_found: broker.source === 'centris.ca-public',
        final_url: zoneState.url,
        navigation_attempts: navigation.attempts,
      };
    }

    // DRY-RUN: short-circuit ici, pas d'envoi
    if (dry_run) {
      return {
        success: true,
        dry_run: true,
        broker_info: broker,
        docs_count: checkedCount,
        docs_list: inventory.docs,
        document_inventory: inventory,
        manifest_id: inventory.manifest_id,
        listing_url: `https://zone.centris.ca/Listings/${centris_num}/Documents`,
        message: `PREVIEW — ${checkedCount} docs prêts à partager. Confirme avec envoyer_tous_documents_zone pour livrer.`,
      };
    }

    if (!expectedManifestId) {
      return {
        success: false,
        blocked: true,
        message: 'Partage Zone bloqué: inventaire dry-run manquant. Relance verifier_listing_centris.',
      };
    }
    if (expectedManifestId !== inventory.manifest_id) {
      return {
        success: false,
        blocked: true,
        message: 'Partage Zone bloqué: la liste des documents a changé depuis l’aperçu. Une nouvelle vérification est requise.',
        expected_manifest_id: expectedManifestId,
        actual_manifest_id: inventory.manifest_id,
        document_inventory: inventory,
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
      docs_list: inventory.docs,
      document_inventory: inventory,
      manifest_id: inventory.manifest_id,
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

async function shareCentrisZoneDocuments(opts = {}) {
  if (!opts.dry_run && !hasExplicitCentrisSendConfirmation(opts.confirmationMessage)) {
    return { success: false, blocked: true, message: 'Partage Zone bloqué: confirmation exacte « envoie » requise' };
  }
  if (!opts.dry_run) return runCentrisZoneDocuments(opts);
  const key = String(opts.centris_num || '').replace(/\D/g, '');
  if (zonePreviewInFlight.has(key)) {
    console.log(`[ZONE-DRY] Preview #${key} déjà en cours — résultat partagé`);
    return zonePreviewInFlight.get(key);
  }
  const task = runCentrisZoneDocuments(opts).finally(() => zonePreviewInFlight.delete(key));
  zonePreviewInFlight.set(key, task);
  return task;
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

    // STRATÉGIE OPTIMALE: navigate Matrix Home (SPA JS-rendered) + wait JS hydrate + use search
    console.log(`[FICHE-PDF] Navigate Matrix Home (networkidle)`);
    await page.goto(`${MATRIX_BASE}/Matrix`, { waitUntil: 'networkidle', timeout: 45000 }).catch(async () => {
      // Fallback si networkidle timeout (Matrix peut avoir des long-polling)
      await page.goto(`${MATRIX_BASE}/Matrix`, { waitUntil: 'load', timeout: 30000 });
    });
    await page.waitForTimeout(5000); // JS hydrate SPA

    // Wait for search field — Matrix SPA peut prendre du temps à render
    console.log('[FICHE-PDF] Wait search field (up to 30s)');
    let searchSelector = null;
    try {
      await page.waitForFunction(() => {
        const cands = ['#QueryText', 'input[id*="Query"]', 'input[id*="Search"]', 'input[placeholder*="echerche" i]', 'input[placeholder*="Centris" i]', 'input[placeholder*="MLS" i]', 'input[type=search]'];
        for (const sel of cands) { const el = document.querySelector(sel); if (el && el.offsetParent && !el.disabled) return true; }
        return false;
      }, { timeout: 30000 });
      searchSelector = await page.evaluate(() => {
        const cands = ['#QueryText', 'input[id*="Query"]', 'input[id*="Search"]', 'input[placeholder*="echerche" i]', 'input[placeholder*="Centris" i]', 'input[placeholder*="MLS" i]', 'input[type=search]'];
        for (const sel of cands) { const el = document.querySelector(sel); if (el && el.offsetParent && !el.disabled) return sel; }
        return null;
      });
    } catch (e) {
      console.warn('[FICHE-PDF] Search field timeout, screenshot current state');
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
      console.log(`[FICHE-PDF] Body preview: ${bodyText.substring(0, 300)}`);
    }
    if (!searchSelector) throw new Error('Champ recherche Matrix introuvable (Matrix SPA pas chargé ou UI changée)');
    console.log(`[FICHE-PDF] Search field found: ${searchSelector}`);

    // Search le listing
    console.log(`[FICHE-PDF] Search #${centrisNum}`);
    await page.fill(searchSelector, String(centrisNum));
    await page.locator(searchSelector).press('Enter');
    await page.waitForTimeout(5000);

    // Click le lien result (numéro Centris)
    const linkClicked = await page.evaluate((n) => {
      // Multiple stratégies pour trouver le lien
      const numStr = String(n);
      // 1. <a> avec text exact = numéro
      let a = [...document.querySelectorAll('a')].find(x => x.textContent.trim() === numStr);
      // 2. <a> avec text contenant le numéro
      if (!a) a = [...document.querySelectorAll('a')].find(x => x.textContent.includes(numStr) && x.href && /listing|property|detail/i.test(x.href));
      // 3. Row TR avec data-mls/data-num
      if (!a) {
        const row = document.querySelector(`[data-mls="${numStr}"], [data-listingid="${numStr}"], [data-num="${numStr}"]`);
        if (row) { row.click(); return 'row-click'; }
      }
      if (a) { a.click(); return 'link-click'; }
      return null;
    }, centrisNum);
    if (!linkClicked) {
      const bodyText = await page.evaluate(() => document.body?.innerText?.substring(0, 1000) || '');
      throw new Error(`Listing #${centrisNum} non trouvé dans résultats search. Body: ${bodyText.substring(0, 200)}`);
    }
    console.log(`[FICHE-PDF] Result clicked (${linkClicked})`);
    await page.waitForTimeout(5000);
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
      const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
      const li = [...document.querySelectorAll('li')].find(l => norm(l.title || l.textContent) === norm(title));
      const cb = li?.querySelector('input[type=checkbox]');
      if (cb) { if (!cb.checked) cb.click(); return true; }
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
  previewCentrisMatrixDocuments,
  getListingBroker,
  _loginCentrisZone: loginCentrisZone,
  // Internals exposés pour tests
  _loginCentris: loginCentris,
  _runCUATask: runCUATask,
  _executeCUAAction: executeCUAAction,
  _newStealthContext: newStealthContext,
  _browserlessEndpointWithTimeout: browserlessEndpointWithTimeout,
  _isAuthenticatedCentrisUrl: isAuthenticatedCentrisUrl,
  _cookieHeaderFromPlaywrightCookies: cookieHeaderFromPlaywrightCookies,
  _hasExplicitCentrisSendConfirmation: hasExplicitCentrisSendConfirmation,
  _buildCentrisDocumentInventory: buildCentrisDocumentInventory,
  _buildCentrisContentManifest: buildCentrisContentManifest,
  _addCentrisContentMetadata: addCentrisContentMetadata,
  _parseCentrisDisplaySize: parseCentrisDisplaySize,
  _normalizeCentrisLabel: normalizeCentrisLabel,
  _classifyZonePageSnapshot: classifyZonePageSnapshot,
  _classifyMatrixPageSnapshot: classifyMatrixPageSnapshot,
  _matrixTextContainsExactNumber: matrixTextContainsExactNumber,
  _extractTaxCandidatesFromText: extractTaxCandidatesFromText,
  _downloadMatrixPdfInBrowser: downloadMatrixPdfInBrowser,
  _downloadMatrixPdfAuthenticated: downloadMatrixPdfAuthenticated,
  _downloadMatrixPdfByAction: downloadMatrixPdfByAction,
  _waitForMatrixPdfResponse: waitForMatrixPdfResponse,
  _mapWithConcurrency: mapWithConcurrency,
  _parsePdfBufferWithModule: parsePdfBufferWithModule,
  cuaLoginCentris,
  ingestManualMFACode,
  isAwaitingCentrisMFA,
};
