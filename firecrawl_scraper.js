// firecrawl_scraper.js — Scraper municipal bulletproof pour Kira Bot
// API Firecrawl v1 (https://api.firecrawl.dev/v1/scrape)
// Clé via env var FIRECRAWL_API_KEY uniquement — jamais en dur dans le code.
// Utilise fetch natif Node 18+ (pas de dépendance node-fetch).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';

const CONFIG = {
  apiKey:       process.env.FIRECRAWL_API_KEY || '',
  baseUrl:      'https://api.firecrawl.dev/v1',
  quotaMonthly: parseInt(process.env.FIRECRAWL_QUOTA_MONTHLY || '500'),
  cacheDir:     path.join(DATA_DIR, 'firecrawl_cache'),
  auditLog:     path.join(DATA_DIR, 'firecrawl_audit.jsonl'),
  quotaFile:    path.join(DATA_DIR, 'firecrawl_quota.json'),
  cacheTTL:     30 * 24 * 60 * 60 * 1000, // 30 jours
  timeout:      45000,
  retries:      2,
  waitFor:      2000,
};

try { if (!fs.existsSync(CONFIG.cacheDir)) fs.mkdirSync(CONFIG.cacheDir, { recursive: true }); } catch {}

// ═══════════════════════════════════════════════════════
// VILLES PRÉ-CONFIGURÉES (Lanaudière + MRC)
// ═══════════════════════════════════════════════════════

const MUNICIPALITES = {
  'sainte-julienne': {
    nom: 'Sainte-Julienne', baseUrl: 'https://sainte-julienne.com',
    pages: {
      zonage:    '/services-aux-citoyens/urbanisme/reglement-de-zonage/',
      urbanisme: '/services-aux-citoyens/urbanisme/',
      permis:    '/services-aux-citoyens/urbanisme/permis-et-certificats/',
      taxes:     '/services-aux-citoyens/taxation/',
    },
    telephone: '450-831-2929', note_urbanisme: 'Poste 7235',
  },
  'rawdon': {
    nom: 'Rawdon', baseUrl: 'https://rawdon.ca',
    pages: {
      zonage: '/services-municipaux/urbanisme/', urbanisme: '/services-municipaux/urbanisme/',
      permis: '/services-municipaux/urbanisme/permis/', taxes: '/services-municipaux/taxation/',
    },
    telephone: '450-834-2596',
  },
  'chertsey': {
    nom: 'Chertsey', baseUrl: 'https://chertsey.ca',
    pages: {
      zonage: '/services-aux-citoyens/urbanisme/', urbanisme: '/services-aux-citoyens/urbanisme/',
      permis: '/services-aux-citoyens/urbanisme/', taxes: '/services-aux-citoyens/taxation/',
    },
    telephone: '450-882-2920',
  },
  'saint-calixte': {
    nom: 'Saint-Calixte', baseUrl: 'https://saint-calixte.ca',
    pages: {
      zonage: '/services-municipaux/urbanisme/', urbanisme: '/services-municipaux/urbanisme/',
      permis: '/services-municipaux/urbanisme/permis/', taxes: '/services-municipaux/taxation/',
    },
    telephone: '450-839-2002',
  },
  'saint-jean-de-matha': {
    nom: 'Saint-Jean-de-Matha', baseUrl: 'https://saint-jean-de-matha.ca',
    pages: { zonage: '/urbanisme/', urbanisme: '/urbanisme/', permis: '/urbanisme/permis/', taxes: '/taxation/' },
    telephone: '450-886-3778',
  },
  'saint-didace': {
    nom: 'Saint-Didace', baseUrl: 'https://saint-didace.com',
    pages: { zonage: '/urbanisme/', urbanisme: '/urbanisme/', permis: '/urbanisme/', taxes: '/taxation/' },
    telephone: '450-835-9340',
  },
  'matawinie': {
    nom: 'MRC Matawinie', baseUrl: 'https://matawinie.org',
    pages: {
      zonage:    '/amenagement-du-territoire/',
      urbanisme: '/amenagement-du-territoire/',
      schema:    '/amenagement-du-territoire/schema-damenagement/',
      riveraine: '/amenagement-du-territoire/protection-rives-littoral/',
    },
    telephone: '450-834-5441',
  },
  'd-autray': {
    nom: "MRC D'Autray", baseUrl: 'https://mrcautray.qc.ca',
    pages: { zonage: '/amenagement/', urbanisme: '/amenagement/' },
    telephone: '450-836-7007',
  },
};

const SUJETS_MOTS_CLES = {
  zonage:     ['marge', 'latérale', 'arrière', 'avant', 'recul', 'hauteur', 'implantation', 'zone', 'grille'],
  urbanisme:  ['règlement', 'zonage', 'subdivision', 'usage', 'lotissement'],
  permis:     ['permis', 'certificat', 'autorisation', 'construction', 'délai', 'frais'],
  taxes:      ['taux', 'taxe', 'évaluation', 'foncière', 'cotisation'],
  riveraine:  ['riveraine', 'littoral', 'bande', "cours d'eau", '30 mètres', '15 mètres'],
};

// ═══════════════════════════════════════════════════════
// CACHE (MD5 + TTL 30j, path traversal safe)
// ═══════════════════════════════════════════════════════

function cacheKey(url) {
  return crypto.createHash('md5').update(String(url)).digest('hex').replace(/[^a-f0-9]/g, '');
}

function getCached(url) {
  try {
    const file = path.join(CONFIG.cacheDir, `${cacheKey(url)}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - data.timestamp > CONFIG.cacheTTL) {
      try { fs.unlinkSync(file); } catch {}
      return null;
    }
    return data;
  } catch { return null; }
}

function setCached(url, markdown, metadata = {}) {
  try {
    const file = path.join(CONFIG.cacheDir, `${cacheKey(url)}.json`);
    fs.writeFileSync(file, JSON.stringify({
      url, markdown, metadata,
      timestamp: Date.now(),
      cached_at: new Date().toISOString(),
    }), 'utf8');
  } catch (e) { /* cache non-bloquant */ }
}

// ═══════════════════════════════════════════════════════
// QUOTA
// ═══════════════════════════════════════════════════════

function currentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getQuota() {
  try {
    if (!fs.existsSync(CONFIG.quotaFile)) return { month: currentMonth(), count: 0 };
    const data = JSON.parse(fs.readFileSync(CONFIG.quotaFile, 'utf8'));
    if (data.month !== currentMonth()) return { month: currentMonth(), count: 0 };
    return data;
  } catch { return { month: currentMonth(), count: 0 }; }
}

function incrementQuota() {
  const state = getQuota();
  state.count += 1;
  try { fs.writeFileSync(CONFIG.quotaFile, JSON.stringify(state), 'utf8'); } catch {}
  return state;
}

function checkQuota() {
  const state = getQuota();
  if (state.count >= CONFIG.quotaMonthly) {
    return { ok: false, message: `❌ Quota Firecrawl épuisé ce mois (${state.count}/${CONFIG.quotaMonthly})` };
  }
  return { ok: true, count: state.count, quota: CONFIG.quotaMonthly };
}

// ═══════════════════════════════════════════════════════
// AUDIT
// ═══════════════════════════════════════════════════════

function auditLog(action, url, success, details = {}) {
  try {
    const entry = JSON.stringify({ ts: new Date().toISOString(), action, url, success, ...details });
    fs.appendFileSync(CONFIG.auditLog, entry + '\n', 'utf8');
  } catch { /* non-bloquant */ }
}

// ═══════════════════════════════════════════════════════
// SCRAPE CORE (retry + timeout + cache + quota)
// ═══════════════════════════════════════════════════════

async function scrapUrlRaw(url) {
  if (!CONFIG.apiKey) throw new Error('FIRECRAWL_API_KEY manquante dans les env vars');

  const cached = getCached(url);
  if (cached) {
    auditLog('scrape_cache_hit', url, true, { cached_at: cached.cached_at });
    return { markdown: cached.markdown, fromCache: true, cached_at: cached.cached_at };
  }

  const quota = checkQuota();
  if (!quota.ok) throw new Error(quota.message);

  let lastError;
  for (let attempt = 1; attempt <= CONFIG.retries + 1; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.timeout);
    try {
      const response = await fetch(`${CONFIG.baseUrl}/scrape`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${CONFIG.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url, formats: ['markdown'],
          onlyMainContent: true,
          timeout: CONFIG.timeout,
          waitFor: CONFIG.waitFor,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!response.ok) {
        const errBody = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}: ${errBody.substring(0, 200)}`);
      }
      const data = await response.json();
      if (!data.success || !data.data?.markdown) {
        throw new Error('Firecrawl: success:false ou markdown vide');
      }
      const markdown = data.data.markdown;
      const metadata = data.data.metadata || {};
      setCached(url, markdown, metadata);
      incrementQuota();
      auditLog('scrape_api', url, true, { attempt, chars: markdown.length });
      return { markdown, fromCache: false, metadata };
    } catch (e) {
      clearTimeout(timer);
      lastError = e;
      if (e.name === 'AbortError') lastError = new Error(`Timeout ${CONFIG.timeout/1000}s — ${url}`);
      if (attempt <= CONFIG.retries) {
        const delay = attempt * 3000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  auditLog('scrape_api', url, false, { error: lastError.message });
  throw lastError;
}

// ═══════════════════════════════════════════════════════
// EXTRACTION SECTION (par mots-clés)
// ═══════════════════════════════════════════════════════

function extractSection(markdown, motsCles) {
  if (!motsCles || motsCles.length === 0) return markdown;
  const lines = markdown.split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    const hasKeyword = motsCles.some(k => lineLower.includes(String(k).toLowerCase()));
    if (hasKeyword) {
      const start = Math.max(0, i - 3);
      const end = Math.min(lines.length - 1, i + 15);
      const chunk = lines.slice(start, end + 1).join('\n');
      if (!chunks.includes(chunk)) chunks.push(chunk);
    }
  }
  if (chunks.length === 0) {
    return markdown.substring(0, 500) + '\n\n*(Section spécifique non trouvée — aperçu partiel)*';
  }
  return chunks.join('\n\n---\n\n');
}

// ═══════════════════════════════════════════════════════
// API PUBLIQUE
// ═══════════════════════════════════════════════════════

async function scrapMunicipalite(ville, sujet = 'zonage') {
  const villeKey = String(ville || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
  const muni = MUNICIPALITES[villeKey];
  if (!muni) {
    return {
      success: false,
      error: `Ville "${ville}" non configurée. Disponibles: ${Object.keys(MUNICIPALITES).join(', ')}`,
      telephone: null,
    };
  }
  const pageKey = sujet in muni.pages ? sujet : 'urbanisme';
  const url = muni.baseUrl + muni.pages[pageKey];
  const motsCles = SUJETS_MOTS_CLES[sujet] || SUJETS_MOTS_CLES.zonage;
  try {
    const result = await scrapUrlRaw(url);
    const section = extractSection(result.markdown, motsCles);
    const quota = getQuota();
    const pctQuota = Math.round((quota.count / CONFIG.quotaMonthly) * 100);
    return {
      success: true, ville: muni.nom, sujet, url,
      contenu: section, fromCache: result.fromCache,
      cached_at: result.cached_at || null,
      telephone: muni.telephone, note_urbanisme: muni.note_urbanisme || null,
      quota: `${quota.count}/${CONFIG.quotaMonthly} (${pctQuota}%)`,
    };
  } catch (e) {
    auditLog('scrape_municipalite', url, false, { ville, sujet, error: e.message });
    return {
      success: false, ville: muni.nom, sujet, url, error: e.message,
      fallback: `📞 Appeler ${muni.nom} directement: ${muni.telephone}${muni.note_urbanisme ? ' (' + muni.note_urbanisme + ')' : ''} pour le règlement de ${sujet}`,
      telephone: muni.telephone,
    };
  }
}

async function scrapUrlPublic(url, motsCles = []) {
  if (!/^https?:\/\//.test(String(url || ''))) {
    return { success: false, error: 'URL doit commencer par http:// ou https://' };
  }
  try {
    const result = await scrapUrlRaw(url);
    const contenu = Array.isArray(motsCles) && motsCles.length > 0
      ? extractSection(result.markdown, motsCles)
      : result.markdown.substring(0, 3000);
    const quota = getQuota();
    return {
      success: true, url, contenu,
      fromCache: result.fromCache,
      cached_at: result.cached_at || null,
      quota: `${quota.count}/${CONFIG.quotaMonthly}`,
    };
  } catch (e) {
    return { success: false, url, error: e.message };
  }
}

function getQuotaStatus() {
  const state = getQuota();
  const pct = Math.round((state.count / CONFIG.quotaMonthly) * 100);
  const restant = CONFIG.quotaMonthly - state.count;
  return {
    mois: state.month, utilise: state.count, quota: CONFIG.quotaMonthly,
    restant, pourcentage: pct,
    statut: pct >= 100 ? '🔴 ÉPUISÉ' : pct >= 80 ? '🟡 ATTENTION' : '🟢 OK',
  };
}

module.exports = {
  scrapMunicipalite,
  scrapUrl: scrapUrlPublic,
  getQuotaStatus,
  MUNICIPALITES,
  SUJETS_MOTS_CLES,
};
