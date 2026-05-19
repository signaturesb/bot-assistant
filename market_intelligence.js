// market_intelligence.js — Scraper centralisé des sources immobilières QC
// Sources configurées par Shawn:
//   - Banque du Canada (taux directeur)
//   - APCIQ (stats marché QC)
//   - OACIQ (règlements courtiers)
//   - Centris.ca (snapshot marché grand public)
//   - MultiPrêt + PlaniPrêt (taux hypothécaires)
//   - DuProprio, Realtor.ca (comparables hors Centris)
//   - Royal LePage, RE/MAX Québec, Sutton (stats régionales)
//
// Architecture:
//   - getMarketSnapshot() → load /data/market_snapshot.json (24h cache)
//   - refreshMarketSnapshot() → scrape toutes sources, save
//   - Cron quotidien 5h matin
//   - Injection HTML campagne via {{ MARKET.X }}
//
// Usage:
//   const { getMarketSnapshot, refreshMarketSnapshot } = require('./market_intelligence');
//   const snapshot = await getMarketSnapshot();
//   html.replace('{{ MARKET.taux_directeur }}', snapshot.banque_canada.taux_directeur);

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const SNAPSHOT_FILE = path.join(DATA_DIR, 'market_snapshot.json');
// Shawn: spot-check des nouvelles infos toutes les 3 semaines
const SNAPSHOT_TTL = 21 * 24 * 60 * 60 * 1000; // 3 semaines
const FRESH_CHECK_TTL = 3 * 24 * 60 * 60 * 1000; // mais re-check 3j pour taux qui bougent

// Lazy load firecrawl (déjà installé)
let _fc = null;
function getFC() {
  if (_fc === null) {
    try { _fc = require('./firecrawl_scraper'); }
    catch (e) { _fc = false; console.warn('[MARKET] firecrawl_scraper indispo:', e.message); }
  }
  return _fc || null;
}

// Helper: extract premier taux % proche d'un mot-clé
function findRateNear(md, keywords, opts = {}) {
  const txt = md.toLowerCase();
  for (const kw of keywords) {
    const idx = txt.indexOf(kw.toLowerCase());
    if (idx < 0) continue;
    // Cherche % dans 200 chars avant et après
    const start = Math.max(0, idx - 200);
    const end = Math.min(md.length, idx + 200);
    const window = md.substring(start, end);
    const m = window.match(/(\d+[\.,]\d{1,3})\s*%/);
    if (m) {
      const val = parseFloat(m[1].replace(',', '.'));
      if (val > (opts.min || 0) && val < (opts.max || 20)) return val;
    }
  }
  return null;
}

// ── Sources configurées (toutes celles demandées par Shawn) ──────────────────
const SOURCES = {
  // === ÉCONOMIQUES — taux qui bougent souvent ===
  banque_canada: {
    label: 'Banque du Canada — Taux directeur',
    url: 'https://www.bankofcanada.ca/rates/',
    keywords: ['target for the overnight rate', 'taux du financement', 'bank rate', 'policy rate', 'taux directeur'],
    fresh: true, // re-scrape souvent
    extract: (md) => {
      const taux = findRateNear(md, ['policy rate', 'target for the overnight', 'taux directeur', 'overnight rate'], { min: 0.1, max: 10 });
      return {
        taux_directeur: taux,
        as_of: new Date().toISOString().slice(0, 10),
        resume: md.substring(0, 800),
      };
    },
  },
  multipret: {
    label: 'MultiPrêt — Taux hypothécaires',
    url: 'https://multi-prets.com/taux-hypothecaires/',
    keywords: ['taux fixe', 'taux variable', '5 ans', '3 ans', 'hypothèque'],
    fresh: true,
    extract: (md) => {
      const m5fix = findRateNear(md, ['fixe 5 ans', '5 ans fixe', '5-year fixed'], { min: 2, max: 10 });
      const m5var = findRateNear(md, ['variable 5 ans', '5 ans variable'], { min: 2, max: 10 });
      const m3fix = findRateNear(md, ['fixe 3 ans', '3 ans fixe'], { min: 2, max: 10 });
      return {
        fixe_5ans: m5fix, variable_5ans: m5var, fixe_3ans: m3fix,
        resume: md.substring(0, 1500), scraped_at: new Date().toISOString(),
      };
    },
  },
  planipret: {
    label: 'PlaniPrêt — Taux hypothécaires',
    url: 'https://planipret.com/taux-hypothecaires/',
    keywords: ['taux fixe', 'taux variable', '5 ans'],
    fresh: true,
    extract: (md) => {
      const m5fix = findRateNear(md, ['fixe 5 ans', '5 ans fixe', '5-year'], { min: 2, max: 10 });
      const m5var = findRateNear(md, ['variable 5 ans', '5 ans variable'], { min: 2, max: 10 });
      return { fixe_5ans: m5fix, variable_5ans: m5var, resume: md.substring(0, 1500), scraped_at: new Date().toISOString() };
    },
  },
  // === STATS MARCHÉ QC ===
  apciq: {
    label: 'APCIQ — Statistiques marché QC',
    url: 'https://apciq.ca/statistiques-immobilieres/',
    keywords: ['statistiques', 'ventes', 'prix médian', 'inventaire', 'mois', 'trimestre'],
    extract: (md) => ({ resume: md.substring(0, 2500), scraped_at: new Date().toISOString() }),
  },
  apciq_lanaudiere: {
    label: 'APCIQ — Lanaudière',
    url: 'https://apciq.ca/statistiques/lanaudiere/',
    keywords: ['lanaudière', 'ventes', 'prix'],
    extract: (md) => ({ resume: md.substring(0, 2000), scraped_at: new Date().toISOString() }),
  },
  oaciq: {
    label: 'OACIQ — Règlements + Pratique',
    url: 'https://www.oaciq.com/fr',
    keywords: ['nouveauté', 'règlement', 'avis', 'pratique', 'courtier', 'mise à jour'],
    extract: (md) => ({ resume: md.substring(0, 1500), scraped_at: new Date().toISOString() }),
  },
  // === SITES IMMOBILIERS QC (les plus gros) ===
  centris_public: {
    label: 'Centris.ca — Tendances',
    url: 'https://www.centris.ca/fr/tendances',
    keywords: ['marché', 'tendance', 'prix', 'région'],
    extract: (md) => ({ resume: md.substring(0, 1500), scraped_at: new Date().toISOString() }),
  },
  duproprio: {
    label: 'DuProprio',
    url: 'https://duproprio.com/fr',
    keywords: ['propriétés', 'vente', 'maisons'],
    extract: (md) => ({ resume: md.substring(0, 1000), scraped_at: new Date().toISOString() }),
  },
  realtor: {
    label: 'Realtor.ca — National',
    url: 'https://www.realtor.ca/blog/data-and-analysis',
    keywords: ['housing', 'sales', 'price', 'national', 'monthly'],
    extract: (md) => ({ resume: md.substring(0, 1500), scraped_at: new Date().toISOString() }),
  },
  remax_qc: {
    label: 'RE/MAX Québec',
    url: 'https://www.remax-quebec.com/fr/blogue/',
    keywords: ['marché', 'tendance', 'région'],
    extract: (md) => ({ resume: md.substring(0, 1200), scraped_at: new Date().toISOString() }),
  },
  royal_lepage: {
    label: 'Royal LePage',
    url: 'https://www.royallepage.ca/fr/realestate/news/',
    keywords: ['marché', 'prix', 'maison', 'tendance'],
    extract: (md) => ({ resume: md.substring(0, 1500), scraped_at: new Date().toISOString() }),
  },
  sutton_qc: {
    label: 'Sutton Québec',
    url: 'https://www.suttonquebec.com/fr/articles',
    keywords: ['marché', 'région', 'maison'],
    extract: (md) => ({ resume: md.substring(0, 1200), scraped_at: new Date().toISOString() }),
  },
  via_capitale: {
    label: 'Via Capitale',
    url: 'https://www.viacapitalevendu.com/fr/blogue',
    keywords: ['marché', 'région', 'maison'],
    extract: (md) => ({ resume: md.substring(0, 1200), scraped_at: new Date().toISOString() }),
  },
  jlr: {
    label: 'JLR Solutions Foncières',
    url: 'https://www.jlr.ca/articles-immobiliers',
    keywords: ['marché', 'prix', 'statistique', 'région'],
    extract: (md) => ({ resume: md.substring(0, 1500), scraped_at: new Date().toISOString() }),
  },
  shq: {
    label: 'Société Habitation Québec',
    url: 'https://www.habitation.gouv.qc.ca/',
    keywords: ['programme', 'aide', 'logement', 'subvention'],
    extract: (md) => ({ resume: md.substring(0, 1500), scraped_at: new Date().toISOString() }),
  },
};

// ── Cache management ────────────────────────────────────────────────────────
function loadSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_FILE)) return null;
    return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
  } catch { return null; }
}

function saveSnapshot(data) {
  try {
    fs.writeFileSync(SNAPSHOT_FILE + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(SNAPSHOT_FILE + '.tmp', SNAPSHOT_FILE);
  } catch (e) { console.warn('[MARKET] save:', e.message); }
}

async function getMarketSnapshot({ maxAge = SNAPSHOT_TTL } = {}) {
  const snap = loadSnapshot();
  if (snap && snap.ts && Date.now() - snap.ts < maxAge) return snap;
  // Stale → return existing if any, but caller should trigger refresh
  return snap;
}

// ── Refresh: scrape toutes les sources ──────────────────────────────────────
async function refreshMarketSnapshot({ sources = null, parallel = 3 } = {}) {
  const fc = getFC();
  if (!fc) throw new Error('firecrawl_scraper non disponible');
  const keys = sources || Object.keys(SOURCES);
  const result = { ts: Date.now(), updated: new Date().toISOString(), data: {}, errors: {} };

  // Run en mini-batches pour respecter quota Firecrawl
  for (let i = 0; i < keys.length; i += parallel) {
    const batch = keys.slice(i, i + parallel);
    await Promise.all(batch.map(async (key) => {
      const src = SOURCES[key];
      if (!src) { result.errors[key] = 'unknown source'; return; }
      try {
        const r = await fc.scrapUrl(src.url, src.keywords || []);
        if (!r || !r.contenu) { result.errors[key] = 'empty content'; return; }
        const extracted = src.extract ? src.extract(r.contenu) : { resume: r.contenu.substring(0, 1500) };
        result.data[key] = {
          label: src.label,
          url: src.url,
          ...extracted,
          fromCache: !!r.fromCache,
        };
      } catch (e) {
        result.errors[key] = e.message?.substring(0, 200) || String(e);
        console.warn(`[MARKET] ${key}:`, e.message);
      }
    }));
  }

  // Merge avec ancien snapshot (sources qui ont fail gardent l'ancien)
  const old = loadSnapshot();
  if (old?.data) {
    for (const k of keys) {
      if (!result.data[k] && old.data[k]) {
        result.data[k] = { ...old.data[k], _stale: true };
      }
    }
  }
  saveSnapshot(result);
  return result;
}

// ── Synthèse pour email ─────────────────────────────────────────────────────
function buildMarketDigest() {
  const snap = loadSnapshot();
  if (!snap) return null;
  const data = snap.data || {};
  return {
    as_of: snap.updated,
    taux_directeur: data.banque_canada?.taux_directeur || null,
    hypotheque_fixe_5ans: data.multipret?.fixe_5ans || data.planipret?.fixe_5ans || null,
    hypotheque_variable_5ans: data.multipret?.variable_5ans || null,
    apciq_stats: data.apciq?.resume?.substring(0, 500) || null,
    sources_count: Object.keys(data).length,
    age_hours: snap.ts ? Math.round((Date.now() - snap.ts) / 3600000) : null,
  };
}

// ── Injection dans HTML campagne Brevo ──────────────────────────────────────
function injectMarketData(html) {
  const digest = buildMarketDigest();
  if (!digest) return html;
  let out = html;
  if (digest.taux_directeur != null) {
    out = out.replace(/\{\{\s*MARKET\.taux_directeur\s*\}\}/gi, `${digest.taux_directeur}%`);
  }
  if (digest.hypotheque_fixe_5ans != null) {
    out = out.replace(/\{\{\s*MARKET\.hypotheque_fixe_5ans\s*\}\}/gi, `${digest.hypotheque_fixe_5ans}%`);
  }
  if (digest.hypotheque_variable_5ans != null) {
    out = out.replace(/\{\{\s*MARKET\.hypotheque_variable_5ans\s*\}\}/gi, `${digest.hypotheque_variable_5ans}%`);
  }
  if (digest.as_of) {
    out = out.replace(/\{\{\s*MARKET\.as_of\s*\}\}/gi, new Date(digest.as_of).toLocaleDateString('fr-CA'));
  }
  // Cleanup placeholders restants
  out = out.replace(/\{\{\s*MARKET\.[a-z_]+\s*\}\}/gi, '');
  return out;
}

// ── Status pour /admin/state ────────────────────────────────────────────────
function marketStatus() {
  const snap = loadSnapshot();
  if (!snap) return { available: false, sources: 0 };
  return {
    available: true,
    updated: snap.updated,
    age_hours: snap.ts ? Math.round((Date.now() - snap.ts) / 3600000) : null,
    sources_count: Object.keys(snap.data || {}).length,
    sources_ok: Object.keys(snap.data || {}).filter(k => !snap.data[k]._stale),
    sources_errors: Object.keys(snap.errors || {}),
    taux_directeur: snap.data?.banque_canada?.taux_directeur,
    hypotheque_fixe_5ans: snap.data?.multipret?.fixe_5ans || snap.data?.planipret?.fixe_5ans,
  };
}

module.exports = {
  SOURCES,
  getMarketSnapshot,
  refreshMarketSnapshot,
  buildMarketDigest,
  injectMarketData,
  marketStatus,
};
