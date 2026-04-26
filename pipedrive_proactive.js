// pipedrive_proactive.js — 5 features anti-perte-de-lead
//
// Architecture: chaque fonction est appelée 1×/jour depuis le cron tick de bot.js.
// Toutes utilisent les mêmes credentials Pipedrive + Telegram déjà configurés.
// État de dédup: /data/proactive_state.json (TTL 7j sur les alertes par deal_id).
//
// Schedule (Eastern):
//   06h00  → stagnantDeals() — alertes J+3/J+7/J+30 (avant la journée Shawn)
//   08h30  → morningReport() — briefing du jour
//   17h00  → alerteJ1NotCalled() — leads créés hier sans appel logué
//   23h00  → crmHygiene() — doublons + fantômes
//   dim 18h → weeklyDigest() — stats semaine

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const STATE_FILE = path.join(DATA_DIR, 'proactive_state.json');
const ALERT_TTL_MS = 7 * 24 * 3600 * 1000;

// ─── Helpers fournis par bot.js (injectés via init) ────────────────────────
let pdGet, sendTG, AGENT, log;

function init(deps) {
  ({ pdGet, sendTG, AGENT, log } = deps);
}

// ─── State persistant ──────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { sent_alerts: {} }; }
}
function saveState(state) {
  // Purge les alertes >7j
  const now = Date.now();
  for (const [k, v] of Object.entries(state.sent_alerts || {})) {
    if (now - v.ts > ALERT_TTL_MS) delete state.sent_alerts[k];
  }
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { log?.('WARN', 'PROACTIVE', `saveState: ${e.message}`); }
}

function alreadyAlerted(state, dealId, alertType) {
  const key = `${dealId}:${alertType}`;
  return !!state.sent_alerts[key];
}
function markAlerted(state, dealId, alertType) {
  state.sent_alerts[`${dealId}:${alertType}`] = { ts: Date.now() };
}

// ─── Helpers Pipedrive ─────────────────────────────────────────────────────
async function fetchOpenDeals() {
  const all = [];
  let start = 0;
  while (true) {
    const r = await pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=500&start=${start}`);
    const data = r?.data || [];
    all.push(...data);
    if (!r?.additional_data?.pagination?.more_items_in_collection) break;
    start = r.additional_data.pagination.next_start || (start + 500);
    if (start > 5000) break; // safety
  }
  return all;
}

async function fetchDealActivities(dealId) {
  const r = await pdGet(`/deals/${dealId}/activities?limit=50`);
  return r?.data || [];
}

function daysSince(isoDate) {
  if (!isoDate) return 999;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / (24 * 3600 * 1000));
}

function fmtMontant(value) {
  if (!value) return '';
  return ` · ${Math.round(value / 1000)}k$`;
}

// ─── 1. ALERTE J+1: Lead créé hier sans appel ─────────────────────────────
async function alerteJ1NotCalled() {
  log('INFO', 'PROACTIVE', 'J+1 not-called scan...');
  const state = loadState();
  const deals = await fetchOpenDeals();

  // Deals créés hier (24-48h avant maintenant)
  const yesterday = deals.filter(d => {
    const days = daysSince(d.add_time);
    return days >= 1 && days < 2;
  });

  if (!yesterday.length) {
    log('INFO', 'PROACTIVE', 'J+1: 0 deals créés hier — skip');
    return;
  }

  const sansAppel = [];
  for (const d of yesterday) {
    if (alreadyAlerted(state, d.id, 'j1_no_call')) continue;
    const acts = await fetchDealActivities(d.id);
    const hasCall = acts.some(a => a.type === 'call' && a.done);
    // Aussi check les notes pour mots clés appel/contacté
    const hasCallNote = (d.last_activity_note || '').match(/appel[ée]?|contact[ée]?|t[ée]l[ée]phon[ée]?/i);
    if (!hasCall && !hasCallNote) {
      sansAppel.push(d);
      markAlerted(state, d.id, 'j1_no_call');
    }
  }

  if (sansAppel.length) {
    let msg = `🔴 *${sansAppel.length} lead(s) créé(s) hier — PAS APPELÉS*\n\n`;
    for (const d of sansAppel.slice(0, 8)) {
      msg += `• #${d.id} *${d.title}*${fmtMontant(d.value)}\n  📞 ${d.person_name || '?'}\n`;
    }
    msg += `\n_Règle: appeler dans les 24h ou perte 3x plus probable._`;
    await sendTG(msg, { parse_mode: 'Markdown' });
  }
  saveState(state);
  return { yesterday: yesterday.length, sansAppel: sansAppel.length };
}

// ─── 2. RAPPORT MATIN 8h30 ─────────────────────────────────────────────────
async function morningReport() {
  log('INFO', 'PROACTIVE', 'Morning report...');
  const deals = await fetchOpenDeals();

  // Deals créés hier
  const newYesterday = deals.filter(d => daysSince(d.add_time) === 1);
  // Deals avec activité prévue aujourd'hui
  const todayKey = new Date().toLocaleDateString('fr-CA', { timeZone: 'America/Toronto' });
  const actsToday = deals.filter(d => d.next_activity_date === todayKey);
  // Deals visite étape 52 demain
  const visitesProches = deals.filter(d => d.stage_id === 52 && d.next_activity_date === todayKey);
  // Deals warm (étape 50-51) sans activité dans 3j
  const warmStale = deals.filter(d =>
    [50, 51].includes(d.stage_id) && daysSince(d.last_activity_date || d.add_time) >= 3
  );

  const date = new Date().toLocaleDateString('fr-CA', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Toronto'
  });

  let msg = `☀️ *Briefing — ${date}*\n\n`;
  msg += `📊 *Pipeline ouvert:* ${deals.length} deals\n\n`;

  if (newYesterday.length) {
    msg += `🆕 *Nouveaux hier (${newYesterday.length}):*\n`;
    for (const d of newYesterday.slice(0, 5)) {
      msg += `• #${d.id} ${d.title}${fmtMontant(d.value)}\n`;
    }
    msg += '\n';
  }

  if (actsToday.length) {
    msg += `📅 *Aujourd'hui à faire (${actsToday.length}):*\n`;
    for (const d of actsToday.slice(0, 8)) {
      msg += `• ${d.next_activity_subject || '?'} — ${d.person_name || d.title}\n`;
    }
    msg += '\n';
  }

  if (warmStale.length) {
    msg += `⏰ *Warm leads à relancer (${warmStale.length}):*\n`;
    for (const d of warmStale.slice(0, 5)) {
      const j = daysSince(d.last_activity_date || d.add_time);
      msg += `• #${d.id} ${d.title} — ${j}j sans contact\n`;
    }
    msg += '\n';
  }

  if (!newYesterday.length && !actsToday.length && !warmStale.length) {
    msg += `_Rien d'urgent ce matin. Bonne journée!_\n`;
  } else {
    msg += `_/voir-pipeline pour le détail · /relancer #id pour action_`;
  }

  await sendTG(msg, { parse_mode: 'Markdown' });
  return { newYesterday: newYesterday.length, actsToday: actsToday.length, warmStale: warmStale.length };
}

// ─── 3. STAGNANTS J+3/J+7/J+30 ─────────────────────────────────────────────
async function stagnantDeals() {
  log('INFO', 'PROACTIVE', 'Stagnant scan...');
  const state = loadState();
  const deals = await fetchOpenDeals();

  const buckets = { j3: [], j7: [], j30: [] };
  for (const d of deals) {
    const j = daysSince(d.last_activity_date || d.update_time || d.add_time);
    let bucket = null;
    if (j >= 30) bucket = 'j30';
    else if (j >= 7 && j < 14) bucket = 'j7';
    else if (j >= 3 && j < 5) bucket = 'j3';
    if (!bucket) continue;
    if (alreadyAlerted(state, d.id, `stagnant_${bucket}`)) continue;
    buckets[bucket].push(d);
    markAlerted(state, d.id, `stagnant_${bucket}`);
  }

  const total = buckets.j3.length + buckets.j7.length + buckets.j30.length;
  if (!total) { saveState(state); return { total: 0 }; }

  let msg = `⚠️ *${total} deals stagnants*\n\n`;
  if (buckets.j3.length) {
    msg += `🟡 *J+3 (${buckets.j3.length}) — relance suggérée:*\n`;
    for (const d of buckets.j3.slice(0, 5)) msg += `• #${d.id} ${d.title}${fmtMontant(d.value)}\n`;
    msg += '\n';
  }
  if (buckets.j7.length) {
    msg += `🟠 *J+7 (${buckets.j7.length}) — action urgente:*\n`;
    for (const d of buckets.j7.slice(0, 5)) msg += `• #${d.id} ${d.title}${fmtMontant(d.value)}\n`;
    msg += '\n';
  }
  if (buckets.j30.length) {
    msg += `🔴 *J+30 (${buckets.j30.length}) — fermer ou rouvrir:*\n`;
    for (const d of buckets.j30.slice(0, 5)) msg += `• #${d.id} ${d.title}${fmtMontant(d.value)}\n`;
    msg += '\n';
  }
  msg += `_Tape /relancer #id ou /perdu #id pour action rapide._`;
  await sendTG(msg, { parse_mode: 'Markdown' });
  saveState(state);
  return buckets;
}

// ─── 4. HYGIÈNE CRM ────────────────────────────────────────────────────────
async function crmHygiene() {
  log('INFO', 'PROACTIVE', 'CRM hygiene scan...');
  const deals = await fetchOpenDeals();

  // 1. Deals fantômes: étape 49 (NOUVEAU) + >60j sans activité
  const fantomes = deals.filter(d =>
    d.stage_id === 49 && daysSince(d.last_activity_date || d.add_time) > 60
  );

  // 2. Doublons potentiels: même person_id avec multiple deals open
  const byPerson = new Map();
  for (const d of deals) {
    if (!d.person_id) continue;
    const pid = typeof d.person_id === 'object' ? d.person_id.value : d.person_id;
    if (!byPerson.has(pid)) byPerson.set(pid, []);
    byPerson.get(pid).push(d);
  }
  const doublons = [...byPerson.values()].filter(arr => arr.length >= 2);

  if (!fantomes.length && !doublons.length) {
    log('INFO', 'PROACTIVE', 'Hygiène: tout est propre');
    return { fantomes: 0, doublons: 0 };
  }

  let msg = `🧹 *Hygiène CRM nocturne*\n\n`;
  if (fantomes.length) {
    msg += `👻 *Fantômes (${fantomes.length}) — étape NOUVEAU >60j:*\n`;
    for (const d of fantomes.slice(0, 5)) {
      const j = daysSince(d.last_activity_date || d.add_time);
      msg += `• #${d.id} ${d.title} (${j}j)\n`;
    }
    msg += `_Suggéré: /perdu pour archiver._\n\n`;
  }
  if (doublons.length) {
    msg += `🔀 *Doublons (${doublons.length} personnes avec 2+ deals):*\n`;
    for (const dups of doublons.slice(0, 5)) {
      msg += `• ${dups[0].person_name || '?'}: ${dups.map(d => '#' + d.id).join(' + ')}\n`;
    }
    msg += `_Suggéré: garder le + récent, marquer les autres /perdu._\n`;
  }
  await sendTG(msg, { parse_mode: 'Markdown' });
  return { fantomes: fantomes.length, doublons: doublons.length };
}

// ─── 5. DIGEST DIMANCHE ────────────────────────────────────────────────────
async function weeklyDigest() {
  log('INFO', 'PROACTIVE', 'Weekly digest...');
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
  const weekAgoIso = new Date(weekAgo).toISOString().split('T')[0];

  // Tous les deals créés/fermés cette semaine
  const opened = await pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=all_not_deleted&limit=500&start=0`);
  const all = opened?.data || [];

  const newThisWeek = all.filter(d => d.add_time && new Date(d.add_time).getTime() >= weekAgo);
  const wonThisWeek = all.filter(d => d.status === 'won' && d.won_time && new Date(d.won_time).getTime() >= weekAgo);
  const lostThisWeek = all.filter(d => d.status === 'lost' && d.lost_time && new Date(d.lost_time).getTime() >= weekAgo);
  const openNow = all.filter(d => d.status === 'open');

  const totalValue = wonThisWeek.reduce((sum, d) => sum + (d.value || 0), 0);
  const conversionRate = newThisWeek.length ? ((wonThisWeek.length / newThisWeek.length) * 100).toFixed(1) : 0;

  let msg = `📊 *Digest semaine — ${new Date().toLocaleDateString('fr-CA', { day: 'numeric', month: 'long' })}*\n\n`;
  msg += `*🆕 Nouveaux:* ${newThisWeek.length} leads\n`;
  msg += `*✅ Gagnés:* ${wonThisWeek.length}${totalValue ? ` (${Math.round(totalValue / 1000)}k$)` : ''}\n`;
  msg += `*❌ Perdus:* ${lostThisWeek.length}\n`;
  msg += `*📂 Pipeline ouvert:* ${openNow.length}\n`;
  msg += `*🎯 Conversion 7j:* ${conversionRate}%\n\n`;

  if (wonThisWeek.length) {
    msg += `*🏆 Wins de la semaine:*\n`;
    for (const d of wonThisWeek.slice(0, 5)) {
      msg += `• ${d.title}${fmtMontant(d.value)}\n`;
    }
    msg += '\n';
  }

  // Top sources
  const sources = {};
  for (const d of newThisWeek) {
    const src = d.source_name || d.source || 'Inconnu';
    sources[src] = (sources[src] || 0) + 1;
  }
  const topSources = Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 3);
  if (topSources.length) {
    msg += `*📈 Top sources:*\n`;
    for (const [src, n] of topSources) msg += `• ${src}: ${n}\n`;
  }

  msg += `\n_Bonne semaine!_`;
  await sendTG(msg, { parse_mode: 'Markdown' });
  return { newThisWeek: newThisWeek.length, wonThisWeek: wonThisWeek.length, openNow: openNow.length };
}

module.exports = {
  init,
  alerteJ1NotCalled,
  morningReport,
  stagnantDeals,
  crmHygiene,
  weeklyDigest
};
