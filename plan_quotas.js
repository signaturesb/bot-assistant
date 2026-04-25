// plan_quotas.js — Quotas SaaS par plan + alertes proactives
// Usage: const { checkQuota, recordUsage, getPlanLimits } = require('./plan_quotas')
// Logique: chaque plan définit des limits journalières/mensuelles. Soft warn à 80%,
// hard cap à 100%. État persisté dans /data/plan_usage.json.
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const USAGE_FILE = path.join(DATA_DIR, 'plan_usage.json');

// ═══════════════════════════════════════════════════════
// PLANS — limits par tier
// ═══════════════════════════════════════════════════════

const PLANS = {
  // Solo: courtier indépendant, ~30 leads/jour, usage modéré
  solo: {
    name: 'Solo',
    pricePerMonth: 49,
    limits: {
      leadsPerDay:        30,
      autoSentPerDay:     30,
      firecrawlPerMonth:  100,
      anthropicCostPerDay: 5,    // USD
      telegramMsgPerDay:  500,
      pipedriveDealsPerDay: 30,
    },
    features: {
      vision:             true,
      vocaux:             false,
      scraping:           true,
      emailSequences:     true,
      multiLogement:      false,
      registreFoncier:    false,
    },
  },
  // Pro: équipe ou volume élevé, support prioritaire
  pro: {
    name: 'Pro',
    pricePerMonth: 149,
    limits: {
      leadsPerDay:        100,
      autoSentPerDay:     100,
      firecrawlPerMonth:  500,
      anthropicCostPerDay: 20,
      telegramMsgPerDay:  2000,
      pipedriveDealsPerDay: 100,
    },
    features: {
      vision:             true,
      vocaux:             true,
      scraping:           true,
      emailSequences:     true,
      multiLogement:      true,
      registreFoncier:    true,
    },
  },
  // Enterprise: agences/multi-courtiers, sans limit dure
  enterprise: {
    name: 'Enterprise',
    pricePerMonth: 499,
    limits: {
      leadsPerDay:        Infinity,
      autoSentPerDay:     Infinity,
      firecrawlPerMonth:  5000,
      anthropicCostPerDay: 100,
      telegramMsgPerDay:  Infinity,
      pipedriveDealsPerDay: Infinity,
    },
    features: {
      vision:             true,
      vocaux:             true,
      scraping:           true,
      emailSequences:     true,
      multiLogement:      true,
      registreFoncier:    true,
    },
  },
  // Trial: 14 jours gratuit pour onboarding
  trial: {
    name: 'Trial',
    pricePerMonth: 0,
    limits: {
      leadsPerDay:        10,
      autoSentPerDay:     10,
      firecrawlPerMonth:  20,
      anthropicCostPerDay: 1,
      telegramMsgPerDay:  100,
      pipedriveDealsPerDay: 10,
    },
    features: {
      vision:             true,
      vocaux:             false,
      scraping:           true,
      emailSequences:     false,
      multiLogement:      false,
      registreFoncier:    false,
    },
  },
};

function getPlanLimits(planName) {
  return PLANS[planName] || PLANS.solo;
}

// ═══════════════════════════════════════════════════════
// USAGE TRACKING
// ═══════════════════════════════════════════════════════

function todayKey() { return new Date().toISOString().split('T')[0]; }
function monthKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; }

function loadUsage() {
  try {
    if (!fs.existsSync(USAGE_FILE)) return { daily: {}, monthly: {} };
    return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')) || { daily: {}, monthly: {} };
  } catch { return { daily: {}, monthly: {} }; }
}

function saveUsage(state) {
  try { fs.writeFileSync(USAGE_FILE, JSON.stringify(state, null, 2)); } catch {}
}

// Garbage collect old daily entries (>30 jours) au boot
function gcUsage(state) {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().split('T')[0];
  for (const day of Object.keys(state.daily || {})) {
    if (day < cutoff) delete state.daily[day];
  }
  // Monthly: keep current + previous
  const currentMonth = monthKey();
  for (const m of Object.keys(state.monthly || {})) {
    if (m < currentMonth.split('').slice(0, 7).join('').replace(/(\d{4})(\d{2})/, '$1-$2')) {
      // Conservatif: ne supprime que les mois >2 mois passés
      const [y, mo] = m.split('-').map(Number);
      const ageMonths = (new Date().getFullYear() - y) * 12 + (new Date().getMonth() + 1 - mo);
      if (ageMonths > 2) delete state.monthly[m];
    }
  }
}

let _usage = loadUsage();
gcUsage(_usage);

// ═══════════════════════════════════════════════════════
// API PUBLIQUE
// ═══════════════════════════════════════════════════════

/**
 * Enregistrer un usage. Appelé après chaque action consommant un quota.
 * @param {string} resource - leadsPerDay | autoSentPerDay | firecrawlPerMonth | etc.
 * @param {number} count - nombre à ajouter (default 1)
 */
function recordUsage(resource, count = 1) {
  const isMonthly = resource.includes('PerMonth');
  const periodKey = isMonthly ? monthKey() : todayKey();
  const bucket = isMonthly ? 'monthly' : 'daily';
  if (!_usage[bucket][periodKey]) _usage[bucket][periodKey] = {};
  _usage[bucket][periodKey][resource] = (_usage[bucket][periodKey][resource] || 0) + count;
  saveUsage(_usage);
}

/**
 * Vérifier si une action est autorisée par le plan + quota.
 * Retourne { allowed, current, limit, pct, status: 'ok'|'warn'|'blocked' }
 */
function checkQuota(planName, resource) {
  const plan = getPlanLimits(planName);
  const limit = plan.limits[resource];
  if (limit === undefined) return { allowed: true, current: 0, limit: -1, pct: 0, status: 'unknown' };
  if (limit === Infinity) return { allowed: true, current: 0, limit: Infinity, pct: 0, status: 'ok' };

  const isMonthly = resource.includes('PerMonth');
  const periodKey = isMonthly ? monthKey() : todayKey();
  const bucket = isMonthly ? 'monthly' : 'daily';
  const current = _usage[bucket]?.[periodKey]?.[resource] || 0;
  const pct = (current / limit) * 100;

  let status = 'ok';
  if (pct >= 100) status = 'blocked';
  else if (pct >= 80) status = 'warn';

  return {
    allowed: status !== 'blocked',
    current,
    limit,
    pct: Math.round(pct),
    status,
    plan: plan.name,
  };
}

/**
 * Vérifier si une feature est dispo dans le plan.
 */
function hasFeature(planName, feature) {
  const plan = getPlanLimits(planName);
  return !!plan.features?.[feature];
}

/**
 * Snapshot complet des quotas pour ce plan (utilisé par /quota command).
 */
function getQuotaSnapshot(planName) {
  const plan = getPlanLimits(planName);
  const snapshot = { plan: plan.name, pricePerMonth: plan.pricePerMonth, resources: {}, features: plan.features };
  for (const resource of Object.keys(plan.limits)) {
    snapshot.resources[resource] = checkQuota(planName, resource);
  }
  return snapshot;
}

module.exports = {
  PLANS,
  getPlanLimits,
  checkQuota,
  recordUsage,
  hasFeature,
  getQuotaSnapshot,
};
