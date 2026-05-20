// campaign_variation.js — Génération de contenu varié pour campagnes Brevo
// Évite que la même audience reçoive 2× le même angle/contenu.
//
// Architecture:
// 1. Track historique par audience: /data/campaign_history.json
//    { acheteurs: [{ ts, angle, hash, campaign_id }], vendeurs: [...] }
// 2. À chaque génération: LLM Claude pick un angle ≠ des 3 derniers
// 3. Regénère hook + intro du master template (zone INTRO_TEXTE)
// 4. Garde branding/structure intact (logos, footer, layout)
//
// Audiences supportées: acheteurs, vendeurs, terrains, prospects, referencement

'use strict';

const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const HISTORY_FILE = path.join(DATA_DIR, 'campaign_history.json');
const MAX_HISTORY_PER_AUDIENCE = 12; // garde 12 derniers pour anti-répétition

// ── Pool d'angles par audience (pour rotation déterministe + LLM context) ──
const ANGLES = {
  acheteurs: [
    { tag: 'taux', focus: 'baisse récente des taux directeur + impact sur capacité achat' },
    { tag: 'inventaire', focus: 'inventaire actif Centris en hausse + meilleur choix' },
    { tag: 'capacite', focus: 'calcul de capacité d\'emprunt avec stress test B-20' },
    { tag: 'preapprobation', focus: 'importance pré-approbation avant offres' },
    { tag: 'negociation', focus: 'marché qui s\'équilibre = pouvoir négociation acheteur' },
    { tag: 'frais', focus: 'tous les frais cachés à anticiper (notaire, mutation, inspection)' },
    { tag: 'visite', focus: 'check-list visites + pièges à éviter' },
    { tag: 'saison', focus: 'meilleur moment de l\'année pour acheter selon saison' },
  ],
  vendeurs: [
    { tag: 'prix', focus: 'évaluation gratuite + prix médian secteur' },
    { tag: 'timing', focus: 'moment idéal de mise en vente + DOM (jours sur marché)' },
    { tag: 'preparation', focus: 'home staging + photos pro + impact prix vente' },
    { tag: 'strategie', focus: 'stratégie offre multiple vs prix fixe' },
    { tag: 'fiscalite', focus: 'fiscalité vente résidence principale vs secondaire' },
    { tag: 'concurrence', focus: 'analyse comparables vendus secteur (3 mois)' },
    { tag: 'documents', focus: 'documents préparation: déclaration, certificat, taxes' },
    { tag: 'inspection', focus: 'inspection pré-vente proactive = -conditions' },
  ],
  terrains: [
    { tag: 'inventaire', focus: 'liste terrains disponibles secteur Lanaudière' },
    { tag: 'autoconstruction', focus: 'subventions auto-construction + financement' },
    { tag: 'zonage', focus: 'comprendre zonage municipal + marges + usages permis' },
    { tag: 'services', focus: 'puits + fosse vs municipaux: vrai coût' },
    { tag: 'investissement', focus: 'terrain comme placement long terme' },
    { tag: 'permis', focus: 'délais + coûts permis construction municipal' },
  ],
  prospects: [
    { tag: 'introduction', focus: 'qui je suis + zone d\'expertise' },
    { tag: 'temoignage', focus: 'transaction récente réussie comme exemple' },
    { tag: 'expertise', focus: 'expertise Lanaudière + Rive-Nord depuis X ans' },
    { tag: 'offre', focus: 'évaluation gratuite + consultation 30 min' },
    { tag: 'tendance', focus: 'tendance marché du mois + chiffres APCIQ' },
    { tag: 'service', focus: 'services exclusifs aux clients Signature SB' },
  ],
  referencement: [
    { tag: 'merci', focus: 'merci confiance + invitation à référer' },
    { tag: 'recompense', focus: 'récompense référencement réussi' },
    { tag: 'temoignage', focus: 'comment vous me décririez à un proche?' },
    { tag: 'reseau', focus: 'votre réseau = mon priorité absolue' },
    { tag: 'famille', focus: 'famille/amis qui pensent acheter/vendre?' },
    { tag: 'feedback', focus: 'demande feedback transaction passée' },
  ],
};

// ── Historique persistant ────────────────────────────────────────────────────
function loadHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return {};
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || {};
  } catch { return {}; }
}

function saveHistory(hist) {
  try {
    fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify(hist, null, 2));
    fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
  } catch (e) { console.warn('[VARIATION] save:', e.message); }
}

function recordSent(audience, campaign_id, angle, contentHash, subject) {
  const hist = loadHistory();
  if (!hist[audience]) hist[audience] = [];
  hist[audience].unshift({
    ts: Date.now(), date: new Date().toISOString().slice(0, 10),
    campaign_id, angle, hash: contentHash, subject,
  });
  hist[audience] = hist[audience].slice(0, MAX_HISTORY_PER_AUDIENCE);
  saveHistory(hist);
}

// ── Détection audience depuis nom campagne ──────────────────────────────────
function detectAudience(campaignName) {
  const n = (campaignName || '').toLowerCase();
  if (/acheteur/i.test(n)) return 'acheteurs';
  if (/vendeur/i.test(n)) return 'vendeurs';
  if (/terrain/i.test(n)) return 'terrains';
  if (/prospect/i.test(n)) return 'prospects';
  if (/référencement|referencement|reeng/i.test(n)) return 'referencement';
  return null;
}

// ── Choix d'angle: round-robin évite répétition ──────────────────────────────
function pickNextAngle(audience) {
  const pool = ANGLES[audience];
  if (!pool || pool.length === 0) return null;
  const hist = loadHistory();
  const recent = (hist[audience] || []).slice(0, Math.min(4, pool.length - 1)).map(h => h.angle);
  // Cherche un angle non utilisé récemment
  for (const a of pool) {
    if (!recent.includes(a.tag)) return a;
  }
  // Tous utilisés → pick le plus ancien
  return pool[0];
}

// ── Génération via LLM Claude ────────────────────────────────────────────────
let _anthropic = null;
function getAnthropic() {
  if (_anthropic === null) {
    try {
      const Anthropic = require('@anthropic-ai/sdk');
      _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } catch { _anthropic = false; }
  }
  return _anthropic || null;
}

/**
 * Génère un nouvel angle pour une campagne — varie le content sans toucher branding.
 * @param {string} audience — acheteurs/vendeurs/etc
 * @param {object} marketData — depuis market_intelligence.buildMarketDigest()
 * @param {object} options — { sectorFocus, customNote }
 * @returns {Promise<{angle, subject, intro_html, key_points}>}
 */
async function generateVariation(audience, marketData = {}, options = {}) {
  const angle = pickNextAngle(audience);
  if (!angle) throw new Error(`Audience inconnue: ${audience}`);
  const a = getAnthropic();
  if (!a) throw new Error('Anthropic SDK non disponible');

  const hist = loadHistory();
  const recentAngles = (hist[audience] || []).slice(0, 3).map(h => `- ${h.date} angle "${h.angle}": ${h.subject || '(sans sujet)'}`).join('\n');

  const marketLines = [];
  if (marketData.taux_directeur) marketLines.push(`Taux directeur BdC: ${marketData.taux_directeur}%`);
  if (marketData.hypotheque_fixe_5ans) marketLines.push(`Hypothèque fixe 5 ans: ${marketData.hypotheque_fixe_5ans}%`);
  if (marketData.apciq_prix_median_unifamiliale) marketLines.push(`Prix médian unifamiliale QC: ${marketData.apciq_prix_median_unifamiliale.toLocaleString('fr-CA')}$`);
  if (marketData.apciq_prix_median_copro) marketLines.push(`Prix médian copropriété QC: ${marketData.apciq_prix_median_copro.toLocaleString('fr-CA')}$`);
  if (marketData.apciq_ventes_variation) marketLines.push(`Ventes vs an passé: ${marketData.apciq_ventes_variation > 0 ? '+' : ''}${marketData.apciq_ventes_variation}%`);

  const prompt = `Tu écris un email de courtier immobilier au Québec (Lanaudière + Rive-Nord) — courtier: Shawn Barrette, RE/MAX PRESTIGE Rawdon, Signature SB.

AUDIENCE: ${audience}
ANGLE À DÉVELOPPER: "${angle.tag}" — ${angle.focus}

DONNÉES MARCHÉ ACTUELLES:
${marketLines.join('\n') || '(pas de données disponibles)'}

HISTORIQUE RÉCENT À ÉVITER (pour différenciation):
${recentAngles || '(aucun)'}

${options.customNote ? `NOTE SHAWN: ${options.customNote}\n` : ''}
INSTRUCTIONS:
- Ton chaleureux mais professionnel, tutoiement
- 2-3 paragraphes maximum, court et impactant
- 1 angle UNIQUE basé sur "${angle.tag}" — pas de mélange
- Inclut au moins 1 chiffre concret du marché si dispo
- Termine par CTA clair (visite Calendly OU répondre à l'email)
- AUCUN mot-clé spam: "gratuit", "promo", "urgent" → utiliser "sans engagement", "stratégie", "consultation"
- PAS de "Cher/Chère ${audience}" — direct "Bonjour,"

Retourne UNIQUEMENT ce JSON exactement:
{
  "subject": "<sujet court 60-80 chars, accroche>",
  "intro_html": "<HTML 3 paragraphes en <p style=...> couleur #cccccc, max 600 mots>",
  "key_points": ["<point clé 1>", "<point clé 2>", "<point clé 3>"]
}`;

  const res = await a.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  });
  const txt = res.content.find(b => b.type === 'text')?.text || '';
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('LLM did not return valid JSON');
  const parsed = JSON.parse(m[0]);
  return { angle: angle.tag, focus: angle.focus, ...parsed };
}

// ── Hash content pour détection de duplication ──────────────────────────────
function hashContent(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').substring(0, 16);
}

// ── Status pour /admin/state ────────────────────────────────────────────────
function variationStatus() {
  const hist = loadHistory();
  const audiences = Object.keys(ANGLES);
  return {
    available: !!getAnthropic(),
    audiences,
    history_summary: audiences.reduce((acc, aud) => {
      const h = hist[aud] || [];
      acc[aud] = {
        sent_count: h.length,
        last_sent: h[0]?.date,
        last_angle: h[0]?.angle,
        angles_pool_size: ANGLES[aud].length,
      };
      return acc;
    }, {}),
  };
}

module.exports = {
  ANGLES,
  detectAudience,
  pickNextAngle,
  generateVariation,
  recordSent,
  hashContent,
  loadHistory,
  variationStatus,
};
