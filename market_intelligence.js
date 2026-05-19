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
const SNAPSHOT_TTL = 24 * 60 * 60 * 1000; // 24h

// Lazy load firecrawl (déjà installé)
let _fc = null;
function getFC() {
  if (_fc === null) {
    try { _fc = require('./firecrawl_scraper'); }
    catch (e) { _fc = false; console.warn('[MARKET] firecrawl_scraper indispo:', e.message); }
  }
  return _fc || null;
}

// ── Sources configurées ─────────────────────────────────────────────────────
const SOURCES = {
  banque_canada: {
    label: 'Banque du Canada',
    url: 'https://www.bankofcanada.ca/rates/',
    keywords: ['target for the overnight rate', 'taux du financement', 'bank rate', 'taux officiel', 'policy rate'],
    extract: (md) => {
      // Cherche pattern "X.XX%" précédé/suivi de "policy rate" ou "taux directeur"
      const patterns = [
        /(\d+\.\d{1,2})\s*%[^.\n]{0,80}(policy|overnight|directeur|officiel)/i,
        /(policy|overnight|directeur|officiel)[^.\n]{0,80}(\d+\.\d{1,2})\s*%/i,
        /current\s+target[^.\n]{0,30}(\d+\.\d{1,2})/i,
      ];
      for (const p of patterns) {
        const m = md.match(p);
        if (m) {
          const rate = m[1].includes('.') ? m[1] : m[2];
          return { taux_directeur: parseFloat(rate), as_of: new Date().toISOString().slice(0, 10) };
        }
      }
      return null;
    },
  },
  apciq: {
    label: 'APCIQ — Stats marché QC',
    url: 'https://apciq.ca/statistiques-immobilieres/',
    keywords: ['statistiques', 'ventes', 'prix médian', 'inventaire', 'mois'],
    extract: (md) => {
      // Heuristique simple: garde 1500 premiers chars qui contiennent les chiffres clés
      const snippet = md.substring(0, 2500);
      return { resume: snippet, scraped_at: new Date().toISOString() };
    },
  },
  oaciq: {
    label: 'OACIQ — Règlements',
    url: 'https://www.oaciq.com/fr',
    keywords: ['nouveauté', 'règlement', 'avis', 'pratique', 'courtier'],
    extract: (md) => ({ resume: md.substring(0, 1500), scraped_at: new Date().toISOString() }),
  },
  multipret: {
    label: 'MultiPrêt — Taux hypothécaires',
    url: 'https://multi-prets.com/taux-hypothecaires/',
    keywords: ['taux fixe', 'taux variable', '5 ans', 'hypothèque'],
    extract: (md) => {
      // Cherche taux fixes 5 ans
      const m5fix = md.match(/5\s*ans?[^\n]{0,60}fixe[^.\n]{0,40}(\d+\.\d{1,2})\s*%/i);
      const m5var = md.match(/5\s*ans?[^\n]{0,60}variable[^.\n]{0,40}(\d+\.\d{1,2})\s*%/i);
      const out = { scraped_at: new Date().toISOString() };
      if (m5fix) out.fixe_5ans = parseFloat(m5fix[1]);
      if (m5var) out.variable_5ans = parseFloat(m5var[1]);
      out.resume = md.substring(0, 1200);
      return out;
    },
  },
  planipret: {
    label: 'PlaniPrêt — Taux hypothécaires',
    url: 'https://planipret.com/taux-hypothecaires/',
    keywords: ['taux fixe', 'taux variable', '5 ans'],
    extract: (md) => ({ resume: md.substring(0, 1500), scraped_at: new Date().toISOString() }),
  },
  centris_public: {
    label: 'Centris.ca — Marché public',
    url: 'https://www.centris.ca/fr/quartiers',
    keywords: ['propriétés', 'vente', 'région'],
    extract: (md) => ({ resume: md.substring(0, 1200), scraped_at: new Date().toISOString() }),
  },
  duproprio: {
    label: 'DuProprio — Inventaire',
    url: 'https://duproprio.com/fr',
    keywords: ['proprietes', 'vente', 'pour vente', 'maisons'],
    extract: (md) => ({ resume: md.substring(0, 1200), scraped_at: new Date().toISOString() }),
  },
  realtor: {
    label: 'Realtor.ca — Marché Canada',
    url: 'https://www.realtor.ca/blog/data-and-analysis',
    keywords: ['housing', 'sales', 'price'],
    extract: (md) => ({ resume: md.substring(0, 1200), scraped_at: new Date().toISOString() }),
  },
  remax_qc: {
    label: 'RE/MAX Québec',
    url: 'https://www.remax-quebec.com/fr/blogue/',
    keywords: ['marché', 'tendance', 'région'],
    extract: (md) => ({ resume: md.substring(0, 1200), scraped_at: new Date().toISOString() }),
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
