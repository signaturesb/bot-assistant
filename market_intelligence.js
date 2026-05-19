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

// Helper: extract montant $ proche d'un mot-clé (ex: prix médian "$XXX XXX")
function findAmountNear(md, keywords, opts = {}) {
  const txt = md.toLowerCase();
  for (const kw of keywords) {
    const idx = txt.indexOf(kw.toLowerCase());
    if (idx < 0) continue;
    const start = Math.max(0, idx - 300);
    const end = Math.min(md.length, idx + 300);
    const window = md.substring(start, end);
    // Pattern QC: "$XXX XXX" ou "XXX XXX $" ou "XXX,XXX $"
    const patterns = [
      /\$\s*(\d{1,3}(?:[\s,]\d{3})+(?:\.\d{1,2})?)/,
      /(\d{1,3}(?:[\s,]\d{3})+(?:\.\d{1,2})?)\s*\$/,
      /(\d{1,3}(?:[\s,]\d{3})+)\s*(?:CAD|\$CA)/i,
    ];
    for (const p of patterns) {
      const m = window.match(p);
      if (m) {
        const num = parseFloat(m[1].replace(/[\s,]/g, ''));
        if (num > (opts.min || 50000) && num < (opts.max || 5000000)) return num;
      }
    }
  }
  return null;
}

// Helper: extract pourcentage variation (ex: "+12% vs an passé")
function findVariationNear(md, keywords, opts = {}) {
  const txt = md.toLowerCase();
  for (const kw of keywords) {
    const idx = txt.indexOf(kw.toLowerCase());
    if (idx < 0) continue;
    const window = md.substring(Math.max(0, idx - 200), Math.min(md.length, idx + 200));
    const m = window.match(/([+\-−]\s*\d+[\.,]?\d*)\s*%/);
    if (m) {
      const val = parseFloat(m[1].replace(/[\s,−]/g, m => m === ',' ? '.' : m === '−' ? '-' : ''));
      if (!isNaN(val) && val > -100 && val < 200) return val;
    }
  }
  return null;
}

// Helper: extract dates récentes mentionnées
function findRecentDates(md) {
  const dates = [];
  const monthsFR = '(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre)';
  const re = new RegExp(`(\\d{1,2})\\s*${monthsFR}\\s*(\\d{4})`, 'gi');
  let m;
  while ((m = re.exec(md)) !== null && dates.length < 5) {
    dates.push(`${m[1]} ${m[2]} ${m[3]}`);
  }
  return dates;
}

// ── Sources configurées (toutes celles demandées par Shawn) ──────────────────
const SOURCES = {
  // === ÉCONOMIQUES — taux qui bougent souvent ===
  banque_canada: {
    label: 'Banque du Canada — Taux directeur',
    // Page principale /rates/ contient juste des liens. La vraie page avec le chiffre:
    url: 'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/',
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
    extract: (md) => ({
      prix_median_unifamiliale: findAmountNear(md, ['prix médian unifamiliale', 'unifamiliale', 'maison médiane'], { min: 200000, max: 2000000 }),
      prix_median_copropriete: findAmountNear(md, ['copropriété', 'condo'], { min: 150000, max: 1500000 }),
      ventes_variation: findVariationNear(md, ['ventes', 'transactions']),
      prix_variation: findVariationNear(md, ['prix médian', 'augmentation', 'baisse']),
      dates_recentes: findRecentDates(md),
      resume: md.substring(0, 2500),
      scraped_at: new Date().toISOString(),
    }),
  },
  apciq_lanaudiere: {
    label: 'APCIQ — Lanaudière',
    url: 'https://apciq.ca/statistiques/lanaudiere/',
    keywords: ['lanaudière', 'ventes', 'prix'],
    extract: (md) => ({
      prix_median: findAmountNear(md, ['prix médian', 'médian', 'lanaudière'], { min: 200000, max: 1500000 }),
      ventes_variation: findVariationNear(md, ['ventes', 'lanaudière']),
      dates_recentes: findRecentDates(md),
      resume: md.substring(0, 2000),
      scraped_at: new Date().toISOString(),
    }),
  },
  oaciq: {
    label: 'OACIQ — Règlements + Pratique',
    url: 'https://www.oaciq.com/fr/articles',
    keywords: ['nouveauté', 'règlement', 'avis', 'pratique', 'courtier', 'mise à jour'],
    extract: (md) => {
      // Filtre lignes texte (pas images/links uniquement)
      const isCleanLine = (s) => s.length > 5 && s.length < 200
        && !/^!?\[.*\]\(.*\)$/.test(s.trim())  // pas juste markdown image/link
        && !/^(https?:\/\/|www\.|\!\[)/i.test(s.trim()) // pas URL nue
        && /[a-zàâéèêëïîôöùûüç]/i.test(s); // contient lettres FR
      const headings = md.split('\n').filter(l => /^#+\s/.test(l))
        .map(h => h.replace(/^#+\s*/, '').replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').trim())
        .filter(isCleanLine).slice(0, 8);
      // Liens internes OACIQ avec texte
      const articles = [];
      const linkRe = /\[([^\]\n]{10,150})\]\(([^)\s]+)\)/g;
      let lm;
      while ((lm = linkRe.exec(md)) !== null && articles.length < 10) {
        const text = lm[1].trim();
        const href = lm[2];
        if (isCleanLine(text) && !/\.(jpg|png|gif|webp|svg)/i.test(href)
            && !articles.some(a => a.text === text)) {
          articles.push({ text: text.substring(0, 120), href });
        }
      }
      return {
        headings_recents: headings,
        articles_recents: articles.map(a => a.text), // backward compat
        articles_with_links: articles,
        dates_recentes: findRecentDates(md),
        resume: md.substring(0, 1500),
        scraped_at: new Date().toISOString(),
      };
    },
  },
  // === SITES IMMOBILIERS QC (les plus gros) ===
  centris_public: {
    label: 'Centris.ca — Tendances',
    url: 'https://www.centris.ca/fr/tendances',
    keywords: ['marché', 'tendance', 'prix', 'région'],
    extract: (md) => ({
      prix_median_qc: findAmountNear(md, ['prix médian', 'médian Québec'], { min: 200000, max: 2000000 }),
      prix_variation: findVariationNear(md, ['prix médian', 'année passée']),
      ventes_variation: findVariationNear(md, ['ventes', 'transactions']),
      dates_recentes: findRecentDates(md),
      headings_recents: md.split('\n').filter(l => /^#+\s/.test(l)).slice(0, 5).map(h => h.replace(/^#+\s*/, '').trim()),
      resume: md.substring(0, 1500),
      scraped_at: new Date().toISOString(),
    }),
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
    label: 'RE/MAX Québec — Blogue',
    url: 'https://www.remax-quebec.com/fr/blogue/',
    keywords: ['marché', 'tendance', 'région', 'prix'],
    extract: (md) => ({
      headings_recents: md.split('\n').filter(l => /^#+\s/.test(l)).slice(0, 8).map(h => h.replace(/^#+\s*/, '').trim()),
      articles_recents: md.match(/^\s*[-*]\s+(.+)$/gm)?.slice(0, 10).map(l => l.replace(/^\s*[-*]\s+/, '').substring(0, 120)) || [],
      prix_median: findAmountNear(md, ['prix médian', 'maison', 'condo'], { min: 200000, max: 2000000 }),
      prix_variation: findVariationNear(md, ['prix', 'augmentation', 'baisse']),
      dates_recentes: findRecentDates(md),
      resume: md.substring(0, 1500),
      scraped_at: new Date().toISOString(),
    }),
  },
  remax_marche: {
    label: 'RE/MAX Canada — Analyse de marché',
    url: 'https://blog.remax.ca/fr-ca/quebec/',
    keywords: ['marché', 'analyse', 'tendance', 'région'],
    extract: (md) => ({
      headings_recents: md.split('\n').filter(l => /^#+\s/.test(l)).slice(0, 8).map(h => h.replace(/^#+\s*/, '').trim()),
      dates_recentes: findRecentDates(md),
      resume: md.substring(0, 1500),
      scraped_at: new Date().toISOString(),
    }),
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
    // Taux économiques
    taux_directeur: data.banque_canada?.taux_directeur || null,
    hypotheque_fixe_5ans: data.multipret?.fixe_5ans || data.planipret?.fixe_5ans || null,
    hypotheque_variable_5ans: data.multipret?.variable_5ans || data.planipret?.variable_5ans || null,
    hypotheque_fixe_3ans: data.multipret?.fixe_3ans || null,
    // Stats marché APCIQ (national QC)
    apciq_prix_median_unifamiliale: data.apciq?.prix_median_unifamiliale || null,
    apciq_prix_median_copro: data.apciq?.prix_median_copropriete || null,
    apciq_ventes_variation: data.apciq?.ventes_variation || null,
    apciq_prix_variation: data.apciq?.prix_variation || null,
    // Stats Lanaudière spécifique
    lanaudiere_prix_median: data.apciq_lanaudiere?.prix_median || null,
    lanaudiere_ventes_variation: data.apciq_lanaudiere?.ventes_variation || null,
    // Centris public
    centris_prix_median_qc: data.centris_public?.prix_median_qc || null,
    // OACIQ nouveautés
    oaciq_articles: data.oaciq?.articles_recents?.slice(0, 5) || [],
    oaciq_headings: data.oaciq?.headings_recents?.slice(0, 5) || [],
    // RE/MAX
    remax_articles: data.remax_qc?.articles_recents?.slice(0, 3) || [],
    // Méta
    sources_count: Object.keys(data).length,
    age_hours: snap.ts ? Math.round((Date.now() - snap.ts) / 3600000) : null,
    sources_list: Object.keys(data),
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
