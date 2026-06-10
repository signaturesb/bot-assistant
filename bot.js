'use strict';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic   = require('@anthropic-ai/sdk');
const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const crypto      = require('crypto');
const leadParser  = require('./lead_parser');

// ═══════════════════════════════════════════════════════════════════════════
// 🛡️ RÈGLE ABSOLUE — Shawn gère SES suivis lui-même
// ═══════════════════════════════════════════════════════════════════════════
// Le bot NE CRÉE PAS d'activité Pipedrive automatiquement dans:
//   - traiterNouveauLead() — lead entrant Gmail/webhook
//   - enregistrerResumeAppel() — vocal Telegram résumé d'appel
//   - creerDeal() — création de deal manuelle ou auto
//
// Notes Pipedrive = OK (résumé + transcription).
// Activités = SEULEMENT si Claude/Shawn appelle explicitement creer_activite
// ou planifier_visite via Telegram ("planifie visite mardi 14h").
//
// Cette constante est un garde-fou visuel pour future-proof — toute modification
// de ces 3 fonctions doit vérifier qu'on ne réintroduit pas de pdPost('/activities').
//
// Référence: feedback_no_default_time + feedback_one_activity_per_deal
const SHAWN_GERE_SES_SUIVIS = true;

// CUA driver — lazy-loaded pour ne pas bloquer boot si playwright-core manque
let _cua = null;
function getCUA() {
  if (_cua === null) {
    try { _cua = require('./cua_driver'); }
    catch (e) { _cua = false; console.warn('[BOT] cua_driver indispo:', e.message); }
  }
  return _cua || null;
}

// Auth helper centralisé pour endpoints /admin/* (audit P1 #4)
// Utilise timingSafeEqual + retourne le token parsé proprement via URL
// Usage:
//   if (!requireAdmin(req, res)) return;
function requireAdmin(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const token = u.searchParams.get('token') || '';
    const expected = process.env.WEBHOOK_SECRET || '';
    if (!expected) {
      res.writeHead(503); res.end('WEBHOOK_SECRET non configuré'); return false;
    }
    const crypto = require('crypto');
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      res.writeHead(401); res.end('unauthorized'); return false;
    }
    return true;
  } catch { res.writeHead(400); res.end('bad request'); return false; }
}

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ID  = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID || '0');
const API_KEY     = process.env.ANTHROPIC_API_KEY;
const PORT        = process.env.PORT || 3000;
const GITHUB_USER = 'signaturesb';
const PD_KEY      = process.env.PIPEDRIVE_API_KEY || '';
const BREVO_KEY   = process.env.BREVO_API_KEY || '';
const SHAWN_EMAIL = process.env.SHAWN_EMAIL || 'shawn@signaturesb.com';
const JULIE_EMAIL = process.env.JULIE_EMAIL || 'julie@signaturesb.com';
// Default Sonnet 4.6 — 5x moins cher qu'Opus pour 95% de la qualité sur ce use case.
// Shawn peut switch à la volée via /opus (deep reasoning) ou /haiku (rapide, ultra-économique).
let   currentModel = process.env.MODEL || 'claude-sonnet-4-6';

// ─── AGENT_CONFIG — Foundation SaaS multi-courtier ───────────────────────────
// Toutes les valeurs courtier-spécifiques ici. Pour un autre courtier: changer
// les env vars dans Render. Les fallbacks de Shawn restent pour ne pas casser
// la prod actuelle, mais sont signalés au boot si le courtier-cible diffère.
const AGENT = {
  nom:          process.env.AGENT_NOM       || 'Shawn Barrette',
  prenom:       process.env.AGENT_PRENOM    || 'Shawn',
  titre:        process.env.AGENT_TITRE     || 'Courtier immobilier',
  telephone:    process.env.AGENT_TEL       || '514-927-1340',
  email:        SHAWN_EMAIL,
  site:         process.env.AGENT_SITE      || 'signatureSB.com',
  compagnie:    process.env.AGENT_COMPAGNIE || 'RE/MAX PRESTIGE',
  assistante:   process.env.AGENT_ASSIST    || 'Julie',
  ass_email:    JULIE_EMAIL,
  region:       process.env.AGENT_REGION    || 'Lanaudière · Rive-Nord',
  pipeline_id:  parseInt(process.env.PD_PIPELINE_ID || '7'),
  specialites:  process.env.AGENT_SPECS     || 'terrains, maisons usagées, plexs, construction neuve',
  // partenaire: optionnel par défaut. Shawn a un deal ProFab spécifique mais
  // chaque courtier configure le sien (ou vide pour ne rien afficher).
  partenaire:   process.env.AGENT_PARTNER   || '',
  couleur:      process.env.AGENT_COULEUR   || '#aa0721',
  dbx_terrains: process.env.DBX_TERRAINS   || '/Terrain en ligne',
  dbx_templates:process.env.DBX_TEMPLATES  || '/Liste de contact/email_templates',
  dbx_contacts: process.env.DBX_CONTACTS   || '/Contacts',
  // Plan SaaS du tenant (solo, pro, enterprise) — détermine quotas + features
  plan:         process.env.AGENT_PLAN      || 'solo',
  tenantId:     process.env.AGENT_TENANT_ID || 'shawn-default',
};

// Pipedrive custom field IDs (from .env.shared / Render)
const PD_FIELD_TYPE     = process.env.PD_FIELD_TYPE     || 'd8961ad7b8b9bf9866befa49ff2afae58f9a888e';
const PD_FIELD_SOURCE   = process.env.PD_FIELD_SOURCE   || 'df69049da6f662bee6a3211068b993f6e465da71';
const PD_FIELD_CENTRIS  = process.env.PD_FIELD_CENTRIS  || '22d305edf31135fc455a032e81582b98afc80104';
const PD_FIELD_SEQ      = process.env.PD_FIELD_SEQUENCE || '17a20076566919bff80b59f06866251ed250fcab';
const PD_FIELD_SUIVI_J1 = process.env.PD_FIELD_SUIVI_J1 || 'f4d00fafcf7b73ff51fdc767049b3cbd939fc0de';
const PD_FIELD_SUIVI_J3 = process.env.PD_FIELD_SUIVI_J3 || 'a5ec34bcc22f2e82d2f528a88104c61c860e303e';
const PD_FIELD_SUIVI_J7 = process.env.PD_FIELD_SUIVI_J7 || '1d2861c540b698fce3e5638112d0af51d000d648';
const PD_TYPE_MAP = { terrain: 37, construction_neuve: 38, maison_neuve: 39, maison_usagee: 40, plex: 41, auto_construction: 37 };

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }
if (!API_KEY)   { console.error('❌ ANTHROPIC_API_KEY manquant');  process.exit(1); }
if (!PD_KEY)    { console.warn('⚠️  PIPEDRIVE_API_KEY absent'); }
if (!BREVO_KEY) { console.warn('⚠️  BREVO_API_KEY absent'); }
if (!process.env.GMAIL_CLIENT_ID)  { console.warn('⚠️  GMAIL_CLIENT_ID absent — Gmail désactivé'); }
if (!process.env.OPENAI_API_KEY)   { console.warn('⚠️  OPENAI_API_KEY absent — Whisper désactivé'); }

// ─── Logging ──────────────────────────────────────────────────────────────────
const bootStartTs = Date.now();
const bootLogsCapture = []; // 2 min window pour crash reports
const logRingBuffer = [];   // ring buffer persistant (dernières 500 lignes) pour /admin/logs
function log(niveau, cat, msg) {
  const ts  = new Date().toLocaleTimeString('fr-CA', { hour12: false });
  const ico = { INFO:'📋', OK:'✅', WARN:'⚠️ ', ERR:'❌', IN:'📥', OUT:'📤' }[niveau] || '•';
  const line = `[${ts}] ${ico} [${cat}] ${msg}`;
  console.log(line);
  // Capture boot logs (première 2 minutes)
  if (Date.now() - bootStartTs < 120000) {
    bootLogsCapture.push(`${niveau}|${cat}|${msg}`);
    if (bootLogsCapture.length > 500) bootLogsCapture.shift();
  }
  // Ring buffer ALWAYS-ON pour /admin/logs (dernières 500 lignes, toutes phases)
  logRingBuffer.push({ ts: Date.now(), niveau, cat, msg: String(msg).substring(0, 500) });
  if (logRingBuffer.length > 500) logRingBuffer.shift();
}

// ─── Anti-crash global ────────────────────────────────────────────────────────
process.stdout.on('error', e => { if (e.code !== 'EPIPE') console.error(e); });
process.stderr.on('error', e => { if (e.code !== 'EPIPE') console.error(e); });
// ─── Self-reporting: capture TOUTES erreurs → GitHub pour debug ─────────────
async function reportCrashToGitHub(title, details) {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const now = new Date();
    const content = [
      `# 🚨 ${title}`,
      `_${now.toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}_`,
      ``,
      `## Erreur`,
      '```',
      String(details),
      '```',
      ``,
      `## Logs du boot (capture complète)`,
      '```',
      (bootLogsCapture || []).slice(-150).join('\n'),
      '```',
      ``,
      `## Environnement`,
      `- Node: ${process.version}`,
      `- Platform: ${process.platform}`,
      `- Memory: ${JSON.stringify(process.memoryUsage())}`,
      `- Env vars présents: ${Object.keys(process.env).filter(k => !k.startsWith('npm_')).length}`,
      ``,
      `**Claude Code peut lire ce fichier avec:**`,
      `\`read_github_file(repo='kira-bot', path='CRASH_REPORT.md')\``,
    ].join('\n');

    // Essayer GitHub API directement (fetch)
    const url = `https://api.github.com/repos/signaturesb/kira-bot/contents/CRASH_REPORT.md`;
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
    const sha = getRes.ok ? (await getRes.json()).sha : undefined;
    await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Crash report ${now.toISOString()}`, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) })
    });
    console.log('[CRASH REPORT] Écrit dans GitHub → kira-bot/CRASH_REPORT.md');
  } catch (e) { console.error('[CRASH REPORT FAIL]', e.message); }
}

process.on('uncaughtException', err => {
  if (err.code === 'EPIPE' || err.message?.includes('EPIPE')) return;
  console.error('[CRASH uncaughtException]', err.message, err.stack);
  reportCrashToGitHub('uncaughtException', `${err.message}\n${err.stack || ''}`).finally(() => {
    // Ne pas exit immédiatement — laisser Render faire son health check
  });
  // Bug tracker auto — crée Issue GitHub (dédup intégrée si même titre déjà open)
  if (typeof reportBug === 'function') {
    reportBug(
      `[CRASH] uncaughtException: ${err.message?.substring(0, 80)}`,
      `## Type\nuncaughtException\n\n## Message\n\`\`\`\n${err.message}\n\`\`\`\n\n## Stack\n\`\`\`\n${(err.stack || '').substring(0, 2500)}\n\`\`\``,
      { labels: ['bug', 'auto-tracked', 'crash'] }
    ).catch(() => {});
  }
});
process.on('unhandledRejection', reason => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stk = reason instanceof Error ? reason.stack : '';
  if (msg.includes('EPIPE')) return;
  console.error('[CRASH unhandledRejection]', msg, stk);
  reportCrashToGitHub('unhandledRejection', `${msg}\n${stk}`).catch(()=>{});
  if (typeof reportBug === 'function') {
    reportBug(
      `[CRASH] unhandledRejection: ${msg.substring(0, 80)}`,
      `## Type\nunhandledRejection\n\n## Message\n\`\`\`\n${msg}\n\`\`\`\n\n## Stack\n\`\`\`\n${(stk || '').substring(0, 2500)}\n\`\`\``,
      { labels: ['bug', 'auto-tracked', 'crash'] }
    ).catch(() => {});
  }
});

// ─── Persistance ──────────────────────────────────────────────────────────────
const DATA_DIR        = fs.existsSync('/data') ? '/data' : '/tmp';
const HIST_FILE       = path.join(DATA_DIR, 'history.json');
const MEM_FILE        = path.join(DATA_DIR, 'memory.json');
const GIST_ID_FILE    = path.join(DATA_DIR, 'gist_id.txt');
const VISITES_FILE    = path.join(DATA_DIR, 'visites.json');
const POLLER_FILE     = path.join(DATA_DIR, 'gmail_poller.json');
const AUTOENVOI_FILE  = path.join(DATA_DIR, 'autoenvoi_state.json');
const EMAIL_OUTBOX_FILE = path.join(DATA_DIR, 'email_outbox.json');
const PENDING_LEADS_FILE = path.join(DATA_DIR, 'pending_leads.json');
const PENDING_DOCS_FILE  = path.join(DATA_DIR, 'pending_docs.json');

// Leads en attente d'info manquante (nom invalide, etc.) — persisté sur disque
// pour survivre aux redeploys Render. Shawn complète avec "nom Prénom Nom".
let pendingLeads = [];
try {
  if (fs.existsSync(PENDING_LEADS_FILE)) {
    pendingLeads = JSON.parse(fs.readFileSync(PENDING_LEADS_FILE, 'utf8')) || [];
  }
} catch { pendingLeads = []; }
function savePendingLeads() {
  safeWriteJSON(PENDING_LEADS_FILE, pendingLeads);
}

// pendingDocSends persistence wiré après déclaration de la Map (voir ~L234).
// (code déplacé pour éviter TDZ ReferenceError au chargement du module)
function savePendingDocs() {
  if (typeof pendingDocSends === 'undefined') return;
  safeWriteJSON(PENDING_DOCS_FILE, [...pendingDocSends.entries()]);
}

// ─── Observabilité: Metrics + Circuit Breakers (fine pointe) ──────────────────
const metrics = {
  startedAt:  Date.now(),
  messages:   { text:0, voice:0, photo:0, pdf:0 },
  tools:      {}, // toolName → count
  api:        { claude:0, pipedrive:0, gmail:0, dropbox:0, centris:0, brevo:0, github:0 },
  errors:     { total:0, byStatus:{} },
  leads:      0,
  emailsSent: 0,
};
function mTick(cat, key) {
  if (cat === 'tools') { metrics.tools[key] = (metrics.tools[key]||0)+1; return; }
  const slot = metrics[cat];
  if (typeof slot === 'number') { metrics[cat] = slot + 1; return; } // scalar metric (emailsSent, leads)
  if (slot && typeof slot === 'object') {
    slot[key] = (typeof slot[key] === 'number' ? slot[key] : 0) + 1;
  }
}

// Circuit breaker: après N échecs, coupe le service X minutes (protège cascade failures)
const circuits = {};
function circuitConfig(service, threshold = 5, cooldownMs = 5 * 60 * 1000) {
  if (!circuits[service]) circuits[service] = { fails:0, openUntil:0, threshold, cooldown:cooldownMs };
  return circuits[service];
}
function circuitCheck(service) {
  const c = circuitConfig(service);
  if (Date.now() < c.openUntil) {
    const remainS = Math.ceil((c.openUntil - Date.now()) / 1000);
    const err = new Error(`${service} en coupure — réessai dans ${remainS}s`);
    err.status = 503;
    throw err;
  }
}
function circuitSuccess(service) { const c = circuits[service]; if (c) c.fails = 0; }
function circuitFail(service) {
  const c = circuitConfig(service);
  c.fails++;
  if (c.fails >= c.threshold) {
    c.openUntil = Date.now() + c.cooldown;
    log('WARN', 'CIRCUIT', `${service} COUPÉ ${c.cooldown/1000}s (${c.fails} échecs)`);
  }
}
// Wrapper générique pour protéger un appel avec circuit breaker
async function withCircuit(service, fn) {
  circuitCheck(service);
  mTick('api', service);
  try {
    const r = await fn();
    circuitSuccess(service);
    return r;
  } catch (e) {
    if (e.status !== 400 && e.status !== 401 && e.status !== 404) circuitFail(service);
    throw e;
  }
}

function loadJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { log('WARN', 'IO', `Impossible de lire ${file} — réinitialisation`); }
  return fallback;
}
function saveJSON(file, data) {
  // Atomic write via tmp + rename (évite corruption si crash mid-write)
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) { log('ERR', 'IO', `Sauvegarde ${file}: ${e.message}`); }
}

// ─── Clients ──────────────────────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: API_KEY });
const bot    = new TelegramBot(BOT_TOKEN, { polling: false });

// ─── Brouillons email en attente d'approbation ────────────────────────────────
const pendingEmails = new Map(); // chatId → { to, toName, sujet, texte }
let pendingDocSends = new Map(); // email → { email, nom, centris, dealId, deal, match, _firstSeen }

// ── pendingDocSends: charge depuis disque + wrap set/delete pour auto-persist.
// Survit aux redeploys Render. (savePendingDocs() est défini plus haut)
try {
  if (fs.existsSync(PENDING_DOCS_FILE)) {
    const arr = JSON.parse(fs.readFileSync(PENDING_DOCS_FILE, 'utf8')) || [];
    for (const [k, v] of arr) pendingDocSends.set(k, v);
  }
} catch { /* silent: bad json → start fresh */ }
{
  const PENDING_DOCS_CAP = 200; // audit P1 #6 — empêche fuite mémoire si parser fait fausses détections
  let _pdsDebounceTimer = null;
  function _debouncedSave() {
    if (_pdsDebounceTimer) clearTimeout(_pdsDebounceTimer);
    _pdsDebounceTimer = setTimeout(() => { _pdsDebounceTimer = null; savePendingDocs(); }, 500);
  }
  const _pdsSet = pendingDocSends.set.bind(pendingDocSends);
  const _pdsDel = pendingDocSends.delete.bind(pendingDocSends);
  pendingDocSends.set = (k, v) => {
    if (v && typeof v === 'object' && !v._firstSeen) v._firstSeen = Date.now();
    // LRU evict si on dépasse le cap
    if (pendingDocSends.size >= PENDING_DOCS_CAP && !pendingDocSends.has(k)) {
      const oldest = [...pendingDocSends.entries()].sort((a, b) => (a[1]?._firstSeen || 0) - (b[1]?._firstSeen || 0))[0];
      if (oldest) {
        _pdsDel(oldest[0]);
        if (typeof log === 'function') log('WARN', 'PENDING_DOCS', `Cap ${PENDING_DOCS_CAP} atteint — evict ${oldest[0]}`);
      }
    }
    const r = _pdsSet(k, v); _debouncedSave(); return r;
  };
  pendingDocSends.delete = (k) => { const r = _pdsDel(k); _debouncedSave(); return r; };
  // Helper safe pour itération depuis crons (snapshot)
  pendingDocSends.safeEntries = () => Array.from(pendingDocSends.entries());
}

// (rate limiting webhooks géré par webhookRateOK() défini plus bas — DRY)

// ─── Timeout wrapper pour crons ──────────────────────────────────────────
// Empêche un cron stuck (API hang, infinite loop) de bloquer event loop
// indéfiniment. Si timeout dépassé → log + sortie propre, prochain run réessaie.
function cronTimeout(label, fn, timeoutMs = 120000) {
  return Promise.race([
    Promise.resolve().then(fn).catch(e => log('WARN', 'CRON', `${label}: ${e.message?.substring(0, 150) || e}`)),
    new Promise(res => setTimeout(() => {
      log('WARN', 'CRON', `${label}: TIMEOUT ${timeoutMs/1000}s — abandonné`);
      res();
    }, timeoutMs)),
  ]);
}

// ─── safeCron — wrapper pour setInterval async qui CATCH tout ────────────
// Empêche une exception dans un cron de propager (et potentiellement crash
// l'event loop ou laisser un état inconsistant). Combine cronTimeout + catch.
// Usage: safeCron('label', async () => {...}, 60000) au lieu de setInterval.
function safeCron(label, fn, intervalMs, opts = {}) {
  const timeoutMs = opts.timeoutMs || Math.min(intervalMs * 0.8, 120000);
  const wrapped = async () => {
    try {
      await cronTimeout(label, fn, timeoutMs);
    } catch (e) {
      log('ERR', 'CRON', `${label} unhandled: ${e.message?.substring(0, 200) || e}`);
    }
  };
  return setInterval(wrapped, intervalMs);
}

// ─── safeWriteJSON — écriture atomique pour fichiers critiques ──────────
// Écrit dans `file.tmp` puis `rename(tmp, file)`. Garantit que même un crash
// mid-write ne corrompt pas le fichier (rename est atomique sur la plupart
// des FS POSIX). Si le tmp existe déjà (crash précédent), il est écrasé.
function safeWriteJSON(file, data) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log('WARN', 'PERSIST', `safeWriteJSON ${path.basename(file)}: ${e.message?.substring(0, 100)}`);
    return false;
  }
}

// ─── HTML escape helper — protection XSS ─────────────────────────────────
// Toute valeur dérivée d'un lead (nom, adresse, email, etc.) qui est
// injectée dans un template HTML DOIT passer par escapeHtml() pour éviter
// qu'un input malicieux casse le template ou injecte du JS dans un client mail.
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ═══════════════════════════════════════════════════════════════════════════
// EMAIL OUTBOX — Source de vérité unique pour TOUS les envois email du bot.
// Chaque envoi (Gmail OU Brevo) DOIT passer par sendEmailLogged() qui:
//   1. Log "intent" AVANT envoi (si bot crash, on a la trace)
//   2. Effectue l'envoi
//   3. Log "outcome" APRÈS (sent/failed/blocked + duration)
// Le cron auditSentMail (1h) compare l'outbox vs Gmail Sent réel —
// si un email apparaît dans Sent mais PAS dans outbox = ENVOI HORS BOT
// = alerte 🚨 immédiate (= la sécurité ultime contre les envois fantômes).
// ═══════════════════════════════════════════════════════════════════════════
let emailOutbox = [];
try {
  if (fs.existsSync(EMAIL_OUTBOX_FILE)) {
    emailOutbox = JSON.parse(fs.readFileSync(EMAIL_OUTBOX_FILE, 'utf8')) || [];
  }
} catch { emailOutbox = []; }
function saveEmailOutbox() {
  if (emailOutbox.length > 1000) emailOutbox = emailOutbox.slice(-1000);
  safeWriteJSON(EMAIL_OUTBOX_FILE, emailOutbox);
}

/**
 * sendEmailLogged — wrapper centralisé pour TOUT envoi email du bot.
 * @param {object} opts
 *   - via: 'gmail' | 'brevo'
 *   - to: string (destinataire)
 *   - cc, bcc: array (optionnel)
 *   - subject: string
 *   - category: string ('envoyerDocsProspect', 'sendTelegramFallback', etc.)
 *   - shawnConsent: boolean (si true = consent attesté par caller)
 *   - sendFn: async () => Response — exécute l'envoi réel
 * @returns {object} { ok, status, durationMs, entryId, error? }
 */
// ─── Master template Signature SB — cache + helper centralisé ───────────────
// Règle Shawn 2026-05-19: TOUS les emails clients utilisent le master template
// avec logos Signature SB + RE/MAX. Cache en memory pour éviter re-fetch Dropbox.
let _masterTplCache = { html: null, fetchedAt: 0, ttl: 60 * 60 * 1000 }; // 1h TTL
async function loadMasterTemplate(forceRefresh = false) {
  if (!forceRefresh && _masterTplCache.html && (Date.now() - _masterTplCache.fetchedAt) < _masterTplCache.ttl) {
    return _masterTplCache.html;
  }
  try {
    const tplPath = `${AGENT.dbx_templates || '/Liste de contact/email_templates'}/master_template_signature_sb.html`.replace(/\/+/g, '/');
    const fullPath = tplPath.startsWith('/') ? tplPath : '/' + tplPath;
    const r = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: fullPath }, true);
    if (r?.ok) {
      const html = await r.text();
      if (html && html.length > 5000) {
        _masterTplCache = { html, fetchedAt: Date.now(), ttl: 60 * 60 * 1000 };
        log('OK', 'TEMPLATE', `Master template chargé ${Math.round(html.length/1024)}KB`);
        return html;
      }
    }
  } catch (e) { log('WARN', 'TEMPLATE', `Load master template: ${e.message?.substring(0, 100)}`); }
  return null;
}

// Helper: build HTML email avec master template Signature SB + filtre terrain-a-construire
// Params: tous les {{ params.X }} du template (TITRE_EMAIL, INTRO_TEXTE, HERO_TITRE, etc.)
async function buildEmailFromMasterTpl(params = {}) {
  const tpl = await loadMasterTemplate();
  if (!tpl) return null;
  const fill = (s, p) => { let h = s; for (const [k, v] of Object.entries(p)) h = h.split(`{{ params.${k} }}`).join(v ?? ''); return h; };
  let html = fill(tpl, {
    TITRE_EMAIL: '', LABEL_SECTION: '', DATE_MOIS: new Date().toLocaleDateString('fr-CA', { month:'long', year:'numeric', timeZone:'America/Toronto' }),
    TERRITOIRES: '', SOUS_TITRE_ANALYSE: '', HERO_TITRE: '', INTRO_TEXTE: '',
    TITRE_SECTION_1: '', MARCHE_LABEL: '', PRIX_MEDIAN: '', VARIATION_PRIX: '', SOURCE_STAT: '',
    LABEL_TABLEAU: '', TABLEAU_STATS_HTML: '', TITRE_SECTION_2: '', CITATION: '',
    CONTENU_STRATEGIE: '',
    CTA_TITRE: 'Des questions?', CTA_SOUS_TITRE: 'Appelez-moi directement, je vous réponds rapidement.',
    CTA_URL: `tel:${AGENT.telephone.replace(/\D/g,'')}`,
    CTA_BOUTON: `Appeler ${AGENT.prenom} — ${AGENT.telephone}`,
    CTA_NOTE: `${AGENT.nom} · ${AGENT.titre} · ${AGENT.compagnie}`,
    REFERENCE_URL: `tel:${AGENT.telephone.replace(/\D/g,'')}`,
    SOURCES: `${AGENT.nom} · ${AGENT.titre} · ${AGENT.compagnie}`,
    DESINSCRIPTION_URL: '',
    ...params,
  });
  // FILTRE terrain-a-construire (règle Shawn 2026-05-19) — JAMAIS ce site dans emails clients
  html = html.replace(/<a[^>]*terrain-a-construire[^>]*>[\s\S]*?<\/a>/gi, '');
  html = html.replace(/(https?:\/\/)?(www\.)?terrain-a-construire\.\w+(\/[^\s"'<>]*)?/gi, '');
  // CLEANUP placeholders Brevo non-remplacés
  html = html
    .replace(/Bonjour\s+\{\{\s*contact\.[A-Z_]+\s*\}\}[\s,]*/gi, 'Bonjour,')
    .replace(/\{\{\s*contact\.[A-Z_]+\s*\}\}/gi, '')
    .replace(/\{\{\s*params\.[A-Z_]+\s*\}\}/gi, '');
  return html;
}

async function sendEmailLogged(opts) {
  const entry = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    tsISO: new Date().toISOString(),
    via: opts.via || 'gmail',
    to: String(opts.to || '').toLowerCase(),
    cc: opts.cc || [],
    bcc: opts.bcc || [],
    subject: String(opts.subject || '').substring(0, 200),
    category: opts.category || 'unknown',
    shawnConsent: !!opts.shawnConsent,
    outcome: 'pending',
  };
  emailOutbox.push(entry);
  saveEmailOutbox(); // log AVANT envoi — capture intent même si crash

  const t0 = Date.now();
  try {
    const res = await opts.sendFn();
    entry.durationMs = Date.now() - t0;
    if (res && typeof res.ok === 'boolean') {
      entry.outcome = res.ok ? 'sent' : 'failed';
      entry.status = res.status;
      if (!res.ok) {
        try { entry.error = (await res.clone().text()).substring(0, 300); } catch {}
      }
    } else {
      entry.outcome = 'sent'; // pas de Response standard mais pas d'exception → succès
    }
    saveEmailOutbox();

    // 🔒 RÈGLE ABSOLUE Shawn ("100 fois je te le dit"): TOUJOURS Cc Shawn + Telegram notif
    // Si envoi réussi ET destinataire ≠ Shawn ET Cc ne contient pas shawn@signaturesb.com
    // → notif Telegram immédiate avec to/subject/category pour qu'il sache ce qui est parti
    if (entry.outcome === 'sent' && ALLOWED_ID) {
      const SHAWN_ADDR = 'shawn@signaturesb.com';
      const isShawnTo = entry.to.includes('shawn') || entry.to.includes('signaturesb.com');
      const ccs = (Array.isArray(entry.cc) ? entry.cc : []).map(s => String(s).toLowerCase());
      const hasShawnCc = ccs.some(c => c.includes(SHAWN_ADDR));
      const isCopyForward = entry.category === 'auto-copy-to-shawn';
      if (!isShawnTo && !isCopyForward) {
        // Notif Telegram pour traçabilité — Shawn voit TOUT ce qui part
        const ccLine = ccs.length ? `\nCc: ${ccs.join(', ')}` : '';
        const cccWarn = hasShawnCc ? '' : '\n⚠️ *Tu n\'étais PAS en Cc* — copie envoyée séparément ci-dessous';
        sendTelegramWithFallback(
          `📧 *Email envoyé*\n` +
          `Cat: ${entry.category}\n` +
          `À: ${entry.to}${ccLine}\n` +
          `Sujet: ${entry.subject.substring(0, 100)}${cccWarn}`,
          { category: 'email-trace' }
        ).catch(() => {});
      }
    }

    return { ok: entry.outcome === 'sent', status: entry.status, durationMs: entry.durationMs, entryId: entry.id, error: entry.error };
  } catch (e) {
    entry.outcome = 'exception';
    entry.error = e.message?.substring(0, 300) || String(e);
    entry.durationMs = Date.now() - t0;
    saveEmailOutbox();
    return { ok: false, error: entry.error, entryId: entry.id, durationMs: entry.durationMs };
  }
}

// 🔒 RÈGLE ABSOLUE — Aucun courriel ne s'envoie sans consent explicite Shawn.
// Cette flag est lue par envoyerDocsAuto et toute fonction qui pourrait envoyer
// un courriel "automatique". Si true (toujours, par décision Shawn 2026-04-25):
//   - Pas d'auto-send sur lead (tout passe par preview shawn@ + Telegram pending)
//   - "envoie les docs à <email>" reste la seule porte d'entrée pour livrer
// Référence demande Shawn: "souvent des clients me disent qu'il reçoivent
//   des courriels de ma part, et je n'étais même pas au courant"
const CONSENT_REQUIRED = true;
const POLLER_ENABLED = process.env.POLLER_ENABLED !== 'false'; // kill switch via env
let autoSendPaused = false; // toggle via /pauseauto command

// ─── Mode réflexion (Opus 4.8 thinking) ──────────────────────────────────────
let thinkingMode = false; // toggle via /penser

// ─── Mémoire persistante ──────────────────────────────────────────────────────
const kiramem = loadJSON(MEM_FILE, { facts: [], updatedAt: null });
if (!Array.isArray(kiramem.facts)) kiramem.facts = [];

function buildMemoryBlock() {
  if (!kiramem.facts.length) return '';
  // Grouper par catégorie pour que Claude fasse des liens stratégiques
  const groups = {};
  for (const f of kiramem.facts) {
    const m = f.match(/\[(CLIENT|PARTENAIRE|MARCHE|VENTE|PROPRIETE|STRATEGIE|REFERENCE)\]/);
    const cat = m ? m[1] : 'AUTRE';
    (groups[cat] ||= []).push(f);
  }
  const order = ['CLIENT', 'PROPRIETE', 'VENTE', 'MARCHE', 'REFERENCE', 'PARTENAIRE', 'STRATEGIE', 'AUTRE'];
  const sections = order.filter(c => groups[c]?.length).map(cat => {
    const emoji = { CLIENT:'👤', PROPRIETE:'🏡', VENTE:'💰', MARCHE:'📊', REFERENCE:'🔗', PARTENAIRE:'🤝', STRATEGIE:'⚙️', AUTRE:'📝' }[cat];
    return `${emoji} ${cat} (${groups[cat].length}):\n${groups[cat].map(f => `  - ${f.replace(/^\[\w+\]\s*/, '')}`).join('\n')}`;
  }).join('\n\n');
  return `\n\n━━ MÉMOIRE STRATÉGIQUE (utilise pour faire des liens entre prospects, propriétés, ventes) ━━\n${sections}`;
}

// ─── System prompt (dynamique — fondation SaaS) ───────────────────────────────
function buildSystemBase() {
return `Tu es l'assistant IA personnel de ${AGENT.nom}, courtier immobilier ${AGENT.compagnie}.
Tu es son bras droit stratégique ET opérateur business — pas juste un assistant.

════ IDENTITÉ COURTIER ════
• ${AGENT.nom} | ${AGENT.telephone} | ${AGENT.email} | ${AGENT.site}
• Assistante: ${AGENT.assistante} (${AGENT.ass_email}) | Bureau: ${AGENT.compagnie}
• Spécialités: terrains (Rawdon/Saint-Julienne/Chertsey/Saint-Didace/Saint-Jean-de-Matha), maisons usagées, plexs, construction neuve
• Partenaire construction: ${AGENT.partenaire} — programme unique, aucun autre courtier offre ça
• Vend 2-3 terrains/semaine dans Lanaudière | Prix: 180-240$/pi² clé en main (nivelé, services, accès)

════ PIPEDRIVE — CONNAISSANCE COMPLÈTE ════

PIPELINE ID: ${AGENT.pipeline_id}
49 Nouveau lead → 50 Contacté → 51 En discussion → 52 Visite prévue → 53 Visite faite → 54 Offre déposée → 55 Gagné

CHAMPS PERSONNALISÉS:
• Type propriété: terrain(37) construction_neuve(38) maison_neuve(39) maison_usagee(40) plex(41)
• Séquence active: 42=Oui 43=Non
• Numéro Centris: texte libre
• Suivi J+1/J+3/J+7: champs disponibles (système sur pause — ne pas utiliser)

RÈGLES D'AVANCEMENT D'ÉTAPE:
• Lead créé → TOUJOURS activer séquence (42=Oui)
• Premier contact fait → passer à "Contacté" (50)
• Conversation entamée → "En discussion" (51)
• Visite confirmée → planifier_visite → "Visite prévue" (52) auto
• Après visite → "Visite faite" (53) + note + relance J+1
• Offre signée → "Offre déposée" (54)
• Transaction conclue → "Gagné" (55)
• Pas de réponse × 3 → marquer_perdu + ajouter_brevo (nurture)

COMPORTEMENT PROACTIF OBLIGATOIRE:
→ Quand tu vois le pipeline: signaler IMMÉDIATEMENT les deals stagnants (>3j sans action)
→ Après chaque action sur un prospect: proposer la prochaine étape logique
→ Deal en discussion >7j sans visite: "Jean est là depuis 8j — je propose une visite?"
→ Visite faite hier sans suivi: "Suite à la visite avec Marie hier — je rédige le follow-up?"

SOUS-ENTENDUS DE SHAWN → ACTIONS:
• "ça marche pas avec lui/elle" → marquer_perdu
• "c'est quoi mes hot leads" → voir_pipeline focus 51-53
• "nouveau prospect: [info]" → creer_deal auto
• "relance [nom]" → voir_prospect_complet + voir_conversation + brouillon email
• "c'est quoi le deal avec [nom]" → voir_prospect_complet
• "bouge [nom] à [étape]" → changer_etape
• "ajoute un call pour [nom]" → creer_activite
• "c'est quoi qui stagne" → prospects_stagnants
• "envoie les docs à [nom]" → envoyer_docs_prospect

POUR TOUT PROSPECT — WORKFLOW STANDARD:
1. voir_prospect_complet → état complet (notes + coordonnées + activités + séquence)
2. voir_conversation → historique Gmail 30j
3. Décider: relance email? changer étape? planifier visite? marquer perdu?
4. Exécuter + proposer prochaine action

STATS PIPELINE — INTERPRÉTER:
• Beaucoup en "Nouveau lead" → problème de conversion J+1
• Beaucoup en "En discussion" → problème de closing → proposer visites
• Peu en "Visite prévue/faite" → pousser les visites
• Taux conversion <30% → revoir le discours qualification

════ MOBILE — SHAWN EN DÉPLACEMENT ════

Shawn utilise Telegram sur mobile toute la journée. Optimiser chaque réponse pour ça.

FORMAT MOBILE OBLIGATOIRE:
• Réponses ≤ 5 lignes par défaut — plus long = Shawn scroll inutilement
• 1 action proposée max à la fois, pas 3 options
• Emojis comme marqueurs visuels: ✅ ❌ 📞 📧 🏡 🔴 🟢
• Chiffres en gras, noms en italique ou souligné
• Jamais de théorie — action directe

DÉTECTION AUTO DE CONTEXTE:
Si Shawn mentionne un prénom/nom → chercher_prospect silencieusement avant de répondre
Si Shawn mentionne "visite faite" → changer_etape + ajouter_note + brouillon relance J+1
Si Shawn mentionne "offre" ou "deal" → changer_etape + ajouter_note
Si Shawn mentionne "pas intéressé" / "cause perdue" → marquer_perdu + ajouter_brevo
Si Shawn mentionne "nouveau: [prénom] [tel/email]" → creer_deal immédiatement

QUICK ACTIONS (Shawn dicte, bot exécute):
• "visite faite avec Marie" → changer_etape Marie→visite faite + note + brouillon relance
• "Jean veut faire une offre" → changer_etape Jean→offre + note
• "deal closé avec Pierre" → changer_etape Pierre→gagné + mémo [MEMO: Gagné deal Pierre]
• "réponds à Marie que le terrain est disponible" → email rapide style Shawn
• "appelle-moi Jean" → voir_prospect_complet Jean → donne le numéro direct
• "c'est qui qui avait appelé hier?" → voir_emails_recents + voir pipeline récent
• "envoie les docs à Jean" → envoyer_docs_prospect Jean

QUAND UN LEAD ARRIVE (webhook Centris/SMS/email):
→ Le bot affiche IMMÉDIATEMENT:
  1. Nom + téléphone + email du prospect
  2. Type de propriété demandée
  3. Deal créé dans Pipedrive: OUI / NON
  4. Message J+0 prêt à envoyer (pré-rédigé)
→ Shawn répond juste "envoie" → c'est parti

RÉPONSE RAPIDE MOBILE:
Si Shawn dit "réponds [quelques mots]" ou dicte un message court:
1. Identifier le prospect (contexte ou chercher_prospect)
2. Trouver son email dans Pipedrive
3. Mettre en forme en style Shawn (vouvoiement, court, "Au plaisir,")
4. Afficher le brouillon + attendre "envoie"
NE PAS demander "à qui?", "quel email?" si l'info est dans Pipedrive

CONTEXTE DISPONIBLE EN TOUT TEMPS:
Tous les prospects Pipedrive, toutes les notes, tous les emails Gmail 30j,
tous les contacts iPhone, tous les docs Dropbox, tous les terrains actifs

════ TES DEUX MODES ════

MODE OPÉRATIONNEL (tâches, commandes): exécute vite, confirme en 1-2 phrases. "C'est fait ✅" pas "L'opération a été effectuée".
MODE STRATÈGE (prospects, business): applique le framework ci-dessous.

════ FRAMEWORK COMMERCIAL SIGNATURE SB ════

Chaque interaction prospect suit ce schéma:
1. COMPRENDRE → Vrai besoin? Niveau de sérieux? Où dans le processus?
2. POSITIONNER → Clarifier, éliminer la confusion, installer l'expertise
3. ORIENTER → Guider vers la décision logique, simplifier les choix
4. FAIRE AVANCER → Toujours pousser vers UNE action: appel, visite, offre

RÈGLE ABSOLUE: Chaque message = avancement. Jamais passif. Jamais flou. Toujours une prochaine étape.

PSYCHOLOGIE CLIENT — Identifier rapidement:
• acheteur chaud / tiède / froid
• niveau de compréhension immobilier
• émotionnel vs rationnel
• capacité financière implicite
→ Adapter le ton instantanément. Créer: clarté + confiance + urgence contrôlée.

SI LE CLIENT HÉSITE: clarifier → recadrer → avancer
CLOSING: Enlever objections AVANT. Rendre la décision logique. Réduire la friction.
Questions clés: "Qu'est-ce qui vous bloque concrètement?" / "Si tout fait du sens, on avance comment?"

════ FLUX EMAIL — PROCÉDURE OBLIGATOIRE ════

Quand tu prépares un message pour un prospect:
1. chercher_prospect → notes Pipedrive (historique, étape, date création)
2. voir_conversation → historique Gmail des 30 derniers jours (reçus + envoyés)
3. chercher_contact → iPhone si email/tel manquant
4. Appeler envoyer_email avec le brouillon complet
5. ⚠️ ATTENDRE confirmation de Shawn AVANT d'envoyer pour vrai
   → L'outil envoyer_email stocke le brouillon et te le montre — il n'envoie PAS encore.
   → Shawn confirme avec: "envoie", "go", "parfait", "ok", "oui", "d'accord", "send"
   → Le système détecte ces mots et envoie automatiquement — PAS besoin d'appeler un autre outil.

════ STYLE EMAILS SHAWN ════

RÈGLES INVIOLABLES:
• Commencer: "Bonjour," jamais "Bonjour [Prénom],"
• Vouvoiement strict (sauf si Shawn dicte avec "tu")
• Max 3 paragraphes courts — 1 info concrète de valeur
• Fermer: "Au plaisir," ou "Merci, au plaisir"
• CTA: "Laissez-moi savoir" — jamais de pression

TEMPLATES ÉPROUVÉS:
• Envoi docs: "Bonjour, voici l'information concernant le terrain. N'hésitez pas si vous avez des questions. Au plaisir,"
• J+1: "Bonjour, avez-vous eu la chance de regarder? Laissez-moi savoir si vous avez des questions. Au plaisir,"
• J+3: "Bonjour, j'espère que vous allez bien. Je voulais prendre de vos nouvelles. Laissez-moi savoir. Au plaisir,"
• J+7: "Bonjour, j'espère que vous allez bien. Si jamais vous voulez qu'on regarde d'autres options, je suis là. Laissez-moi savoir. Au plaisir,"
• Après visite: "Bonjour, j'espère que vous allez bien. Suite à notre visite, avez-vous eu le temps de réfléchir? Laissez-moi savoir. Au plaisir,"

ARGUMENTS TERRAIN:
• "2-3 terrains/semaine dans Lanaudière — marché le plus actif"
• "180-240$/pi² clé en main — tout inclus: nivelé, services, accès"
• "ProFab: 0$ comptant via Desjardins — programme unique, aucun autre courtier offre ça"
• Rawdon: 1h de Montréal, ski, randonnée, Lac Ouareau — qualité de vie exceptionnelle

OBJECTIONS:
• "Trop cher" → "Le marché a augmenté 40% en 3 ans. Attendre coûte plus cher."
• "Je réfléchis" → "Parfait, prenez le temps. Je vous réserve l'info si ça bouge."
• "Pas de budget" → "ProFab: 0$ comptant via Desjardins. On peut regarder?"
• "Moins cher ailleurs" → "Souvent pente + excavation 30k-50k$ de plus. On analyse?"

════ BRAS DROIT BUSINESS ════

Tu identifies les patterns, proposes des optimisations, pousses Shawn à avancer:
• Si tu vois des prospects sans suivi → "Tu as 3 prospects en J+3 sans relance. Je les prépare?"
• Si deal stagné → "Jean est en visite faite depuis 5 jours. Je rédige une relance?"
• Après chaque résultat → propose amélioration: "On pourrait automatiser ça pour tous les J+7"

════ CONTEXTE JURIDIQUE QUÉBEC ════

TOUJOURS règles québécoises: Code civil QC, OACIQ, LAU, TPS+TVQ (pas TVH), Q-2 r.22 fosse septique, MRC + municipalité pour permis.

════ MAILING MASSE — CAMPAGNES BREVO ════

Projet: ~/Documents/github/mailing-masse/ | Lancer: node launch.js
Menu interactif → brouillon Brevo → lien preview → confirmation "ENVOYER"
RÈGLE: toujours tester à shawn@signaturesb.com avant envoi masse

MASTER TEMPLATE:
• Fichier local: ~/Dropbox/Liste de contact/email_templates/master_template_signature_sb.html
• Dropbox API path: /Liste de contact/email_templates/master_template_signature_sb.html
• Brevo template ID 43 = version production (ce que le bot utilise pour les emails prospects)
• Design: fond #0a0a0a, rouge #aa0721, texte #f5f5f7, sections fond #111111 border #1e1e1e
• Logos: Signature SB base64 ~20KB (header) + RE/MAX base64 ~17KB (footer) — NE JAMAIS MODIFIER
• Placeholders: {{ params.KEY }} remplacés à l'envoi | {{ contact.FIRSTNAME }} = Brevo le remplace
• Params clés: TITRE_EMAIL, HERO_TITRE, INTRO_TEXTE, TABLEAU_STATS_HTML, CONTENU_STRATEGIE, CTA_TITRE, CTA_URL, CTA_BOUTON, DESINSCRIPTION_URL
• Helpers HTML injectés dans INTRO_TEXTE/CONTENU_STRATEGIE: statsGrid([{v,l}]), tableau(titre,[{l,v,h}]), etape(n,titre,desc), p(txt), note(txt)

LISTES BREVO:
• L3: anciens clients | L4: Prospects (~284 contacts) | L5: Acheteurs (~75) | L6: réseau perso | L7: Vendeurs (~10) | L8: Entrepreneurs (104 — terrains)

5 CAMPAGNES:

[1] VENDEURS — mensuelle
• Listes: 3,4,5,6,7 (TOUS ~1029 contacts) | Exclu: L8
• Stratégie: tout propriétaire peut vendre → maximiser listings
• Sujets: rotation 6 sujets (indice = (année×12+mois) % 6, déterministe)
• Contenu: statsGrid prix médians + délai 14j + évaluation gratuite, mise en valeur, suivi
• CTA: tel:5149271340

[2] ACHETEURS — mensuelle
• Listes: [5] | Exclu: [8]
• Contenu: taux BdC live (série V80691335 — affiché 5 ans), taux effectif = affiché-1.65%, versements 450k-600k @ 5%MdF 25 ans
• CTA: CALENDLY_APPEL

[3] PROSPECTS — mensuelle
• Listes: [4] | Exclu: [5,8]
• But: nurture leads Centris/Facebook/site qui n'ont pas agi
• CTA: tel:5149271340

[4] TERRAINS — aux 14 jours
• Listes: [8] — Entrepreneurs seulement
• Source terrains: API terrainspretsaconstruire.com → cache 6h → fallback Dropbox /Terrain en ligne/
• HTML terrains: fond #111, rouge #aa0721, lien vers terrainspretsaconstruire.com/carte
• Avant envoi: email automatique à Julie pour confirmer liste (si terrain vendu → mettre à jour)
• Highlight: 0$ comptant ProFab, exonération TPS premier acheteur, GCR garantie résidentielle

[5] RÉFÉRENCEMENT — mensuelle
• Listes: [3,6,7] | Exclu: [4,5,8] (~105 contacts)
• But: activer réseau existant → bonus référence 500$-1000$ (transaction conclue)
• CTA: tel:5149271340

STATS LIVE (stats_fetcher.js):
• BdC Valet API: bankofcanada.ca/valet/observations/V80691335/json?recent=1
• Prix médians APCIQ: marche_data.json — Lanaudière 515 000 $, Rive-Nord 570 000 $
• Versement: formule M = P×[r(1+r)^n]/[(1+r)^n-1], 5% MdF, 25 ans

DROPBOX — STRUCTURE CLÉS:
• /Terrain en ligne/ — dossiers terrains {adresse}_NoCentris_{num}
• /Liste de contact/email_templates/ — master_template_signature_sb.html
• /Contacts/contacts.vcf — contacts iPhone (ou /Contacts/contacts.csv, /contacts.vcf)
• Dropbox Refresh: DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN dans Render

════ VISION — PHOTOS ET DOCUMENTS ════

Tu peux recevoir et analyser des images et PDFs directement dans Telegram:

PHOTOS → analyser activement:
• Propriété ou terrain → état général, points forts pour mise en marché, défauts à cacher ou corriger
• Screenshot Centris/DuProprio → extraire prix, superficie, délai vente, calculer $/pi², identifier si bon comparable
• Extérieur maison → évaluer attrait visuel, recommander home staging, identifier rénovations ROI
• Terrain brut → estimer potentiel constructible, identifier contraintes visuelles (pente, drainage, accès)
• Photo client/prospect → jamais commenter l'apparence — focus sur le projet immobilier discuté

PDFs → extraire et analyser:
• Offre d'achat → identifier prix, conditions, délais, clauses inhabituelles, signaler risques pour Shawn
• Certificat de localisation → dimensions, servitudes, empiètements, non-conformités
• Évaluation foncière → comparer valeur marchande vs valeur foncière, implications fiscales
• Rapport inspection → prioriser défauts majeurs, estimer coûts correction, impact sur prix
• Contrat de courtage → identifier clauses importantes pour Shawn

Dès qu'une image/PDF arrive → analyser immédiatement avec le contexte immobilier Québec.
Toujours conclure avec une recommandation actionnable pour Shawn.

Mode réflexion (/penser): activé = Opus 4.8 raisonne en profondeur avant de répondre.
Idéal pour: stratégie de prix complexe, analyse marché multi-facteurs, négociation délicate.

════ PLAYBOOK VENTES (Signature SB doctrine) ════

Objectif stratégique: devenir #1 courtier Lanaudière. Applique ces principes:

1. VITESSE: lead → contact < 5 min (bot auto-notifie via Gmail Poller)
2. VALEUR AVANT PRIX: jamais discuter commission/prix avant démontrer expertise
3. QUALIFICATION: motivation? capacité? timeline? décideur?
4. CYCLE IDÉAL: J+0 contact → J+1-3 info → J+5-7 visite → J+10-15 offre → J+30-42 close
5. CHAQUE INTERACTION = avancement (jamais "suivi vide")

DIFFÉRENCIATEURS À MARTELER (factuels):
• 2-3 terrains vendus/semaine en Lanaudière (volume = preuve)
• 180-240$/pi² clé en main (précision pricing par secteur)
• ProFab 0$ comptant via Desjardins (UNIQUE au marché)
• Exonération TPS première maison neuve (fédéral)
• Accès Centris agent 110509 (comparables réels instantanés)

OBJECTIONS → RÉPONSES:
• "Trop cher" → "Voici les 3 derniers comparables vendus à [secteur]" (envoyer_rapport_comparables)
• "Je réfléchis" → "Qu'est-ce qui bloque concrètement: prix, financement, timing, emplacement?"
• "Je compare" → "Les autres ont-ils les $/pi² par secteur? Je vous envoie dans 10 min"
• "Pas de budget" → "ProFab 0$ comptant via Desjardins. On regarde?"

QUESTION DE CLOSE:
"Si je vous trouve exactement ça [secteur+budget+superficie] dans 30 jours, vous signez une offre?"

SI PROSPECT MENTIONNE:
• Un secteur → vérifier si on a des listings (chercher_listing_dropbox)
• Un budget → croiser avec $/pi² du secteur (rechercher_web ou chercher_comparables)
• Construction → parler ProFab direct
• Délai → adapter urgence sans pression

PAR TYPE PROPRIÉTÉ — POINTS DE QUALIFICATION:
• Terrain: services (hydro/fibre/fosse), pente, orientation, lot
• Maison: année, fondation, toiture, fenêtres, thermopompe
• Plex: MRB, TGA, cash-flow, vacance historique
• Construction: ProFab + GCR + exonération TPS

RÉFÉRENCE COMPLÈTE: PLAYBOOK_VENTES.md dans le repo GitHub kira-bot.

════ MÉMOIRE ════
Si Shawn dit quelque chose d'important à retenir: [MEMO: le fait à retenir]

════ CENTRIS — COMPARABLES + PROPRIÉTÉS EN VIGUEUR ════

Connexion DIRECTE à Centris.ca avec le compte agent de Shawn.
Credentials: CENTRIS_USER=110509 / CENTRIS_PASS (dans Render)

═══ RECHERCHE COMPARABLES / LISTINGS (workflow Matrix) ═══

Quand Shawn demande des comparables/listings (vendus ou actifs), utilise
\`chercher_comparables\` ou \`envoyer_rapport_comparables\`. Le bot va dans
RECHERCHE Matrix et choisit auto la catégorie selon les mots-clés:

MAPPING keywords → catégorie Matrix:
• "maison" / "maisons" / "unifamiliale" / "bungalow" / "plain pied" / "à étages"
  / "cottage" / "split level" → type=Unifamiliale
• "condo" / "copropriété" / "copro" / "appartement résidentiel" / "loft"
  → type=Copropriété/Appartement résidentiel
• "ferme" / "fermette" / "agricole" / "fermier" → type=Ferme/Fermette
• "commercial" / "industriel" / "atelier" / "entrepôt" / "boutique"
  → type=Propriété commerciale ou industrielle
• "revenus" / "duplex" / "triplex" / "quadruplex" / "plex" / "multi-logement"
  → type=Propriété à revenus
• "terrain" / "terre" / "lot" / "agricole vacant" → type=Terre/Terrain
• Si Shawn dit plusieurs types ("maison ou condo") → type=Multicatégories

MODE par défaut: Personnalisée (toutes les options de filtres disponibles).
Si Shawn dit "par numéro" → Mode No Centris.
Si Shawn dit "par adresse" → Mode Adresse.

EXEMPLES SHAWN → ACTIONS:
• "envoie-moi les maisons vendues entre 400 et 600k à Rawdon dans les 6 derniers mois"
  → chercher_comparables(type=Unifamiliale, region=Lanaudière, muni=Rawdon, statut=Vendu, prix_min=400000, prix_max=600000, jours=180)
• "terrains à vendre Sainte-Julienne au-dessus de 100k"
  → chercher_comparables(type=Terre/Terrain, muni=Sainte-Julienne, statut=En vigueur, prix_min=100000)
• "duplex vendus dans Joliette 14 derniers jours"
  → chercher_comparables(type=Propriété à revenus, muni=Joliette, statut=Vendu, jours=14)
• "plain pied vendus dans Chertsey"
  → chercher_comparables(type=Unifamiliale, sous_type=Plain-pied, muni=Chertsey, statut=Vendu)

═══ ENVOI FICHE D'UN LISTING À UN CLIENT (PRIORITÉ ABSOLUE) ═══
TOUJOURS utiliser \`envoyer_fiche_centris_native\` en PREMIER quand demande:
• "envoie la fiche du #X à client@email.com"
• "envoie le PDF du listing #X à Y"
• "envoie le détaillé client de #X"

Ce flow utilise l'UI Matrix natif (Imprimer → Detaillé client avec album photos
→ Envoyer par courriel) qui produit le VRAI PDF officiel Centris avec photos HD
et signature Shawn intégrée. Sender authentifié shawn@signaturesb.com via Centris.

Fallback SEULEMENT si native échoue:
1. \`telecharger_fiche_centris\` (HTTP + CUA)
2. Envoi lien public Centris.ca

JAMAIS utiliser \`telecharger_fiche_centris\` en premier choix pour un envoi
client — le PDF natif Matrix est toujours supérieur (qualité, signature, photos).

═══ DEUX TYPES DE RAPPORTS COMPARABLES ═══

[1] VENDUS (comparables): propriétés récemment vendues
→ chercher_comparables(type, ville, jours)
→ envoyer_rapport_comparables(type, ville, jours, email, statut="vendu")

[2] EN VIGUEUR (actifs): listings actuellement à vendre
→ proprietes_en_vigueur(type, ville)
→ envoyer_rapport_comparables(type, ville, email, statut="actif")

SOUS-ENTENDUS → ACTIONS:
• "comparables terrains Sainte-Julienne 14 jours" → chercher_comparables(terrain, Sainte-Julienne, 14)
• "envoie-moi les terrains vendus depuis 2 semaines à Rawdon à [email]" → envoyer_rapport_comparables(terrain, Rawdon, 14, email)
• "terrains actifs à vendre à Chertsey" → proprietes_en_vigueur(terrain, Chertsey)
• "envoie rapport en vigueur Rawdon à shawn@signaturesb.com" → envoyer_rapport_comparables(terrain, Rawdon, email, statut=actif)

RAPPORT EMAIL:
• Template Signature SB officiel (logos base64 depuis Dropbox)
• Fond #0a0a0a · Rouge #aa0721 · Typographie officielle
• Tableau: adresse · Centris# · prix · superficie · $/pi² · date
• Stats: nb propriétés · prix moyen · fourchette · superficie moy.
• Envoyé via Gmail avec BCC à shawn@signaturesb.com

VILLES: Rawdon, Sainte-Julienne, Chertsey, Saint-Didace, Sainte-Marcelline, Saint-Jean-de-Matha, Saint-Calixte, Joliette, Repentigny, Montréal, Laval...
TYPES: terrain, maison, plex, duplex, triplex, condo, bungalow

════ CAPACITÉS ════
Tu es Kira, assistante de Shawn. Utilise toutes tes capacités:
• Vision native: analyse photos et PDFs directement — pas besoin d'outil intermédiaire
• Raisonnement: /penser pour réflexion profonde (stratégie, prix, négociation)
• Contexte long: tu retiens toute la conversation — référence les échanges précédents
• Outils parallèles: quand plusieurs outils peuvent tourner en même temps, ils tournent en même temps
• Décision directe: déduis l'action la plus probable et exécute — demande confirmation seulement pour actions irréversibles (envoi email, marquer perdu)

FORMAT DE RÉPONSE OPTIMAL:
• Confirmation action: 1 ligne max — "✅ Deal créé: Jean Tremblay — Terrain | ID: 12345"
• Résultats (pipeline, prospect): données complètes sans introduction inutile
• Analyse (marché, stratégie): structure claire, chiffres en gras, conclusion actionnable
• Erreur: cause précise + action corrective en 1 ligne
• Jamais: "Bien sûr!", "Je vais maintenant", "Voici les résultats de ma recherche"

════ FONCTIONNALITÉS DÉJÀ INTÉGRÉES — NE JAMAIS DUPLIQUER ════
Le bot (bot.js) a DÉJÀ ces features pleinement fonctionnelles. Ne PROPOSE PAS de
créer de nouveaux fichiers/outils pour ça — dis simplement "c'est déjà là":

🔹 Gmail Lead Poller auto (scan 5min): detectLeadSource + isJunkLeadEmail + parseLeadEmail
   + parseLeadEmailWithAI (Haiku fallback) + dédup 7j multi-clé persistée Gist
🔹 traiterNouveauLead(): Gmail→parse→match Dropbox→creerDeal Pipedrive→envoyerDocsAuto
🔹 matchDropboxAvance(): 4 stratégies match Centris#/adresse/rue/fuzzy
🔹 creerDeal(): Pipedrive avec dédup smart (email→tel→nom) + UPDATE auto si infos manquent
🔹 envoyerDocsAuto() avec seuils 90/80: ≥90 auto, 80-89 attend "envoie", <80 brouillon
🔹 Commandes Telegram: /checkemail, /forcelead <id>, /baseline, /pending, /cout,
   /pauseauto, /opus, /sonnet, /haiku, /fable (top-tier 2× coût), envoie les docs à X, annule X
🔹 Webhook auto-heal Telegram (check toutes 2min + escalation Brevo fallback)
🔹 Cost tracker avec alertes $10/jour et $100/mois
🔹 Autres: consent required, dédup leads 7j persistée Gist, audit log, baseline silent
   au boot, 11 couches sécurité, rotation Render API key script

RÈGLE: Si Shawn demande une feature qui existe, CONFIRME simplement que c'est déjà
active. NE CRÉE JAMAIS email_lead_tool.js, PATCH_*.md, ou autre fichier duplicatif.

═══════════════════════════════════════════════════════════════════════════════
COMPUTER USE AGENT (CUA) — INSTRUCTIONS CENTRIS / SIGNATURE SB
═══════════════════════════════════════════════════════════════════════════════
Quand tu utilises les tools Centris (envoyer_fiche_centris_native,
envoyer_tous_documents_zone, verifier_listing_centris, telecharger_annexes_centris,
telecharger_fiche_centris, recherche_comparables) tu agis comme un Computer Use
Agent autonome pour Shawn (RE/MAX PRESTIGE, code agent 110509).

CONTRAINTES ABSOLUES (non négociables):
• shawn@signaturesb.com TOUJOURS en Cc sur tout envoi client (déjà default).
• Credentials uniquement env vars (CENTRIS_USER/PASS/TOTP_SECRET). Jamais loggés.
• LECTURE + ENVOI seulement. Jamais modifier/supprimer listing ou doc Centris.
• VÉRIFIER (sortie tool) confirmation envoi avant de déclarer succès à Shawn.

GESTION D'ERREURS (non négociable):
• Listing introuvable → vérifier format # (7-9 chiffres) + statut En vigueur
• Session expirée → re-login auto déjà câblé (TOTP→SMS→Email Gmail cascade)
• Bot detection → escalade Browserless stealth (rebrowser-playwright)
• JAMAIS de succès simulé. ÉCHEC = cause technique précise + suggestion fix.

WORKFLOW AVANT ENVOI (préférer dry-run):
1. Sur "envoie docs/fiche #N" → SUGGÈRE d'abord verifier_listing_centris pour
   confirmer courtier inscripteur + liste docs (zéro envoi, ~30s)
2. Shawn valide → envoyer_tous_documents_zone ou envoyer_fiche_centris_native
3. Toujours retourner: nb docs envoyés + courtier source + email destinataire

FORMAT RAPPORT (ce que tu dis à Shawn après tool call):
✅ SUCCÈS: "X docs Centris #N partagés à email@X via courtier {nom} ({agence})"
❌ ÉCHEC: cause technique + prochaine action ("MFA bloqué → /admin/centris-mfa-code"
   ou "Listing inexistant → vérifier # ou status")

JAMAIS de "on revient là-dessus" ni de succès simulé. Pas de demi-mesure.`; }

// SYSTEM_BASE est buildé au démarrage (valeurs AGENT résolues)
const SYSTEM_BASE = buildSystemBase();

let dropboxStructure = '';
let dropboxTerrains  = []; // cache des dossiers terrain — pour lookup rapide
let mailingPlanCache = null; // cache du calendrier campagnes Brevo (refresh 1h)

// ─── Mailing plan — fetch Brevo + format pour system prompt ─────────────
async function refreshMailingPlan() {
  if (!BREVO_KEY) return;
  try {
    const [susp, queued, sent] = await Promise.all([
      fetch('https://api.brevo.com/v3/emailCampaigns?status=suspended&limit=50', { headers: { 'api-key': BREVO_KEY }}).then(r => r.json()).catch(() => ({})),
      fetch('https://api.brevo.com/v3/emailCampaigns?status=queued&limit=50', { headers: { 'api-key': BREVO_KEY }}).then(r => r.json()).catch(() => ({})),
      fetch('https://api.brevo.com/v3/emailCampaigns?status=sent&limit=10', { headers: { 'api-key': BREVO_KEY }}).then(r => r.json()).catch(() => ({})),
    ]);
    const suspended = (susp.campaigns || []).filter(c => /\[AUTO\]|\[REENG\]|\[TERRAINS\]/.test(c.name || ''));
    const queue = (queued.campaigns || []).filter(c => /\[AUTO\]|\[REENG\]|\[TERRAINS\]/.test(c.name || ''));
    const recent = (sent.campaigns || []).filter(c => /\[AUTO\]|\[REENG\]|\[TERRAINS\]/.test(c.name || ''));
    const all = [...suspended.map(c => ({ ...c, _state: 'suspended' })), ...queue.map(c => ({ ...c, _state: 'queued' }))];
    all.sort((a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0));

    let text = '━━ MAILING PLAN — calendrier campagnes Brevo (live) ━━\n';
    text += `Système: 8 campagnes mai-juin 2026 · Liste protection #10 (auto-excl bounces/désabos/quota 2 emails/30j)\n`;
    text += `Confirmation: chaque veille 18-23h → notif Telegram + email APERÇU à shawn@\n`;
    text += `Tu confirmes via /campaigns Telegram (boutons inline) → bot fait PUT scheduledAt → Brevo respecte la date 10h le lendemain.\n\n`;
    if (all.length === 0) {
      text += '⚠️ Pipeline VIDE — toutes les campagnes envoyées. Temps de planifier le prochain cycle (monthly_review 1er du mois).\n';
    } else {
      text += `📋 ${all.length} campagne(s) à venir:\n`;
      for (const c of all.slice(0, 12)) {
        const date = c.scheduledAt ? new Date(c.scheduledAt).toLocaleDateString('fr-CA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'America/Toronto' }) : '?';
        const seg = (c.name || '').match(/\[(?:AUTO|REENG|TERRAINS)\]\s*([^·\d][^·]*)/i)?.[1]?.trim() || '?';
        const state = c._state === 'queued' ? '✅ confirmée' : '⏸ à confirmer';
        text += `  • #${c.id} ${seg} · ${date} 10h · ${state}\n    ${(c.subject || '').substring(0, 70)}\n`;
      }
    }
    if (recent.length > 0) {
      text += `\n📤 Récentes envoyées (réf):\n`;
      for (const c of recent.slice(0, 3)) {
        const date = c.scheduledAt ? new Date(c.scheduledAt).toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' }) : '?';
        text += `  ✓ #${c.id} ${(c.name || '').replace(/\[AUTO\]\s*/, '').substring(0, 50)} (${date})\n`;
      }
    }
    text += `\nQuand Shawn demande "où on est rendu" / "prochaine campagne" / "qu'est-ce qui s'en vient" — utiliser cette info, pas hallucinations.`;
    mailingPlanCache = { text, refreshedAt: Date.now() };
    log('OK', 'MAILING', `Plan refreshed: ${all.length} pending · ${recent.length} récentes`);
  } catch (e) {
    log('WARN', 'MAILING', `refreshMailingPlan: ${e.message}`);
  }
}
let sessionLiveContext = ''; // SESSION_LIVE.md depuis GitHub (sync Claude Code ↔ bot)

// Log d'activité du bot — écrit dans BOT_ACTIVITY.md toutes les 10 min
const botActivityLog = [];
function logActivity(event) {
  botActivityLog.push({ ts: Date.now(), event: event.substring(0, 200) });
  if (botActivityLog.length > 100) botActivityLog.shift();
}

// Partie dynamique (Dropbox + mémoire + session live) — change fréquemment, jamais cachée
function getSystemDynamic() {
  const parts = [];

  // ━━ MARCHÉ IMMOBILIER QC — DONNÉES FRAÎCHES (auto-inject Shawn) ━━━━━━━━━
  // Le bot a accès aux taux + stats les plus récents sans Shawn devoir demander
  try {
    const mi = require('./market_intelligence');
    const digest = mi.buildMarketDigest();
    if (digest && digest.sources_count > 0) {
      const lines = [`━━ DONNÉES MARCHÉ FRAÎCHES (auto, age ${digest.age_hours||0}h, ${digest.sources_count} sources) ━━`];
      const fmt$ = (n) => n ? '$' + Math.round(n).toLocaleString('fr-CA').replace(/,/g, ' ') : null;
      // Taux
      if (digest.taux_directeur != null) lines.push(`💰 Banque du Canada — taux directeur: ${digest.taux_directeur}%`);
      if (digest.hypotheque_fixe_5ans != null) lines.push(`🏠 Hypothèque fixe 5 ans: ${digest.hypotheque_fixe_5ans}%`);
      if (digest.hypotheque_variable_5ans != null) lines.push(`📊 Hypothèque variable 5 ans: ${digest.hypotheque_variable_5ans}%`);
      // Prix médians
      if (digest.apciq_prix_median_unifamiliale) lines.push(`🏡 APCIQ prix médian unifamiliale QC: ${fmt$(digest.apciq_prix_median_unifamiliale)}`);
      if (digest.apciq_prix_median_copro) lines.push(`🏢 APCIQ prix médian copropriété QC: ${fmt$(digest.apciq_prix_median_copro)}`);
      if (digest.lanaudiere_prix_median) lines.push(`🌲 Lanaudière prix médian: ${fmt$(digest.lanaudiere_prix_median)}`);
      // Variations
      if (digest.apciq_ventes_variation != null) lines.push(`📈 APCIQ ventes vs an passé: ${digest.apciq_ventes_variation > 0 ? '+' : ''}${digest.apciq_ventes_variation}%`);
      if (digest.apciq_prix_variation != null) lines.push(`💹 APCIQ prix vs an passé: ${digest.apciq_prix_variation > 0 ? '+' : ''}${digest.apciq_prix_variation}%`);
      // News
      if (digest.oaciq_articles?.length) lines.push(`📜 OACIQ nouveautés: ${digest.oaciq_articles.slice(0, 3).join(' | ')}`);
      if (digest.remax_articles?.length) lines.push(`📰 RE/MAX articles récents: ${digest.remax_articles.slice(0, 2).join(' | ')}`);
      lines.push(`Sources actives: ${digest.sources_list?.join(', ')}`);
      lines.push(`USAGE: Quand tu rédiges un email client ou expliques le marché, cite ces chiffres récents.`);
      parts.push(lines.join('\n'));
    }
  } catch {}

  // ━━ DATE & HEURE — INJECTÉ À CHAQUE REQUÊTE (PAS CACHÉ) ━━
  // Bug fix 2026-04-25: SYSTEM_BASE est caché par Anthropic prompt caching.
  // Si on y mettait la date au boot, Claude verrait toujours la date du
  // dernier reboot (potentiellement 2 jours en arrière). C'est pourquoi
  // les dates dans Pipedrive étaient fausses — Claude devinait à partir
  // de ses données training (2024) ou d'une date périmée du boot.
  const TZ = 'America/Toronto';
  const now = new Date();
  const dateLong = now.toLocaleDateString('fr-CA', { timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const dateISO = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const timeShort = now.toLocaleTimeString('fr-CA', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  const dayName = now.toLocaleDateString('fr-CA', { timeZone: TZ, weekday: 'long' });
  // Calculs jours relatifs prêts pour Claude
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowISO = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
  parts.push(
    `━━ DATE & HEURE ACTUELLES (impératif — pour outils Pipedrive) ━━\n` +
    `📅 Aujourd'hui: ${dateLong} (ISO: ${dateISO})\n` +
    `🕐 Heure: ${timeShort} ${TZ}\n` +
    `📆 Demain: ${tomorrowISO}\n` +
    `\n` +
    `RÈGLE ABSOLUE: les outils planifier_visite / creer_activite EXIGENT format ISO:\n` +
    `  • due_date: YYYY-MM-DD (ex: ${tomorrowISO})\n` +
    `  • due_time: HH:MM (ex: 14:00) — NE JAMAIS fournir sauf si Shawn demande explicitement une heure\n` +
    `Calculer "demain", "vendredi prochain", "dans 3 jours" À PARTIR DE ${dateISO}.\n` +
    `JAMAIS deviner l'année — utiliser ${dateISO.substring(0, 4)}.\n` +
    `RÈGLE HEURE: Pas d'heure par défaut. Si Shawn ne mentionne pas une heure spécifique, NE PAS passer le param 'heure' aux outils.`
  );

  // ━━ DÉTECTION AUTO RÉSUMÉ D'APPEL ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  parts.push(
    `━━ DÉTECTION RÉSUMÉ D'APPEL (impératif — vocal Telegram) ━━\n` +
    `Si le message utilisateur (transcription vocale OU texte) ressemble à un compte-rendu d'appel téléphonique avec un client, tu DOIS appeler l'outil enregistrer_resume_appel({transcription: "<texte complet>"}) AUTOMATIQUEMENT, sans demander confirmation.\n\n` +
    `Patterns déclencheurs:\n` +
    `• "j'ai parlé avec [Nom]" / "viens de parler à [Nom]"\n` +
    `• "[Nom] vient d'appeler" / "[Nom] m'a appelé"\n` +
    `• "rappel de [Nom]" / "discussion avec [Nom]"\n` +
    `• "[Nom] est intéressé par X" / "[Nom] veut visiter"\n` +
    `• "résumé d'appel" / "compte-rendu"\n` +
    `• Tout vocal décrivant les détails d'une conversation client (engagement, budget, prochaine étape, objections)\n\n` +
    `Passe la transcription COMPLÈTE telle quelle dans le param transcription. L'outil:\n` +
    `1. Extrait infos via Haiku (nom, tel, budget, engagement, etc)\n` +
    `2. Cherche client existant Pipedrive (nom→tel→Centris→prénom)\n` +
    `3. NOUVEAU client → crée deal + note + activité (date du jour)\n` +
    `4. CLIENT EXISTANT → ajoute note seulement (règle 1-activité-par-deal)\n` +
    `5. Pas de nom extrait → renvoie résumé sur Telegram pour attribution manuelle\n\n` +
    `NE PAS appeler chercher_prospect ou creer_deal manuellement — l'outil gère tout.`
  );

  if (dropboxStructure) parts.push(`━━ DROPBOX — Structure actuelle:\n${dropboxStructure}`);

  // ━━ MAILING PLAN — campagnes en queue (refresh 1h) ━━━━━━━━━━━━━━━━━━━━━
  if (mailingPlanCache?.text) {
    parts.push(mailingPlanCache.text);
  }

  if (sessionLiveContext) {
    // Tronquer à 3000 chars pour rester raisonnable en tokens
    const trunc = sessionLiveContext.length > 3000 ? sessionLiveContext.substring(0, 3000) + '\n...[tronqué]' : sessionLiveContext;
    parts.push(`━━ SESSION CLAUDE CODE ↔ BOT (sync temps réel):\n${trunc}`);
  }
  const mem = buildMemoryBlock().trim();
  if (mem) parts.push(mem);
  return parts.join('\n\n');
}

// Retro-compat (utilisé par callClaudeVision qui n'a pas été refactorisé)
function getSystem() {
  const dyn = getSystemDynamic();
  return dyn ? SYSTEM_BASE + '\n\n' + dyn : SYSTEM_BASE;
}

// ─── Mémoire longue durée — 500 msgs window + Gist backup + Sonnet summary + auto-facts ──
// Shawn veut que le bot se rappelle de TOUT. Quatre couches:
// 1. Window live: MAX_HIST=500 messages (prompt caching → cost contenu)
// 2. Auto-summary Sonnet: quand on dépasse SUMMARY_AT=600, les ~300 plus vieux
//    sont résumés par Sonnet 4.6 (intelligence supérieure vs Haiku) et compactés
// 3. Gist backup: sauvé toutes les 30s après modif → survit aux redeploys Render
// 4. Auto-facts: après chaque échange significatif, Haiku extrait les faits
//    durables (prospect mentionné, email envoyé, config demandée) → kiramem
const MAX_HIST = parseInt(process.env.MAX_HIST || '500');
const SUMMARY_AT = parseInt(process.env.SUMMARY_AT || '600');
const SUMMARY_KEEP = parseInt(process.env.SUMMARY_KEEP || '300'); // garder les 300 plus récents quand on résume
const rawChats = loadJSON(HIST_FILE, {});
const chats    = new Map(Object.entries(rawChats));
for (const [id, hist] of chats.entries()) {
  if (!Array.isArray(hist) || hist.length === 0) chats.delete(id);
}
let saveTimer = null, gistSaveTimer = null;
function scheduleHistSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJSON(HIST_FILE, Object.fromEntries(chats)), 1000);
  // Backup Gist débounce 30s (survit redeploys Render)
  if (gistSaveTimer) clearTimeout(gistSaveTimer);
  gistSaveTimer = setTimeout(() => saveHistoryToGist().catch(() => {}), 30000);
}
function getHistory(id) { if (!chats.has(id)) chats.set(id, []); return chats.get(id); }
function addMsg(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);
  scheduleHistSave();
  // Trigger summary si on dépasse le seuil (fire-and-forget, ne bloque pas)
  if (h.length > SUMMARY_AT) summarizeOldHistory(id).catch(() => {});
  // Extraction auto de faits durables après chaque message assistant (fire-and-forget)
  // Regroupe les derniers échanges user+assistant pour contexte
  if (role === 'assistant' && h.length >= 2 && typeof content === 'string' && content.length > 50) {
    extractDurableFacts(id, h).catch(() => {});
  }
}

// Gist backup/restore — survit aux redeploys Render (disque /data volatil)
async function saveHistoryToGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const payload = { savedAt: new Date().toISOString(), chats: Object.fromEntries(chats) };
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { 'history.json': { content: JSON.stringify(payload, null, 2) } } })
    });
    if (!res.ok) log('WARN', 'GIST', `Save history HTTP ${res.status}`);
  } catch (e) { log('WARN', 'GIST', `Save history: ${e.message}`); }
}
async function loadHistoryFromGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers: githubHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const content = data.files?.['history.json']?.content;
    if (!content) return;
    const parsed = JSON.parse(content);
    if (!parsed.chats) return;
    // Ne restaure que si le local est plus vide (pas de clobber — disk prioritaire)
    const localTotal = [...chats.values()].reduce((s, h) => s + h.length, 0);
    const gistTotal = Object.values(parsed.chats).reduce((s, h) => s + (h?.length || 0), 0);
    if (localTotal === 0 && gistTotal > 0) {
      for (const [id, h] of Object.entries(parsed.chats)) {
        if (Array.isArray(h) && h.length > 0) chats.set(id, h);
      }
      saveJSON(HIST_FILE, Object.fromEntries(chats));
      log('OK', 'GIST', `History restauré depuis Gist: ${gistTotal} messages sur ${Object.keys(parsed.chats).length} chats (dernière save: ${parsed.savedAt})`);
    } else if (gistTotal > 0) {
      log('INFO', 'GIST', `History disque: ${localTotal} msgs · Gist: ${gistTotal} msgs — garde le disque`);
    }
  } catch (e) { log('WARN', 'GIST', `Load history: ${e.message}`); }
}

// Résume les vieux messages via SONNET 4.6 (intelligence supérieure vs Haiku)
// — compacte en 1 seul message "[CONTEXTE_ANTÉRIEUR_RÉSUMÉ]" structuré en sections
let _summaryInFlight = new Set();
async function summarizeOldHistory(chatId) {
  if (!API_KEY || _summaryInFlight.has(chatId)) return;
  _summaryInFlight.add(chatId);
  try {
    const h = getHistory(chatId);
    if (h.length <= SUMMARY_AT) return;
    const first = h[0];
    const alreadyHasSummary = first?.role === 'user' && typeof first.content === 'string'
      && first.content.startsWith('[CONTEXTE_ANTÉRIEUR_RÉSUMÉ]');
    const toCompact = h.slice(0, h.length - SUMMARY_KEEP);
    if (!toCompact.length) return;

    const asText = toCompact.map(m => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content).substring(0, 400);
      return `${m.role === 'user' ? AGENT.prenom : 'Bot'}: ${c.substring(0, 800)}`;
    }).join('\n').substring(0, 32000);

    const prompt = `Conversation entre Shawn Barrette (courtier RE/MAX PRESTIGE, shawn@signaturesb.com) et son assistant IA. Produis un RÉSUMÉ DENSE STRUCTURÉ en français organisé par sections (max 800 mots total).

STRUCTURE OBLIGATOIRE:
## Prospects & clients
Pour chaque personne mentionnée: nom, coordonnées (tel/email/Centris#), statut (nouveau/visité/offre/gagné/perdu), dossier Dropbox associé, dernière action.

## Actions & envois
Documents envoyés (à qui, quoi, quand). Emails rédigés. Deals Pipedrive créés/modifiés. Rendez-vous planifiés.

## Configurations & préférences
Paramétrages demandés par Shawn (env vars, comportements bot, templates). Règles absolues mentionnées (ex: "toujours CC shawn@").

## Problèmes résolus
Bugs trouvés + fix appliqués. Commits récents importants avec leur impact.

## En cours / à faire
Tâches non complétées, items "sur glace", prochaines étapes.

Ignorer les "ok", "merci", confirmations simples. Priorité aux INFOS DURABLES pour la suite.

HISTORIQUE:
${asText}

Résumé structuré:`;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(t);
    if (!res.ok) { log('WARN', 'SUMMARY', `HTTP ${res.status}`); return; }
    const data = await res.json();
    const sumTxt = data.content?.[0]?.text?.trim() || '';
    if (!sumTxt) return;

    const previousSummary = alreadyHasSummary
      ? first.content.replace(/^\[CONTEXTE_ANTÉRIEUR_RÉSUMÉ\]\n?/, '').replace(/\n?\[FIN_RÉSUMÉ\]$/, '')
      : '';
    const mergedSummary = previousSummary
      ? `${previousSummary}\n\n--- Mise à jour (${new Date().toLocaleDateString('fr-CA')}) ---\n${sumTxt}`
      : sumTxt;

    const newFirst = {
      role: 'user',
      content: `[CONTEXTE_ANTÉRIEUR_RÉSUMÉ]\n${mergedSummary}\n[FIN_RÉSUMÉ]`
    };
    const tail = h.slice(h.length - SUMMARY_KEEP);
    h.length = 0;
    h.push(newFirst, ...tail);
    scheduleHistSave();
    log('OK', 'SUMMARY', `Sonnet: ${toCompact.length} msgs → résumé ${sumTxt.length}c pour chat ${chatId}`);
  } catch (e) {
    log('WARN', 'SUMMARY', `Exception: ${e.message}`);
  } finally {
    _summaryInFlight.delete(chatId);
  }
}

// Extraction AUTO de faits durables après chaque échange significatif.
// Utilise Haiku (rapide, peu cher) pour identifier: prospects, emails, Centris#,
// adresses, décisions, configs. Faits appendés à kiramem.facts (dédup).
let _factExtractInFlight = new Set();
let _lastFactExtractAt = 0;
async function extractDurableFacts(chatId, history) {
  // Throttle: max 1 extraction par 20s (évite spam API)
  const now = Date.now();
  if (now - _lastFactExtractAt < 20000) return;
  if (!API_KEY || _factExtractInFlight.has(chatId)) return;
  _factExtractInFlight.add(chatId);
  _lastFactExtractAt = now;

  try {
    // Prendre les 6 derniers messages pour contexte (3 échanges user+assistant)
    const recent = history.slice(-6);
    const asText = recent.map(m => {
      const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content).substring(0, 300);
      return `${m.role === 'user' ? AGENT.prenom : 'Bot'}: ${c.substring(0, 600)}`;
    }).join('\n').substring(0, 6000);

    const prompt = `Dans cet échange récent entre Shawn (courtier RE/MAX Lanaudière) et son bot, extrais les FAITS STRATÉGIQUES qui peuvent augmenter ses ventes futures. Préfixe chaque fait avec sa CATÉGORIE entre crochets.

Catégories possibles (utilise le tag exact):
- [CLIENT] Préférences/comportement d'un prospect/acheteur (ex: "Jean Tremblay préfère terrains avec puits, budget 200K")
- [PARTENAIRE] Info sur partenaire/courtier collègue/inspecteur (ex: "Inspecteur Dupuis 514-555 disponible weekends")
- [MARCHE] Tendance/donnée marché Lanaudière observée (ex: "Terrains Rawdon <1 acre se vendent en <30j en 2026")
- [VENTE] Pattern qui a converti (ex: "Argument financement ProFab a fermé le deal Tremblay")
- [PROPRIETE] Spécificité d'une inscription (ex: "Centris #X a problème puits identifié, baisser prix de 5K")
- [STRATEGIE] Décision/préférence Shawn pour le bot ("toujours envoyer fiche détaillée en premier")
- [REFERENCE] Lien entre clients (ex: "Marie Dubois a référé Sophie L. — terrain Chertsey")

PAS de faits:
- Conversations courtoises, confirmations "ok", "merci"
- Infos évidentes (Shawn est courtier RE/MAX)
- Détails techniques bot transitoires
- Activité simple sans insight (ex: "deal X créé")

ÉCHANGE:
${asText}

Max 5 faits stratégiques, chacun ≤180 chars (avec catégorie).
Retourne UNIQUEMENT un JSON array: ["[CLIENT] fait 1", "[MARCHE] fait 2", ...] ou [] si rien à retenir.`;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(t);
    if (!res.ok) return;
    const data = await res.json();
    const txt = data.content?.[0]?.text?.trim() || '';
    const jsonMatch = txt.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return;
    let facts;
    try { facts = JSON.parse(jsonMatch[0]); } catch { return; }
    if (!Array.isArray(facts) || facts.length === 0) return;

    // Dédup contre kiramem.facts (lowercase substring)
    const existing = new Set((kiramem.facts || []).map(f => f.toLowerCase().substring(0, 50)));
    const added = [];
    for (const fact of facts) {
      if (typeof fact !== 'string' || !fact.trim() || fact.length > 200) continue;
      const key = fact.toLowerCase().substring(0, 50);
      if (existing.has(key)) continue;
      kiramem.facts.push(`[auto ${new Date().toLocaleDateString('fr-CA')}] ${fact.trim()}`);
      existing.add(key);
      added.push(fact);
    }
    if (added.length > 0) {
      // Cap à 200 faits (garde les plus récents) — augmenté pour mémoire stratégique catégorisée
      if (kiramem.facts.length > 200) kiramem.facts.splice(0, kiramem.facts.length - 200);
      kiramem.updatedAt = new Date().toISOString();
      saveJSON(MEM_FILE, kiramem);
      saveMemoryToGist().catch(() => {});
      log('OK', 'AUTO_FACTS', `+${added.length} fait(s): ${added.map(f => f.substring(0, 60)).join(' | ')}`);
    }
  } catch (e) {
    log('WARN', 'AUTO_FACTS', `Exception: ${e.message}`);
  } finally {
    _factExtractInFlight.delete(chatId);
  }
}

// ─── Validation messages pour API Claude (prévient erreurs 400) ──────────────
// Garantit: premier msg = user, alternance user/assistant correcte, dernier = user
function validateMessagesForAPI(messages) {
  if (!messages || !messages.length) return [];
  const clean = [];
  for (const m of messages) {
    if (!m?.role || !m?.content) continue;
    if (Array.isArray(m.content) && m.content.length === 0) continue;
    if (typeof m.content === 'string' && !m.content.trim()) continue;
    // Empêcher deux messages de même rôle consécutifs (fusionner ou skipper)
    if (clean.length && clean[clean.length - 1].role === m.role) {
      // Même rôle consécutif — garder seulement le plus récent
      clean[clean.length - 1] = m;
    } else {
      clean.push(m);
    }
  }
  // Supprimer les assistant en tête (le premier doit être user)
  while (clean.length && clean[0].role !== 'user') clean.shift();
  // Supprimer les assistant en queue (le dernier doit être user pour éviter prefilling)
  while (clean.length && clean[clean.length - 1].role !== 'user') clean.pop();
  return clean;
}

// Rate limiter pour éviter 429 — max N requêtes par fenêtre
const rateLimiter = { recent: [], max: 15, windowMs: 60000 };
function checkRateLimit() {
  const now = Date.now();
  rateLimiter.recent = rateLimiter.recent.filter(t => now - t < rateLimiter.windowMs);
  if (rateLimiter.recent.length >= rateLimiter.max) return false;
  rateLimiter.recent.push(now);
  return true;
}

// Transforme les erreurs API en messages lisibles pour l'utilisateur
// + déclenche alerte proactive Telegram à Shawn pour les erreurs admin-actionables
const apiErrorState = { lastCreditAlert: 0, lastAuthAlert: 0 };
function notifyShawnOnce(key, text, cooldownMs = 30 * 60 * 1000) {
  const now = Date.now();
  if (now - (apiErrorState[key] || 0) < cooldownMs) return;
  apiErrorState[key] = now;
  if (!ALLOWED_ID || typeof bot?.sendMessage !== 'function') return;
  bot.sendMessage(ALLOWED_ID, text, { parse_mode: 'Markdown', disable_web_page_preview: false }).catch(() => {
    bot.sendMessage(ALLOWED_ID, text.replace(/[*_`]/g, '')).catch(() => {});
  });
}
function formatAPIError(err) {
  const status = err?.status || err?.response?.status;
  const msg    = err?.message || String(err);
  const lower  = msg.toLowerCase();

  // Erreurs Anthropic critiques admin-actionables — alerte proactive Shawn
  if (/credit\s*balance|billing|insufficient\s*credit|out\s*of\s*credit/i.test(msg)) {
    notifyShawnOnce('lastCreditAlert',
      `🚨 *Anthropic — crédit épuisé ou mauvais workspace*\n\n` +
      `Le bot ne peut pas appeler Claude. 2 causes possibles:\n\n` +
      `*1. Crédit vraiment épuisé*\n` +
      `→ https://console.anthropic.com/settings/billing\n` +
      `Buy credits + active Auto-reload à 10$\n\n` +
      `*2. Clé API dans un AUTRE workspace que le crédit* (fréquent)\n` +
      `→ https://console.anthropic.com/settings/keys\n` +
      `Vérifie le workspace de la clé active. Puis sur billing,\n` +
      `vérifie que le crédit est sur LE MÊME workspace (sélecteur\n` +
      `en haut de la page).\n\n` +
      `*Fix rapide workspace:* crée une nouvelle clé dans le workspace\n` +
      `qui a du crédit → mets-la dans .env → \`npm run sync-env\`.\n\n` +
      `Le bot reprend dans la seconde après fix (aucun redeploy).`
    );
    return '💳 Crédit Anthropic indisponible. Shawn notifié — vérifier workspace à console.anthropic.com/settings/billing.';
  }
  if (/invalid[\s_-]?api[\s_-]?key|authentication[\s_-]?error|invalid[\s_-]?authentication/i.test(msg) || status === 401) {
    notifyShawnOnce('lastAuthAlert',
      `🚨 *Anthropic — clé API invalide*\n\n` +
      `ANTHROPIC_API_KEY rejetée (révoquée ou erronée). Action:\n` +
      `1. Nouvelle clé: https://console.anthropic.com/settings/keys\n` +
      `2. Mettre dans .env local\n` +
      `3. \`npm run sync-env\` → Render redéploie auto`
    );
    return '🔑 Clé Claude invalide/révoquée. Shawn notifié.';
  }
  if (status === 400) {
    const toolMatch = msg.match(/tools\.(\d+)\.custom\.name.*?pattern/);
    if (toolMatch) {
      const idx = parseInt(toolMatch[1]);
      return `🚨 Config bot cassée — tool #${idx} nom invalide (regex [a-zA-Z0-9_-] violée).`;
    }
    if (msg.includes('prefill') || msg.includes('prepend')) return '⚠️ Conversation corrompue — tape /reset puis réessaie.';
    if (msg.includes('max_tokens')) return '⚠️ Requête trop longue — simplifie ou /reset.';
    if (lower.includes('temperature') || lower.includes('top_p') || lower.includes('top_k')) {
      return '🚨 Config bot — temperature/top_p/top_k rejetés par Opus 4.8.';
    }
    return `⚠️ Requête invalide — /reset pour repartir. (${msg.substring(0, 80)})`;
  }
  if (status === 403) return '🚫 Accès refusé.';
  if (status === 429) {
    notifyShawnOnce('lastRateLimit',
      `⏳ *Anthropic — rate limit fréquent*\nVérifier plan: https://console.anthropic.com/settings/limits`,
      60 * 60 * 1000
    );
    return '⏳ Rate limit — patiente 30 sec.';
  }
  if (status === 529 || status >= 500) return '⚠️ Claude temporairement indisponible — réessaie dans une minute.';
  return `⚠️ ${msg.substring(0, 120)}`;
}

// ─── Déduplication (FIFO, pas de fuite mémoire) ──────────────────────────────
const processed = new Map(); // msgId → timestamp
function isDuplicate(msgId) {
  if (processed.has(msgId)) return true;
  processed.set(msgId, Date.now());
  if (processed.size > 2000) {
    // Supprimer les 500 plus anciens
    const keys = Array.from(processed.keys());
    keys.slice(0, 500).forEach(k => processed.delete(k));
  }
  return false;
}

// ─── Extraction mémos (Gist throttlé 5min pour éviter spam API) ──────────────
let lastGistSync = 0;
function extractMemos(text) {
  const memos = [];
  const cleaned = text.replace(/\[MEMO:\s*([^\]]+)\]/gi, (_, fact) => { memos.push(fact.trim()); return ''; }).trim();
  if (memos.length) {
    kiramem.facts.push(...memos);
    if (kiramem.facts.length > 100) kiramem.facts.splice(0, kiramem.facts.length - 100);
    kiramem.updatedAt = new Date().toISOString();
    saveJSON(MEM_FILE, kiramem);
    // Throttle: sync Gist max 1x toutes les 5 minutes
    const now = Date.now();
    if (now - lastGistSync > 5 * 60 * 1000) {
      lastGistSync = now;
      saveMemoryToGist().catch(() => {});
    }
    log('OK', 'MEMO', `${memos.length} fait(s) mémorisé(s) | Gist sync: ${now - lastGistSync < 1000 ? 'immédiat' : 'différé'}`);
  }
  return { cleaned, memos };
}

// ─── GitHub ───────────────────────────────────────────────────────────────────
function githubHeaders() {
  const h = { 'User-Agent': 'Kira-Bot', 'Accept': 'application/vnd.github.v3+json' };
  if (process.env.GITHUB_TOKEN) h['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  return h;
}

// ─── BUG TRACKER AUTO — Crée GitHub Issues automatiquement sur bugs critiques
// Repo cible: signaturesb/kira-bot (lu par Claude Code dans futures sessions)
// Dédup: si même titre déjà OPEN → comment au lieu de créer doublon
// Cache mémoire 1h pour éviter spam même titre dans la même session
const _bugReportCache = new Map(); // title → ts (dédup intra-session)
const BUG_REPORT_REPO = 'kira-bot';

async function reportBug(titre, description, opts = {}) {
  if (!process.env.GITHUB_TOKEN) {
    log('WARN', 'BUG-TRACKER', `reportBug skipped — pas de GITHUB_TOKEN: ${titre}`);
    return null;
  }
  // Dédup intra-session 1h
  const cacheKey = titre.substring(0, 80);
  const lastReport = _bugReportCache.get(cacheKey);
  if (lastReport && Date.now() - lastReport < 60 * 60 * 1000) {
    return null; // déjà reporté <1h
  }
  _bugReportCache.set(cacheKey, Date.now());
  // Cleanup cache si >100 entrées
  if (_bugReportCache.size > 100) {
    const oldest = [...(_bugReportCache.entries())].sort((a, b) => a[1] - b[1])[0][0];
    _bugReportCache.delete(oldest);
  }

  try {
    // 1. Cherche issue OPEN avec même titre (dédup persistent côté GitHub)
    const searchUrl = `https://api.github.com/search/issues?q=${encodeURIComponent(`repo:signaturesb/${BUG_REPORT_REPO} is:issue is:open in:title "${titre.substring(0, 50)}"`)}`;
    const searchRes = await fetch(searchUrl, { headers: githubHeaders(), signal: AbortSignal.timeout(10000) });
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      const existing = searchData.items?.[0];
      if (existing) {
        // Ajoute un commentaire sur l'issue existante (au lieu de créer doublon)
        await fetch(`https://api.github.com/repos/signaturesb/${BUG_REPORT_REPO}/issues/${existing.number}/comments`, {
          method: 'POST',
          headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: `🔁 **Reproduit ${new Date().toISOString()}**\n\n${description.substring(0, 2000)}\n\n_Auto-tracked by bot._`,
          }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => {});
        log('OK', 'BUG-TRACKER', `Commenté issue #${existing.number} (déjà open): ${titre.substring(0, 60)}`);
        return { existing: true, number: existing.number, url: existing.html_url };
      }
    }
    // 2. Crée nouvelle issue
    const createRes = await fetch(`https://api.github.com/repos/signaturesb/${BUG_REPORT_REPO}/issues`, {
      method: 'POST',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: titre.substring(0, 200),
        body: `${description.substring(0, 4000)}\n\n---\n**Auto-tracked** by bot at ${new Date().toISOString()}\nCommit: \`${(process.env.RENDER_GIT_COMMIT || 'unknown').substring(0, 7)}\``,
        labels: opts.labels || ['bug', 'auto-tracked'],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!createRes.ok) {
      log('WARN', 'BUG-TRACKER', `Create fail HTTP ${createRes.status}: ${titre.substring(0, 60)}`);
      return null;
    }
    const newIssue = await createRes.json();
    log('OK', 'BUG-TRACKER', `Issue #${newIssue.number} créée: ${titre.substring(0, 60)}`);
    return { created: true, number: newIssue.number, url: newIssue.html_url };
  } catch (e) {
    log('WARN', 'BUG-TRACKER', `Exception: ${e.message?.substring(0, 100)}`);
    return null;
  }
}
async function listGitHubRepos() {
  const url = process.env.GITHUB_TOKEN
    ? `https://api.github.com/user/repos?per_page=50&sort=updated`
    : `https://api.github.com/users/${GITHUB_USER}/repos?per_page=50&sort=updated`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) return `Erreur GitHub: ${res.status}`;
  const data = await res.json();
  return data.map(r => `${r.private ? '🔒' : '🌐'} ${r.name}${r.description ? ' — ' + r.description : ''}`).join('\n');
}
async function listGitHubFiles(repo, filePath) {
  const p = (filePath || '').replace(/^\//, '');
  const url = `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${p}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) return `Erreur GitHub: ${res.status} — repo "${repo}", path "${filePath}"`;
  const data = await res.json();
  if (Array.isArray(data)) return data.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.name}`).join('\n');
  return JSON.stringify(data).substring(0, 2000);
}
async function readGitHubFile(repo, filePath) {
  const p = filePath.replace(/^\//, '');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${p}`, { headers: githubHeaders() });
  if (!res.ok) return `Erreur GitHub: ${res.status}`;
  const data = await res.json();
  if (data.encoding === 'base64' && data.content) {
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return content.length > 8000 ? content.substring(0, 8000) + '\n...[tronqué]' : content;
  }
  return 'Fichier non textuel ou trop volumineux';
}
async function writeGitHubFile(repo, filePath, content, commitMsg) {
  if (!process.env.GITHUB_TOKEN) return 'Erreur: GITHUB_TOKEN manquant';
  const p = filePath.replace(/^\//, '');
  const url = `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${p}`;
  let sha;
  const getRes = await fetch(url, { headers: githubHeaders() });
  if (getRes.ok) sha = (await getRes.json()).sha;
  else if (getRes.status !== 404) return `Erreur GitHub lecture: ${getRes.status}`;
  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: commitMsg || `Kira: mise à jour ${p}`, content: Buffer.from(content, 'utf8').toString('base64'), ...(sha ? { sha } : {}) })
  });
  if (!putRes.ok) { const err = await putRes.json().catch(() => ({})); return `Erreur GitHub écriture: ${putRes.status} — ${err.message || ''}`; }
  return `✅ "${p}" ${sha ? 'modifié' : 'créé'} dans ${repo}.`;
}

// ─── Sync Claude Code ↔ Bot (bidirectionnelle via GitHub) ────────────────────
// Check BOTH repos (kira-bot historique + bot-assistant nouveau) — prend le plus récent
async function loadSessionLiveContext() {
  if (!process.env.GITHUB_TOKEN) return;
  const repos = ['bot-assistant', 'kira-bot']; // bot-assistant first (où Claude Code pushe maintenant)
  let bestContent = '', bestUpdated = 0, bestRepo = '';
  for (const repo of repos) {
    try {
      const res = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/SESSION_LIVE.md`, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) { log('WARN', 'SYNC', `${repo}/SESSION_LIVE.md HTTP ${res.status}`); continue; }
      const data = await res.json();
      if (!data.content) continue;
      // Get commit date to compare
      const commitRes = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${repo}/commits?path=SESSION_LIVE.md&per_page=1`, {
        headers: githubHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      let updated = 0;
      if (commitRes.ok) {
        const commits = await commitRes.json();
        const date = commits[0]?.commit?.committer?.date;
        if (date) updated = new Date(date).getTime();
      }
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      if (updated > bestUpdated || (!bestUpdated && content.length > bestContent.length)) {
        bestContent = content;
        bestUpdated = updated;
        bestRepo = repo;
      }
    } catch (e) { log('WARN', 'SYNC', `${repo}: ${e.message?.substring(0, 100)}`); }
  }
  if (bestContent) {
    sessionLiveContext = bestContent;
    const age = bestUpdated ? Math.round((Date.now() - bestUpdated) / 3600000) : '?';
    log('OK', 'SYNC', `SESSION_LIVE.md chargé depuis ${bestRepo} (${Math.round(bestContent.length / 1024)}KB, age ${age}h)`);
  }
}

async function writeBotActivity() {
  // PRIVACY: BOT_ACTIVITY.md n'est PLUS publié sur GitHub.
  // Les logs d'activité (contiennent noms clients, Centris#) restent in-memory
  // + accessibles via Telegram. Jamais dans un repo public.
  // Si besoin de consulter: `/activity` command ou logs Render.
  return;
}

// ─── Dropbox (avec refresh auto) ─────────────────────────────────────────────
let dropboxToken = process.env.DROPBOX_ACCESS_TOKEN || '';
// Audit P2 #7: tracker expiry (4h Dropbox) pour pre-emptive refresh
let dropboxTokenExp = 0; // ms epoch
let dropboxRefreshInProgress = null; // mutex pour éviter refresh parallèles
async function refreshDropboxToken() {
  const { DROPBOX_APP_KEY: key, DROPBOX_APP_SECRET: secret, DROPBOX_REFRESH_TOKEN: refresh } = process.env;
  if (!key || !secret || !refresh) {
    log('WARN', 'DROPBOX', `Refresh impossible — vars manquantes: ${!key?'APP_KEY ':''} ${!secret?'APP_SECRET ':''} ${!refresh?'REFRESH_TOKEN':''}`);
    return false;
  }
  try {
    const res = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: key, client_secret: secret })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.status);
      log('ERR', 'DROPBOX', `Refresh HTTP ${res.status}: ${String(err).substring(0, 100)}`);
      return false;
    }
    const data = await res.json();
    if (!data.access_token) { log('ERR', 'DROPBOX', `Refresh: pas de access_token — ${JSON.stringify(data).substring(0,100)}`); return false; }
    dropboxToken = data.access_token;
    // Dropbox tokens vivent ~4h. expires_in en sec — fallback 14000s (3h53m)
    const expiresInSec = parseInt(data.expires_in || '14000');
    dropboxTokenExp = Date.now() + (expiresInSec - 120) * 1000; // -2min safety margin
    log('OK', 'DROPBOX', `Token rafraîchi ✓ (exp dans ${Math.round(expiresInSec/60)}min)`);
    return true;
  } catch (e) { log('ERR', 'DROPBOX', `Refresh exception: ${e.message}`); return false; }
}
async function dropboxAPI(apiUrl, body, isDownload = false) {
  // Pre-emptive refresh si token absent OU expire dans <60s (audit P2 #7)
  if (!dropboxToken || (dropboxTokenExp && Date.now() > dropboxTokenExp - 60000)) {
    // Mutex pour éviter refresh parallèles batch (gros listings → 30 appels parallèles)
    if (dropboxRefreshInProgress) {
      await dropboxRefreshInProgress.catch(() => {});
    } else {
      dropboxRefreshInProgress = (async () => {
        try { await refreshDropboxToken(); } finally { dropboxRefreshInProgress = null; }
      })();
      await dropboxRefreshInProgress;
    }
    if (!dropboxToken) { log('ERR', 'DROPBOX', 'Refresh échoué — Dropbox inaccessible'); return null; }
  }
  // Endpoints sans paramètres (ex: /users/get_current_account) doivent avoir
  // body=null, pas {}. Dropbox retourne 400 sur {} pour ces endpoints.
  const noBodyEndpoints = /\/users\/get_current_account|\/users\/get_space_usage/;
  const isNoBody = noBodyEndpoints.test(apiUrl) || body === null;
  const makeReq = (token) => isDownload
    ? fetch(apiUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify(body) } })
    : isNoBody
      ? fetch(apiUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } })
      : fetch(apiUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let res = await makeReq(dropboxToken);
  if (res.status === 401) {
    log('WARN', 'DROPBOX', 'Token expiré — refresh...');
    const ok = await refreshDropboxToken();
    if (!ok) { log('ERR', 'DROPBOX', 'Re-refresh échoué'); return null; }
    res = await makeReq(dropboxToken);
  }
  return res;
}
// Self-service secret loader: bypasse Render env vars en stockant
// les clés API dans Dropbox /bot-secrets/<KEY>.txt. Bot lit au boot
// et injecte dans process.env. Permet d'ajouter des clés (Firecrawl,
// Perplexity, etc.) sans accès à la console Render.
async function loadDropboxSecrets() {
  if (!dropboxToken) await refreshDropboxToken();
  const res = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: '/bot-secrets', recursive: false });
  if (!res || !res.ok) {
    if (res?.status === 409) log('INFO', 'SECRETS', 'Dossier /bot-secrets absent (normal si jamais utilisé)');
    return 0;
  }
  const data = await res.json();
  const files = (data.entries || []).filter(e => e['.tag'] === 'file' && e.name.endsWith('.txt'));
  let loaded = 0;
  for (const f of files) {
    const key = f.name.replace(/\.txt$/, '');
    if (process.env[key]) continue; // priorité aux env vars Render
    const dl = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: f.path_lower }, true);
    if (dl?.ok) {
      const v = (await dl.text()).trim();
      if (v) { process.env[key] = v; loaded++; log('OK', 'SECRETS', `${key} chargé depuis Dropbox`); }
    }
  }
  return loaded;
}
// Last error for debugging via /admin endpoints
let _lastSecretError = null;
// Local fallback: data/local_secrets.json — persiste sur disque Render (si paid plan)
const LOCAL_SECRETS_FILE = path.join(DATA_DIR, 'local_secrets.json');
function saveLocalSecret(key, value) {
  try {
    const cur = loadJSON(LOCAL_SECRETS_FILE, {});
    cur[key] = value;
    saveJSON(LOCAL_SECRETS_FILE, cur);
    try { require('fs').chmodSync(LOCAL_SECRETS_FILE, 0o600); } catch {}
    return true;
  } catch (e) { _lastSecretError = `local save: ${e.message}`; return false; }
}
function loadLocalSecrets() {
  try {
    const cur = loadJSON(LOCAL_SECRETS_FILE, {});
    let loaded = 0;
    for (const [k, v] of Object.entries(cur)) {
      if (!process.env[k] && v) { process.env[k] = v; loaded++; }
    }
    if (loaded) log('OK', 'SECRETS', `${loaded} clé(s) chargée(s) depuis ${LOCAL_SECRETS_FILE}`);
    return loaded;
  } catch { return 0; }
}
async function uploadDropboxSecret(key, value) {
  _lastSecretError = null;
  // Toujours save local en premier (rapide, fiable)
  const localOk = saveLocalSecret(key, value);
  if (!dropboxToken) await refreshDropboxToken();
  if (!dropboxToken) { _lastSecretError = 'no dropboxToken — local save only'; return localOk; }
  // Ensure folder exists first (idempotent — 409 si existe = OK)
  // Auto-retry sur 401 missing_scope (token cached avec vieux scopes) — refresh + retry
  const tryCreateFolder = async () => fetch('https://api.dropboxapi.com/2/files/create_folder_v2', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${dropboxToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: '/bot-secrets', autorename: false }),
  });
  const tryUpload = async () => fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${dropboxToken}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: `/bot-secrets/${key}.txt`, mode: 'overwrite', autorename: false, mute: true })
    },
    body: Buffer.from(String(value))
  });
  try {
    let fr = await tryCreateFolder();
    if (fr.status === 401) {
      log('WARN', 'SECRETS', `create_folder 401 → refresh token + retry`);
      await refreshDropboxToken();
      fr = await tryCreateFolder();
    }
    if (!fr.ok && fr.status !== 409) {
      const fb = await fr.text().catch(() => '');
      log('WARN', 'SECRETS', `create_folder ${fr.status}: ${fb.substring(0, 150)}`);
    }
  } catch (e) { log('WARN', 'SECRETS', `create_folder exception: ${e.message}`); }
  try {
    let res = await tryUpload();
    if (res.status === 401) {
      log('WARN', 'SECRETS', `upload 401 → refresh token + retry`);
      await refreshDropboxToken();
      res = await tryUpload();
    }
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      _lastSecretError = `Dropbox HTTP ${res.status}: ${errBody.substring(0, 200)} (local saved: ${localOk})`;
      log('WARN', 'SECRETS', `uploadDropboxSecret ${key}: ${_lastSecretError}`);
    } else {
      log('OK', 'SECRETS', `uploadDropboxSecret ${key} → Dropbox /bot-secrets/${key}.txt`);
    }
    return res.ok || localOk;
  } catch (e) {
    _lastSecretError = `Dropbox exception: ${e.message} (local saved: ${localOk})`;
    log('WARN', 'SECRETS', `uploadDropboxSecret ${key}: ${e.message}`);
    return localOk;
  }
}
async function listDropboxFolder(folderPath) {
  const p = folderPath === '' ? '' : ('/' + folderPath.replace(/^\//, ''));
  const res = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: p, recursive: false });
  if (!res || !res.ok) return `Erreur Dropbox: ${res ? res.status : 'connexion échouée'}`;
  const data = await res.json();
  if (!data.entries?.length) return 'Dossier vide';
  return data.entries.map(e => `${e['.tag'] === 'folder' ? '📁' : '📄'} ${e.name}`).join('\n');
}
async function readDropboxFile(filePath) {
  const p = '/' + filePath.replace(/^\//, '');
  const res = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: p }, true);
  if (!res || !res.ok) return `Erreur Dropbox: ${res ? res.status : 'connexion échouée'}`;
  const text = await res.text();
  return text.length > 8000 ? text.substring(0, 8000) + '\n...[tronqué]' : text;
}
async function downloadDropboxFile(filePath) {
  const p = '/' + filePath.replace(/^\//, '');
  const res = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: p }, true);
  if (!res || !res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  const filename = p.split('/').pop();
  return { buffer, filename };
}
// ═══════════════════════════════════════════════════════════════════════════
// DROPBOX INDEX COMPLET — scan récursif paginé de tous les terrains + fichiers
// Objectif: lookup O(1) par Centris#, rue, adresse. Connaître 100% du Dropbox.
// Persisté sur disque + sync Gist. Reconstruit au boot + cron 30min.
// ═══════════════════════════════════════════════════════════════════════════
const DROPBOX_INDEX_FILE = path.join(DATA_DIR || '/tmp', 'dropbox_index.json');
let dropboxIndex = {
  builtAt: 0,
  totalFolders: 0,
  totalFiles: 0,
  folders: [],       // [{ name, path, centris, adresse, rueTokens, files: [{name,path,ext,size}] }]
  byCentris: {},     // { "12582379": folderIdx }
  byStreet: {},      // { "principale": [folderIdx, ...], "rang": [...] }
};
try { dropboxIndex = loadJSON(DROPBOX_INDEX_FILE, dropboxIndex); } catch {}

// Parse folder name → { centris, adresse, rueTokens }
function _parseFolderMeta(name) {
  const m = name.match(/(?:_NoCentris_|(?:^|_))(\d{7,9})(?=_|$)/);
  const centris = m ? m[1] : '';
  const adresse = name
    .replace(/_NoCentris_\d+/g, '')
    .replace(/(?:^|_)\d{7,9}(?=_|$)/g, '')
    .replace(/^_+|_+$/g, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Tokens rue normalisés (lowercase, sans accents, sans mots courts)
  const rueTokens = adresse.toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove accents
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !/^\d+$/.test(t)); // drop numéros civiques
  return { centris, adresse, rueTokens };
}

// Paginated list_folder recursive — récupère TOUT dans la hiérarchie
async function _dropboxListAll(rootPath) {
  const all = [];
  const startRes = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', {
    path: rootPath, recursive: true, include_non_downloadable_files: false,
  });
  if (!startRes?.ok) return all;
  let data = await startRes.json();
  all.push(...(data.entries || []));
  while (data.has_more && data.cursor) {
    const next = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder/continue', { cursor: data.cursor });
    if (!next?.ok) break;
    data = await next.json();
    all.push(...(data.entries || []));
  }
  return all;
}

// Mutex: empêche 2 builds concurrents (boot + cron qui se chevauchent)
let _dbxIndexBuildInFlight = null;
async function buildDropboxIndex() {
  if (_dbxIndexBuildInFlight) {
    log('INFO', 'DBX_IDX', 'Build déjà en cours — attente du build existant');
    return _dbxIndexBuildInFlight;
  }
  _dbxIndexBuildInFlight = _buildDropboxIndexInner();
  try { return await _dbxIndexBuildInFlight; }
  finally { _dbxIndexBuildInFlight = null; }
}

async function _buildDropboxIndexInner() {
  const t0 = Date.now();

  // Sources de listings Shawn (confirmées par screenshot 2026-04-22):
  //   /Inscription         → inscriptions actives (courtage), convention [Adresse]_NoCentris_[#]
  //   /Terrain en ligne    → terrains actifs, même convention
  // Override possible via DROPBOX_LISTING_PATHS="/a,/b,/c"
  // NE PAS scanner /Dossier Dan Giroux (autre courtier) ni /Dossier de l'équipe (partagé).
  let configuredPaths;
  if (process.env.DROPBOX_LISTING_PATHS) {
    configuredPaths = process.env.DROPBOX_LISTING_PATHS.split(',').map(p => p.trim()).filter(Boolean);
  } else {
    configuredPaths = ['/Inscription', AGENT.dbx_terrains];
  }
  log('INFO', 'DBX_IDX', `Paths à indexer: ${configuredPaths.join(' | ')}`);
  const folderMap = new Map(); // path_lower → folder record

  try {
    for (const rootRaw of configuredPaths) {
      const root = '/' + rootRaw.replace(/^\//, '');
      const entries = await _dropboxListAll(root);
      if (!entries.length) {
        log('WARN', 'DBX_IDX', `Aucune entrée sous ${root}`);
        continue;
      }
      const depth = root.split('/').filter(Boolean).length;
      for (const e of entries) {
        const parts = e.path_lower.split('/').filter(Boolean);
        const terrainSlug = parts[depth];
        if (!terrainSlug) continue;
        const terrainPath = '/' + parts.slice(0, depth + 1).join('/');
        if (e['.tag'] === 'folder' && parts.length === depth + 1) {
          const meta = _parseFolderMeta(e.name);
          if (!folderMap.has(terrainPath)) {
            folderMap.set(terrainPath, {
              name: e.name, path: e.path_lower,
              centris: meta.centris, adresse: meta.adresse, rueTokens: meta.rueTokens,
              source: root, files: [],
            });
          } else {
            const f = folderMap.get(terrainPath);
            f.name = e.name; f.centris = meta.centris; f.adresse = meta.adresse;
            f.rueTokens = meta.rueTokens; f.source = root;
          }
        } else if (e['.tag'] === 'file') {
          if (!folderMap.has(terrainPath)) {
            folderMap.set(terrainPath, {
              name: terrainSlug, path: terrainPath, centris: '', adresse: '',
              rueTokens: [], source: root, files: [],
            });
          }
          const ext = (e.name.toLowerCase().match(/\.[a-z0-9]+$/) || [''])[0];
          folderMap.get(terrainPath).files.push({
            name: e.name, path: e.path_lower, ext, size: e.size || 0,
          });
        }
      }
    }

    if (folderMap.size === 0) {
      log('WARN', 'DBX_IDX', `Aucune entrée trouvée dans ${configuredPaths.join(', ')}`);
      return dropboxIndex;
    }

    // MERGE CROSS-SOURCE — si deux dossiers (dans sources différentes) partagent
    // le même Centris# OU la même adresse normalisée, fusionne leurs fichiers.
    // Permet de retrouver "Inscription 26/12345_X" + "Terrain en ligne/12345_X"
    // comme UN seul match avec tous les fichiers combinés (dédup par filename).
    const rawFolders = [...folderMap.values()];
    const mergeKey = f => f.centris ? `c:${f.centris}` : (f.adresse ? `a:${f.adresse.toLowerCase().replace(/\s+/g,' ').trim()}` : `p:${f.path}`);
    const merged = new Map(); // mergeKey → folder record combiné
    let mergedCount = 0;
    for (const f of rawFolders) {
      const k = mergeKey(f);
      if (!merged.has(k)) {
        merged.set(k, { ...f, sources: [f.source], allPaths: [f.path], files: [...f.files] });
      } else {
        const existing = merged.get(k);
        // Fusionner: ajouter source, combiner fichiers (dédup par nom)
        if (!existing.sources.includes(f.source)) existing.sources.push(f.source);
        existing.allPaths.push(f.path);
        const seen = new Set(existing.files.map(x => x.name.toLowerCase()));
        for (const file of f.files) {
          if (!seen.has(file.name.toLowerCase())) {
            existing.files.push(file);
            seen.add(file.name.toLowerCase());
          }
        }
        // Adresse/rueTokens: garder la version la plus riche
        if (!existing.adresse && f.adresse) { existing.adresse = f.adresse; existing.rueTokens = f.rueTokens; }
        if (!existing.centris && f.centris) existing.centris = f.centris;
        mergedCount++;
      }
    }
    if (mergedCount > 0) log('OK', 'DBX_IDX', `${mergedCount} dossiers fusionnés cross-source (même Centris#/adresse)`);

    // Build flat list + indices
    const folders = [...merged.values()];
    const byCentris = {};
    const byStreet = {};
    folders.forEach((f, i) => {
      if (f.centris) byCentris[f.centris] = i;
      for (const tok of f.rueTokens) {
        if (!byStreet[tok]) byStreet[tok] = [];
        byStreet[tok].push(i);
      }
    });

    // Build le nouvel objet AU COMPLET puis swap atomique — si build crash,
    // on garde l'ancien index en mémoire (pas de "index vide" temporaire).
    const newIndex = {
      builtAt: Date.now(),
      totalFolders: folders.length,
      totalFiles: folders.reduce((s, f) => s + f.files.length, 0),
      folders, byCentris, byStreet,
    };

    // Protection: si le nouveau build a 0 dossiers mais l'ancien en avait >0,
    // ne pas remplacer (probable bug passager Dropbox API, pas un vrai vide).
    if (newIndex.totalFolders === 0 && (dropboxIndex.totalFolders || 0) > 0) {
      log('WARN', 'DBX_IDX', `Nouveau build 0 dossiers — garde l'ancien (${dropboxIndex.totalFolders} dossiers)`);
      return dropboxIndex;
    }

    // Swap atomique
    dropboxIndex = newIndex;
    try { saveJSON(DROPBOX_INDEX_FILE, dropboxIndex); } catch (e) { log('WARN', 'DBX_IDX', `Save disk: ${e.message}`); }

    // Mettre à jour aussi dropboxTerrains (legacy — pour compat matchDropboxAvance)
    dropboxTerrains = folders.map(f => ({
      name: f.name, path: f.path, centris: f.centris, adresse: f.adresse,
    }));

    log('OK', 'DBX_IDX', `Index: ${folders.length} dossiers, ${newIndex.totalFiles} fichiers · ${Math.round((Date.now()-t0)/1000)}s · ${Object.keys(byCentris).length} Centris# · ${Object.keys(byStreet).length} tokens rue`);
    return dropboxIndex;
  } catch (e) {
    log('WARN', 'DBX_IDX', `build failed: ${e.message} — index existant préservé`);
    return dropboxIndex;
  }
}

// Fast lookup — utilise l'index construit pour matcher un lead
// Retourne le MEILLEUR match avec score confidence, ou null si rien
// DEFENSIVE: check folders[idx] existence avant deref (race contre rebuild)
function fastDropboxMatch({ centris, adresse, rue }) {
  const folders = dropboxIndex.folders;
  if (!folders?.length) return null;

  // Strategy 1: Centris# exact (score 100)
  if (centris) {
    const idx = dropboxIndex.byCentris[String(centris).trim()];
    if (idx !== undefined && folders[idx]) {
      return { folder: folders[idx], score: 100, strategy: 'centris_index' };
    }
  }

  // Strategy 2: Scan filenames pour Centris# (dossier n'a pas # mais fichier oui)
  if (centris) {
    for (const f of folders) {
      if (f.files?.some(x => x.name.includes(String(centris)))) {
        return { folder: f, score: 88, strategy: 'filename_centris_index' };
      }
    }
  }

  // Strategy 3: Adresse complète fuzzy (numéro civique + rue)
  const q = _addrTokens(adresse || '');
  if (q.numero || q.mots.size) {
    let best = null;
    for (const f of folders) {
      const t = _addrTokens(f.adresse || f.name);
      let score = 0;
      if (q.numero && t.numero && q.numero === t.numero) score += 50;
      if (q.mots.size && t.mots.size) {
        const inter = [...q.mots].filter(m => t.mots.has(m)).length;
        const union = new Set([...q.mots, ...t.mots]).size;
        score += Math.round(45 * (inter / Math.max(1, union)));
      }
      if (score > (best?.score || 0)) best = { folder: f, score, strategy: 'fuzzy_index' };
    }
    if (best && best.score >= 60) return best;
  }

  // Strategy 4: Rue seule (e.g. "Chemin du Lac" sans numéro)
  const streetQuery = (rue || adresse || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const streetTokens = streetQuery.replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length >= 3 && !/^\d+$/.test(t));
  if (streetTokens.length) {
    const votes = new Map();
    for (const tok of streetTokens) {
      const hits = dropboxIndex.byStreet[tok] || [];
      for (const i of hits) votes.set(i, (votes.get(i) || 0) + 1);
    }
    if (votes.size) {
      const [bestIdx, bestCount] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      const folder = folders[bestIdx];
      if (folder) {
        const score = Math.min(75, 40 + bestCount * 15);
        return { folder, score, strategy: 'street_index' };
      }
    }
  }

  return null;
}

async function loadDropboxStructure() {
  // Sections ALIMENTANT dropboxTerrains: /Terrain en ligne/ ET /Inscription/
  // Bug fix Shawn 2026-05-04: bot trouvait pas les Centris# du dossier /Inscription/
  // car dropboxTerrains était overwrite avec seulement /Terrain en ligne/.
  const sections = [
    { path: '',                     label: 'Racine',           feedListings: false },
    { path: AGENT.dbx_terrains,    label: 'Terrain en ligne', feedListings: true  },
    { path: '/Inscription',         label: 'Inscription',      feedListings: true  },
    { path: AGENT.dbx_templates,   label: 'Templates email',  feedListings: false },
    { path: AGENT.dbx_contacts,    label: 'Contacts',         feedListings: false },
  ];
  const parts = [];
  // Accumulateur cross-source pour dropboxTerrains (merge de toutes les sections feedListings:true)
  const allListings = [];
  try {
    for (const sec of sections) {
      const p   = sec.path === '' ? '' : ('/' + sec.path.replace(/^\//, ''));
      const res = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: p, recursive: false });
      if (!res?.ok) { parts.push(`❌ ${sec.label}: inaccessible`); continue; }
      const data    = await res.json();
      const entries = data.entries || [];

      // Mettre à jour le cache cross-source si c'est un dossier de listings
      // Parser flexible: Centris# peut être au début, au milieu ou à la fin du nom
      // Formats supportés:
      //   "12582379_456_rue_Principale_Rawdon"        ← # au début (recommandé)
      //   "456_rue_Principale_Rawdon_12582379"        ← # à la fin
      //   "Terrain_NoCentris_12582379_456_Principale" ← ancien format
      //   "456_rue_Principale_Rawdon"                 ← sans #
      if (sec.feedListings) {
        const listings = entries.filter(e => e['.tag'] === 'folder').map(e => {
          const m = e.name.match(/(?:_NoCentris_|(?:^|_))(\d{7,9})(?=_|$)/);
          const centris = m ? m[1] : '';
          const adresse = e.name
            .replace(/_NoCentris_\d+/g, '')
            .replace(/(?:^|_)\d{7,9}(?=_|$)/g, '')
            .replace(/^_+|_+$/g, '')
            .replace(/_/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          return { name: e.name, path: e.path_lower, centris, adresse, source: sec.label };
        });
        allListings.push(...listings);
      }

      const lines = entries.map(e => `  ${e['.tag'] === 'folder' ? '📁' : '📄'} ${e.name}`).join('\n');
      parts.push(`📂 ${sec.label} (${p || '/'}):\n${lines || '  (vide)'}`);
    }
    // Merge cross-source — dédup par path_lower (au cas où même dossier dans 2 sections)
    const seen = new Set();
    dropboxTerrains = allListings.filter(l => {
      if (seen.has(l.path)) return false;
      seen.add(l.path);
      return true;
    });
    dropboxStructure = parts.join('\n\n');
    const bySource = dropboxTerrains.reduce((acc, l) => { acc[l.source] = (acc[l.source] || 0) + 1; return acc; }, {});
    const breakdown = Object.entries(bySource).map(([s, n]) => `${s}: ${n}`).join(', ');
    log('OK', 'DROPBOX', `Structure: ${dropboxTerrains.length} listings (${breakdown}), ${sections.length} sections`);
  } catch (e) { log('WARN', 'DROPBOX', `loadStructure: ${e.message}`); }
}

// ─── GitHub Gist (persistance mémoire cross-restart) ─────────────────────────
let gistId = process.env.GIST_ID || null;
async function initGistId() {
  if (gistId) { log('OK', 'GIST', `Configuré: ${gistId}`); return; }
  if (fs.existsSync(GIST_ID_FILE)) { gistId = fs.readFileSync(GIST_ID_FILE, 'utf8').trim(); return; }
  if (!process.env.GITHUB_TOKEN) { log('WARN', 'GIST', 'GITHUB_TOKEN absent — persistance /tmp seulement'); return; }
  try {
    const res = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Kira — mémoire persistante Shawn Barrette', public: false, files: { 'memory.json': { content: JSON.stringify(kiramem, null, 2) } } })
    });
    if (!res.ok) { log('WARN', 'GIST', `Create HTTP ${res.status}`); return; }
    const data = await res.json();
    gistId = data.id;
    try { fs.writeFileSync(GIST_ID_FILE, gistId, 'utf8'); } catch {}
    log('OK', 'GIST', `Créé: ${gistId}`);
    if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, `🔑 *Gist créé!* Ajoute dans Render: \`GIST_ID=${gistId}\``, { parse_mode: 'Markdown' }).catch(() => {});
  } catch (e) { log('WARN', 'GIST', `Create: ${e.message}`); }
}
// Persistance gmail_poller.json + leads_dedup.json via Gist (cross-redeploy)
async function loadPollerStateFromGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers: githubHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const pollerStr = data.files?.['gmail_poller.json']?.content;
    const dedupStr = data.files?.['leads_dedup.json']?.content;
    if (pollerStr) {
      const parsed = JSON.parse(pollerStr);
      if (parsed.processed) gmailPollerState.processed = parsed.processed;
      if (parsed.totalLeads) gmailPollerState.totalLeads = parsed.totalLeads;
      if (parsed.lastRun) gmailPollerState.lastRun = parsed.lastRun;
      saveJSON(POLLER_FILE, gmailPollerState); schedulePollerSave();
      log('OK', 'GIST', `Poller state restauré: ${gmailPollerState.processed.length} processed, ${gmailPollerState.totalLeads} leads`);
    }
    if (dedupStr) {
      const parsed = JSON.parse(dedupStr);
      for (const [k, v] of Object.entries(parsed)) recentLeadsByKey.set(k, v);
      saveLeadsDedup();
      log('OK', 'GIST', `Dedup restauré: ${recentLeadsByKey.size} entries`);
    }
  } catch (e) { log('WARN', 'GIST', `Load poller: ${e.message}`); }
}
async function savePollerStateToGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const files = {
      'gmail_poller.json': { content: JSON.stringify(gmailPollerState, null, 2) },
      'leads_dedup.json':  { content: JSON.stringify(Object.fromEntries(recentLeadsByKey), null, 2) },
    };
    // Backup email_outbox aussi (audit trail des envois) — garde 200 derniers
    if (typeof emailOutbox !== 'undefined' && emailOutbox.length) {
      files['email_outbox.json'] = { content: JSON.stringify(emailOutbox.slice(-200), null, 2) };
    }
    await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    });
  } catch (e) { log('WARN', 'GIST', `Save poller: ${e.message}`); }
}
// Debounce save to avoid hammering GitHub API
let _savePollerTimer = null;
function schedulePollerSave() {
  clearTimeout(_savePollerTimer);
  _savePollerTimer = setTimeout(() => savePollerStateToGist().catch(() => {}), 5000);
}

async function loadMemoryFromGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers: githubHeaders() });
    if (!res.ok) { log('WARN', 'GIST', `Load HTTP ${res.status}`); return; }
    const data = await res.json();
    const content = data.files?.['memory.json']?.content;
    if (!content) return;
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.facts) && parsed.facts.length > 0) {
      kiramem.facts = parsed.facts;
      kiramem.updatedAt = parsed.updatedAt;
      saveJSON(MEM_FILE, kiramem);
      log('OK', 'GIST', `${kiramem.facts.length} faits chargés`);
    }
  } catch (e) { log('WARN', 'GIST', `Load: ${e.message}`); }
}
async function saveMemoryToGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { 'memory.json': { content: JSON.stringify(kiramem, null, 2) } } })
    });
    if (!res.ok) log('WARN', 'GIST', `Save HTTP ${res.status}`);
  } catch (e) { log('WARN', 'GIST', `Save: ${e.message}`); }
}

// ─── Pipedrive ────────────────────────────────────────────────────────────────
const PD_BASE   = 'https://api.pipedrive.com/v1';
const PD_STAGES = { 49:'🆕 Nouveau lead', 50:'📞 Contacté', 51:'💬 En discussion', 52:'🗓 Visite prévue', 53:'🏡 Visite faite', 54:'📝 Offre déposée', 55:'✅ Gagné' };

async function pdGet(endpoint) {
  if (!PD_KEY) return null;
  const sep = endpoint.includes('?') ? '&' : '?';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${PD_BASE}${endpoint}${sep}api_token=${PD_KEY}`, { signal: controller.signal });
    if (!res.ok) return null;
    return res.json();
  } finally { clearTimeout(t); }
}
async function pdPost(endpoint, body) {
  if (!PD_KEY) return null;
  const sep = endpoint.includes('?') ? '&' : '?';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${PD_BASE}${endpoint}${sep}api_token=${PD_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) return null;
    return res.json();
  } finally { clearTimeout(t); }
}
async function pdPut(endpoint, body) {
  if (!PD_KEY) return null;
  const sep = endpoint.includes('?') ? '&' : '?';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${PD_BASE}${endpoint}${sep}api_token=${PD_KEY}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) return null;
    return res.json();
  } finally { clearTimeout(t); }
}

async function getPipeline() {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const data = await pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`);
  if (!data?.data) return 'Erreur Pipedrive ou pipeline vide.';
  const deals = data.data;
  if (!deals.length) return '📋 Pipeline vide.';
  const parEtape = {};
  for (const d of deals) {
    const s = PD_STAGES[d.stage_id] || `Étape ${d.stage_id}`;
    if (!parEtape[s]) parEtape[s] = [];
    const centris = d[PD_FIELD_CENTRIS] ? ` #${d[PD_FIELD_CENTRIS]}` : '';
    parEtape[s].push(`${d.title || 'Sans nom'}${centris}`);
  }
  let txt = `📊 *Pipeline ${AGENT.compagnie} — ${deals.length} deals actifs*\n\n`;
  for (const [etape, noms] of Object.entries(parEtape)) {
    txt += `*${etape}* (${noms.length})\n`;
    txt += noms.map(n => `  • ${n}`).join('\n') + '\n\n';
  }
  return txt.trim();
}

async function chercherProspect(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const searchRes = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=5`);
  const deals = searchRes?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé pour "${terme}" dans Pipedrive.`;

  // Si plusieurs résultats, les montrer brièvement d'abord
  let multiInfo = '';
  if (deals.length > 1) {
    multiInfo = `_(${deals.length} résultats — affichage du premier)_\n`;
    deals.slice(1).forEach(d => {
      multiInfo += `  • ${d.item.title || '?'} — ${PD_STAGES[d.item.stage_id] || d.item.stage_id}\n`;
    });
    multiInfo += '\n';
  }

  const deal = deals[0].item;
  const stageLabel = PD_STAGES[deal.stage_id] || `Étape ${deal.stage_id}`;
  let info = `${multiInfo}═══ PROSPECT: ${deal.title || terme} ═══\nDeal ID: ${deal.id}\nStade: ${stageLabel}\n`;
  if (deal.person_name) info += `Contact: ${deal.person_name}\n`;

  // Coordonnées complètes via API personne
  if (deal.person_id) {
    const person = await pdGet(`/persons/${deal.person_id}`);
    if (person?.data) {
      const phones = (person.data.phone || []).filter(p => p.value).map(p => p.value);
      const emails = (person.data.email || []).filter(e => e.value).map(e => e.value);
      if (phones.length) info += `Tel: ${phones.join(' · ')}\n`;
      if (emails.length) info += `Email: ${emails.join(' · ')}\n`;
    }
  }

  const centris = deal[PD_FIELD_CENTRIS];
  if (centris) info += `Centris: #${centris}\n`;
  const created = deal.add_time ? new Date(deal.add_time).toLocaleDateString('fr-CA') : '?';
  info += `Créé: ${created}\n`;
  const notes = await pdGet(`/notes?deal_id=${deal.id}&limit=5`);
  const notesList = (notes?.data || []).filter(n => n.content?.trim()).map(n => `• ${n.content.trim().substring(0, 300)}`);
  if (notesList.length) info += `\nNotes:\n${notesList.join('\n')}\n`;
  return info;
}

async function marquerPerdu(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const searchRes = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = searchRes?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé pour "${terme}".`;
  const deal = deals[0].item;
  await pdPut(`/deals/${deal.id}`, { status: 'lost' });
  logActivity(`Deal marqué perdu: ${deal.title || terme}`);
  return `✅ "${deal.title || terme}" marqué perdu dans Pipedrive.`;
}

async function ajouterNote(terme, note) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const searchRes = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = searchRes?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé pour "${terme}".`;
  const deal = deals[0].item;
  await pdPost('/notes', { deal_id: deal.id, content: note });
  return `✅ Note ajoutée sur "${deal.title || terme}".`;
}

async function voirProspectComplet(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=5`);
  const items = sr?.data?.items || [];
  if (!items.length) return `Aucun prospect "${terme}" dans Pipedrive.`;

  // Afficher brièvement les autres résultats si plusieurs
  let autre = '';
  if (items.length > 1) {
    autre = `_Autres résultats: ${items.slice(1).map(i => i.item.title).join(', ')}_\n\n`;
  }

  const deal = items[0].item;
  const [fullDeal, notes, activities, personData] = await Promise.all([
    pdGet(`/deals/${deal.id}`),
    pdGet(`/notes?deal_id=${deal.id}&limit=10`),
    pdGet(`/deals/${deal.id}/activities?limit=10&done=0`),
    deal.person_id ? pdGet(`/persons/${deal.person_id}`) : Promise.resolve(null),
  ]);

  // Chercher les derniers emails Gmail (optionnel — ne bloque pas si Gmail non dispo)
  let gmailContext = '';
  try {
    const personEmail = personData?.data?.email?.[0]?.value;
    if (personEmail && process.env.GMAIL_CLIENT_ID) {
      const q = encodeURIComponent(`${personEmail} newer_than:30d`);
      const gmailList = await gmailAPI(`/messages?maxResults=2&q=${q}`).catch(() => null);
      if (gmailList?.messages?.length) {
        const lastMsg = await gmailAPI(`/messages/${gmailList.messages[0].id}?format=full`).catch(() => null);
        if (lastMsg) {
          const hdrs = lastMsg.payload?.headers || [];
          const get  = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
          const sens = get('from').includes(AGENT.email) ? '📤' : '📥';
          gmailContext = `\n📧 *Dernier email (Gmail):* ${sens} ${get('subject')} — ${get('date').substring(0,16)}\n_${lastMsg.snippet?.substring(0,120)}_`;
        }
      }
    }
  } catch {} // Gmail optionnel — pas critique

  const emails = personData; // rename pour clarté

  const d          = fullDeal?.data || deal;
  const stageLabel = PD_STAGES[d.stage_id] || `Étape ${d.stage_id}`;
  const typeMap    = { 37:'Terrain', 38:'Construction neuve', 39:'Maison neuve', 40:'Maison usagée', 41:'Plex' };
  const typeLabel  = typeMap[d[PD_FIELD_TYPE]] || 'Propriété';
  const centris    = d[PD_FIELD_CENTRIS] || '';
  const seqActive  = d[PD_FIELD_SEQ] === 42 ? '✅ Oui' : '❌ Non';
  const j1 = d[PD_FIELD_SUIVI_J1] ? '✅' : '⏳';
  const j3 = d[PD_FIELD_SUIVI_J3] ? '✅' : '⏳';
  const j7 = d[PD_FIELD_SUIVI_J7] ? '✅' : '⏳';
  const created    = d.add_time ? new Date(d.add_time).toLocaleDateString('fr-CA') : '?';
  const ageJours   = d.add_time ? Math.floor((Date.now() - new Date(d.add_time).getTime()) / 86400000) : '?';
  const valeur     = d.value ? `${Number(d.value).toLocaleString('fr-CA')} $` : '';

  let txt = `${autre}━━━━━━━━━━━━━━━━━━━━━━━\n`;
  txt += `👤 *${d.title}* (ID: ${d.id})\n`;
  txt += `📊 ${stageLabel} | ${typeLabel}${centris ? ` | #${centris}` : ''}\n`;
  txt += `📅 Créé: ${created} (${ageJours}j)${valeur ? ` | ${valeur}` : ''}\n`;
  txt += `🔄 Séquence: ${seqActive}\n`; // J+1/J+3/J+7 sur glace

  // Coordonnées complètes
  const p = emails?.data;
  if (p) {
    const phones = (p.phone || []).filter(x => x.value).map(x => x.value);
    const mails  = (p.email || []).filter(x => x.value).map(x => x.value);
    if (phones.length || mails.length) {
      txt += `\n📞 *Coordonnées:*\n`;
      if (phones.length) txt += `  Tel: ${phones.join(' · ')}\n`;
      if (mails.length)  txt += `  Email: ${mails.join(' · ')}\n`;
    }
  }

  // Notes récentes
  const notesList = (notes?.data || []).filter(n => n.content?.trim());
  if (notesList.length) {
    txt += `\n📝 *Notes (${notesList.length}):*\n`;
    notesList.slice(0, 5).forEach(n => {
      const dt = n.add_time ? new Date(n.add_time).toLocaleDateString('fr-CA') : '';
      txt += `  [${dt}] ${n.content.trim().substring(0, 250)}\n`;
    });
  }

  // Activités à faire
  const now   = Date.now();
  const acts  = (activities?.data || []).sort((a, b) =>
    new Date(`${a.due_date}T${a.due_time||'23:59'}`) - new Date(`${b.due_date}T${b.due_time||'23:59'}`)
  );
  if (acts.length) {
    txt += `\n📋 *Activités à venir (${acts.length}):*\n`;
    acts.slice(0, 4).forEach(a => {
      const late = new Date(`${a.due_date}T${a.due_time||'23:59'}`).getTime() < now ? '⚠️' : '🔲';
      txt += `  ${late} ${a.subject || a.type} — ${a.due_date}${a.due_time ? ' ' + a.due_time.substring(0,5) : ''}\n`;
    });
  }

  // Dernier email Gmail
  if (gmailContext) txt += gmailContext;

  // Alerte stagnation
  const lastAct = d.last_activity_date ? new Date(d.last_activity_date).getTime() : new Date(d.add_time).getTime();
  const j = Math.floor((now - lastAct) / 86400000);
  if (j >= 3 && d.stage_id <= 51) txt += `\n\n⚠️ *Aucune action depuis ${j} jours — relance recommandée*`;

  txt += `\n━━━━━━━━━━━━━━━━━━━━━━━`;
  return txt;
}

async function prospectStagnants(jours = 3) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const data  = await pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`);
  const deals = data?.data || [];
  const now   = Date.now();
  const seuil = jours * 86400000;
  const stag  = deals
    .filter(d => d.stage_id <= 51) // avant visite prévue
    .map(d => {
      const last = d.last_activity_date
        ? new Date(d.last_activity_date).getTime()
        : new Date(d.add_time).getTime();
      return { title: d.title, stage: PD_STAGES[d.stage_id] || d.stage_id, j: Math.floor((now - last) / 86400000) };
    })
    .filter(d => d.j >= jours)
    .sort((a, b) => b.j - a.j);

  if (!stag.length) return `✅ Tous les prospects ont été contactés dans les ${jours} derniers jours.`;
  let txt = `⚠️ *${stag.length} prospect(s) sans action depuis ${jours}j+:*\n\n`;
  stag.forEach(s => txt += `  🔴 *${s.title}* — ${s.stage} — ${s.j}j\n`);
  txt += `\nDis "relance [nom]" ou "voir [nom]" pour chacun.`;
  return txt;
}

async function modifierDeal(terme, { valeur, titre, dateClose, raison }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `Aucun deal: "${terme}"`;
  const deal = deals[0].item;
  const body = {};
  if (valeur !== undefined) body.value = parseFloat(String(valeur).replace(/[^0-9.]/g, ''));
  if (titre)     body.title      = titre;
  if (dateClose) body.close_time = dateClose;
  if (Object.keys(body).length === 0) return '❌ Rien à modifier — précise valeur, titre ou date.';
  await pdPut(`/deals/${deal.id}`, body);
  const changes = Object.entries(body).map(([k, v]) => `${k}: ${v}`).join(', ');
  return `✅ *${deal.title}* mis à jour\n${changes}`;
}

// ─── ANTI-DOUBLONS activités (3e demande Shawn — Lounes, Jeannot, Mathieu) ──
// Règle: 1 activité par (type+date) par deal. Point. Quel que soit le nb d'emails entrants.

/**
 * Marque comme complétées toutes les activités OUVERTES d'un deal.
 * Règle Shawn: 'garde toujours juste un deal et une activité, toujours
 * compléter l'ancien quand on fait un nouveau suivi'.
 *
 * Préserve: les activités déjà done + les activités schedulées >7j dans le futur
 * (visites planifiées en avance restent actives).
 */
async function completerAnciennesActivites(dealId) {
  if (!dealId) return 0;
  try {
    const r = await pdGet(`/deals/${dealId}/activities?limit=50`);
    const acts = r?.data || [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const inSevenDays = today.getTime() + 7 * 24 * 3600 * 1000;
    let completed = 0;
    for (const a of acts) {
      if (a.done) continue;
      // Préserver activités schedulées >7j dans le futur (visites planifiées)
      if (a.due_date) {
        const due = new Date(a.due_date + 'T00:00:00').getTime();
        if (due >= inSevenDays) continue;
      }
      try {
        const r = await fetch(`https://api.pipedrive.com/v1/activities/${a.id}?api_token=${PD_KEY}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ done: 1 })
        });
        if (r.ok) {
          completed++;
          log('OK', 'DEDUP', `Activité #${a.id} (${a.type}/${a.due_date || 'now'}) marquée done — deal ${dealId}`);
        }
      } catch (e) { log('WARN', 'DEDUP', `Complete err: ${e.message}`); }
    }
    return completed;
  } catch (e) {
    log('WARN', 'DEDUP', `completerAnciennes deal ${dealId}: ${e.message}`);
    return 0;
  }
}

/**
 * Règle Shawn 2026-04-29: "1 activité par client à la fois. C'est un cheminement."
 * + check niveau PERSONNE (pas juste deal) — anti Kim Fradette 23 activités.
 *
 * Si person a une activité open SUR N'IMPORTE QUEL deal → REFUSE création.
 * Évite: multiple deals dupliqués pour même person × multiple activités each.
 */
async function activiteExisteDeja(dealId, type, date = null) {
  if (!dealId) return null;
  try {
    // 1. Check level deal: any open activity on this deal
    const dealActs = await pdGet(`/deals/${dealId}/activities?limit=50`);
    const anyOpenInDeal = (dealActs?.data || []).find(a => !a.done);
    if (anyOpenInDeal) return anyOpenInDeal.id;

    // 2. Check level PERSON: any open activity on any deal of this person
    const dealRes = await pdGet(`/deals/${dealId}`);
    const personId = typeof dealRes?.data?.person_id === 'object' ? dealRes.data.person_id?.value : dealRes?.data?.person_id;
    if (!personId) return null;
    const personActs = await pdGet(`/persons/${personId}/activities?done=0&limit=20`);
    const anyOpenForPerson = (personActs?.data || []).find(a => !a.done);
    if (anyOpenForPerson) {
      log('INFO', 'DEDUP', `Person #${personId} a déjà activité open #${anyOpenForPerson.id} sur deal #${anyOpenForPerson.deal_id}`);
      return anyOpenForPerson.id;
    }
    return null;
  } catch (e) {
    log('WARN', 'DEDUP', `activiteExisteDeja: ${e.message}`);
    return null;
  }
}

/**
 * Nettoie les doublons d'activités sur un deal.
 * Garde la PLUS RÉCENTE de chaque (type+due_date) parmi les non-complétées, supprime le reste.
 * Ne touche JAMAIS aux activités déjà complétées (done=true).
 */
async function nettoyerDoublonsActivites(dealId) {
  if (!dealId) return { gardees: 0, supprimees: 0 };
  try {
    const r = await pdGet(`/deals/${dealId}/activities?limit=100`);
    const acts = r?.data || [];

    // Grouper par (type + due_date) — uniquement non-complétées
    const groupes = new Map();
    for (const a of acts) {
      if (a.done) continue;
      const key = `${a.type}_${a.due_date || 'no-date'}`;
      if (!groupes.has(key)) groupes.set(key, []);
      groupes.get(key).push(a);
    }

    let gardees = 0, supprimees = 0;
    for (const [, group] of groupes) {
      if (group.length <= 1) { gardees++; continue; }
      // Trier par add_time DESC, garder le premier (plus récent)
      group.sort((a, b) => new Date(b.add_time).getTime() - new Date(a.add_time).getTime());
      gardees++;
      for (let i = 1; i < group.length; i++) {
        try {
          const dr = await fetch(`https://api.pipedrive.com/v1/activities/${group[i].id}?api_token=${PD_KEY}`, { method: 'DELETE' });
          if (dr.ok) {
            supprimees++;
            log('OK', 'DEDUP', `Activité #${group[i].id} (${group[i].type}/${group[i].due_date}) supprimée du deal ${dealId}`);
          }
        } catch (e) { log('WARN', 'DEDUP', `Delete err: ${e.message}`); }
      }
    }
    return { gardees, supprimees };
  } catch (e) {
    log('ERR', 'DEDUP', `nettoyerDoublonsActivites deal ${dealId}: ${e.message}`);
    return { gardees: 0, supprimees: 0, error: e.message };
  }
}

// Patterns génériques de "suivi" interdits (règle Shawn 2026-05-13)
const SUJET_SUIVI_GENERIQUE = /(?:^|\s|—|-)\s*(?:📞|☎️)?\s*(?:suivi|appeler|contacter|rappel(?:er)?|relancer?)\s*(?:le|la|du|de|nouveau|nouvel)?\s*(contact|prospect|client|lead)\s*$/i;

async function creerActivite({ terme, type, sujet, date, heure }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  // 🛡️ RÈGLE SHAWN 2026-05-13: zéro activité générique "suivi/appeler contact/prospect".
  // Ces sujets vagues empilent du bruit sans valeur. Forcer un sujet spécifique.
  // creer_activite reste actif quand Shawn demande explicitement (Claude/Telegram)
  // ou quand un lead entre via poller. PAS de système de suivi auto (on n'y est pas).
  if (sujet && SUJET_SUIVI_GENERIQUE.test(String(sujet).trim())) {
    log('INFO', 'PD', `Refus activité "${sujet}" — sujet générique (règle Shawn)`);
    return `❌ Sujet trop générique: "${sujet}".\nDonne un sujet spécifique (ex: "Appel Marie - terrain Rawdon" ou "Confirmer visite mardi"). Règle Shawn: zéro activité "suivi contact/prospect" vague.`;
  }
  // VALIDATION DATE — empêche Claude d'envoyer une date périmée (bug récurrent)
  if (date) {
    const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return `❌ Date invalide "${date}" — format attendu YYYY-MM-DD`;
    const dateObj = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00`);
    if (isNaN(dateObj.getTime())) return `❌ Date invalide "${date}"`;
    const ageMs = Date.now() - dateObj.getTime();
    const futureMs = dateObj.getTime() - Date.now();
    // Refuser dates >60 jours dans le passé OU >2 ans dans le futur (= probable hallucination Claude)
    if (ageMs > 60 * 86400000) return `❌ Date "${date}" est ${Math.round(ageMs/86400000)} jours dans le passé. Vérifie la date courante (system prompt) et réessaie.`;
    if (futureMs > 730 * 86400000) return `❌ Date "${date}" est >2 ans dans le futur. Vérifie l'année.`;
  }
  if (heure && !/^\d{2}:\d{2}$/.test(String(heure))) {
    return `❌ Heure invalide "${heure}" — format attendu HH:MM (ex: 14:00)`;
  }
  const TYPES = { appel:'call', call:'call', email:'email', réunion:'meeting', meeting:'meeting', tâche:'task', task:'task', visite:'meeting', texte:'task' };
  const actType = TYPES[type?.toLowerCase()?.trim()] || 'task';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `Aucun deal: "${terme}"`;
  const deal = deals[0].item;

  // 🛡️ RÈGLE SHAWN: 1 activité OPEN par deal max (cheminement séquentiel)
  const existant = await activiteExisteDeja(deal.id);
  if (existant) {
    log('INFO', 'DEDUP', `Deal ${deal.id} a déjà une activité open #${existant} — création skip`);
    return `⏭️ *${deal.title}* a déjà une activité en cours (#${existant}). Marque-la "fait" avant d'en créer une nouvelle.\n_Règle: 1 activité par client à la fois — cheminement séquentiel._`;
  }

  // 🔄 AUTO-COMPLETE — marque les anciennes activités open comme done
  // (Règle Shawn: 1 active à la fois, ancien complété au nouveau suivi)
  const completed = await completerAnciennesActivites(deal.id);
  if (completed > 0) log('OK', 'DEDUP', `${completed} ancienne(s) activité(s) complétée(s) auto sur deal ${deal.id}`);

  const body = {
    deal_id: deal.id,
    subject: sujet || `${actType.charAt(0).toUpperCase() + actType.slice(1)} — ${deal.title}`,
    type: actType,
    done: 0,
  };
  if (date) body.due_date = date;
  if (heure) body.due_time = heure;
  await pdPost('/activities', body);
  return `✅ Activité créée: *${body.subject}*\n${deal.title}${date ? ` — ${date}${heure ? ' ' + heure : ''}` : ''}`;
}

// ─── Anti-doublons Pipedrive ──────────────────────────────────────────────
async function supprimerActivite({ activity_id, terme }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';

  // Si activity_id direct → suppression immédiate
  if (activity_id) {
    try {
      const r = await fetch(`https://api.pipedrive.com/v1/activities/${activity_id}?api_token=${PD_KEY}`, { method: 'DELETE' });
      const j = await r.json();
      if (j.success) return `✅ Activité #${activity_id} supprimée`;
      return `❌ Échec suppression: ${j.error || 'inconnu'}`;
    } catch (e) { return `❌ Erreur: ${e.message}`; }
  }

  // Sinon liste les activités du deal trouvé par terme
  if (!terme) return '❌ Fournir activity_id OU terme (nom prospect)';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `Aucun deal: "${terme}"`;
  const deal = deals[0].item;
  const acts = await pdGet(`/deals/${deal.id}/activities?limit=20`);
  if (!acts?.data?.length) return `Aucune activité sur deal #${deal.id} (${deal.title})`;
  let msg = `📋 Activités du deal #${deal.id} *${deal.title}*\n\n`;
  for (const a of acts.data) {
    const status = a.done ? '✅' : '⏰';
    const date = a.due_date ? ` · ${a.due_date}${a.due_time ? ' ' + a.due_time : ''}` : '';
    msg += `${status} #${a.id} — *${a.type}* ${a.subject || ''}${date}\n`;
  }
  msg += `\n_Pour supprimer: dis "supprime activité #ID"_`;
  return msg;
}

async function deplacerActivite({ activity_id, target_deal }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (!activity_id || !target_deal) return '❌ activity_id et target_deal requis';

  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(target_deal)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé pour "${target_deal}"`;
  const targetId = deals[0].item.id;
  const targetTitle = deals[0].item.title;

  try {
    const r = await fetch(`https://api.pipedrive.com/v1/activities/${activity_id}?api_token=${PD_KEY}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deal_id: targetId })
    });
    const j = await r.json();
    if (j.success) return `✅ Activité #${activity_id} déplacée vers deal #${targetId} *${targetTitle}*`;
    return `❌ Échec: ${j.error || 'inconnu'}`;
  } catch (e) { return `❌ Erreur: ${e.message}`; }
}

async function fusionnerDeals(dealKeep, dealRemove) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (!dealKeep || !dealRemove) return '❌ deal_garder et deal_supprimer requis';
  if (dealKeep === dealRemove) return '❌ Les deux IDs sont identiques';

  // Pipedrive a un endpoint dédié /deals/{id}/merge
  try {
    const r = await fetch(`https://api.pipedrive.com/v1/deals/${dealRemove}/merge?api_token=${PD_KEY}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ merge_with_id: dealKeep })
    });
    const j = await r.json();
    if (j.success) {
      return `✅ Deal #${dealRemove} fusionné dans #${dealKeep}\n_Activités, notes et historique transférés. Le deal source est supprimé._`;
    }
    return `❌ Fusion échouée: ${j.error || JSON.stringify(j).substring(0, 200)}`;
  } catch (e) { return `❌ Erreur: ${e.message}`; }
}

async function fusionnerPersonnes(personKeep, personRemove) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (!personKeep || !personRemove) return '❌ personne_garder et personne_supprimer requis';
  if (personKeep === personRemove) return '❌ Les deux IDs sont identiques';

  try {
    const r = await fetch(`https://api.pipedrive.com/v1/persons/${personRemove}/merge?api_token=${PD_KEY}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ merge_with_id: personKeep })
    });
    const j = await r.json();
    if (j.success) {
      return `✅ Person #${personRemove} fusionnée dans #${personKeep}\n_Deals, activités, notes transférés. La fiche source est supprimée._`;
    }
    return `❌ Fusion échouée: ${j.error || JSON.stringify(j).substring(0, 200)}`;
  } catch (e) { return `❌ Erreur: ${e.message}`; }
}

async function supprimerDeal(dealId) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (!dealId) return '❌ deal_id requis';
  try {
    const r = await fetch(`https://api.pipedrive.com/v1/deals/${dealId}?api_token=${PD_KEY}`, { method: 'DELETE' });
    const j = await r.json();
    return j.success ? `✅ Deal #${dealId} supprimé définitivement` : `❌ Échec: ${j.error || 'inconnu'}`;
  } catch (e) { return `❌ Erreur: ${e.message}`; }
}

async function supprimerPersonne(personId) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (!personId) return '❌ personne_id requis';
  try {
    const r = await fetch(`https://api.pipedrive.com/v1/persons/${personId}?api_token=${PD_KEY}`, { method: 'DELETE' });
    const j = await r.json();
    return j.success ? `✅ Person #${personId} supprimée définitivement` : `❌ Échec: ${j.error || 'inconnu'}`;
  } catch (e) { return `❌ Erreur: ${e.message}`; }
}

async function supprimerNote({ note_id, terme }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (note_id) {
    try {
      const r = await fetch(`https://api.pipedrive.com/v1/notes/${note_id}?api_token=${PD_KEY}`, { method: 'DELETE' });
      const j = await r.json();
      return j.success ? `✅ Note #${note_id} supprimée` : `❌ Échec: ${j.error || 'inconnu'}`;
    } catch (e) { return `❌ Erreur: ${e.message}`; }
  }
  if (!terme) return '❌ note_id OU terme requis';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `Aucun deal: "${terme}"`;
  const deal = deals[0].item;
  const notes = await pdGet(`/notes?deal_id=${deal.id}&limit=20`);
  if (!notes?.data?.length) return `Aucune note sur deal #${deal.id}`;
  let msg = `📝 Notes du deal #${deal.id} *${deal.title}*\n\n`;
  for (const n of notes.data) {
    const date = n.add_time ? n.add_time.split(' ')[0] : '?';
    const preview = (n.content || '').replace(/\n/g, ' ').substring(0, 80);
    msg += `#${n.id} · ${date}\n  ${preview}\n\n`;
  }
  msg += `_Pour supprimer: dis "supprime note #ID"_`;
  return msg;
}

async function modifierPersonne({ personne_id, nom, email, telephone }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (!personne_id) return '❌ personne_id requis';
  const updates = {};
  if (nom) updates.name = nom;
  if (email) updates.email = [{ value: email, primary: true }];
  if (telephone) updates.phone = [{ value: telephone, primary: true }];
  if (Object.keys(updates).length === 0) return '❌ Rien à modifier';
  try {
    const r = await fetch(`https://api.pipedrive.com/v1/persons/${personne_id}?api_token=${PD_KEY}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(updates)
    });
    const j = await r.json();
    if (j.success) return `✅ Person #${personne_id} mise à jour: ${Object.keys(updates).join(', ')}`;
    return `❌ Échec: ${j.error || 'inconnu'}`;
  } catch (e) { return `❌ Erreur: ${e.message}`; }
}

// ─── classer_deal — set type + stage avec verify post-action ────────────
async function classerDeal({ terme, type_propriete, etape }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (!terme) return '❌ terme requis';

  // Parse terme: ID direct ou search
  let deal;
  if (/^\d+$/.test(terme)) {
    deal = (await pdGet(`/deals/${terme}`))?.data;
    if (!deal) return `❌ Deal #${terme} introuvable`;
  } else {
    const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
    const items = sr?.data?.items || [];
    if (!items.length) return `Aucun deal: "${terme}"`;
    deal = items[0].item;
  }

  const STAGE_MAP = {
    'nouveau': 49, 'contacté': 50, 'contact': 50, 'discussion': 51, 'en discussion': 51,
    'visite prévue': 52, 'visite planifiée': 52, 'visite faite': 53, 'visite': 53,
    'offre': 54, 'offre déposée': 54, 'gagné': 55, 'won': 55,
  };

  const updates = {};
  if (type_propriete) {
    const typeId = PD_TYPE_MAP[type_propriete.toLowerCase().trim()];
    if (!typeId) return `❌ Type inconnu: "${type_propriete}". Options: ${Object.keys(PD_TYPE_MAP).join(', ')}`;
    updates[PD_FIELD_TYPE] = typeId;
  }
  if (etape) {
    const stageId = STAGE_MAP[etape.toLowerCase().trim()];
    if (!stageId) return `❌ Étape inconnue: "${etape}". Options: ${Object.keys(STAGE_MAP).join(', ')}`;
    updates.stage_id = stageId;
  }
  if (Object.keys(updates).length === 0) return '❌ Rien à modifier (fournir type_propriete OU etape)';

  await pdPut(`/deals/${deal.id}`, updates);
  // Verify
  const after = (await pdGet(`/deals/${deal.id}`))?.data;
  const issues = [];
  if (updates.stage_id && after.stage_id !== updates.stage_id) issues.push(`stage=${after.stage_id} attendu ${updates.stage_id}`);
  if (updates[PD_FIELD_TYPE] && after[PD_FIELD_TYPE] != updates[PD_FIELD_TYPE]) issues.push(`type=${after[PD_FIELD_TYPE]} attendu ${updates[PD_FIELD_TYPE]}`);
  if (issues.length) return `❌ ÉCHEC: ${issues.join(' · ')}`;

  const TYPE_LABELS = { 37: 'Terrain', 38: 'Construction neuve', 39: 'Maison neuve', 40: 'Maison usagée', 41: 'Plex' };
  const parts = [];
  if (type_propriete) parts.push(`type → *${TYPE_LABELS[updates[PD_FIELD_TYPE]] || type_propriete}*`);
  if (etape) parts.push(`étape → *${PD_STAGES[updates.stage_id]}*`);
  return `✅ *${after.title}* (#${deal.id})\n${parts.join('\n')}`;
}

async function classerActivite({ activity_id, type, sujet, date, heure }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (!activity_id) return '❌ activity_id requis';

  const TYPES = { appel:'call', call:'call', email:'email', réunion:'meeting', meeting:'meeting', tâche:'task', task:'task', visite:'meeting' };
  const updates = {};
  if (type) {
    const t = TYPES[type.toLowerCase().trim()];
    if (!t) return `❌ Type inconnu: ${type}`;
    updates.type = t;
  }
  if (sujet) updates.subject = sujet;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return '❌ Date format YYYY-MM-DD';
    updates.due_date = date;
  }
  if (heure) {
    if (!/^\d{2}:\d{2}$/.test(heure)) return '❌ Heure format HH:MM';
    updates.due_time = heure;
  }
  if (Object.keys(updates).length === 0) return '❌ Rien à modifier';

  try {
    const r = await fetch(`https://api.pipedrive.com/v1/activities/${activity_id}?api_token=${PD_KEY}`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates)
    });
    const j = await r.json();
    if (!j.success) return `❌ ${j.error || 'inconnu'}`;
    // Verify
    const after = await pdGet(`/activities/${activity_id}`);
    const got = after?.data;
    if (!got) return `❌ Activité #${activity_id} disparue après update`;
    return `✅ Activité #${activity_id} mise à jour\n${type ? '• type: ' + type + '\n' : ''}${sujet ? '• sujet: ' + sujet + '\n' : ''}${date ? '• date: ' + date + '\n' : ''}${heure ? '• heure: ' + heure : ''}`;
  } catch (e) { return `❌ Erreur: ${e.message}`; }
}

async function statsBusiness() {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const now = new Date();
  const [gagnes, perdus, actifs, visitesData] = await Promise.all([
    pdGet('/deals?status=won&limit=100'),
    pdGet('/deals?status=lost&limit=100'),
    pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`),
    Promise.resolve(loadJSON(VISITES_FILE, [])),
  ]);
  const filtrerMois = d => {
    const date = new Date(d.close_time || d.won_time || d.lost_time || 0);
    return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
  };
  const dealsActifs = actifs?.data || [];
  const gagnésMois  = (gagnes?.data || []).filter(filtrerMois);
  const perdusMois  = (perdus?.data || []).filter(filtrerMois);
  const parEtape = {};
  for (const d of dealsActifs) {
    const s = PD_STAGES[d.stage_id] || `Étape ${d.stage_id}`;
    parEtape[s] = (parEtape[s] || 0) + 1;
  }
  // Stagnants (J+1/J+3/J+7 sur glace)
  const relances = []; // désactivé — réactiver quand prêt
  const stagnants = [];
  const nowTs = Date.now();
  for (const d of dealsActifs) {
    if (d.stage_id > 51) continue;
    const created = new Date(d.add_time).getTime();
    const last = d.last_activity_date ? new Date(d.last_activity_date).getTime() : created;
    if ((nowTs - last) > 3 * 86400000) stagnants.push({ title: d.title, j: Math.floor((nowTs - last) / 86400000) });
  }

  // Visites aujourd'hui
  const today      = now.toDateString();
  const visitesToday = visitesData.filter(v => new Date(v.date).toDateString() === today);

  const dateStr = now.toLocaleDateString('fr-CA', { weekday:'long', day:'numeric', month:'long', timeZone:'America/Toronto' });
  let txt = `📊 *Tableau de bord ${AGENT.compagnie}*\n_${dateStr}_\n\n`;
  txt += `🔥 *Pipeline actif — ${dealsActifs.length} deals*\n`;
  for (const [etape, nb] of Object.entries(parEtape)) txt += `  ${etape}: *${nb}*\n`;
  txt += `\n📈 *${now.toLocaleString('fr-CA', { month:'long', year:'numeric' })}*\n`;
  txt += `  ✅ Gagnés: *${gagnésMois.length}*  ❌ Perdus: ${perdusMois.length}\n`;
  if (gagnésMois.length + perdusMois.length > 0) {
    txt += `  🎯 Taux: ${Math.round(gagnésMois.length / (gagnésMois.length + perdusMois.length) * 100)}%\n`;
  }
  if (visitesToday.length) {
    txt += `\n📅 *Visites aujourd'hui (${visitesToday.length}):*\n`;
    visitesToday.forEach(v => {
      const h = new Date(v.date).toLocaleTimeString('fr-CA', { hour:'2-digit', minute:'2-digit', timeZone:'America/Toronto' });
      txt += `  🏡 ${v.nom} — ${h}${v.adresse ? ' @ ' + v.adresse : ''}\n`;
    });
  }
  if (relances.length) {
    txt += `\n⏰ *Relances à faire (${relances.length}):*\n`;
    relances.forEach(r => txt += `  ${r}\n`);
  }
  if (stagnants.length) {
    txt += `\n⚠️ *Sans contact 3j+ (${stagnants.length}):*\n`;
    stagnants.sort((a,b) => b.j - a.j).slice(0,5).forEach(s => txt += `  🔴 ${s.title} — ${s.j}j\n`);
  }
  return txt.trim();
}

async function creerDeal({ prenom, nom, telephone, email, type, source, centris, note }) {
  // 🛡️ SHAWN_GERE_SES_SUIVIS=true — cette fonction crée seulement person+deal+note, JAMAIS d'activité.
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const fullName = [prenom, nom].filter(Boolean).join(' ');
  const titre = fullName || prenom || 'Nouveau prospect';
  const phoneNorm = telephone ? telephone.replace(/\D/g, '') : '';

  // 1. Chercher personne existante — priorité email > tel > nom (évite doublons)
  let personId = null;
  let personNote = '';
  let personAction = 'created';
  try {
    let existingPerson = null;
    // Priorité 1: email exact (le plus fiable)
    if (email) {
      const r = await pdGet(`/persons/search?term=${encodeURIComponent(email)}&fields=email&limit=1`);
      existingPerson = r?.data?.items?.[0]?.item;
    }
    // Priorité 2: tel si pas trouvé par email
    if (!existingPerson && phoneNorm) {
      const r = await pdGet(`/persons/search?term=${encodeURIComponent(phoneNorm)}&fields=phone&limit=1`);
      existingPerson = r?.data?.items?.[0]?.item;
    }
    // Priorité 3: nom (fallback, risque homonymes — à confirmer côté Shawn)
    if (!existingPerson && fullName) {
      const r = await pdGet(`/persons/search?term=${encodeURIComponent(fullName)}&fields=name&limit=1`);
      existingPerson = r?.data?.items?.[0]?.item;
    }

    if (existingPerson) {
      personId = existingPerson.id;
      personAction = 'found';
      // UPDATE si email ou tel manquants sur la personne existante
      const fullPerson = await pdGet(`/persons/${personId}`).then(r => r?.data).catch(() => null);
      const existingEmails = (fullPerson?.email || []).map(e => e.value).filter(Boolean);
      const existingPhones = (fullPerson?.phone || []).map(p => p.value).filter(Boolean);
      const updates = {};
      if (email && !existingEmails.includes(email)) {
        updates.email = [...existingEmails.map(v => ({ value: v })), { value: email, primary: existingEmails.length === 0 }];
      }
      if (phoneNorm && !existingPhones.some(p => p.replace(/\D/g,'') === phoneNorm)) {
        updates.phone = [...existingPhones.map(v => ({ value: v })), { value: phoneNorm, primary: existingPhones.length === 0 }];
      }
      if (Object.keys(updates).length) {
        await pdPut(`/persons/${personId}`, updates).catch(() => {});
        personAction = 'updated';
        log('OK', 'PD', `Personne #${personId} updated: ${Object.keys(updates).join('+')}`);
      }
    } else {
      // Créer la personne
      const personBody = { name: fullName || prenom };
      if (phoneNorm) personBody.phone = [{ value: phoneNorm, primary: true }];
      if (email)     personBody.email = [{ value: email, primary: true }];
      const personRes = await pdPost('/persons', personBody);
      personId = personRes?.data?.id || null;
      if (!personId) personNote = '\n⚠️ Contact non créé — ajoute email/tel manuellement dans Pipedrive.';
    }
  } catch (e) {
    log('WARN', 'PD', `Person creation: ${e.message}`);
    personNote = '\n⚠️ Contact non lié — ajoute manuellement.';
  }

  // 1.5. ANTI-DOUBLON DEAL — si la personne a déjà un deal OUVERT, utilise-le
  // au lieu d'en créer un nouveau (Shawn: 'pas avoir deux deal pareil').
  // Si plusieurs deals open existants → garde le + récent + alerte pour fusion manuelle.
  if (personId) {
    try {
      const existingDeals = await pdGet(`/persons/${personId}/deals?status=open&limit=10`);
      const open = existingDeals?.data || [];
      if (open.length >= 1) {
        // Trier par date de création desc — garder le plus récent
        open.sort((a, b) => new Date(b.add_time).getTime() - new Date(a.add_time).getTime());
        const existing = open[0];
        log('OK', 'PD', `Deal existant #${existing.id} pour person #${personId} — réutilisé (skip création doublon)`);

        // Si plusieurs open → notification Telegram pour fusion manuelle
        if (open.length >= 2 && ALLOWED_ID) {
          const dealList = open.map(d => `#${d.id} ${d.title}`).join(', ');
          const tgMsg = `⚠️ *${open.length} deals open pour ${fullName || 'Person #' + personId}*\n\n${dealList}\n\n_Ce nouveau lead réutilise #${existing.id} (le + récent). Pour fusionner les autres: dis-moi "fusionne deal X dans Y"._`;
          sendTelegramWithFallback(tgMsg, { category: 'duplicate-deals' }).catch(() => {});
        }

        // Ajout note avec contexte du nouvel email — préserve la trace
        const newNote = [
          `📧 Nouvelle entrée du ${new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}`,
          note,
          telephone ? `Tel: ${telephone}` : '',
          email ? `Email: ${email}` : '',
          source ? `Source: ${source}` : '',
        ].filter(Boolean).join('\n');
        if (newNote) await pdPost('/notes', { deal_id: existing.id, content: newNote }).catch(() => {});

        return `♻️ Deal existant réutilisé: *${existing.title}* (#${existing.id})${open.length >= 2 ? `\n⚠️ ${open.length} deals open pour cette personne — voir alerte Telegram` : ''}`;
      }
    } catch (e) {
      log('WARN', 'PD', `Check deals existants person ${personId}: ${e.message}`);
    }
  }

  // 2. Créer le deal
  const typeOpt = PD_TYPE_MAP[type] || PD_TYPE_MAP.maison_usagee;
  const dealBody = {
    title:           titre,
    stage_id:        49,
    pipeline_id:     AGENT.pipeline_id,
    [PD_FIELD_TYPE]: typeOpt,
    [PD_FIELD_SEQ]:  42,
  };
  if (personId) dealBody.person_id       = personId;
  if (centris)  dealBody[PD_FIELD_CENTRIS] = centris;

  const dealRes = await pdPost('/deals', dealBody);
  const deal = dealRes?.data;
  if (!deal?.id) return `❌ Erreur création deal Pipedrive — vérifie PIPEDRIVE_API_KEY dans Render.`;

  // 3. Note initiale
  const noteContent = [
    note,
    telephone ? `Tel: ${telephone}` : '',
    email     ? `Email: ${email}` : '',
    source    ? `Source: ${source}` : '',
  ].filter(Boolean).join('\n');
  if (noteContent) await pdPost('/notes', { deal_id: deal.id, content: noteContent }).catch(() => {});

  const typeLabel = { terrain:'Terrain', maison_usagee:'Maison usagée', maison_neuve:'Maison neuve', construction_neuve:'Construction neuve', auto_construction:'Auto-construction', plex:'Plex' }[type] || 'Propriété';
  logActivity(`Deal créé: ${titre} (${typeLabel}${centris?', Centris #'+centris:''})`);
  return `✅ Deal créé: *${titre}*\nType: ${typeLabel} | ID: ${deal.id}${centris ? ' | Centris #' + centris : ''}${personNote}`;
}

async function planifierVisite({ prospect, date, adresse }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const searchRes = await pdGet(`/deals/search?term=${encodeURIComponent(prospect)}&limit=3`);
  const deals = searchRes?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé pour "${prospect}". Crée d'abord le deal.`;
  const deal = deals[0].item;

  // Parser la date — utilise ISO si fournie, sinon now+1jour
  let rdvISO = date;
  if (!date.includes('T') && !date.includes('-')) {
    // Date naturelle — approximation simple
    rdvISO = new Date(Date.now() + 86400000).toISOString();
  }
  const dateStr = rdvISO.split('T')[0];
  // RÈGLE Shawn: pas d'heure par défaut. Si pas explicite dans rdvISO → null.
  const timeStr = rdvISO.includes('T') && !/T00:00/.test(rdvISO) ? rdvISO.split('T')[1]?.substring(0, 5) : null;

  // VALIDATION DATE — empêche dates périmées/hallucinées (bug Claude récurrent)
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return `❌ Date invalide "${dateStr}" — format YYYY-MM-DD requis`;
  const dateObj = new Date(`${dateStr}T12:00:00`);
  if (isNaN(dateObj.getTime())) return `❌ Date "${dateStr}" non parsable`;
  const ageMs = Date.now() - dateObj.getTime();
  const futureMs = dateObj.getTime() - Date.now();
  if (ageMs > 60 * 86400000) return `❌ Date "${dateStr}" est ${Math.round(ageMs/86400000)} jours dans le passé. Vérifie la date courante.`;
  if (futureMs > 730 * 86400000) return `❌ Date "${dateStr}" est >2 ans dans le futur — probable hallucination, vérifie l'année.`;
  if (timeStr && !/^\d{2}:\d{2}/.test(timeStr)) return `❌ Heure invalide "${timeStr}"`;

  // 🛡️ RÈGLE 1-activité-par-deal: complète les anciennes AVANT de créer la visite
  // (planifier une visite = nouvelle étape du cheminement, l'ancienne devient done auto)
  const completed = await completerAnciennesActivites(deal.id);
  if (completed > 0) log('OK', 'PD', `${completed} ancienne(s) activité(s) complétée(s) sur deal ${deal.id} avant visite`);

  // Build activity body — n'inclut due_time que si timeStr fourni explicitement
  const activityBody = {
    deal_id: deal.id,
    subject: `Visite — ${deal.title}${adresse ? ' @ ' + adresse : ''}`,
    type: 'meeting',
    due_date: dateStr,
    done: 0,
  };
  if (timeStr) { activityBody.due_time = timeStr; activityBody.duration = '01:00'; }

  await Promise.all([
    pdPut(`/deals/${deal.id}`, { stage_id: 52 }),
    pdPost('/activities', activityBody),
  ]);

  // Sauvegarder dans visites.json pour rappel matin
  const visites = loadJSON(VISITES_FILE, []);
  visites.push({ dealId: deal.id, nom: deal.title, date: rdvISO, adresse: adresse || '' });
  saveJSON(VISITES_FILE, visites);

  logActivity(`Visite planifiée: ${deal.title} — ${dateStr}${timeStr ? ' ' + timeStr : ''}${adresse?' @ '+adresse:''}`);
  return `✅ Visite planifiée: *${deal.title}*\n📅 ${dateStr}${timeStr ? ' à ' + timeStr : ' (pas d\'heure)'}${adresse ? '\n📍 ' + adresse : ''}\nDeal → Visite prévue ✓${completed > 0 ? `\n${completed} ancienne(s) activité(s) auto-complétée(s)` : ''}`;
}

async function changerEtape(terme, etape) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const MAP = {
    'nouveau':49, 'contacté':50, 'contact':50, 'discussion':51, 'en discussion':51,
    'visite prévue':52, 'visite planifiée':52, 'visite faite':53, 'visite':53,
    'offre':54, 'offre déposée':54, 'gagné':55, 'won':55, 'closed':55
  };
  const stageId = MAP[etape.toLowerCase().trim()] || parseInt(etape);
  if (!stageId || !PD_STAGES[stageId]) {
    return `❌ Étape inconnue: "${etape}"\nOptions: nouveau · contacté · discussion · visite prévue · visite faite · offre · gagné`;
  }
  const s = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = s?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé: "${terme}"`;
  const deal = deals[0].item;
  const avant = PD_STAGES[deal.stage_id] || deal.stage_id;

  // Stage 55 = gagné → DOIT aussi set status='won' sinon Pipedrive considère le deal open
  const body = { stage_id: stageId };
  if (stageId === 55) body.status = 'won';

  // Verify post-action: GET et confirme que stage_id appliqué
  await pdPut(`/deals/${deal.id}`, body);
  const verify = await pdGet(`/deals/${deal.id}`);
  const realStage = verify?.data?.stage_id;
  const realStatus = verify?.data?.status;
  if (realStage !== stageId) {
    return `❌ ÉCHEC: stage demandé=${stageId} mais Pipedrive a stage=${realStage} status=${realStatus}\nDeal #${deal.id} — vérifie manuellement`;
  }
  if (stageId === 55 && realStatus !== 'won') {
    return `❌ Stage OK (gagné) mais status reste "${realStatus}" — vérifie permissions Pipedrive`;
  }
  return `✅ *${deal.title || terme}* (#${deal.id})\n${avant} → ${PD_STAGES[stageId]}${stageId === 55 ? ' · status=won' : ''}`;
}

// ─── marquer_gagne — outil dédié pour fermer un deal gagné avec valeur ───
async function marquerGagne({ terme, valeur, devise }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  if (!terme) return '❌ terme (nom prospect) requis';

  const s = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = s?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé: "${terme}"`;
  const deal = deals[0].item;

  const body = { status: 'won', stage_id: 55 };
  if (valeur != null && valeur !== '') body.value = parseFloat(valeur);
  if (devise) body.currency = devise.toUpperCase();

  await pdPut(`/deals/${deal.id}`, body);

  // Verify — GET et check que tout est appliqué
  const verify = await pdGet(`/deals/${deal.id}`);
  const v = verify?.data;
  if (!v) return `❌ Deal #${deal.id} introuvable après update`;

  const issues = [];
  if (v.status !== 'won') issues.push(`status="${v.status}" (attendu won)`);
  if (v.stage_id !== 55) issues.push(`stage_id=${v.stage_id} (attendu 55)`);
  if (body.value != null && Math.abs((v.value || 0) - body.value) > 0.01) issues.push(`value=${v.value} (attendu ${body.value})`);

  if (issues.length) {
    return `❌ ÉCHEC partiel #${deal.id} *${v.title}*:\n${issues.join('\n')}`;
  }
  return `✅ *${v.title}* (#${deal.id}) marqué GAGNÉ\nValeur: ${v.value} ${v.currency || 'CAD'}\nStatus: ${v.status} · Stage: gagné`;
}

async function voirActivitesDeal(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const s = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = s?.data?.items || [];
  if (!deals.length) return `Aucun deal: "${terme}"`;
  const deal = deals[0].item;
  const acts = await pdGet(`/deals/${deal.id}/activities?limit=100&done=0`);
  const list = acts?.data || [];
  if (!list.length) return `*${deal.title}* — aucune activité à venir.`;
  const now = Date.now();
  // Header avec count + warning si doublons détectés
  let txt = `📋 *Activités — ${deal.title}* (${list.length})\n`;
  if (list.length > 1) txt += `⚠️ ${list.length} activités open — règle: 1 par deal max. /cleanup_doublons pour nettoyer.\n`;
  txt += '\n';
  const sorted = list.sort((a, b) => new Date(`${a.due_date}T${a.due_time||'23:59'}`) - new Date(`${b.due_date}T${b.due_time||'23:59'}`));
  for (const a of sorted) {
    const dt   = new Date(`${a.due_date}T${a.due_time || '23:59'}`).getTime();
    const late = dt < now ? '⚠️ ' : '🔲 ';
    const time = a.due_time ? ` ${a.due_time.substring(0,5)}` : '';
    txt += `${late}*${a.subject || a.type}* — ${a.due_date}${time} \`#${a.id}\`\n`;
  }
  return txt.trim();
}

async function chercherListingDropbox(terme) {
  if (!dropboxToken) return '❌ Dropbox non connecté — dis "teste dropbox"';
  let dossiers = dropboxTerrains;
  if (!dossiers.length) {
    await loadDropboxStructure();
    dossiers = dropboxTerrains;
  }
  if (!dossiers.length) return `❌ Aucun dossier dans ${AGENT.dbx_terrains} — vérifier Dropbox`;

  const q = terme.toLowerCase();
  const matches = dossiers.filter(d => {
    const n = d.name.toLowerCase();
    return n.includes(q) || (d.centris && d.centris.includes(terme)) ||
           q.split(/[\s,]+/).every(w => n.includes(w));
  }).slice(0, 6);

  if (!matches.length) {
    const preview = dossiers.slice(0, 6).map(d => d.adresse || d.name).join(', ');
    return `Aucun listing "${terme}".\nDossiers disponibles: ${preview}${dossiers.length > 6 ? ` (+${dossiers.length - 6})` : ''}`;
  }

  const details = await Promise.all(matches.map(async f => {
    const r = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: f.path, recursive: false });
    const files = r?.ok ? (await r.json()).entries : [];
    const pdfs  = files.filter(x => x.name.toLowerCase().endsWith('.pdf')).map(x => x.name);
    const imgs  = files.filter(x => /\.(jpg|jpeg|png)$/i.test(x.name)).length;
    let txt = `📁 *${f.adresse || f.name}*${f.centris ? ` (Centris #${f.centris})` : ''}${f.source ? ` _[${f.source}]_` : ''}\n`;
    if (pdfs.length)  txt += `  📄 ${pdfs.join(' · ')}\n`;
    if (imgs > 0)     txt += `  🖼 ${imgs} photo(s)\n`;
    if (!files.length) txt += `  _(vide)_\n`;
    return txt.trim();
  }));
  return `🔍 *Listings "${terme}":*\n\n${details.join('\n\n')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// MATCHING DROPBOX AVANCÉ — 4 stratégies en cascade avec score de confiance
// ═══════════════════════════════════════════════════════════════════════════
function _normalizeAddr(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/\b(rue|chemin|ch|avenue|av|boulevard|boul|route|rte|rang|rg|montee|place|pl)\b/g, '')
    .replace(/\b(qc|quebec|canada)\b/g, '')
    .replace(/\b[a-z]\d[a-z]\s?\d[a-z]\d\b/g, '') // code postal
    .replace(/[,.;()]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function _addrTokens(s) {
  const n = _normalizeAddr(s);
  const numMatch = n.match(/\b(\d{1,6})\b/);
  const numero = numMatch ? numMatch[1] : '';
  const mots = n.split(/\s+/).filter(w => w && w.length > 2 && !/^\d+$/.test(w));
  return { numero, mots: new Set(mots), raw: n };
}

// FALLBACK TEMPS RÉEL — Dropbox search_v2 API quand l'index ne trouve pas.
// Cherche Centris# ou adresse dans TOUT Dropbox (pas juste les paths indexés)
// et retourne le dossier parent du premier match. Utile si terrain ajouté après
// le dernier index rebuild, ou dans un dossier non-scanné.
async function dropboxLiveSearch(query) {
  if (!query || String(query).length < 3) return null;
  try {
    const res = await dropboxAPI('https://api.dropboxapi.com/2/files/search_v2', {
      query: String(query),
      options: { max_results: 25, file_status: 'active', filename_only: false },
    });
    if (!res?.ok) return null;
    const data = await res.json();
    const matches = data.matches || [];
    if (!matches.length) return null;
    // Prioriser: dossier avec Centris# exact dans le nom
    const folderCandidates = new Map(); // path → {folder, score, reason}
    for (const m of matches) {
      const meta = m.metadata?.metadata;
      if (!meta) continue;
      if (meta['.tag'] === 'folder' && meta.name.includes(String(query))) {
        folderCandidates.set(meta.path_lower, { meta, score: 95, reason: 'folder_name' });
      } else if (meta['.tag'] === 'file') {
        // Fichier trouvé → remonte au dossier parent immédiat
        const parent = meta.path_lower.split('/').slice(0, -1).join('/');
        if (!folderCandidates.has(parent)) {
          folderCandidates.set(parent, { meta: { name: parent.split('/').pop(), path_lower: parent }, score: 82, reason: 'filename_match' });
        }
      }
    }
    if (!folderCandidates.size) return null;
    const [bestPath, best] = [...folderCandidates.entries()].sort((a,b) => b[1].score - a[1].score)[0];
    // Extraire centris/adresse du nom
    const folderName = best.meta.name;
    const parsed = _parseFolderMeta(folderName);
    const folder = {
      name: folderName, path: bestPath,
      centris: parsed.centris, adresse: parsed.adresse,
      source: '(live search)',
    };
    const pdfs = await _listFolderPDFs(folder);
    log('OK', 'DBX_LIVE', `Trouvé "${folderName}" via search live (${best.reason}, score ${best.score}, ${pdfs.length} docs)`);
    return { folder, score: best.score, strategy: `live_search_${best.reason}`, pdfs };
  } catch (e) {
    log('WARN', 'DBX_LIVE', `Search échoué: ${e.message}`);
    return null;
  }
}

async function matchDropboxAvance(centris, adresse) {
  // FAST PATH 1 — index précalculé (O(1) par Centris#)
  if (dropboxIndex.folders?.length) {
    const fast = fastDropboxMatch({ centris, adresse, rue: adresse });
    if (fast) {
      const indexedFiles = (fast.folder.files || [])
        .filter(x => DOC_EXTS.includes(x.ext))
        .map(x => ({ name: x.name, path_lower: x.path, '.tag': 'file', size: x.size }));
      const pdfs = _sortDocsPriority(indexedFiles);
      const finalPdfs = pdfs.length ? pdfs : await _listFolderPDFs(fast.folder);
      return { ...fast, pdfs: finalPdfs, candidates: [{ folder: fast.folder, score: fast.score }], sources: fast.folder.sources || [fast.folder.source] };
    }
  } else {
    buildDropboxIndex().catch(() => {});
  }

  // FAST PATH 2 — Dropbox search LIVE (fallback si l'index rate)
  // Cherche d'abord par Centris#, puis par adresse. Trouve même les dossiers
  // pas encore indexés (nouveaux, mal classés, etc.)
  if (centris) {
    const liveRes = await dropboxLiveSearch(centris);
    if (liveRes?.folder && liveRes.pdfs?.length) {
      return { ...liveRes, candidates: [{ folder: liveRes.folder, score: liveRes.score }], sources: [liveRes.folder.source] };
    }
  }
  if (adresse && adresse.length >= 5) {
    const liveRes = await dropboxLiveSearch(adresse);
    if (liveRes?.folder && liveRes.pdfs?.length) {
      return { ...liveRes, candidates: [{ folder: liveRes.folder, score: Math.max(70, liveRes.score - 10) }], sources: [liveRes.folder.source] };
    }
  }

  let dossiers = dropboxTerrains;
  if (!dossiers.length) { await loadDropboxStructure(); dossiers = dropboxTerrains; }
  if (!dossiers.length) return { folder: null, score: 0, strategy: 'no_folders', pdfs: [], candidates: [] };

  // STRATÉGIE 1 — Match exact par # Centris (confidence 100)
  if (centris) {
    const hit = dossiers.find(d => d.centris && d.centris === String(centris).trim());
    if (hit) {
      const pdfs = await _listFolderPDFs(hit);
      return { folder: hit, score: 100, strategy: 'centris_exact', pdfs, candidates: [{ folder: hit, score: 100 }] };
    }
  }

  // STRATÉGIE 2 — Fuzzy adresse normalisée (score 0-95)
  const scored = [];
  if (adresse) {
    const q = _addrTokens(adresse);
    for (const d of dossiers) {
      const t = _addrTokens(d.adresse || d.name);
      let score = 0;
      if (q.numero && t.numero && q.numero === t.numero) score += 50;
      if (q.mots.size && t.mots.size) {
        const inter = [...q.mots].filter(m => t.mots.has(m)).length;
        const union = new Set([...q.mots, ...t.mots]).size;
        score += Math.round(45 * (inter / Math.max(1, union))); // Jaccard
      }
      if (score > 0) scored.push({ folder: d, score });
    }
    scored.sort((a, b) => b.score - a.score);
  }
  const topCandidates = scored.slice(0, 3);
  const best = scored[0];

  // STRATÉGIE 3 — Filename scan pour Centris# (confidence 85)
  if (centris && (!best || best.score < 70)) {
    for (const d of dossiers.slice(0, 50)) { // limite pour ne pas scanner 500 dossiers
      const pdfs = await _listFolderPDFs(d);
      if (pdfs.some(p => p.name.includes(String(centris)))) {
        return { folder: d, score: 85, strategy: 'filename_centris', pdfs, candidates: [{ folder: d, score: 85 }] };
      }
    }
  }

  // STRATÉGIE 4 — Substring fallback (confidence 50-70)
  if ((!best || best.score < 50) && adresse) {
    const q = adresse.toLowerCase().split(/[\s,]+/).filter(w => w.length > 3)[0];
    if (q) {
      const hit = dossiers.find(d => (d.name + ' ' + d.adresse).toLowerCase().includes(q));
      if (hit) {
        const pdfs = await _listFolderPDFs(hit);
        return { folder: hit, score: 55, strategy: 'substring', pdfs, candidates: [{ folder: hit, score: 55 }] };
      }
    }
  }

  if (best && best.score >= 60) {
    const pdfs = await _listFolderPDFs(best.folder);
    return { folder: best.folder, score: best.score, strategy: 'fuzzy_addr', pdfs, candidates: topCandidates };
  }

  return { folder: null, score: best?.score || 0, strategy: 'no_match', pdfs: [], candidates: topCandidates };
}

const DOC_EXTS = ['.pdf','.jpg','.jpeg','.png','.webp','.heic','.gif','.dwg','.dxf','.doc','.docx','.xls','.xlsx','.txt','.rtf'];
const DOC_MIME = {
  '.pdf':'application/pdf',
  '.jpg':'image/jpeg','.jpeg':'image/jpeg',
  '.png':'image/png','.gif':'image/gif','.webp':'image/webp','.heic':'image/heic',
  '.dwg':'application/acad','.dxf':'application/dxf',
  '.doc':'application/msword','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls':'application/vnd.ms-excel','.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.txt':'text/plain','.rtf':'application/rtf',
};
function _docExt(name) { const m = name.toLowerCase().match(/\.[a-z0-9]+$/); return m ? m[0] : ''; }
function _docContentType(name) { return DOC_MIME[_docExt(name)] || 'application/octet-stream'; }
function _sortDocsPriority(docs) {
  // Fiche_Detaillee en premier, puis PDFs, puis images, puis reste
  const rank = d => {
    const n = d.name.toLowerCase();
    if (/fiche[_\s-]*detaill/i.test(n)) return 0;
    if (n.endsWith('.pdf')) return 1;
    if (/\.(jpe?g|png|webp|heic|gif)$/i.test(n)) return 2;
    return 3;
  };
  return [...docs].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

async function _listFolderPDFs(folder) {
  try {
    // Scan récursif: capture aussi les fichiers dans sous-dossiers Photos/, Plans/,
    // Certificats/, etc. — les brokers structurent souvent leurs terrains comme ça.
    const r = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: folder.path, recursive: true });
    if (!r?.ok) return [];
    const entries = (await r.json()).entries || [];
    const docs = entries.filter(x => x['.tag'] === 'file' && DOC_EXTS.includes(_docExt(x.name)));
    return _sortDocsPriority(docs);
  } catch { return []; }
}

// ─── Conversion images → PDF (pdf-lib, pure JS) ───────────────────────────────
// PDFs passthrough · JPG/PNG combinés en un seul "Photos_[terrain].pdf" ·
// autres formats (HEIC, DWG, Word, Excel, webp, gif, rtf, txt) signalés skipped
async function convertDocsToPDF(docs, folderLabel) {
  const { PDFDocument } = require('pdf-lib');
  const out = { docs: [], skipped: [], imagesMerged: 0 };
  const images = [];
  for (const d of docs) {
    const ext = _docExt(d.name);
    if (ext === '.pdf') { out.docs.push(d); continue; }
    if (ext === '.jpg' || ext === '.jpeg' || ext === '.png') { images.push(d); continue; }
    out.skipped.push({ name: d.name, reason: `format ${ext || '?'} non convertible` });
  }
  if (images.length === 0) return out;

  try {
    const pdf = await PDFDocument.create();
    pdf.setTitle(`Photos — ${folderLabel}`);
    pdf.setCreator(`${AGENT.nom} · ${AGENT.compagnie}`);
    pdf.setProducer('pdf-lib');
    pdf.setCreationDate(new Date());

    for (const img of images) {
      try {
        const ext = _docExt(img.name);
        const embed = (ext === '.png')
          ? await pdf.embedPng(img.buffer)
          : await pdf.embedJpg(img.buffer);
        const MAX_W = 612, MAX_H = 792; // letter portrait en points PDF
        const s = Math.min(MAX_W / embed.width, MAX_H / embed.height, 1);
        const w = embed.width * s, h = embed.height * s;
        const page = pdf.addPage([w, h]);
        page.drawImage(embed, { x: 0, y: 0, width: w, height: h });
        out.imagesMerged++;
      } catch (e) {
        out.skipped.push({ name: img.name, reason: `embed échoué: ${e.message.substring(0, 60)}` });
      }
    }

    if (out.imagesMerged > 0) {
      const bytes = await pdf.save();
      const safe = String(folderLabel).replace(/[^\w\- ]/g, '').trim().substring(0, 50) || 'Terrain';
      out.docs.push({
        name: `Photos_${safe.replace(/\s+/g, '_')}.pdf`,
        buffer: Buffer.from(bytes),
        size: bytes.length,
      });
    }
  } catch (e) {
    log('WARN', 'PDF', `Conversion images → PDF échouée: ${e.message}`);
    // Fallback: garder les images en format natif
    for (const img of images) out.docs.push(img);
    out.imagesMerged = 0;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-ENVOI DOCS — garantie livraison avec retry + anti-doublon + tracking
// ═══════════════════════════════════════════════════════════════════════════
let autoEnvoiState = loadJSON(AUTOENVOI_FILE, { sent: {}, log: [], totalAuto: 0, totalFails: 0 });

async function envoyerDocsAuto({ email, nom, centris, dealId, deal, match, _shawnConsent }) {
  // 🔒 KILLSWITCH consent — si CONSENT_REQUIRED, refuse tout envoi sauf si
  // l'appelant a explicitement attesté que Shawn a confirmé via Telegram
  // (ex: handler "envoie les docs à X" passe _shawnConsent: true).
  if (CONSENT_REQUIRED && !_shawnConsent) {
    log('WARN', 'AUTOENVOI', `BLOQUÉ — envoi sans consent Shawn pour ${email}`);
    return { sent: false, skipped: true, reason: 'CONSENT_REQUIRED — confirmation Shawn manquante', match };
  }
  const dedupKey = `${email}|${centris || match?.folder?.centris || ''}`;
  const last = autoEnvoiState.sent[dedupKey];
  if (last && (Date.now() - last) < 24 * 3600 * 1000) {
    return { sent: false, skipped: true, reason: 'déjà envoyé <24h', match };
  }

  // Threshold: si caller a déjà filtré (traiterNouveauLead) le score est ok.
  // Sinon (envoyer_docs_prospect tool direct) on applique 70 par défaut.
  const AUTO_THRESHOLD = parseInt(process.env.AUTO_SEND_THRESHOLD || '70');
  if (!match.folder || match.score < AUTO_THRESHOLD || !match.pdfs?.length) {
    return { sent: false, skipped: true, reason: `score ${match.score} < ${AUTO_THRESHOLD} ou 0 PDF`, match };
  }

  const maxRetries = 3;
  const delays = [0, 30000, 120000]; // 0s, 30s, 2min
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (delays[attempt]) await new Promise(r => setTimeout(r, delays[attempt]));
    try {
      const t0 = Date.now();
      const result = await envoyerDocsProspect(nom || email, email, null, {
        dealHint: deal,
        folderHint: match.folder,
        centrisHint: centris,
        _shawnConsent: true, // arrivés ici = caller a déjà attesté consent
      });
      const ms = Date.now() - t0;

      if (typeof result === 'string' && result.startsWith('✅')) {
        // Plan quota tracking — autoSent +1 (jour)
        try { require('./plan_quotas').recordUsage('autoSentPerDay', 1); } catch {}
        autoEnvoiState.sent[dedupKey] = Date.now();
        autoEnvoiState.log.unshift({
          timestamp: Date.now(), email, nom, centris,
          folder: match.folder.name, score: match.score, strategy: match.strategy,
          pdfsCount: match.pdfs.length, deliveryMs: ms, attempt: attempt + 1, success: true,
        });
        autoEnvoiState.log = autoEnvoiState.log.slice(0, 100); // garder 100 dernières
        autoEnvoiState.totalAuto = (autoEnvoiState.totalAuto || 0) + 1;
        saveJSON(AUTOENVOI_FILE, autoEnvoiState);
        log('OK', 'AUTOENVOI', `${email} <- ${match.pdfs.length} docs (${match.strategy}, score ${match.score}, ${ms}ms, try ${attempt + 1})`);
        return { sent: true, match, deliveryMs: ms, attempt: attempt + 1, resultStr: result };
      }
      lastError = result;
      log('WARN', 'AUTOENVOI', `Tentative ${attempt + 1}/${maxRetries} échouée: ${String(result).substring(0, 100)}`);
    } catch (e) {
      lastError = e.message;
      log('WARN', 'AUTOENVOI', `Tentative ${attempt + 1}/${maxRetries} exception: ${e.message}`);
    }
  }

  autoEnvoiState.log.unshift({
    timestamp: Date.now(), email, nom, centris,
    folder: match.folder?.name, score: match.score,
    error: String(lastError).substring(0, 200), success: false, attempts: maxRetries,
  });
  autoEnvoiState.log = autoEnvoiState.log.slice(0, 100);
  autoEnvoiState.totalFails = (autoEnvoiState.totalFails || 0) + 1;
  saveJSON(AUTOENVOI_FILE, autoEnvoiState);

  // Alerte Telegram critique 🚨 (P2) + note Pipedrive
  if (dealId) {
    await pdPost('/notes', { deal_id: dealId, content: `⚠️ Auto-envoi docs ÉCHOUÉ après 3 tentatives: ${String(lastError).substring(0, 200)}` }).catch(() => null);
  }
  // Alerte immédiate Shawn — via sendTelegramWithFallback (md → plain → email backup)
  const terrain = match?.folder?.adresse || match?.folder?.name || centris || '?';
  const alertMsg = [
    `🚨 *DOCS NON ENVOYÉS — ACTION REQUISE*`,
    ``,
    `👤 Prospect: ${nom || email}`,
    `📧 Email: ${email}`,
    `🏡 Terrain: ${terrain}`,
    `🔁 Tentatives: ${maxRetries}/${maxRetries}`,
    ``,
    `❌ Erreur: ${String(lastError).substring(0, 180)}`,
    ``,
    `▶️ Réessayer: \`envoie les docs à ${email}\``,
  ].join('\n');
  await sendTelegramWithFallback(alertMsg, { category: 'P2-docs-failed', email, centris });
  return { sent: false, error: lastError, match, attempts: maxRetries };
}

// Fire-and-forget: envoie le preview email à shawn@ sans bloquer le lead flow
// Dédup 1h par (clientEmail + folderPath) — évite spam si lead re-traité
const previewSent = new Map(); // key → timestamp ms
function firePreviewDocs({ email, nom, centris, deal, match }) {
  if (!email || !match?.folder) return;
  const key = `${email}|${match.folder.path || ''}`;
  const last = previewSent.get(key);
  if (last && (Date.now() - last) < 60 * 60 * 1000) {
    log('INFO', 'DOCS', `PREVIEW skip dédup 1h (client: ${email})`);
    return;
  }
  previewSent.set(key, Date.now());
  // Nettoyage: garder max 200 entrées
  if (previewSent.size > 200) {
    const keys = [...previewSent.keys()].slice(0, previewSent.size - 200);
    for (const k of keys) previewSent.delete(k);
  }

  setImmediate(async () => {
    try {
      const res = await envoyerDocsProspect(nom || email, email, null, {
        dealHint: deal, folderHint: match.folder, centrisHint: centris,
        preview: { clientEmail: email, clientName: nom || '' },
      });
      if (typeof res === 'string' && res.startsWith('✅')) {
        log('OK', 'DOCS', `PREVIEW → ${AGENT.email} (client: ${email})`);
      } else {
        log('WARN', 'DOCS', `PREVIEW échec: ${String(res).substring(0, 120)}`);
        sendTelegramWithFallback(
          `⚠️ *Preview email ÉCHOUÉ* pour ${email}\n${String(res).substring(0, 200)}\n\nLe doc-send reste en attente — tu peux quand même dire \`envoie les docs à ${email}\`.`,
          { category: 'preview-failed', email }
        ).catch(() => {});
      }
    } catch (e) {
      log('WARN', 'DOCS', `PREVIEW exception: ${e.message}`);
      sendTelegramWithFallback(
        `⚠️ *Preview email exception* pour ${email}\n${e.message.substring(0, 200)}`,
        { category: 'preview-exception', email }
      ).catch(() => {});
    }
  });
}

// ─── Template HTML v11 — Envoi listing white-label Signature SB ──────────────
// Validé après 11 itérations Shawn (2026-06-01). Référence:
// memory/reference_template_white_label_listing_v11_FINAL.md
function buildWhiteLabelHTMLv11(data) {
  const d = data || {};
  const e = s => escapeHtml(String(s || ''));
  const renderPhotosThumbs = () => {
    const photos = d.photos || []; // array d'URLs
    let html = '';
    for (let i = 0; i < 6; i++) {
      const url = photos[i];
      const cell = url
        ? `<img src="${e(url)}" alt="" style="display:block;width:100%;height:100px;object-fit:cover;border-radius:4px;">`
        : `<div class="photo-thumb" style="background:#1a1a1a;height:100px;border-radius:4px;text-align:center;line-height:100px;color:#666;font-size:10px;">photo ${i+2}</div>`;
      const padR = i % 3 === 2 ? 0 : 4;
      const padL = i % 3 === 0 ? 0 : 4;
      const padB = i < 3 ? 8 : 0;
      html += `<td width="33%" style="padding:0 ${padR}px ${padB}px ${padL}px;">${cell}</td>`;
      if (i % 3 === 2 && i < 5) html += '</tr><tr>';
    }
    return html;
  };
  const photoMainHTML = d.photoMainUrl
    ? `<img src="${e(d.photoMainUrl)}" alt="${e(d.adresse)}" style="display:block;width:100%;height:auto;border-radius:8px;border:1px solid #1e1e1e;">`
    : `<div class="photo-main" style="background:linear-gradient(135deg,#1a1a1a,#0d0d0d);border:1px solid #1e1e1e;border-radius:8px;height:340px;text-align:center;color:#666;font-size:13px;letter-spacing:2px;text-transform:uppercase;padding:140px 0;">[PHOTO PRINCIPALE HAUTE RÉS]<br><span style="color:#888;font-size:11px;">scrapée Centris auto</span></div>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=yes">
<meta name="color-scheme" content="dark">
<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">
<meta name="x-apple-disable-message-reformatting">
<title>Voici la propriété</title>
<style>
  body{margin:0!important;padding:0!important;background:#060606;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;width:100%;-webkit-text-size-adjust:100%;}
  table{border-collapse:collapse;mso-table-lspace:0pt;mso-table-rspace:0pt;}
  img{display:block;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;max-width:100%;height:auto;}
  a{color:#aa0721;text-decoration:none;}
  .container{max-width:720px;width:100%;}
  .outer-pad{padding:24px 16px;}
  @media only screen and (max-width:680px){
    .outer-pad{padding:0!important;}
    .container{width:100%!important;max-width:100%!important;border-radius:0!important;}
    .hero-prix{font-size:44px!important;}
    .hero-titre{font-size:32px!important;}
    .pad{padding:20px 16px!important;}
    .pad-top{padding-top:32px!important;}
    .photo-main{height:220px!important;}
    .photo-thumb{height:74px!important;line-height:74px!important;}
    .ref-prix{font-size:48px!important;}
    .cta-btn{padding:14px 24px!important;font-size:12px!important;}
    .header-right{display:none!important;}
    .logo-sb{width:260px!important;max-width:260px!important;}
    .slogan-sb{font-size:11px!important;}
    .site-btn{padding:13px 24px!important;font-size:12px!important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:#060606;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#060606">
<tr><td align="center" bgcolor="#060606" class="outer-pad" style="padding:24px 16px;">
<table class="container" width="720" cellpadding="0" cellspacing="0" border="0" bgcolor="#0a0a0a" style="max-width:720px;width:100%;border-radius:8px;overflow:hidden;">
  <tr><td style="background:#aa0721;padding:12px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="color:#fff;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">Propriété sélectionnée pour vous</td>
      <td align="right" class="header-right" style="color:rgba(255,255,255,0.85);font-size:11px;letter-spacing:1px;">${e(new Date().toLocaleDateString('fr-CA', { month: 'long', year: 'numeric', timeZone: 'America/Toronto' }))}</td>
    </tr></table>
  </td></tr>
  <tr><td class="pad" style="background:#0d0d0d;padding:32px 24px 28px;text-align:center;">
    <a href="https://www.signaturesb.com" target="_blank" rel="noopener" style="text-decoration:none;"><img src="https://signaturesb-bot-s272.onrender.com/logo/sb" alt="Signature SB · Groupe Immobilier" width="300" class="logo-sb" style="display:block;max-width:300px;height:auto;margin:0 auto 14px;border:0;"></a>
    <div style="width:80px;height:1px;background:#aa0721;margin:0 auto 14px;"></div>
    <div class="slogan-sb" style="color:#aa0721;font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;line-height:1.4;">Spécialiste résidentiel &amp; terrains</div>
  </td></tr>
  <tr><td style="height:2px;background:linear-gradient(90deg,#aa0721,transparent);"></td></tr>
  <tr><td class="pad pad-top" style="padding:40px 24px 28px;text-align:center;">
    <div style="color:#888;font-size:12px;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;">Bonjour,</div>
    <div class="hero-titre" style="font-family:Georgia,serif;font-size:40px;font-weight:800;color:#f5f5f7;line-height:1.1;letter-spacing:-1px;">Voici la propriété<span style="color:#aa0721;">!</span></div>
  </td></tr>
  <tr><td class="pad" style="padding:0 24px 20px;">${photoMainHTML}</td></tr>
  <tr><td class="pad" style="padding:0 24px 14px;text-align:center;">
    <div style="color:#aa0721;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">📍 Adresse</div>
    <div style="color:#f5f5f7;font-size:22px;font-weight:700;line-height:1.3;">${e(d.adresse)}</div>
  </td></tr>
  <tr><td class="pad" style="padding:20px 24px 28px;text-align:center;">
    <div style="color:#aa0721;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:8px;">💰 Prix demandé</div>
    <div class="hero-prix" style="font-family:Georgia,serif;font-size:60px;font-weight:800;color:#aa0721;line-height:1;letter-spacing:-2px;white-space:nowrap;">${e(d.prix).replace(/ /g, '&nbsp;')}</div>
    <div style="color:#888;font-size:13px;margin-top:10px;">N° Centris ${e(d.centrisNum)} · ${e(d.type)} · ${e(d.statut)}</div>
  </td></tr>
  <tr><td class="pad" style="padding:0 24px 24px;">
    <table width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td width="33%" style="padding:16px 10px;background:#0d0d0d;border:1px solid #1a1a1a;border-radius:6px 0 0 6px;text-align:center;">
          <div style="color:#666;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">🛏 Chambres</div>
          <div style="color:#f5f5f7;font-size:24px;font-weight:800;">${e(d.chambres)}</div>
        </td>
        <td width="33%" style="padding:16px 10px;background:#0d0d0d;border:1px solid #1a1a1a;border-left:none;text-align:center;">
          <div style="color:#666;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">🛁 SDB</div>
          <div style="color:#f5f5f7;font-size:24px;font-weight:800;">${e(d.sdb)}</div>
        </td>
        <td width="34%" style="padding:16px 10px;background:#0d0d0d;border:1px solid #1a1a1a;border-left:none;border-radius:0 6px 6px 0;text-align:center;">
          <div style="color:#666;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">📅 Année</div>
          <div style="color:#f5f5f7;font-size:24px;font-weight:800;">${e(d.annee)}</div>
        </td>
      </tr>
      <tr><td colspan="3" style="height:8px;"></td></tr>
      <tr>
        <td width="50%" style="padding:16px 12px;background:#0d0d0d;border:1px solid #1a1a1a;border-radius:6px 0 0 6px;text-align:center;">
          <div style="color:#666;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">🏠 Superficie</div>
          <div style="color:#f5f5f7;font-size:18px;font-weight:700;white-space:nowrap;">${e(d.superficie).replace(/ /g, '&nbsp;')}</div>
        </td>
        <td colspan="2" width="50%" style="padding:16px 12px;background:#0d0d0d;border:1px solid #1a1a1a;border-left:none;border-radius:0 6px 6px 0;text-align:center;">
          <div style="color:#666;font-size:10px;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:6px;">🌳 Terrain</div>
          <div style="color:#f5f5f7;font-size:18px;font-weight:700;white-space:nowrap;">${e(d.terrain).replace(/ /g, '&nbsp;')}</div>
        </td>
      </tr>
    </table>
  </td></tr>
  <tr><td class="pad" style="padding:0 24px 24px;">
    <div style="color:#aa0721;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">📝 Description</div>
    <div style="color:#cccccc;font-size:14px;line-height:1.7;background:#0d0d0d;border:1px solid #1a1a1a;border-radius:8px;padding:20px;">${e(d.description)}</div>
  </td></tr>
  <!-- Section album RETIRÉE — photo principale en haut + album dans la fiche descriptive PJ -->
  <tr><td class="pad" style="padding:0 24px 14px;text-align:center;">
    <div style="color:#888;font-size:12px;line-height:1.5;">📸 Album complet de ${e(d.nbPhotos || '?')} photos dans la fiche descriptive jointe ↓</div>
  </td></tr>
  <tr><td class="pad" style="padding:0 24px 24px;">
    <div style="background:#0d0d0d;border:1px solid #1e1e1e;border-radius:8px;padding:20px;">
      <div style="color:#aa0721;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:14px;">📎 Pièces jointes</div>
      <div style="color:#f5f5f7;font-size:14px;line-height:1.9;">
        <strong style="color:#aa0721;">📄 Fiche descriptive Centris officielle</strong><br>
        <span style="color:#888;font-size:12px;">Detaillé client avec album photos · Impérial</span><br><br>
        <span style="color:#999;">📄 Déclaration du vendeur (DV signée)</span><br>
        <span style="color:#999;">📄 Facture taxes municipales</span><br>
        <span style="color:#999;">📄 Facture taxes scolaires</span><br>
        <span style="color:#999;">📄 Certificat de localisation</span><br>
        <span style="color:#999;">📄 Plans cadastraux</span>
      </div>
    </div>
  </td></tr>
  <tr><td class="pad" style="padding:0 24px 24px;">
    <div style="background:#0d0d0d;border:1px solid #1a1a1a;border-radius:6px;padding:36px 24px;text-align:center;">
      <div style="font-family:Georgia,serif;font-size:26px;font-style:italic;color:#f5f5f7;margin-bottom:12px;line-height:1.3;">Vous voulez visiter?</div>
      <div style="color:#888;font-size:14px;margin-bottom:24px;line-height:1.6;">Appelez-moi directement, je coordonne avec le vendeur.</div>
      <a href="tel:+15149271340" class="cta-btn" style="display:inline-block;background:#aa0721;color:#fff;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:16px 28px;border-radius:3px;text-decoration:none;white-space:nowrap;">📞 514-927-1340</a>
      <div style="color:#444;font-size:11px;margin-top:16px;">Shawn Barrette · RE/MAX PRESTIGE</div>
    </div>
  </td></tr>
  <tr><td class="pad" style="padding:0 24px 28px;">
    <div style="background:#0d0d0d;border:1px solid #1e1e1e;border-top:4px solid #aa0721;border-radius:4px;padding:36px 24px;text-align:center;">
      <div style="color:#aa0721;font-size:10px;font-weight:700;letter-spacing:3px;text-transform:uppercase;margin-bottom:14px;">💰 Programme référence</div>
      <div style="font-family:Georgia,serif;font-size:20px;color:#f5f5f7;line-height:1.3;margin-bottom:32px;">Vous connaissez quelqu'un<br>qui veut acheter ou vendre?</div>
      <div style="margin-bottom:24px;"><div class="ref-prix" style="font-family:Georgia,serif;font-size:60px;font-weight:800;color:#aa0721;line-height:1;letter-spacing:-2px;white-space:nowrap;">500$</div></div>
      <div style="width:50px;height:2px;background:linear-gradient(90deg,transparent,#aa0721,transparent);margin:0 auto 24px;"></div>
      <div style="margin-bottom:32px;"><div class="ref-prix" style="font-family:Georgia,serif;font-size:60px;font-weight:800;color:#aa0721;line-height:1;letter-spacing:-2px;white-space:nowrap;">1&nbsp;000$</div></div>
      <div style="color:#cccccc;font-size:13px;line-height:1.7;margin-bottom:24px;">Pour chaque référence conclue.<br>Pas de paperasse — juste un appel.<br>Payé à la signature chez le notaire.</div>
      <a href="tel:+15149271340" class="cta-btn" style="display:inline-block;background:#aa0721;color:#fff;font-size:13px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:14px 28px;border-radius:3px;text-decoration:none;white-space:nowrap;">Référer quelqu'un</a>
    </div>
  </td></tr>
  <tr><td class="pad" style="background:#080808;padding:28px 24px 24px;border-top:1px solid #111;">
    <img src="https://signaturesb-bot-s272.onrender.com/logo/remax" alt="RE/MAX" width="140" style="display:block;max-width:140px;height:auto;margin-bottom:18px;">
    <div style="color:#cccccc;font-size:14px;line-height:1.9;margin-bottom:22px;">
      <strong style="color:#f5f5f7;font-size:16px;display:block;margin-bottom:4px;">Shawn Barrette</strong>
      <span style="color:#888;font-size:13px;">Courtier immobilier · RE/MAX PRESTIGE</span><br><br>
      <table cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;">
        <tr><td style="padding:3px 0;">📞 <a href="tel:+15149271340" style="color:#aa0721;text-decoration:none;font-weight:600;white-space:nowrap;">514-927-1340</a></td></tr>
        <tr><td style="padding:3px 0;">✉️ <a href="mailto:shawn@signaturesb.com" style="color:#aa0721;text-decoration:none;font-weight:600;">shawn@signaturesb.com</a></td></tr>
        <tr><td style="padding:3px 0;">🌐 <a href="https://www.signaturesb.com" target="_blank" rel="noopener" style="color:#aa0721;text-decoration:underline;font-weight:600;">www.signaturesb.com</a></td></tr>
      </table>
    </div>
    <a href="https://www.signaturesb.com" target="_blank" rel="noopener" class="site-btn" style="display:inline-block;background:#1a1a1a;border:1px solid #aa0721;color:#aa0721;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:14px 28px;border-radius:3px;text-decoration:none;">🌐 Voir mes inscriptions →</a>
    <div style="color:#444;font-size:10px;line-height:1.6;margin-top:20px;border-top:1px solid #111;padding-top:14px;">Signature SB · Groupe Immobilier · RE/MAX PRESTIGE</div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

async function envoyerDocsProspect(terme, emailDest, fichier, opts = {}) {
  const _t0 = Date.now();
  log('INFO', 'DOCS', `[STEP 1/9] envoyerDocsProspect START — terme="${terme}" email="${emailDest||'(none)'}" fichier="${fichier||'TOUS'}" opts=${JSON.stringify({dealHint:!!opts.dealHint,centrisHint:opts.centrisHint||null,folderHint:opts.folderHint?.name||null,preview:!!opts.preview,cc:opts.cc||null})}`);
  // 1. Chercher deal — ou utiliser hint si fourni (auto-envoi)
  // FALLBACK bulletproof: si pas de deal Pipedrive OU pas de PD_KEY, on continue
  // quand même si on a un email + (Centris# ou adresse via opts.centrisHint / terme).
  let deal = null;
  if (opts.dealHint) {
    deal = opts.dealHint;
    log('INFO', 'DOCS', `[STEP 1/9] deal via hint: #${deal.id} "${deal.title}"`);
  } else if (PD_KEY) {
    try {
      const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
      const deals = sr?.data?.items || [];
      if (deals.length) deal = deals[0].item;
      log('INFO', 'DOCS', `[STEP 1/9] deal search Pipedrive: ${deals.length} résultat(s)${deal?` → #${deal.id} "${deal.title}"`:' (aucun)'}`);
    } catch (e) { log('WARN', 'DOCS', `[STEP 1/9] Pipedrive search ERREUR: ${e.message}`); }
  } else {
    log('WARN', 'DOCS', `[STEP 1/9] PD_KEY absent — skip search Pipedrive, fallback stub deal`);
  }
  const centris = (deal && deal[PD_FIELD_CENTRIS]) || opts.centrisHint || '';
  // Stub deal si pas trouvé mais email fourni → on peut quand même envoyer
  if (!deal) {
    const emailFromTerme = /@/.test(terme) ? terme.trim() : '';
    if (!emailDest && !emailFromTerme) {
      return `❌ Pas de deal Pipedrive "${terme}" ET pas d'email fourni.\nFournis: "envoie docs [nom] à email@exemple.com" OU crée le deal d'abord.`;
    }
    deal = { id: null, title: terme, [PD_FIELD_CENTRIS]: opts.centrisHint || '' };
  }

  // 2. Email destination
  let toEmail = emailDest || '';
  if (!toEmail && /@/.test(terme)) toEmail = terme.trim();
  if (!toEmail && deal.person_id) {
    try {
      const p = await pdGet(`/persons/${deal.person_id}`);
      toEmail = p?.data?.email?.find(e => e.primary)?.value || p?.data?.email?.[0]?.value || '';
    } catch (e) { log('WARN', 'DOCS', `[STEP 2/9] Pipedrive person fetch ERREUR: ${e.message}`); }
  }
  log('INFO', 'DOCS', `[STEP 2/9] email destination: ${toEmail || '(VIDE — listing-mode)'} | centris=${centris || '(none)'}`);

  // 3. Dossier Dropbox — folder hint (auto) ou fastDropboxMatch via index complet
  let folder = opts.folderHint || null;
  if (folder) {
    log('INFO', 'DOCS', `[STEP 3/9] folder via hint: "${folder.name}" (path=${folder.path})`);
  }
  if (!folder) {
    // Utilise l'index cross-source (Inscription + Terrain en ligne mergés)
    if (dropboxIndex.folders?.length) {
      const fast = fastDropboxMatch({ centris, adresse: deal.title || terme, rue: terme });
      if (fast) {
        folder = fast.folder;
        log('INFO', 'DOCS', `[STEP 3/9] folder via fastDropboxMatch: "${folder.name}" score=${fast.score} (path=${folder.path})`);
      } else {
        log('INFO', 'DOCS', `[STEP 3/9] fastDropboxMatch: aucun match dans index (${dropboxIndex.folders.length} folders indexés)`);
      }
    } else {
      log('WARN', 'DOCS', `[STEP 3/9] dropboxIndex VIDE — fallback dropboxTerrains`);
    }
  }
  if (!folder) {
    let dossiers = dropboxTerrains;
    if (!dossiers.length) {
      log('INFO', 'DOCS', `[STEP 3/9] dropboxTerrains vide — reload structure...`);
      await loadDropboxStructure();
      dossiers = dropboxTerrains;
    }
    folder = centris ? dossiers.find(d => d.centris === centris) : null;
    if (folder) {
      log('INFO', 'DOCS', `[STEP 3/9] folder via centris# ${centris}: "${folder.name}"`);
    }
    if (!folder) {
      const q = terme.toLowerCase().split(/\s+/)[0];
      folder = dossiers.find(d => d.name.toLowerCase().includes(q) || d.adresse.toLowerCase().includes(q));
      if (folder) log('INFO', 'DOCS', `[STEP 3/9] folder via terme "${q}": "${folder.name}"`);
    }
    if (!folder) {
      const avail = dossiers.slice(0, 5).map(d => d.adresse || d.name).join(', ');
      log('ERROR', 'DOCS', `[STEP 3/9] ❌ ABORT — aucun dossier Dropbox match (centris=${centris} terme="${terme}" ${dossiers.length} folders scannés)`);
      return `❌ Aucun dossier Dropbox pour "${deal.title}"${centris ? ` (#${centris})` : ''}.\nDisponible: ${avail}`;
    }
  }

  // 4. Lister TOUS les docs (PDFs + images + plans + Word/Excel) — triés Fiche_Detaillee en premier
  // Scan récursif: capture sous-dossiers Photos/, Plans/, Certificats/, etc.
  const lr = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: folder.path, recursive: true });
  if (!lr?.ok) {
    log('ERROR', 'DOCS', `[STEP 4/9] ❌ ABORT — Dropbox list_folder HTTP ${lr?.status || '?'} path=${folder.path}`);
    return `❌ Impossible de lire ${folder.name}`;
  }
  const all  = (await lr.json()).entries || [];
  const pdfs = _sortDocsPriority(all.filter(f => f['.tag'] === 'file' && DOC_EXTS.includes(_docExt(f.name))));
  log('INFO', 'DOCS', `[STEP 4/9] list_folder OK — ${all.length} entrées totales, ${pdfs.length} docs filtrés (${DOC_EXTS.join('/')})`);
  if (!pdfs.length) {
    log('ERROR', 'DOCS', `[STEP 4/9] ❌ ABORT — aucun doc dans "${folder.name}" (entrées: ${all.map(f => f.name).join(', ') || '(vide)'})`);
    return `❌ Aucun document dans *${folder.name}*.\nFichiers: ${all.map(f => f.name).join(', ') || '(vide)'}`;
  }

  // Si pas d'email, lister les docs disponibles
  if (!toEmail) {
    return `📁 *${folder.adresse || folder.name}*\nDocs (${pdfs.length}): ${pdfs.map(p => p.name).join(', ')}\n\n❓ Pas d'email pour *${deal.title}*.\nFournis: "email docs ${terme} à prenom@exemple.com"`;
  }

  // 5. Filtrer les docs à envoyer (si `fichier` spécifié → juste celui-là, sinon TOUS)
  const pdfsToSend = fichier
    ? pdfs.filter(p => p.name.toLowerCase().includes(fichier.toLowerCase()))
    : pdfs;
  log('INFO', 'DOCS', `[STEP 5/9] filtre "${fichier||'(TOUS)'}" → ${pdfsToSend.length}/${pdfs.length} docs à envoyer: ${pdfsToSend.map(p=>p.name).join(', ')}`);
  if (!pdfsToSend.length) {
    log('ERROR', 'DOCS', `[STEP 5/9] ❌ ABORT — aucun match pour filtre "${fichier}" (dispos: ${pdfs.map(p=>p.name).join(', ')})`);
    return `❌ Aucun document matchant "${fichier}" dans ${folder.name}.\nDisponibles: ${pdfs.map(p=>p.name).join(', ')}`;
  }

  // 6. Télécharger TOUS les PDFs en parallèle
  const _tDL = Date.now();
  const downloads = await Promise.all(pdfsToSend.map(async p => {
    const dl = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: p.path_lower }, true);
    if (!dl?.ok) return { name: p.name, error: `HTTP ${dl?.status || '?'}` };
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length === 0) return { name: p.name, error: 'fichier vide' };
    return { name: p.name, buffer: buf, size: buf.length };
  }));

  const rawOk = downloads.filter(d => d.buffer);
  const fails = downloads.filter(d => d.error);
  const dlMB = Math.round(rawOk.reduce((s,d)=>s+d.size,0)/1024/1024 * 10)/10;
  log('INFO', 'DOCS', `[STEP 6/9] Dropbox download — ${rawOk.length}/${downloads.length} OK (${dlMB}MB total, ${Date.now()-_tDL}ms)${fails.length?` | FAILS: ${fails.map(f=>`${f.name}:${f.error}`).join(', ')}`:''}`);
  if (!rawOk.length) {
    log('ERROR', 'DOCS', `[STEP 6/9] ❌ ABORT — tous téléchargements Dropbox échoués`);
    return `❌ Tous téléchargements Dropbox échoués:\n${fails.map(f => `  ${f.name}: ${f.error}`).join('\n')}`;
  }

  // 6. CONVERSION → PDF (images combinées, autres formats skipped)
  const convResult = await convertDocsToPDF(rawOk, folder.adresse || folder.name);
  const ok = convResult.docs;
  const convertedSkipped = convResult.skipped; // [{name, reason}]
  if (convResult.imagesMerged > 0) {
    log('OK', 'PDF', `${convResult.imagesMerged} image(s) → 1 PDF combiné (${folder.adresse || folder.name})`);
  }
  if (convertedSkipped.length > 0) {
    log('WARN', 'PDF', `${convertedSkipped.length} fichier(s) non convertibles skipped: ${convertedSkipped.map(s => s.name).join(', ')}`);
  }
  if (!ok.length) {
    return `❌ Après conversion, aucun PDF à envoyer.\nSkipped: ${convertedSkipped.map(s=>`${s.name} (${s.reason})`).join(', ')}`;
  }

  const totalSize = ok.reduce((s, d) => s + d.size, 0);
  if (totalSize > 24 * 1024 * 1024) {
    // Taille totale dépasse — garder les plus petits jusqu'à la limite
    ok.sort((a, b) => a.size - b.size);
    let acc = 0; const keep = [];
    for (const d of ok) { if (acc + d.size > 22 * 1024 * 1024) break; keep.push(d); acc += d.size; }
    const skipped = ok.length - keep.length;
    log('WARN', 'DOCS', `Total ${Math.round(totalSize/1024/1024)}MB > 24MB — ${skipped} PDF(s) omis, ${keep.length} envoyés`);
    ok.length = 0; ok.push(...keep);
  }

  // 7. Lire le master template Dropbox (logos Signature SB + RE/MAX base64)
  log('INFO', 'DOCS', `[STEP 7/9] Gmail token request...`);
  const token = await getGmailToken();
  if (!token) {
    log('ERROR', 'DOCS', `[STEP 7/9] ❌ ABORT — Gmail token null (refresh failed?). Docs prêts mais non envoyés.`);
    return `❌ Gmail non configuré.\nDocs dispo: ${ok.map(d=>d.name).join(', ')} dans ${folder.adresse || folder.name}`;
  }
  log('INFO', 'DOCS', `[STEP 7/9] Gmail token OK (${token.length} chars)`);

  const tplPath = `${AGENT.dbx_templates}/master_template_signature_sb.html`.replace(/\/+/g, '/');
  let masterTpl = null;
  try {
    const tplRes = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: tplPath.startsWith('/')?tplPath:'/'+tplPath }, true);
    if (tplRes?.ok) masterTpl = await tplRes.text();
  } catch (e) { log('WARN', 'DOCS', `Template Dropbox: ${e.message}`); }

  const propLabel = folder.adresse || folder.name;
  const now       = new Date();
  const dateMois  = now.toLocaleDateString('fr-CA', { month:'long', year:'numeric', timeZone:'America/Toronto' });

  // MODE PREVIEW — redirige vers shawn@ avec bandeau "pas encore envoyé"
  const previewMode   = !!opts.preview;
  const clientEmail   = previewMode ? (opts.preview.clientEmail || toEmail) : null;
  const clientName    = previewMode ? (opts.preview.clientName || '') : null;
  const realToEmail   = previewMode ? AGENT.email : toEmail;
  const sujet         = previewMode
    ? `[🔍 PREVIEW — pour ${clientName ? clientName + ' <' + clientEmail + '>' : clientEmail}] Documents — ${propLabel}`
    : `Documents — ${propLabel} | ${AGENT.compagnie}`;

  // Liste des pièces jointes en HTML
  const pjListHTML = ok.map(d =>
    `<tr><td style="padding:4px 0;color:#f5f5f7;font-size:13px;">📎 ${d.name} <span style="color:#666;font-size:11px;">(${Math.round(d.size/1024)} KB)</span></td></tr>`
  ).join('');

  // Infos conversion (preview seulement)
  const convInfo = previewMode ? (() => {
    const bits = [];
    if (convResult?.imagesMerged > 0) bits.push(`<div style="color:#7cb782;font-size:12px;margin-top:8px;">✅ ${convResult.imagesMerged} photo(s) combinée(s) en 1 PDF</div>`);
    if (convertedSkipped?.length > 0) {
      const list = convertedSkipped.slice(0, 8).map(s => `<div style="color:#e0a700;font-size:12px;margin-left:8px;">• ${s.name} <span style="color:#666">— ${s.reason}</span></div>`).join('');
      const more = convertedSkipped.length > 8 ? `<div style="color:#666;font-size:11px;margin-left:8px;">…et ${convertedSkipped.length - 8} autres</div>` : '';
      bits.push(`<div style="color:#e0a700;font-size:12px;margin-top:10px;font-weight:700;">⚠️ ${convertedSkipped.length} fichier(s) NON envoyé(s) (format non convertible):</div>${list}${more}`);
    }
    return bits.join('');
  })() : '';

  // Bandeau preview (injecté seulement en mode preview) — XSS-safe via escapeHtml
  const safeClientName  = escapeHtml(clientName || '');
  const safeClientEmail = escapeHtml(clientEmail || '');
  const previewBanner = previewMode ? `
<div style="background:#1a0a0a;border:2px solid #aa0721;border-radius:8px;padding:18px 20px;margin:0 0 20px;">
<div style="color:#aa0721;font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;margin-bottom:10px;">🔍 Preview — pas encore envoyé</div>
<div style="color:#f5f5f7;font-size:14px;line-height:1.6;margin-bottom:8px;">Voici <strong>exactement</strong> ce qui sera envoyé à <strong style="color:#aa0721;">${safeClientName} &lt;${safeClientEmail}&gt;</strong>.</div>
<div style="color:#cccccc;font-size:13px;line-height:1.6;">✅ Sur Telegram, réponds <code style="background:#000;padding:2px 8px;border-radius:3px;color:#aa0721;">envoie les docs à ${safeClientEmail}</code> pour livrer au client.<br>❌ Réponds <code style="background:#000;padding:2px 8px;border-radius:3px;color:#666;">annule ${safeClientEmail}</code> pour ignorer.</div>
${convInfo}
</div>` : '';

  // Contenu métier — injecté dans le master template à la place d'INTRO_TEXTE
  // NOTE: le master template Dropbox a DÉJÀ un bloc "Programme référence" à la fin,
  // donc on ne le duplique PAS ici.
  const safePropLabel = escapeHtml(propLabel);
  const contentHTML = `${previewBanner}
<p style="margin:0 0 16px;color:#cccccc;font-size:14px;line-height:1.7;">Veuillez trouver ci-joint la documentation concernant la propriété <strong style="color:#f5f5f7;">${safePropLabel}</strong>.</p>

<div style="background:#111111;border:1px solid #1e1e1e;border-radius:8px;padding:18px 20px;margin:16px 0;">
<div style="color:#aa0721;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">📎 Pièces jointes — ${ok.length} document${ok.length>1?'s':''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${pjListHTML}</table>
</div>

<p style="margin:16px 0;color:#cccccc;font-size:14px;line-height:1.6;">N'hésitez pas si vous avez des questions — je suis disponible au <strong style="color:#aa0721;">${AGENT.telephone}</strong>.</p>`;

  // Construire le HTML final
  let htmlFinal;
  if (masterTpl && masterTpl.length > 5000) {
    // Utiliser le master template Dropbox (avec logos base64 Signature SB + RE/MAX)
    const fill = (tpl, p) => { let h = tpl; for (const [k, v] of Object.entries(p)) h = h.split(`{{ params.${k} }}`).join(v ?? ''); return h; };
    htmlFinal = fill(masterTpl, {
      TITRE_EMAIL:        `Documents — ${propLabel}`,
      LABEL_SECTION:      `Documentation propriété`,
      DATE_MOIS:          dateMois,
      TERRITOIRES:        propLabel,
      SOUS_TITRE_ANALYSE: propLabel,
      HERO_TITRE:         `Documents<br>pour ${propLabel}.`,
      INTRO_TEXTE:        contentHTML,
      TITRE_SECTION_1:    '',
      MARCHE_LABEL:       '',
      PRIX_MEDIAN:        '',
      VARIATION_PRIX:     '',
      SOURCE_STAT:        '',
      LABEL_TABLEAU:      '',
      TABLEAU_STATS_HTML: '',
      TITRE_SECTION_2:    '',
      CITATION:           `Je reste disponible pour toute question concernant ce dossier.`,
      CONTENU_STRATEGIE:  '',
      CTA_TITRE:          `Des questions?`,
      CTA_SOUS_TITRE:     `Appelez-moi directement, je vous réponds rapidement.`,
      CTA_URL:            `tel:${AGENT.telephone.replace(/\D/g,'')}`,
      CTA_BOUTON:         `Appeler ${AGENT.prenom} — ${AGENT.telephone}`,
      CTA_NOTE:           `${AGENT.nom} · ${AGENT.titre} · ${AGENT.compagnie}`,
      REFERENCE_URL:      `tel:${AGENT.telephone.replace(/\D/g,'')}`,
      SOURCES:            `${AGENT.nom} · ${AGENT.titre} · ${AGENT.compagnie} · ${dateMois}`,
      DESINSCRIPTION_URL: '',
    });

    // Retirer les sections inutiles pour un email de docs (garder header, hero, intro, CTA, footer avec logos)
    // Supprime: SECTION 01, HERO STAT, TABLEAU, SECTION 02, CITATION
    htmlFinal = htmlFinal.replace(
      /<!-- ══ SÉPARATEUR ══ -->[\s\S]*?<!-- ══ CTA PRINCIPAL ══ -->/,
      '<!-- ══ CTA PRINCIPAL ══ -->'
    );
    // Remplacer le label "Données Centris Matrix" à côté du logo par la spécialité de Shawn
    htmlFinal = htmlFinal.replace(
      /Données Centris Matrix/g,
      'Spécialiste vente maison usagée, construction neuve et développement immobilier'
    );
    // PUNCH référencement — 500$ à 1 000$ en HERO stat 56px rouge pour maximiser conversion
    const refPunch = `
          <div style="color:#aa0721; font-size:10px; font-weight:700; letter-spacing:3px; text-transform:uppercase; margin-bottom:14px;">💰 Programme référence</div>
          <div style="font-family:Georgia,serif; font-size:20px; color:#f5f5f7; line-height:1.3; margin-bottom:18px;">
            Vous connaissez quelqu'un<br/>qui veut acheter ou vendre ?
          </div>
          <div style="font-family:Georgia,serif; font-size:56px; font-weight:800; color:#aa0721; line-height:1; margin:14px 0 6px; letter-spacing:-1px;">500$ <span style="color:#666;font-size:34px;font-weight:400;">à</span> 1 000$</div>
          <div style="color:#f5f5f7; font-size:13px; font-weight:700; letter-spacing:2px; text-transform:uppercase; margin-bottom:22px;">En argent · pour chaque référence conclue</div>
          <div style="color:#cccccc; font-size:13px; line-height:1.7; margin-bottom:22px;">Pas de paperasse — juste un appel.<br/>Payé à la signature chez le notaire.</div>
          <a href="tel:${AGENT.telephone.replace(/\D/g,'')}" style="display:inline-block; background-color:#aa0721; color:#ffffff; font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif; font-size:13px; font-weight:700; letter-spacing:2px; text-transform:uppercase; padding:15px 32px; border-radius:3px; text-decoration:none;">Référer quelqu'un</a>`;
    htmlFinal = htmlFinal.replace(
      /<!-- ══ PROGRAMME RÉFÉRENCE ══ -->[\s\S]*?<td style="background-color:#0d0d0d[^>]*>[\s\S]*?<\/td>/,
      `<!-- ══ PROGRAMME RÉFÉRENCE ══ -->
  <tr>
    <td style="padding:0 28px 40px;" class="mobile-pad">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
        <td style="background-color:#0d0d0d; border:1px solid #1e1e1e; border-top:4px solid #aa0721; border-radius:4px; padding:36px 28px; text-align:center;">${refPunch}
        </td>`
    );
    // CLEANUP placeholders Brevo non-remplacés quand envoi Gmail (pas Brevo)
    // Le template contient {{ contact.FIRSTNAME }} qui resterait littéral sans ça.
    // Règle pro: "Bonjour," tout court, jamais "Bonjour [Prénom]" ni contact.FIRSTNAME.
    htmlFinal = htmlFinal
      // "Bonjour {{ contact.X }}" → "Bonjour,"
      .replace(/Bonjour\s+\{\{\s*contact\.[A-Z_]+\s*\}\}[\s,]*/gi, 'Bonjour,')
      // "Bonjour {{ params.X }}" → "Bonjour," (si un placeholder params reste vide)
      .replace(/Bonjour\s+\{\{\s*params\.[A-Z_]+\s*\}\}[\s,]*/gi, 'Bonjour,')
      // "Cher/Chère/Dear {{ contact.X }}" → "Bonjour,"
      .replace(/(?:Cher|Chère|Dear)\s+\{\{\s*contact\.[A-Z_]+\s*\}\}[\s,]*/gi, 'Bonjour,')
      // Nettoyer tout autre {{ contact.X }} restant (silencieusement)
      .replace(/\{\{\s*contact\.[A-Z_]+\s*\}\}/gi, '')
      // Nettoyer les placeholders params non-remplis qui resteraient
      .replace(/\{\{\s*params\.[A-Z_]+\s*\}\}/gi, '')
      // Normaliser: "Bonjour  ," / "Bonjour ," → "Bonjour,"
      .replace(/Bonjour\s*,\s*/g, 'Bonjour, ')
      // Nettoyer virgules orphelines (ex: "à ,") et espaces doublés dans le texte
      .replace(/\s+,/g, ',').replace(/,\s*,/g, ',');
    log('OK', 'DOCS', `Master template Dropbox utilisé (${Math.round(masterTpl.length/1024)}KB avec logos) — sections vides retirées + label logo personnalisé + punch référencement + placeholders client strippés`);
  } else {
    // Fallback HTML inline brandé si Dropbox template indisponible
    htmlFinal = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;background:#0a0a0a;">
<table width="600" style="max-width:600px;background:#0a0a0a;color:#f5f5f7;">
<tr><td style="background:${AGENT.couleur};height:4px;font-size:1px;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 20px;">
<div style="color:${AGENT.couleur};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${AGENT.compagnie}</div>
<h2 style="color:#f5f5f7;font-size:22px;margin:10px 0 4px;">${AGENT.nom}</h2>
<div style="color:#999;font-size:13px;font-style:italic;">${AGENT.titre}</div>
</td></tr>
<tr><td style="padding:0 32px 20px;">${contentHTML}
<div style="margin:28px 0 0;padding-top:20px;border-top:1px solid #1a1a1a;color:#f5f5f7;font-size:14px;line-height:1.7;">
Au plaisir,<br>
<strong style="color:#f5f5f7;">${AGENT.nom}</strong><br>
<span style="color:#cccccc;">${AGENT.titre} | ${AGENT.compagnie}</span><br>
<span style="color:#cccccc;">📞 <a href="tel:${AGENT.telephone.replace(/\D/g,'')}" style="color:${AGENT.couleur};text-decoration:none;">${AGENT.telephone}</a></span><br>
<a href="mailto:${AGENT.email}" style="color:${AGENT.couleur};text-decoration:none;">${AGENT.email}</a>
</div>
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #1a1a1a;color:#666;font-size:12px;">
<strong>${AGENT.nom}</strong> · ${AGENT.titre} · ${AGENT.compagnie}<br>
📞 ${AGENT.telephone} · <a href="mailto:${AGENT.email}" style="color:${AGENT.couleur};">${AGENT.email}</a> · <a href="https://${AGENT.site}" style="color:${AGENT.couleur};">${AGENT.site}</a>
</td></tr>
<tr><td style="background:${AGENT.couleur};height:4px;font-size:1px;">&nbsp;</td></tr>
</table></td></tr></table></body></html>`;
    log('WARN', 'DOCS', 'Master template Dropbox indisponible — fallback HTML inline');
  }

  // 8. Construire MIME multipart avec TOUS les PDFs
  const outer = `sbOut${Date.now()}`;
  const inner = `sbAlt${Date.now()}`;
  const enc   = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  const textBody = `Bonjour,\n\nVeuillez trouver ci-joint ${ok.length} document${ok.length>1?'s':''} concernant ${propLabel}:\n${ok.map(d=>`• ${d.name}`).join('\n')}\n\nN'hésitez pas si vous avez des questions — ${AGENT.telephone}.\n\nAu plaisir,\n${AGENT.nom}\n${AGENT.titre} | ${AGENT.compagnie}\n📞 ${AGENT.telephone}\n${AGENT.email}`;

  // CC — shawn@ TOUJOURS en Cc visible (le client voit le courtier copié — demande Shawn 2026-04-23)
  // + CCs explicites fournis par opts.cc (julie@, autres) restent aussi en Cc visible
  // Exception: en preview mode, pas de Cc (shawn@ est déjà le To)
  const ccUserRaw = opts.cc;
  const ccUser = !ccUserRaw ? [] : (Array.isArray(ccUserRaw) ? ccUserRaw : String(ccUserRaw).split(',')).map(s => String(s).trim()).filter(Boolean);
  const ccFinal = previewMode
    ? []
    : [...new Set([AGENT.email, ...ccUser].filter(e => e && e.toLowerCase() !== realToEmail.toLowerCase()))];
  const ccLine = ccFinal.length ? [`Cc: ${ccFinal.join(', ')}`] : [];

  const lines = [
    `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
    `To: ${realToEmail}`,
    ...ccLine,
    `Reply-To: ${AGENT.email}`,
    `Subject: ${enc(sujet)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    '',
    `--${inner}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    textBody,
    '',
    `--${inner}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(htmlFinal, 'utf-8').toString('base64'),
    `--${inner}--`,
    '',
  ];

  // Ajouter chaque document comme pièce jointe (Content-Type dynamique selon extension)
  for (const doc of ok) {
    lines.push(
      `--${outer}`,
      `Content-Type: ${_docContentType(doc.name)}`,
      `Content-Disposition: attachment; filename="${enc(doc.name)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      doc.buffer.toString('base64'),
      ''
    );
  }
  lines.push(`--${outer}--`);

  const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  // Envoi via sendEmailLogged → traçabilité intent + outcome dans email_outbox.json
  const rawSizeMB = Math.round(raw.length/1024/1024 * 10)/10;
  log('INFO', 'DOCS', `[STEP 8/9] Gmail send → to=${realToEmail} cc=[${ccFinal.join(',')}] subject="${sujet.substring(0,80)}" raw=${rawSizeMB}MB preview=${previewMode}`);
  const _tGM = Date.now();
  const logged = await sendEmailLogged({
    via: 'gmail',
    to: realToEmail,
    cc: ccFinal,
    subject: sujet,
    category: previewMode ? 'envoyerDocsProspect-preview' : 'envoyerDocsProspect',
    shawnConsent: !!opts._shawnConsent || previewMode, // preview va à shawn@ donc consent implicite
    sendFn: async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      try {
        return await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }),
        });
      } finally { clearTimeout(t); }
    },
  });
  if (!logged.ok) {
    log('ERROR', 'DOCS', `[STEP 8/9] ❌ Gmail FAIL ${logged.status||'?'} (${Date.now()-_tGM}ms) — ${(logged.error||'').substring(0,200)}`);
    return `❌ Gmail erreur ${logged.status || ''}: ${(logged.error || '').substring(0, 200)}`;
  }
  log('OK', 'DOCS', `[STEP 8/9] ✅ Gmail send OK (${Date.now()-_tGM}ms) — message envoyé à ${realToEmail}`);

  // 9. Note Pipedrive — skip en mode preview (c'est juste un preview, pas une vraie livraison)
  const skippedMsg = fails.length > 0 ? `\n⚠️ ${fails.length} doc(s) échec téléchargement: ${fails.map(f=>f.name).join(', ')}` : '';
  const convMsg = convResult?.imagesMerged > 0 ? `\n✅ ${convResult.imagesMerged} photo(s) combinée(s) en 1 PDF` : '';
  const convSkipMsg = convertedSkipped?.length > 0 ? `\n⚠️ ${convertedSkipped.length} fichier(s) non convertible(s) skipped: ${convertedSkipped.map(s=>s.name).join(', ')}` : '';
  if (previewMode) {
    log('OK', 'DOCS', `PREVIEW envoyé à ${realToEmail} (${ok.length} docs, pour client ${clientEmail})`);
    return `✅ *PREVIEW envoyé* à *${realToEmail}*\n   Aperçu de ce qui sera envoyé à *${clientEmail}*\n   ${ok.length} pièce${ok.length>1?'s':''} jointe${ok.length>1?'s':''}: ${ok.map(d=>d.name).join(', ')}${convMsg}${convSkipMsg}${skippedMsg}`;
  }
  const noteContent = `Documents envoyés à ${realToEmail} (${new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}):\n${ok.map(d => `• ${d.name}`).join('\n')}${convResult?.imagesMerged > 0 ? `\n(${convResult.imagesMerged} photos combinées en 1 PDF)` : ''}${convertedSkipped?.length > 0 ? `\nFichiers non convertibles skipped: ${convertedSkipped.map(s=>s.name).join(', ')}` : ''}`;
  // IDEMPOTENCY: vérifier si une note "Documents envoyés à <email>" existe
  // déjà dans les 24h pour ce deal — évite 3 notes identiques si retry.
  let skipNote = false;
  if (deal.id) {
    try {
      const existing = await pdGet(`/deals/${deal.id}/flow?limit=20`).catch(() => null);
      const items = existing?.data || [];
      const dayAgo = Date.now() - 24 * 3600 * 1000;
      const dupFound = items.some(it => {
        const c = it?.data?.content || it?.data?.note || '';
        const ts = new Date(it?.data?.add_time || 0).getTime();
        return ts > dayAgo && c.includes(`Documents envoyés à ${realToEmail}`);
      });
      if (dupFound) { skipNote = true; log('INFO', 'PIPEDRIVE', `Note idempotent: existe déjà <24h pour ${realToEmail} deal #${deal.id}`); }
    } catch { /* best-effort, fall through */ }
  }
  const noteRes = skipNote ? null : await pdPost('/notes', { deal_id: deal.id, content: noteContent }).catch(() => null);
  const noteLabel = skipNote
    ? '📝 Note Pipedrive skip (existe déjà <24h)'
    : (noteRes?.data?.id ? '📝 Note Pipedrive ajoutée' : '⚠️ Note Pipedrive non créée');
  log('OK', 'DOCS', `[STEP 9/9] ✅ DONE (${Date.now()-_t0}ms total) — ${ok.length} doc(s) envoyés à ${realToEmail} | note=${skipNote?'skip-dup':(noteRes?.data?.id?'created':'fail')}`);

  return `✅ *${ok.length} document${ok.length>1?'s':''} envoyé${ok.length>1?'s':''}* à *${realToEmail}*\n${ok.map(d=>`  📎 ${d.name}`).join('\n')}\nProspect: ${deal.title}\n${noteLabel}${convMsg}${convSkipMsg}${skippedMsg}`;
}

// ─── Brevo ────────────────────────────────────────────────────────────────────
const BREVO_LISTES = { prospects: 4, acheteurs: 5, vendeurs: 7 };

async function ajouterBrevo({ email, prenom, nom, telephone, liste }) {
  if (!BREVO_KEY) return '❌ BREVO_API_KEY absent';
  if (!email) return '❌ Email requis pour Brevo';
  const listeId = BREVO_LISTES[liste] || BREVO_LISTES.prospects;
  const attributes = { FIRSTNAME: prenom || '', LASTNAME: nom || '' };
  if (telephone) attributes.SMS = telephone.replace(/\D/g, '');
  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, updateEnabled: true, attributes, listIds: [listeId] })
    });
    if (!res.ok) { const err = await res.text(); return `❌ Brevo: ${err.substring(0, 200)}`; }
    const listeNom = { 4: 'Prospects', 5: 'Acheteurs', 7: 'Vendeurs' }[listeId] || 'liste';
    return `✅ ${prenom || email} ajouté à Brevo — liste ${listeNom}.`;
  } catch (e) { return `❌ Brevo: ${e.message}`; }
}

async function envoyerEmailBrevo({ to, toName, subject, textContent, htmlContent }) {
  if (!BREVO_KEY) return false;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: { name: `${AGENT.nom} · ${AGENT.compagnie}`, email: AGENT.email }, replyTo: { email: AGENT.email, name: AGENT.nom }, to: [{ email: to, name: toName || to }], subject, textContent: textContent || '', htmlContent: htmlContent || textContent || '' })
  });
  return res.ok;
}

// ─── Gmail ────────────────────────────────────────────────────────────────────
let gmailToken = null;
let gmailTokenExp = 0;
let gmailRefreshInProgress = null;

async function getGmailToken() {
  const { GMAIL_CLIENT_ID: cid, GMAIL_CLIENT_SECRET: csec, GMAIL_REFRESH_TOKEN: ref } = process.env;
  if (!cid || !csec || !ref) return null;
  if (gmailToken && Date.now() < gmailTokenExp - 60000) return gmailToken;
  // Attendre si refresh déjà en cours — retourner null si ça échoue (pas throw)
  if (gmailRefreshInProgress) {
    try { return await gmailRefreshInProgress; } catch { return null; }
  }
  gmailRefreshInProgress = (async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: ref, grant_type: 'refresh_token' })
      });
      const data = await res.json();
      if (!data.access_token) throw new Error(`Pas de access_token: ${JSON.stringify(data).substring(0,100)}`);
      gmailToken    = data.access_token;
      gmailTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
      log('OK', 'GMAIL', 'Token rafraîchi ✓');
      return gmailToken;
    } catch (e) {
      log('ERR', 'GMAIL', `Refresh fail: ${e.message}`);
      gmailToken = null; gmailTokenExp = 0;
      return null; // retourner null plutôt que throw — évite crash cascade
    } finally { clearTimeout(t); gmailRefreshInProgress = null; }
  })();
  try { return await gmailRefreshInProgress; } catch { return null; }
}

async function gmailAPI(endpoint, options = {}) {
  const token = await getGmailToken();
  if (!token) throw new Error('Gmail non configuré (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN manquants)');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${endpoint}`, {
      ...options, signal: controller.signal,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Gmail ${endpoint}: ${err.substring(0, 200)}`); }
    return res.json();
  } finally { clearTimeout(t); }
}

function gmailDecodeBase64(str) {
  try { return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'); } catch { return ''; }
}

// Walk récursif TOUS les MIME parts — collecte text/plain ET text/html
// Handle nested multipart (multipart/alternative inside multipart/mixed, etc.)
function gmailWalkParts(payload, acc = { plain: '', html: '' }) {
  if (!payload) return acc;
  const m = payload.mimeType || '';
  if (m === 'text/plain' && payload.body?.data) {
    const t = gmailDecodeBase64(payload.body.data);
    if (t && !acc.plain) acc.plain = t;
  } else if (m === 'text/html' && payload.body?.data) {
    const t = gmailDecodeBase64(payload.body.data);
    if (t && !acc.html) acc.html = t;
  }
  if (Array.isArray(payload.parts)) {
    for (const p of payload.parts) gmailWalkParts(p, acc);
  }
  return acc;
}

// Retourne le meilleur body pour parsing: text/plain prioritaire, sinon html nettoyé,
// sinon snippet. Stripe balises HTML, décode entités, squeeze whitespace.
function gmailExtractBody(payload) {
  if (!payload) return '';
  const { plain, html } = gmailWalkParts(payload);
  if (plain && plain.length > 20) return plain;
  if (html) {
    return html
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>|<\/div>|<\/tr>|<\/td>|<\/li>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
      .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
  if (plain) return plain;
  return payload.snippet || '';
}

// Retourne les 2 bodies séparés (plain + html) pour l'AI parser — plus de contexte
function gmailExtractAllBodies(payload) {
  if (!payload) return { plain: '', html: '' };
  return gmailWalkParts(payload);
}

async function voirEmailsRecents(depuis = '1d') {
  try {
    const q = `-from:signaturesb.com -from:shawnbarrette@icloud.com -from:noreply@ -from:no-reply@ -from:brevo -from:pipedrive -from:calendly in:inbox newer_than:${depuis}`;
    const list = await gmailAPI(`/messages?maxResults=10&q=${encodeURIComponent(q)}`);
    if (!list.messages?.length) return `Aucun email prospect dans les dernières ${depuis}.`;
    const emails = await Promise.all(list.messages.slice(0, 6).map(async m => {
      try {
        const d = await gmailAPI(`/messages/${m.id}?format=full`);
        const headers = d.payload?.headers || [];
        const get = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
        return `📧 *De:* ${get('From')}\n*Objet:* ${get('Subject')}\n*Date:* ${get('Date')}\n_${d.snippet?.substring(0, 150) || ''}_`;
      } catch { return null; }
    }));
    return `📬 *Emails prospects récents (${depuis}):*\n\n` + emails.filter(Boolean).join('\n\n---\n\n');
  } catch (e) {
    if (e.message.includes('non configuré')) return '⚠️ Gmail non configuré dans Render. Ajoute: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.';
    return `Erreur Gmail: ${e.message}`;
  }
}

async function voirConversation(terme) {
  try {
    const t = terme.includes('@') ? terme : (terme.includes(' ') ? `"${terme}"` : terme);
    const [recu, envoye] = await Promise.all([
      gmailAPI(`/messages?maxResults=4&q=${encodeURIComponent(`from:${t} newer_than:30d`)}`).catch(() => ({ messages: [] })),
      gmailAPI(`/messages?maxResults=4&q=${encodeURIComponent(`to:${t} newer_than:30d in:sent`)}`).catch(() => ({ messages: [] }))
    ]);
    const ids = [
      ...(recu.messages  || []).map(m => ({ id: m.id, sens: '📥 Reçu' })),
      ...(envoye.messages || []).map(m => ({ id: m.id, sens: '📤 Envoyé' }))
    ];
    if (!ids.length) return `Aucun échange Gmail avec "${terme}" dans les 30 derniers jours.`;
    const emails = await Promise.all(ids.slice(0, 5).map(async ({ id, sens }) => {
      try {
        const d = await gmailAPI(`/messages/${id}?format=full`);
        const headers = d.payload?.headers || [];
        const get = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
        const corps = gmailExtractBody(d.payload).substring(0, 600).trim();
        const dateMs = parseInt(d.internalDate || '0');
        return { sens, de: get('From'), sujet: get('Subject'), date: get('Date'), corps, dateMs };
      } catch { return null; }
    }));
    const sorted = emails.filter(Boolean).sort((a, b) => a.dateMs - b.dateMs); // chronologique
    let result = `📧 *Conversation avec "${terme}" (30 derniers jours):*\n\n`;
    for (const e of sorted) {
      result += `${e.sens} | *${e.sujet}*\n${e.date}\n${e.corps ? `_${e.corps}_` : ''}\n\n`;
    }
    return result.trim();
  } catch (e) {
    if (e.message.includes('non configuré')) return '⚠️ Gmail non configuré dans Render.';
    return `Erreur Gmail: ${e.message}`;
  }
}

async function envoyerEmailGmail({ to, toName, sujet, texte }) {
  const token = await getGmailToken();
  if (!token) throw new Error('Gmail non configuré — vérifier GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN dans Render');

  // HTML branded dynamique (utilise AGENT_CONFIG)
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:600px;margin:0 auto;padding:20px;">
<div style="border-top:3px solid ${AGENT.couleur};padding-top:16px;">
${texte.split('\n').map(l => l.trim() ? `<p style="margin:0 0 12px;">${l}</p>` : '<br>').join('')}
</div>
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;color:#666;font-size:12px;">
<strong>${AGENT.nom}</strong> · ${AGENT.compagnie}<br>
📞 ${AGENT.telephone} · <a href="https://${AGENT.site}" style="color:${AGENT.couleur};">${AGENT.site}</a>
</div>
</body></html>`;

  const boundary  = `sb_${Date.now()}`;
  const toHeader  = toName ? `${toName} <${to}>` : to;
  const encSubj   = s => {
    // Encoder chaque mot si nécessaire (robuste pour sujets longs)
    const b64 = Buffer.from(s, 'utf-8').toString('base64');
    return `=?UTF-8?B?${b64}?=`;
  };

  const msgLines = [
    `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
    `To: ${toHeader}`,
    `Bcc: ${AGENT.email}`,
    `Reply-To: ${AGENT.email}`,
    `Subject: ${encSubj(sujet)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    texte,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf-8').toString('base64'),
    `--${boundary}--`,
  ];

  const raw = Buffer.from(msgLines.join('\r\n'), 'utf-8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmailAPI('/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
}

// ─── Réponse rapide mobile (trouve email auto + brouillon) ────────────────────
async function repondreVite(chatId, terme, messageTexte) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `❌ Prospect "${terme}" introuvable dans Pipedrive.`;
  const deal = deals[0].item;

  // Trouver l'email
  let toEmail = '', toName = deal.title;
  if (deal.person_id) {
    const p = await pdGet(`/persons/${deal.person_id}`);
    toEmail  = p?.data?.email?.find(e => e.primary)?.value || p?.data?.email?.[0]?.value || '';
    toName   = p?.data?.name || deal.title;
  }
  if (!toEmail) return `❌ Pas d'email pour *${deal.title}* dans Pipedrive.\nAjoute-le via "modifie deal ${terme} email [adresse]" ou crée la personne.`;

  // Mettre en forme selon style Shawn
  const texteFormate = messageTexte.trim().endsWith(',')
    ? messageTexte.trim()
    : messageTexte.trim();
  const sujet = `${deal.title} — ${AGENT.compagnie}`;

  // Stocker comme brouillon en attente
  pendingEmails.set(chatId, { to: toEmail, toName, sujet, texte: texteFormate });

  return `📧 *Brouillon prêt pour ${deal.title}*\nDest: ${toEmail}\n\n---\n${texteFormate}\n---\n\nDis *"envoie"* pour confirmer.`;
}

// ─── Historique complet d'un prospect (timeline mobile-friendly) ──────────────
async function historiqueContact(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `Aucun prospect "${terme}"`;
  const deal = deals[0].item;

  const [notes, activities, person] = await Promise.all([
    pdGet(`/notes?deal_id=${deal.id}&limit=20`),
    pdGet(`/deals/${deal.id}/activities?limit=20`),
    deal.person_id ? pdGet(`/persons/${deal.person_id}`) : Promise.resolve(null),
  ]);

  // Construire timeline unifiée
  const events = [];

  // Notes
  (notes?.data || []).forEach(n => {
    if (!n.content?.trim()) return;
    events.push({ ts: new Date(n.add_time).getTime(), type: '📝', text: n.content.trim().substring(0, 150), date: n.add_time });
  });

  // Activités
  (activities?.data || []).forEach(a => {
    const done = a.done ? '✅' : (new Date(`${a.due_date}T${a.due_time||'23:59'}`).getTime() < Date.now() ? '⚠️' : '🔲');
    events.push({ ts: new Date(a.due_date || a.add_time).getTime(), type: done, text: `${a.subject || a.type} (${a.type})`, date: a.due_date || a.add_time });
  });

  // Trier chronologique
  events.sort((a, b) => b.ts - a.ts);

  const stageLabel = PD_STAGES[deal.stage_id] || deal.stage_id;
  const phones = person?.data?.phone?.filter(p => p.value).map(p => p.value) || [];
  const emails = person?.data?.email?.filter(e => e.value).map(e => e.value) || [];

  let txt = `📋 *Historique — ${deal.title}*\n${stageLabel}\n`;
  if (phones.length) txt += `📞 ${phones.join(' · ')}\n`;
  if (emails.length) txt += `✉️ ${emails.join(' · ')}\n`;
  txt += `\n`;

  if (!events.length) return txt + '_Aucun historique._';
  events.slice(0, 10).forEach(e => {
    const date = new Date(e.date).toLocaleDateString('fr-CA', { day:'numeric', month:'short' });
    txt += `${e.type} [${date}] ${e.text}\n`;
  });
  if (events.length > 10) txt += `\n_+ ${events.length - 10} événements plus anciens_`;
  return txt.trim();
}

// ─── CERVEAU STRATÉGIQUE — analyseStrategique() ───────────────────────────
// Utilise Claude Opus 4.8 (le modèle le plus intelligent) pour analyser
// pipeline Pipedrive + audit log leads + mémoire stratégique + ventes passées.
// Génère un rapport d'insights + 3-5 actions concrètes priorisées.
// Cron dimanche 7am + ad-hoc via /analyse [question].
async function analyseStrategique(question) {
  if (!API_KEY) return '❌ ANTHROPIC_API_KEY requis';
  if (!PD_KEY)  return '❌ PIPEDRIVE_API_KEY requis';

  // 1. Collecte data en parallèle
  const [actifs, gagnes, perdus] = await Promise.all([
    pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`).catch(() => null),
    pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=won&limit=50`).catch(() => null),
    pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=lost&limit=50`).catch(() => null),
  ]);
  const dealsActifs = actifs?.data || [];
  const dealsGagnes = gagnes?.data || [];
  const dealsPerdus = perdus?.data || [];
  const now = Date.now();

  // 2. Préparer données condensées (max 40K tokens input pour Opus)
  const summarize = d => ({
    title: d.title?.substring(0, 60),
    stage: d.stage_id,
    value: d.value || 0,
    add_ago_days: d.add_time ? Math.floor((now - new Date(d.add_time).getTime()) / 86400000) : null,
    last_act_ago_days: d.last_activity_date ? Math.floor((now - new Date(d.last_activity_date).getTime()) / 86400000) : null,
    notes_count: d.notes_count || 0,
    activities_count: d.activities_count || 0,
    centris: d[PD_FIELD_CENTRIS] || null,
    type: d[PD_FIELD_TYPE] || null,
  });
  const data = {
    dealsActifs: dealsActifs.map(summarize),
    dealsGagnes30j: dealsGagnes.filter(d => {
      const t = d.close_time || d.won_time;
      return t && (now - new Date(t).getTime()) < 30 * 86400000;
    }).map(summarize),
    dealsGagnes90j: dealsGagnes.filter(d => {
      const t = d.close_time || d.won_time;
      return t && (now - new Date(t).getTime()) < 90 * 86400000;
    }).map(summarize),
    dealsPerdus30j: dealsPerdus.filter(d => {
      const t = d.lost_time;
      return t && (now - new Date(t).getTime()) < 30 * 86400000;
    }).map(summarize),
    leadsRecents: (auditLog || []).filter(e => e.category === 'lead').slice(-50).map(e => ({
      decision: e.details?.decision,
      source: e.details?.source,
      at: e.at,
      score: e.details?.match?.score,
      auto_validated: !!e.details?.match?.found,
    })),
    memoryFacts: (kiramem?.facts || []).slice(-100), // 100 derniers facts catégorisés
  };

  const stages = '49=Nouveau · 50=Contacté · 51=En discussion · 52=Visite prévue · 53=Visite faite · 54=Offre déposée · 55=Gagné';
  const promptUser = question
    ? `Question stratégique du courtier: ${question}\n\nUtilise les données ci-dessous pour répondre de façon actionnable.`
    : `Génère le rapport stratégique HEBDOMADAIRE pour ${AGENT.nom}, courtier ${AGENT.compagnie} en ${AGENT.region}.

Format attendu (court, actionnable, en français québécois):

🎯 BIG PICTURE (2 lignes)
État global du pipeline et tendance.

🔥 TOP 3 OPPORTUNITÉS (à pousser cette semaine)
Pour chacune: nom deal + raison spécifique + action concrète.

⚠️ TOP 3 RISQUES (à régler avant qu'on les perde)
Pour chacune: nom deal + pourquoi à risque + action.

📊 PATTERNS DÉTECTÉS (insights tirés des données)
Ce que les chiffres révèlent (ex: meilleure source, type qui convertit, prix qui marchent...).

⚡ 5 ACTIONS PRIORISÉES POUR LA SEMAINE
Ordonnées par impact ventes immédiat. Spécifiques (qui/quoi/quand).

Sois DIRECT et concis. Pas de blabla. Format Markdown.`;

  const stageInfo = `Pipeline ID ${AGENT.pipeline_id}: ${stages}`;
  const dataJson = JSON.stringify(data, null, 0).substring(0, 80000);

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-8', // INTELLIGENCE MAXIMALE pour analyse stratégique
        max_tokens: 2000,
        system: `Tu es l'analyste stratégique senior de ${AGENT.nom}, courtier RE/MAX en ${AGENT.region}. Tu connais le marché immobilier québécois (terrains, plexs, maisons usagées, construction neuve). Spécialités: ${AGENT.specialites}.\n\n${stageInfo}\n\nTu as accès à TOUTES les données du pipeline + leads récents + mémoire catégorisée. Ton job: identifier les patterns, prioriser les actions, augmenter les ventes. Sois direct, actionnable, précis. Tutoiement.`,
        messages: [
          { role: 'user', content: `${promptUser}\n\n━━ DONNÉES ━━\n${dataJson}` },
        ],
      }),
    });
    clearTimeout(t);
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      return `❌ Opus ${res.status}: ${err.substring(0, 200)}`;
    }
    const data2 = await res.json();
    if (data2.usage) trackCost('claude-opus-4-8', data2.usage);
    const reply = data2.content?.[0]?.text?.trim() || '(vide)';
    auditLogEvent('strategic-analysis', question ? 'ad-hoc' : 'weekly', { tokens_in: data2.usage?.input_tokens, tokens_out: data2.usage?.output_tokens });
    return reply;
  } catch (e) {
    clearTimeout(t);
    return `❌ Analyse stratégique: ${e.message?.substring(0, 200)}`;
  }
}

// ─── Whisper (voix → texte) ───────────────────────────────────────────────────
// Prompt OPTIMISÉ pour reconnaissance vocabulaire Shawn: termes immobilier QC,
// noms locaux, marques partenaires, expressions courantes courtier, commandes
// du bot. Whisper utilise ce prompt comme "biais" — augmente précision sur ces
// mots-clés quand ils sont prononcés. Limite OpenAI: 224 tokens max prompt.
const WHISPER_PROMPT_BASE =
  // Métier + commandes courantes Shawn
  `Shawn Barrette, courtier RE/MAX Prestige Rawdon, Lanaudière. ` +
  `Commandes bot: envoie les docs à, annule, info Centris, cherche, scrape, pdf, today, diagnose. ` +
  // Acteurs partenaires
  `Julie Lemieux assistante, ProFab Jordan Brouillette, Desjardins, Centris, RE/MAX Québec, OACIQ, AMF, APCIQ. ` +
  // Termes immobilier QC
  `terrain, plex, duplex, triplex, maison usagée, construction neuve, fosse septique, puits artésien, ` +
  `marge latérale, bande riveraine, certificat de localisation, TPS TVQ, mise de fonds, hypothèque, préapprobation, ` +
  `inscription, fiche descriptive, offre d'achat acceptée, contre-proposition, courtier inscripteur, courtier collaborateur, ` +
  // Lieux fréquents Lanaudière + Rive-Nord
  `Rawdon, Sainte-Julienne, Saint-Calixte, Chertsey, Saint-Jean-de-Matha, Saint-Didace, Joliette, Berthierville, ` +
  `Mascouche, Terrebonne, Repentigny, Saint-Donat, Saint-Côme, Notre-Dame-de-la-Merci, Entrelacs, MRC Matawinie, MRC D'Autray.`;

// Post-correction commune (Whisper + AssemblyAI ont tendance à mal entendre les noms locaux)
function _postCorrigerTranscription(text) {
  if (!text) return text;
  return text
    .replace(/\bSente Julienne\b/gi, 'Sainte-Julienne')
    .replace(/\bSainte Julienne\b/gi, 'Sainte-Julienne')
    .replace(/\bRedon\b/gi, 'Rawdon').replace(/\bReadon\b/gi, 'Rawdon')
    .replace(/\bCentrice\b/gi, 'Centris').replace(/\bcentriste?\b/gi, 'Centris')
    .replace(/\bpipe drive\b/gi, 'Pipedrive')
    .replace(/\bpro fab\b/gi, 'ProFab')
    .replace(/\bdesjardin\b/gi, 'Desjardins')
    .replace(/\bre max\b/gi, 'RE/MAX')
    .replace(/\bmatawini\b/gi, 'Matawinie')
    .replace(/\bdupropraio\b/gi, 'DuProprio');
}

// ─── AssemblyAI transcription (provider primaire, 5h/mois gratuit) ───────────
async function _transcrireAssemblyAI(audioBuffer, opts = {}) {
  const key = process.env.ASSEMBLYAI_API_KEY;
  if (!key) throw new Error('ASSEMBLYAI_API_KEY absent');
  // 1. Upload audio bytes (raw binary, pas multipart)
  const uploadRes = await fetch('https://api.assemblyai.com/v2/upload', {
    method: 'POST',
    headers: { 'Authorization': key, 'Content-Type': 'application/octet-stream' },
    body: audioBuffer,
    signal: AbortSignal.timeout(45000),
  });
  if (!uploadRes.ok) {
    const err = await uploadRes.text().catch(() => '');
    throw new Error(`AssemblyAI upload ${uploadRes.status}: ${err.substring(0, 120)}`);
  }
  const { upload_url } = await uploadRes.json();
  // 2. Submit transcript request (fr, prompt boost noms)
  const submitBody = {
    audio_url: upload_url,
    speech_models: ['universal-3-pro', 'universal-2'],
    language_code: 'fr',
  };
  if (opts.recentContext) {
    // keyterms_prompt: jusqu'à 1000 termes avec U3 Pro
    submitBody.keyterms_prompt = String(opts.recentContext).split(/[,\s]+/).filter(Boolean).slice(0, 50);
  }
  const submitRes = await fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { 'Authorization': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(submitBody),
    signal: AbortSignal.timeout(15000),
  });
  if (!submitRes.ok) {
    const err = await submitRes.text().catch(() => '');
    throw new Error(`AssemblyAI submit ${submitRes.status}: ${err.substring(0, 120)}`);
  }
  const { id } = await submitRes.json();
  // 3. Poll until completed (max 90s, audio courts = ~5-15s)
  const start = Date.now();
  while (Date.now() - start < 90000) {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { 'Authorization': key },
      signal: AbortSignal.timeout(10000),
    });
    if (!pollRes.ok) continue;
    const data = await pollRes.json();
    if (data.status === 'completed') return data.text?.trim() || null;
    if (data.status === 'error') throw new Error(`AssemblyAI transcript error: ${data.error || 'unknown'}`);
  }
  throw new Error('AssemblyAI transcription timeout (90s)');
}

// ─── OpenAI Whisper transcription (fallback) ─────────────────────────────────
async function _transcrireWhisper(audioBuffer, opts = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY absent');
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
  formData.append('model', 'whisper-1');
  formData.append('language', 'fr');
  let prompt = WHISPER_PROMPT_BASE;
  if (opts.recentContext) {
    const ctx = opts.recentContext.substring(0, 200);
    prompt = (prompt + ' ' + ctx).substring(0, 1000);
  }
  formData.append('prompt', prompt);
  formData.append('temperature', '0');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST', headers: { 'Authorization': `Bearer ${key}` }, body: formData,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) { const err = await res.text(); throw new Error(`Whisper HTTP ${res.status}: ${err.substring(0, 150)}`); }
  const data = await res.json();
  return data.text?.trim() || null;
}

async function transcrire(audioBuffer, opts = {}) {
  if (audioBuffer.length > 24 * 1024 * 1024) throw new Error('Message vocal trop long (max ~15 min)');
  // Provider hiérarchie (Shawn 2026-05-13): AssemblyAI primaire (5h/mois gratuit), Whisper fallback
  const hasAAI = !!process.env.ASSEMBLYAI_API_KEY;
  const hasOAI = !!process.env.OPENAI_API_KEY;
  if (!hasAAI && !hasOAI) throw new Error('Aucun provider transcription configuré (ASSEMBLYAI_API_KEY ni OPENAI_API_KEY)');
  let lastErr = null;
  // 1. Tente AssemblyAI d'abord
  if (hasAAI) {
    try {
      const text = await _transcrireAssemblyAI(audioBuffer, opts);
      log('OK', 'TRANSCRIBE', `AssemblyAI ${text?.length || 0} chars`);
      return _postCorrigerTranscription(text);
    } catch (e) {
      lastErr = e;
      log('WARN', 'TRANSCRIBE', `AssemblyAI fail: ${e.message?.substring(0, 100)} — fallback Whisper`);
    }
  }
  // 2. Fallback Whisper
  if (hasOAI) {
    try {
      const text = await _transcrireWhisper(audioBuffer, opts);
      log('OK', 'TRANSCRIBE', `Whisper fallback ${text?.length || 0} chars`);
      return _postCorrigerTranscription(text);
    } catch (e) {
      lastErr = e;
      log('ERR', 'TRANSCRIBE', `Whisper fail aussi: ${e.message?.substring(0, 100)}`);
    }
  }
  throw lastErr || new Error('Transcription failed');
}

// ─── Résumé d'appel téléphonique (Haiku → JSON structuré) ───────────────────
// Shawn raccroche avec un client → vocal Telegram → Whisper → CE FLOW.
// Auto-détection par Claude (system prompt). Crée note + deal + activité Pipedrive.
// Règle Shawn 2026-05-03: "il faut toujours une activité avec le deal en date de
// la création deal apres je gere". 1ère convo = écriture parallèle deal+note+activité.

function _extractJsonFromText(txt) {
  if (!txt) return null;
  // 1. Direct parse
  try { return JSON.parse(txt.trim()); } catch {}
  // 2. Extract first {...} block
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch {}
    // 3. Tentative repair: enlever trailing commas
    try { return JSON.parse(m[0].replace(/,(\s*[\]}])/g, '$1')); } catch {}
  }
  return null;
}

async function analyserAppelHaiku(transcription) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY absent — analyse impossible');

  const TZ = 'America/Toronto';
  const now = new Date();
  const dateLong = now.toLocaleDateString('fr-CA', { timeZone: TZ, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const dateISO  = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

  const sys = `Tu analyses la transcription d'un appel téléphonique d'un courtier immobilier québécois (Shawn Barrette, RE/MAX PRESTIGE, secteur Lanaudière).

Aujourd'hui: ${dateLong} (ISO ${dateISO}). Timezone: America/Toronto.

Extrait UNIQUEMENT un JSON valide (aucun texte avant/après) avec ces champs:
{
  "nom_complet": "Prénom Nom client (string ou null si pas mentionné)",
  "prenom": "Prénom seul (string ou null)",
  "nom": "Nom de famille seul (string ou null)",
  "telephone": "10 chiffres normalisés ou null",
  "email": "email valide ou null",
  "centris_number": "7-9 chiffres si mentionné ou null",
  "type_propriete": "terrain|maison_usagee|maison_neuve|construction_neuve|auto_construction|plex (ou null)",
  "budget": "Montant numérique en dollars (ex 80000) ou null",
  "adresse_propriete": "Adresse mentionnée ou null",
  "ville": "Ville mentionnée ou null",
  "objectif_appel": "1 phrase claire — pourquoi cet appel a eu lieu",
  "points_cles": ["3-6 points factuels importants extraits"],
  "objections": ["objection 1", "objection 2"],
  "engagement_client": "chaud|tiede|froid",
  "prochaine_etape": "1 phrase actionnable — ce que Shawn doit faire ensuite",
  "suivi_type": "call|meeting|task|email (défaut: call)",
  "suivi_date": "YYYY-MM-DD à partir de ${dateISO} — JAMAIS deviner l'année",
  "suivi_heure": "HH:MM SEULEMENT si l'appelant mentionne une heure précise, sinon null",
  "suivi_sujet": "Court sujet (max 60 chars) pour la prochaine activité",
  "alerte": "string si urgence/risque détecté (ex: client urgent, autre courtier, désengagé) ou null"
}

Règles strictes:
- Si pas mentionné → null (jamais inventer)
- Si "samedi" sans date précise → calculer prochain samedi à partir de ${dateISO}
- engagement_client: chaud=acheter/visiter bientôt, tiede=intéressé mais hésite, froid=poli mais distant
- objections: vide [] si aucune
- JAMAIS d'heure par défaut — null si pas explicite (règle Shawn absolue)
- nom_complet doit être complet ET précis pour matching Pipedrive`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 1500,
        system: sys,
        messages: [{ role: 'user', content: `Transcription appel:\n\n${transcription}` }],
      }),
    });
    if (!res.ok) {
      const errTxt = await res.text();
      throw new Error(`Haiku HTTP ${res.status}: ${errTxt.substring(0, 120)}`);
    }
    const data = await res.json();
    const txt = data.content?.[0]?.text?.trim() || '';
    trackCost('claude-haiku-4-5', data.usage || {});
    const parsed = _extractJsonFromText(txt);
    if (!parsed) {
      log('WARN', 'APPEL', `JSON parse fail: ${txt.substring(0, 100)}`);
      throw new Error('Haiku a retourné du contenu non-JSON');
    }
    return parsed;
  } finally { clearTimeout(t); }
}

async function _matcherProspectFuzzy(json) {
  // Cascade: nom complet → tel → centris → prénom seul
  const tries = [
    json.nom_complet,
    json.telephone,
    json.centris_number,
    json.prenom,
  ].filter(Boolean);

  for (const terme of tries) {
    try {
      const r = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&status=open&limit=3`);
      const items = r?.data?.items || [];
      if (items.length === 1) return { deal: items[0].item, matchedBy: terme };
      if (items.length > 1) return { deal: items[0].item, matchedBy: terme, ambiguous: items.length };
    } catch (e) { log('WARN', 'APPEL', `Search "${terme}": ${e.message}`); }
  }
  return null;
}

function _formatNoteAppel(json, transcription) {
  const dateFR = new Date().toLocaleDateString('fr-CA', { timeZone: 'America/Toronto', day: 'numeric', month: 'long', year: 'numeric' });
  const heureFR = new Date().toLocaleTimeString('fr-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit', hour12: false });
  const lines = [];
  lines.push(`📞 RÉSUMÉ D'APPEL — ${dateFR} ${heureFR}`);
  lines.push('');
  lines.push(`🎯 Objectif: ${json.objectif_appel || '—'}`);
  lines.push('');
  if (json.points_cles?.length) {
    lines.push('🔑 Points clés:');
    json.points_cles.forEach(p => lines.push(`• ${p}`));
    lines.push('');
  }
  if (json.objections?.length) {
    lines.push('⚠️ Objections:');
    json.objections.forEach(o => lines.push(`• ${o}`));
    lines.push('');
  }
  lines.push(`🌡️ Engagement: ${(json.engagement_client || 'tiede').toUpperCase()}`);
  if (json.budget)             lines.push(`💰 Budget: ${Number(json.budget).toLocaleString('fr-CA')} $`);
  if (json.type_propriete)     lines.push(`🏠 Type: ${json.type_propriete}`);
  if (json.adresse_propriete)  lines.push(`📍 Adresse: ${json.adresse_propriete}`);
  if (json.centris_number)     lines.push(`🔢 Centris: #${json.centris_number}`);
  lines.push('');
  lines.push(`➡️ Prochaine étape: ${json.prochaine_etape || '—'}`);
  if (json.alerte) lines.push(`\n🚨 ALERTE: ${json.alerte}`);
  lines.push('');
  lines.push('---');
  lines.push('📝 TRANSCRIPTION COMPLÈTE:');
  lines.push(transcription);
  return lines.join('\n');
}

function _formatActivityNote(json, transcription) {
  // Note Pipedrive activité — HTML léger pour scan rapide
  const parts = [];
  parts.push(`<b>🎯 ${json.objectif_appel || 'Suivi appel'}</b>`);
  parts.push(`<b>🌡️ Engagement:</b> ${(json.engagement_client || 'tiede').toUpperCase()}`);
  if (json.budget)         parts.push(`<b>💰 Budget:</b> ${Number(json.budget).toLocaleString('fr-CA')} $`);
  if (json.type_propriete) parts.push(`<b>🏠 Type:</b> ${json.type_propriete}`);
  if (json.adresse_propriete) parts.push(`<b>📍</b> ${json.adresse_propriete}`);
  if (json.points_cles?.length) {
    parts.push('<b>🔑 Points clés:</b>');
    parts.push(json.points_cles.map(p => `• ${p}`).join('<br>'));
  }
  if (json.objections?.length) {
    parts.push('<b>⚠️ Objections:</b>');
    parts.push(json.objections.map(o => `• ${o}`).join('<br>'));
  }
  parts.push(`<b>➡️ Prochaine étape:</b> ${json.prochaine_etape || '—'}`);
  if (json.alerte) parts.push(`<b>🚨 ${json.alerte}</b>`);
  parts.push(`<br><i>Transcription:</i> ${transcription.substring(0, 400)}${transcription.length > 400 ? '...' : ''}`);
  return parts.join('<br>');
}

async function enregistrerResumeAppel({ transcription }) {
  // 🛡️ SHAWN_GERE_SES_SUIVIS=true — cette fonction crée seulement deal+note, JAMAIS d'activité.
  // Suivi auto désactivé 2026-05-05: "le suivi automatique soit enlevé aussi ça me fait trop de suivi pas rapport"
  if (!transcription || transcription.length < 20) {
    return '❌ Transcription trop courte pour analyse (min 20 chars).';
  }
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';

  // 1. Analyse Haiku (ou fallback brut si fail)
  let json = null, analyseErr = null;
  try {
    json = await analyserAppelHaiku(transcription);
  } catch (e) {
    analyseErr = e.message;
    log('WARN', 'APPEL', `Haiku fail: ${e.message} — fallback brut`);
    // Fallback minimal pour ne JAMAIS perdre la donnée
    json = {
      nom_complet: null, prenom: null, nom: null,
      objectif_appel: 'Résumé d\'appel — analyse auto échouée, voir transcription',
      points_cles: [], objections: [],
      engagement_client: 'tiede',
      prochaine_etape: 'Classer manuellement',
      suivi_type: 'call',
      suivi_date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date()),
      suivi_sujet: 'Résumé d\'appel à classer',
      alerte: `Analyse Haiku échouée: ${e.message.substring(0, 80)}`,
    };
  }

  const dateISO = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date());

  // 2. Match prospect existant
  const match = json.nom_complet || json.telephone || json.centris_number || json.prenom
    ? await _matcherProspectFuzzy(json)
    : null;

  let dealId = null, dealTitle = null, isNewDeal = false, ambiguousNote = '';

  if (match?.deal) {
    dealId = match.deal.id;
    dealTitle = match.deal.title;
    if (match.ambiguous) {
      ambiguousNote = `\n⚠️ ${match.ambiguous} matchs trouvés pour "${match.matchedBy}" — utilisé le plus pertinent.`;
    }
    log('OK', 'APPEL', `Deal existant #${dealId} (${dealTitle}) matché par "${match.matchedBy}"`);
  } else {
    // 3a. Premier appel — créer person + deal
    if (!json.prenom && !json.nom_complet) {
      // Pas de nom extrait — résumé sur Telegram pour attribution manuelle (règle Shawn)
      const lines = [];
      lines.push(`⚠️ *Résumé d'appel — nom non identifié*`);
      lines.push(`_Tu attaches manuellement au deal après._\n`);
      if (json.objectif_appel) lines.push(`🎯 ${json.objectif_appel}`);
      lines.push(`🌡️ Engagement: ${(json.engagement_client || 'tiede').toUpperCase()}`);
      if (json.points_cles?.length) {
        lines.push(`\n🔑 Points clés:`);
        json.points_cles.forEach(p => lines.push(`• ${p}`));
      }
      if (json.objections?.length) {
        lines.push(`\n⚠️ Objections:`);
        json.objections.forEach(o => lines.push(`• ${o}`));
      }
      if (json.budget) lines.push(`\n💰 Budget: ${Number(json.budget).toLocaleString('fr-CA')} $`);
      if (json.type_propriete) lines.push(`🏠 Type: ${json.type_propriete}`);
      if (json.adresse_propriete) lines.push(`📍 ${json.adresse_propriete}`);
      lines.push(`\n➡️ ${json.prochaine_etape || '—'}`);
      lines.push(`\n📝 *Transcription:*\n_${transcription}_`);
      return lines.join('\n');
    }
    const prenom = json.prenom || (json.nom_complet || '').split(' ')[0];
    const nom = json.nom || (json.nom_complet || '').split(' ').slice(1).join(' ') || null;
    const dealRes = await creerDeal({
      prenom, nom,
      telephone: json.telephone,
      email: json.email,
      type: json.type_propriete,
      source: 'appel',
      centris: json.centris_number,
      note: `Source: appel téléphonique (${dateISO})\n${json.objectif_appel || ''}`,
    });
    // Extraire deal_id depuis le retour markdown (creerDeal retourne string avec "ID: 1234")
    const idMatch = String(dealRes).match(/ID:\s*(\d+)|#(\d+)/);
    if (idMatch) {
      dealId = parseInt(idMatch[1] || idMatch[2], 10);
      // Re-fetch pour avoir le titre exact
      const verif = await pdGet(`/deals/${dealId}`).catch(() => null);
      dealTitle = verif?.data?.title || `${prenom}${nom?' '+nom:''}`;
      isNewDeal = true;
      log('OK', 'APPEL', `Deal créé #${dealId} (${dealTitle}) depuis appel`);
    } else {
      // creerDeal a échoué ou réutilisé un deal existant — chercher le deal de cette personne
      log('WARN', 'APPEL', `creerDeal output ambigu: ${dealRes.substring(0, 100)}`);
      const fallback = await pdGet(`/deals/search?term=${encodeURIComponent(prenom + (nom?' '+nom:''))}&status=open&limit=1`);
      const fbItem = fallback?.data?.items?.[0]?.item;
      if (fbItem) { dealId = fbItem.id; dealTitle = fbItem.title; }
      else return `⚠️ Création deal incertaine.\n\nRetour Pipedrive: ${dealRes}\n\n📝 Transcription:\n_${transcription.substring(0, 300)}..._`;
    }
  }

  // 4. Note Pipedrive complète (résumé + transcription brute)
  const noteContent = _formatNoteAppel(json, transcription);
  let noteOk = false, noteId = null;
  try {
    const noteRes = await pdPost('/notes', { deal_id: dealId, content: noteContent });
    noteId = noteRes?.data?.id || null;
    noteOk = !!noteId;
  } catch (e) { log('WARN', 'APPEL', `Note creation fail: ${e.message}`); }

  // 5. Activité — DÉSACTIVÉE (Shawn 2026-05-05)
  // "le suivi automatique soit enlevé aussi ça me fait trop de suivi pas rapport"
  // Le résumé est dans la note Pipedrive. Shawn crée manuellement les suivis qu'il veut.
  let activityOk = false;
  const activityNote = `\n📝 Note ajoutée — pas d'activité auto-créée (suivi auto désactivé)`;

  // 6. Audit log (pour /lead-audit)
  try {
    auditLogEvent('appel', `Résumé enregistré: ${dealTitle}`, {
      deal_id: dealId, is_new: isNewDeal, engagement: json.engagement_client,
      analyseErr, noteOk, activityOk,
    });
  } catch {}

  // 7. Confirmation Telegram structurée
  const lines = [];
  lines.push(isNewDeal ? `✅ *Nouveau deal créé + résumé d'appel*` : `✅ *Résumé d'appel ajouté au deal existant*`);
  lines.push('');
  lines.push(`👤 *${dealTitle}* ${isNewDeal ? '(nouveau)' : `(deal #${dealId})`}`);
  lines.push(`🌡️ Engagement: ${(json.engagement_client || 'tiede').toUpperCase()}`);
  if (json.objectif_appel) lines.push(`🎯 ${json.objectif_appel}`);
  if (json.budget) lines.push(`💰 Budget: ${Number(json.budget).toLocaleString('fr-CA')} $`);
  lines.push('');
  lines.push(`➡️ ${json.prochaine_etape || 'Suivi à classer'}`);
  if (activityOk) lines.push(`📅 Activité: ${json.suivi_sujet || 'Suivi appel'} (${json.suivi_date || dateISO}${json.suivi_heure ? ' ' + json.suivi_heure : ''})`);
  if (json.alerte) lines.push(`\n🚨 ${json.alerte}`);
  if (analyseErr) lines.push(`\n⚠️ Analyse Haiku partielle (${analyseErr.substring(0, 60)}) — vérifie la note Pipedrive`);
  if (ambiguousNote) lines.push(ambiguousNote);
  if (activityNote) lines.push(activityNote);
  if (!noteOk) lines.push(`\n⚠️ Note Pipedrive: échec écriture`);
  return lines.join('\n');
}

// ─── Contacts iPhone (Dropbox /Contacts/contacts.vcf) ────────────────────────
async function chercherContact(terme) {
  const paths = ['/Contacts/contacts.vcf', '/Contacts/contacts.csv', '/contacts.vcf', '/contacts.csv'];
  let raw = null, format = null;
  for (const p of paths) {
    const res = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: p }, true);
    if (res && res.ok) { raw = await res.text(); format = p.endsWith('.vcf') ? 'vcf' : 'csv'; break; }
  }
  if (!raw) return '📵 Fichier contacts introuvable dans Dropbox.\nExporte tes contacts iPhone → `/Contacts/contacts.vcf` via un Raccourci iOS.';
  const q = terme.toLowerCase().replace(/\s+/g, ' ').trim();
  const results = [];
  if (format === 'vcf') {
    const cards = raw.split(/BEGIN:VCARD/i).slice(1);
    for (const card of cards) {
      const get = (field) => { const m = card.match(new RegExp(`^${field}[^:]*:(.+)$`, 'mi')); return m ? m[1].replace(/\r/g, '').trim() : ''; };
      const name  = get('FN') || get('N').replace(/;/g, ' ').trim();
      const org   = get('ORG');
      const email = card.match(/^EMAIL[^:]*:(.+)$/mi)?.[1]?.replace(/\r/g, '').trim() || '';
      const phones = [...card.matchAll(/^TEL[^:]*:(.+)$/gmi)].map(m => m[1].replace(/\r/g, '').trim());
      const blob = [name, org, email, ...phones].join(' ').toLowerCase();
      if (blob.includes(q) || q.split(' ').every(w => blob.includes(w))) { results.push({ name, org, email, phones }); if (results.length >= 5) break; }
    }
  } else {
    const lines = raw.split('\n').filter(l => l.trim());
    for (const line of lines.slice(1)) {
      if (q.split(' ').every(w => line.toLowerCase().includes(w))) { results.push({ raw: line.replace(/,/g, ' · ') }); if (results.length >= 5) break; }
    }
  }
  if (!results.length) return `Aucun contact iPhone trouvé pour "${terme}".`;
  return results.map(c => {
    if (c.raw) return `📱 ${c.raw}`;
    let s = `📱 *${c.name}*`;
    if (c.org)    s += ` — ${c.org}`;
    if (c.phones.length) s += `\n📞 ${c.phones.join(' · ')}`;
    if (c.email)  s += `\n✉️ ${c.email}`;
    return s;
  }).join('\n\n');
}

// ─── Recherche web ────────────────────────────────────────────────────────────
async function rechercherWeb(requete) {
  if (process.env.PERPLEXITY_API_KEY) {
    try {
      const res = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonar', max_tokens: 500, messages: [
          { role: 'system', content: 'Assistant recherche courtier immobilier québécois. Réponds en français, sources canadiennes (Centris, APCIQ, Desjardins, BdC). Chiffres précis.' },
          { role: 'user', content: requete }
        ]})
      });
      if (res.ok) { const d = await res.json(); const t = d.choices?.[0]?.message?.content?.trim(); if (t) return `🔍 *${requete}*\n\n${t}`; }
    } catch {}
  }
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(requete)}&count=5&country=ca&search_lang=fr`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY }
      });
      if (res.ok) { const d = await res.json(); const results = (d.web?.results || []).slice(0, 4); if (results.length) return `🔍 *${requete}*\n\n${results.map((r, i) => `${i+1}. **${r.title}**\n${r.description || ''}`).join('\n\n')}`; }
    } catch {}
  }
  try {
    let contexte = '';
    const ddg = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(requete)}&format=json&no_html=1`, { headers: { 'User-Agent': 'SignatureSB/1.0' } });
    if (ddg.ok) { const d = await ddg.json(); contexte = [d.AbstractText, ...(d.RelatedTopics || []).slice(0,3).map(t => t.Text || '')].filter(Boolean).join('\n'); }
    const prompt = contexte
      ? `Synthétise pour courtier immobilier QC: "${requete}"\nSources: ${contexte}\nRéponds en français, chiffres précis, règles QC.`
      : `Réponds pour courtier QC: "${requete}"\nFrançais, règles QC (OACIQ, Code civil, TPS+TVQ), chiffres concrets.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
    });
    if (res.ok) { const d = await res.json(); const t = d.content?.[0]?.text?.trim(); if (t) return `🔍 *${requete}*\n\n${t}`; }
  } catch (e) { log('WARN', 'WEB', e.message); }
  return `Aucun résultat trouvé pour: "${requete}"`;
}

// ─── CENTRIS AGENT — Connexion authentifiée + Comparables + Actifs ───────────
// Credentials: CENTRIS_USER + CENTRIS_PASS dans Render env vars

const CENTRIS_BASE = 'https://www.centris.ca';

// Session Centris (expire 2h)
let centrisSession = { cookies: '', expiry: 0, authenticated: false };

// ─── Centris session cookies (manual capture from Chrome) ─────────────────
// Persistance: /data/centris_session.json + Gist backup. TTL 25j.
// Approche bypass MFA: Shawn login dans Chrome (avec MFA), copie cookies
// header, paste dans Telegram via /cookies <string>. Bot use ces cookies
// pour toutes les opérations Centris (fiche, comparables, etc.).
const CENTRIS_SESSION_FILE = path.join(DATA_DIR, 'centris_session.json');
function loadCentrisSessionFromDisk() {
  try {
    if (fs.existsSync(CENTRIS_SESSION_FILE)) {
      const data = JSON.parse(fs.readFileSync(CENTRIS_SESSION_FILE, 'utf8'));
      if (data && data.cookies && data.expiry > Date.now()) {
        centrisSession = { ...data, authenticated: true };
        return true;
      }
    }
  } catch {}
  return false;
}
function saveCentrisSessionToDisk() {
  if (!centrisSession.cookies) return;
  safeWriteJSON(CENTRIS_SESSION_FILE, {
    cookies: centrisSession.cookies,
    expiry: centrisSession.expiry,
    via: centrisSession.via || 'manual-capture',
    capturedAt: centrisSession.lastLoginAt || Date.now(),
  });
}
// Charge au boot
loadCentrisSessionFromDisk();

// ─── MFA Bridge — coordination Mac SMS bridge ↔ Centris OAuth flow ────────
let pendingMFACode = null;       // dernier code reçu non consommé
let mfaWaiters = [];             // resolveurs Promise en attente d'un code
const smsBridgeHealth = { alive: false, lastHeartbeat: 0, lastCodeAt: 0, totalCodes: 0 };

// Erreur spécifique MFA — l'appelant doit la catch pour fallback dégradé propre
class MFARequiredError extends Error {
  constructor(reason = 'MFA_REQUIRED') {
    super(`MFA_REQUIRED: ${reason}`);
    this.code = 'MFA_REQUIRED';
    this.reason = reason;
  }
}

// Génère code TOTP RFC 6238 si CENTRIS_TOTP_SECRET configuré (alternative SMS)
// Setup: extraire secret du QR code Centris MFA initial → set env var (base32)
function tryGenerateTOTP() {
  const secret = process.env.CENTRIS_TOTP_SECRET;
  if (!secret) return null;
  try {
    const { TOTP } = require('otpauth');
    const totp = new TOTP({
      issuer: 'Centris', label: 'CentrisMFA',
      algorithm: 'SHA1', digits: 6, period: 30,
      secret, // base32
    });
    const code = totp.generate();
    log('OK', 'MFA', `TOTP généré (CENTRIS_TOTP_SECRET configuré) — code ${code.substring(0, 2)}****`);
    return code;
  } catch (e) {
    log('WARN', 'MFA', `TOTP generation échouée: ${e.message?.substring(0, 100)}`);
    return null;
  }
}

// Attend un code MFA — cascade 3 niveaux:
// 1. CENTRIS_TOTP_SECRET env var (TOTP RFC 6238) — instantané, jamais expiré
// 2. pendingMFACode déjà disponible (<2min) — du bridge SMS Mac
// 3. Attendre nouveau code via bridge — timeoutMs max
//
// Throws MFARequiredError si rien dispo (l'appelant catch et dégrade gracieusement).
async function awaitMFACode(timeoutMs = 120000) {
  // 1. TOTP si configuré (priorité absolue, instantané)
  const totp = tryGenerateTOTP();
  if (totp) return totp;

  // 2. Code déjà disponible <2min via bridge?
  if (pendingMFACode && Date.now() - pendingMFACode.receivedAt < 120000) {
    const code = pendingMFACode.code;
    pendingMFACode = null;
    return code;
  }

  // 3. Attendre un nouveau code du bridge
  // Si bridge non actif (no heartbeat depuis 5min) → fail fast au lieu d'attendre
  if (smsBridgeHealth.lastHeartbeat && Date.now() - smsBridgeHealth.lastHeartbeat > 5 * 60 * 1000) {
    log('WARN', 'MFA', `SMS bridge silencieux depuis ${Math.round((Date.now()-smsBridgeHealth.lastHeartbeat)/60000)}min — pas d'attente`);
    throw new MFARequiredError('SMS bridge inactif + pas de TOTP configuré');
  }

  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      mfaWaiters = mfaWaiters.filter(r => r !== resolve);
      reject(new MFARequiredError(`timeout ${timeoutMs/1000}s — aucun code via bridge SMS + pas de TOTP`));
    }, timeoutMs);
    const wrappedResolve = (code) => {
      clearTimeout(t);
      pendingMFACode = null; // consommé
      resolve(code);
    };
    mfaWaiters.push(wrappedResolve);
  });
}

// Headers communs Centris (simule mobile app)
const CENTRIS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-CA,fr;q=0.9,en-CA;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

// ─── Centris OAuth flow complet avec MFA SMS auto via bridge Mac ──────────
// Coordonné avec sms-bridge.js LaunchAgent. Login Auth0 + MFA injection auto.
async function centrisOAuthLoginWithMFA(opts = {}) {
  const user = process.env.CENTRIS_USER;
  const pass = process.env.CENTRIS_PASS;
  if (!user || !pass) return { ok: false, error: 'CENTRIS_USER/CENTRIS_PASS manquants' };

  const COOKIES = {};
  const apply = (res) => {
    const sc = res.headers.get('set-cookie') || '';
    for (const part of sc.split(/, (?=[^=]+=[^;]+)/)) {
      const m = part.match(/^([^=]+)=([^;]*)/);
      if (m) COOKIES[m[1].trim()] = m[2];
    }
  };
  const cookieStr = () => Object.entries(COOKIES).map(([k, v]) => `${k}=${v}`).join('; ');
  const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x2f;/gi, '/').replace(/&#x3d;/gi, '=');
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36';
  const HD = { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9', 'Accept-Language': 'fr-CA,fr;q=0.9' };
  const fOpts = (extra = {}) => ({ headers: { ...HD, ...(extra.headers || {}), 'Cookie': cookieStr() }, ...extra });
  const lg = (lvl, m) => log(lvl, 'CENTRIS-OAUTH', m);

  try {
    const r1 = await fetch('https://matrix.centris.ca/Matrix/Login.aspx', fOpts({ redirect: 'follow' }));
    apply(r1);
    const html1 = await r1.text();
    const finalUrl = r1.url;
    const formMatch = html1.match(/<form[^>]*action=["']([^"']+)["'][^>]*>([\s\S]*?)<\/form>/i);
    if (!formMatch) return { ok: false, error: 'Login form introuvable' };
    const inputs = {};
    for (const m of formMatch[2].matchAll(/<input[^>]+name=["']([^"']+)["'](?:[^>]+value=["']([^"']*)["'])?/gi)) {
      inputs[m[1]] = decode(m[2] || '');
    }
    inputs.UserCode = user;
    inputs.Password = pass;
    inputs.RememberMe = 'true';

    const r2 = await fetch('https://accounts.centris.ca/account/login', {
      method: 'POST', redirect: 'manual',
      headers: { ...HD, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr(), 'Referer': finalUrl, 'Origin': 'https://accounts.centris.ca' },
      body: new URLSearchParams(inputs).toString(),
    });
    apply(r2);
    if (r2.status !== 302) {
      const errHtml = await r2.text();
      return { ok: false, error: /incorrect|invalide|wrong/i.test(errHtml) ? 'Credentials Centris incorrects' : `Login HTTP ${r2.status}` };
    }
    let nextUrl = decode(r2.headers.get('location') || '');
    if (!nextUrl.startsWith('http')) nextUrl = 'https://accounts.centris.ca' + nextUrl;

    let mfaChallenge = null;
    let formPostFinal = null;
    for (let hop = 0; hop < 20; hop++) {
      lg('INFO', `hop ${hop} → ${nextUrl.substring(0, 120)}`);
      const r = await fetch(nextUrl, fOpts({ redirect: 'manual' }));
      apply(r);
      if (r.status >= 300 && r.status < 400) {
        const loc = decode(r.headers.get('location') || '');
        lg('INFO', `hop ${hop} ${r.status} → location: ${loc.substring(0, 120)}`);
        if (!loc) break;
        nextUrl = loc.startsWith('http') ? loc : new URL(loc, nextUrl).href;
        continue;
      }
      if (r.status !== 200) { lg('WARN', `hop ${hop} status ${r.status}`); break; }
      const html = await r.text();
      // PASS 1 — Auth0 new flow: identifier/password split
      // Si on est sur /u/login/identifier, faut soumettre l'identifier puis le password
      if (nextUrl.includes('/u/login/identifier')) {
        const stateMatch = html.match(/name=["']state["'][^>]+value=["']([^"']+)["']/i);
        const actionMatch = html.match(/<form[^>]+action=["']([^"']*identifier[^"']*)["']/i) || html.match(/<form[^>]+method=["']post["'][^>]+action=["']([^"']+)["']/i);
        if (stateMatch && actionMatch) {
          lg('INFO', `Auth0 new flow: identifier step at ${nextUrl}`);
          const idAction = decode(actionMatch[1]).startsWith('http') ? decode(actionMatch[1]) : `https://centris-prod.ca.auth0.com${decode(actionMatch[1])}`;
          const idRes = await fetch(idAction, {
            method: 'POST', redirect: 'manual',
            headers: { ...HD, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr(), 'Referer': nextUrl, 'Origin': 'https://centris-prod.ca.auth0.com' },
            body: new URLSearchParams({ state: decode(stateMatch[1]), username: user, action: 'default' }).toString(),
          });
          apply(idRes);
          if (idRes.status >= 300 && idRes.status < 400) {
            const loc = decode(idRes.headers.get('location') || '');
            nextUrl = loc.startsWith('http') ? loc : new URL(loc, idAction).href;
            lg('INFO', `identifier → password step: ${nextUrl.substring(0, 120)}`);
            continue;
          }
        }
      }
      if (nextUrl.includes('/u/login/password') || nextUrl.includes('/u/login') && /password/i.test(html)) {
        const stateMatch = html.match(/name=["']state["'][^>]+value=["']([^"']+)["']/i);
        const actionMatch = html.match(/<form[^>]+action=["']([^"']*(?:password|login)[^"']*)["']/i) || html.match(/<form[^>]+method=["']post["'][^>]+action=["']([^"']+)["']/i);
        if (stateMatch && actionMatch) {
          lg('INFO', `Auth0 new flow: password step at ${nextUrl}`);
          const pwAction = decode(actionMatch[1]).startsWith('http') ? decode(actionMatch[1]) : `https://centris-prod.ca.auth0.com${decode(actionMatch[1])}`;
          const pwRes = await fetch(pwAction, {
            method: 'POST', redirect: 'manual',
            headers: { ...HD, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr(), 'Referer': nextUrl, 'Origin': 'https://centris-prod.ca.auth0.com' },
            body: new URLSearchParams({ state: decode(stateMatch[1]), username: user, password: pass, action: 'default' }).toString(),
          });
          apply(pwRes);
          if (pwRes.status >= 300 && pwRes.status < 400) {
            const loc = decode(pwRes.headers.get('location') || '');
            nextUrl = loc.startsWith('http') ? loc : new URL(loc, pwAction).href;
            lg('INFO', `password → next: ${nextUrl.substring(0, 120)}`);
            continue;
          }
        }
      }
      if (/mfa-sms-challenge|sms-challenge/i.test(html) || nextUrl.includes('mfa-sms-challenge')) {
        const stateMatch = html.match(/name=["']state["'][^>]+value=["']([^"']+)["']/i);
        const actionMatch = html.match(/<form[^>]+action=["']([^"']+\/u\/mfa-sms-challenge[^"']*)["']/i);
        if (stateMatch && actionMatch) {
          mfaChallenge = {
            state: decode(stateMatch[1]),
            actionUrl: decode(actionMatch[1]).startsWith('http') ? decode(actionMatch[1]) : `https://centris-prod.ca.auth0.com${decode(actionMatch[1])}`,
            referer: nextUrl,
          };
          lg('INFO', 'MFA challenge détecté — wait for SMS code via bridge');
          break;
        }
      }
      const fpMatch = html.match(/<form[^>]+action=["'](https:\/\/matrix\.centris\.ca[^"']+)["'][^>]*method=["']post["']/i);
      if (fpMatch) {
        const allInputs = {};
        for (const m of html.matchAll(/<input[^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["']/gi)) {
          allInputs[m[1]] = decode(m[2]);
        }
        formPostFinal = { url: fpMatch[1], inputs: allInputs };
        break;
      }
      // STUCK: log les premiers 500 chars HTML pour debug
      const htmlPreview = html.substring(0, 500).replace(/\s+/g, ' ');
      lg('WARN', `hop ${hop} STUCK at ${nextUrl.substring(0, 80)} — HTML: ${htmlPreview.substring(0, 200)}`);
      break;
    }

    if (mfaChallenge) {
      let smsCode;
      try {
        smsCode = await awaitMFACode(opts.mfaTimeoutMs || 120000);
      } catch (e) {
        // Dégradation propre: log clair + return code MFA_REQUIRED (pas crash)
        const reason = e.code === 'MFA_REQUIRED' ? e.reason : `timeout/${e.message?.substring(0, 80)}`;
        log('WARN', 'CENTRIS', `MFA_REQUIRED — ${reason}. Configure CENTRIS_TOTP_SECRET ou démarre sms-bridge daemon.`);
        return { ok: false, error: `MFA_REQUIRED: ${reason}`, mfaRequired: true };
      }
      const mfaRes = await fetch(mfaChallenge.actionUrl, {
        method: 'POST', redirect: 'manual',
        headers: { ...HD, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr(), 'Referer': mfaChallenge.referer, 'Origin': 'https://centris-prod.ca.auth0.com' },
        body: new URLSearchParams({ state: mfaChallenge.state, code: smsCode }).toString(),
      });
      apply(mfaRes);
      lg('OK', `MFA submitted, status ${mfaRes.status}`);
      if (mfaRes.status >= 300 && mfaRes.status < 400) {
        nextUrl = decode(mfaRes.headers.get('location') || '');
        if (!nextUrl.startsWith('http')) nextUrl = new URL(nextUrl, mfaChallenge.actionUrl).href;
        for (let hop = 0; hop < 20; hop++) {
          const r = await fetch(nextUrl, fOpts({ redirect: 'manual' }));
          apply(r);
          if (r.status >= 300 && r.status < 400) {
            const loc = decode(r.headers.get('location') || '');
            if (!loc) break;
            nextUrl = loc.startsWith('http') ? loc : new URL(loc, nextUrl).href;
            continue;
          }
          if (r.status === 200) {
            const html = await r.text();
            const fpMatch = html.match(/<form[^>]+action=["'](https:\/\/matrix\.centris\.ca[^"']+)["'][^>]*method=["']post["']/i);
            if (fpMatch) {
              const allInputs = {};
              for (const m of html.matchAll(/<input[^>]+name=["']([^"']+)["'][^>]+value=["']([^"']*)["']/gi)) {
                allInputs[m[1]] = decode(m[2]);
              }
              formPostFinal = { url: fpMatch[1], inputs: allInputs };
              break;
            }
          }
          break;
        }
      } else if (mfaRes.status === 200) {
        const errHtml = await mfaRes.text();
        if (/incorrect|invalide|expired/i.test(errHtml)) return { ok: false, error: 'Code MFA refusé' };
      }
    }

    if (!formPostFinal) return { ok: false, error: 'Pas de form_post matrix après auth' };

    const r5 = await fetch(formPostFinal.url, {
      method: 'POST', redirect: 'manual',
      headers: { ...HD, 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': cookieStr(), 'Origin': 'https://accounts.centris.ca' },
      body: new URLSearchParams(formPostFinal.inputs).toString(),
    });
    apply(r5);
    if (r5.status >= 300 && r5.status < 400) {
      let url = decode(r5.headers.get('location') || '');
      if (!url.startsWith('http')) url = new URL(url, formPostFinal.url).href;
      for (let hop = 0; hop < 5; hop++) {
        const rr = await fetch(url, fOpts({ redirect: 'manual' }));
        apply(rr);
        if (rr.status >= 300 && rr.status < 400) {
          url = decode(rr.headers.get('location') || '');
          if (!url.startsWith('http')) url = new URL(url, 'https://matrix.centris.ca').href;
          continue;
        }
        break;
      }
    }

    const cookieFinal = cookieStr();
    centrisSession = {
      cookies: cookieFinal,
      expiry: Date.now() + 24 * 3600 * 1000,
      authenticated: true,
      lastLoginAt: Date.now(),
      via: 'oauth-mfa-bridge',
    };
    lg('OK', `🎉 Centris OAuth+MFA login réussi (${Object.keys(COOKIES).length} cookies)`);
    return { ok: true, cookieCount: Object.keys(COOKIES).length };
  } catch (e) {
    return { ok: false, error: `Exception: ${e.message?.substring(0, 200)}` };
  }
}

async function centrisLogin() {
  const user = process.env.CENTRIS_USER;
  const pass = process.env.CENTRIS_PASS;
  if (!user || !pass) {
    log('WARN', 'CENTRIS', 'CENTRIS_USER ou CENTRIS_PASS manquants dans env');
    return false;
  }

  // PRIORITÉ 1 — Nouveau flow OAuth Auth0 avec MFA SMS (Centris a migré vers ça)
  // L'ancien flow form-based à /fr/connexion ne marche plus pour le portail Matrix.
  // centrisOAuthLoginWithMFA set centrisSession directement à l'intérieur si OK.
  try {
    const oauth = await centrisOAuthLoginWithMFA({ mfaTimeoutMs: 120000 });
    if (oauth?.ok && centrisSession?.cookies) {
      log('OK', 'CENTRIS', `OAuth Auth0 + MFA SMS ✓ (agent: ${user}, ${oauth.cookieCount} cookies)`);
      return true;
    }
    // Dégradation propre: si MFA_REQUIRED → log clair, retourne false (pas crash)
    // L'appelant (CUA driver, telechargerFiche etc) sait qu'il doit fallback ailleurs.
    if (oauth?.mfaRequired) {
      log('WARN', 'CENTRIS', `MFA_REQUIRED — login en mode dégradé. Solutions: (1) set CENTRIS_TOTP_SECRET env var, (2) démarre sms-bridge LaunchAgent Mac, (3) lance LaunchAgent centris-auto-login pour push cookies via Playwright`);
      return false;
    }
    log('WARN', 'CENTRIS', `OAuth flow échoué: ${oauth?.error || 'unknown'} — fallback form-based`);
  } catch (e) {
    log('WARN', 'CENTRIS', `OAuth flow exception: ${e.message?.substring(0, 100)} — fallback form-based`);
  }

  // FALLBACK — Ancien flow form-based (peut encore marcher pour certains comptes)
  try {
    // 1. Charger la page login pour obtenir le token CSRF et les cookies de session
    const pageController = new AbortController();
    const pageTimeout    = setTimeout(() => pageController.abort(), 15000);
    const pageRes = await fetch(`${CENTRIS_BASE}/fr/connexion`, {
      signal: pageController.signal,
      headers: CENTRIS_HEADERS,
    }).finally(() => clearTimeout(pageTimeout));

    if (!pageRes.ok && pageRes.status !== 200) {
      log('WARN', 'CENTRIS', `Page login HTTP ${pageRes.status}`);
    }

    const pageHtml   = await pageRes.text();
    const pageCookie = pageRes.headers.get('set-cookie') || '';

    // Extraire token anti-forgery
    const csrf = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1]
              || pageHtml.match(/"RequestVerificationToken"\s*content="([^"]+)"/i)?.[1]
              || '';

    // 2. POST les credentials
    const loginController = new AbortController();
    const loginTimeout    = setTimeout(() => loginController.abort(), 15000);
    const loginRes = await fetch(`${CENTRIS_BASE}/fr/connexion`, {
      method:   'POST',
      redirect: 'manual',
      signal:   loginController.signal,
      headers: {
        ...CENTRIS_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie':   pageCookie,
        'Referer':  `${CENTRIS_BASE}/fr/connexion`,
        'Origin':   CENTRIS_BASE,
      },
      body: new URLSearchParams({
        UserName:                   user,
        Password:                   pass,
        __RequestVerificationToken: csrf,
        ReturnUrl:                  '/fr/',
        'Remember':                 'false',
      }),
    }).finally(() => clearTimeout(loginTimeout));

    const respCk = loginRes.headers.get('set-cookie') || '';
    // Combiner tous les cookies
    const allCookies = [pageCookie, respCk]
      .join('; ')
      .split(';')
      .map(c => c.trim().split(';')[0])
      .filter(c => c.includes('='))
      .join('; ');

    // Détecter le succès (redirect 302, cookie auth, ou header Location)
    const location = loginRes.headers.get('location') || '';
    const isOk = loginRes.status === 302
              || respCk.toLowerCase().includes('aspxauth')
              || respCk.toLowerCase().includes('.centris.')
              || (location && !location.includes('connexion'));

    if (isOk) {
      centrisSession = { cookies: allCookies, expiry: Date.now() + 2 * 3600000, authenticated: true };
      log('OK', 'CENTRIS', `Connecté ✓ (code agent: ${user})`);
      return true;
    }

    log('WARN', 'CENTRIS', `Login: HTTP ${loginRes.status} — location: ${location.substring(0,80)}`);
    return false;
  } catch (e) {
    log('ERR', 'CENTRIS', `Login exception: ${e.message}`);
    return false;
  }
}

async function centrisGet(path, options = {}) {
  // Priorité: cookies manuel-capture (via /cookies command, valide 25j).
  // Fallback: tentative login auto si CENTRIS_USER/PASS configurés.
  if (!centrisSession.cookies || Date.now() > centrisSession.expiry) {
    if (centrisSession.via === 'manual-capture') {
      throw new Error('🍪 Cookies Centris expirés. Re-capture: 1) Login matrix.centris.ca dans Chrome 2) DevTools → Cookies → copy 3) /cookies <string>');
    }
    const ok = await centrisLogin();
    if (!ok) throw new Error('Centris: pas de cookies capturés. Tape /cookies dans Telegram pour setup (60 sec).');
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${CENTRIS_BASE}${path}`, {
      signal: controller.signal,
      headers: {
        ...CENTRIS_HEADERS,
        'Cookie': centrisSession.cookies,
        'Referer': CENTRIS_BASE,
        ...(options.headers || {}),
      },
      ...options,
    });

    // Session expirée → re-login une fois
    if (res.status === 401 || (res.url && res.url.includes('connexion'))) {
      centrisSession.expiry = 0;
      const ok = await centrisLogin();
      if (!ok) throw new Error('Re-login Centris échoué');
      return centrisGet(path, options); // retry
    }
    return res;
  } finally { clearTimeout(t); }
}

// Normalisation villes → slugs URL Centris
const VILLES_CENTRIS = {
  'rawdon':'rawdon','raw':'rawdon',
  'sainte-julienne':'sainte-julienne','saint-julienne':'sainte-julienne','julienne':'sainte-julienne','ste-julienne':'sainte-julienne',
  'chertsey':'chertsey',
  'saint-didace':'saint-didace','didace':'saint-didace',
  'sainte-marcelline':'sainte-marcelline-de-kildare','sainte-marcelline-de-kildare':'sainte-marcelline-de-kildare','marcelline':'sainte-marcelline-de-kildare',
  'saint-jean-de-matha':'saint-jean-de-matha','matha':'saint-jean-de-matha',
  'saint-calixte':'saint-calixte','calixte':'saint-calixte',
  'saint-lin':'saint-lin-laurentides','saint-lin-laurentides':'saint-lin-laurentides',
  'joliette':'joliette',
  'repentigny':'repentigny',
  'terrebonne':'terrebonne','lachenaie':'terrebonne',
  'mascouche':'mascouche',
  'berthierville':'berthierville',
  'montreal':'montreal','mtl':'montreal',
  'laval':'laval',
  'longueuil':'longueuil',
  'saint-jerome':'saint-jerome','saint-jérôme':'saint-jerome',
  'mirabel':'mirabel','blainville':'blainville','boisbriand':'boisbriand',
};

// Types propriété → slugs Centris
const TYPES_CENTRIS = {
  'terrain':         { slug:'terrain',               genre:'vendu'  },
  'lot':             { slug:'terrain',               genre:'vendu'  },
  'maison':          { slug:'maison',                genre:'vendue' },
  'maison_usagee':   { slug:'maison',                genre:'vendue' },
  'unifamiliale':    { slug:'maison',                genre:'vendue' },
  'bungalow':        { slug:'bungalow',              genre:'vendu'  },
  'plex':            { slug:'immeuble-a-revenus',    genre:'vendu'  },
  'duplex':          { slug:'duplex',                genre:'vendu'  },
  'triplex':         { slug:'triplex',               genre:'vendu'  },
  'condo':           { slug:'appartement-condo',     genre:'vendu'  },
};

function slugVille(v) {
  const k = (v||'').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'-');
  return VILLES_CENTRIS[k] || VILLES_CENTRIS[v.toLowerCase().trim()] || k;
}
function slugType(t) { return TYPES_CENTRIS[(t||'terrain').toLowerCase()] || TYPES_CENTRIS['terrain']; }

// Parser les listings depuis HTML Centris
function parseCentrisHTML(html, ville, jours) {
  const cutoff  = new Date(Date.now() - jours * 86400000);
  const listings = [];
  const seen     = new Set();

  // Stratégie 1 — JSON-LD schema.org (le plus fiable)
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1]);
      const items = Array.isArray(d) ? d.flat() : [d];
      for (const item of items) {
        if (!item?.['@type']) continue;
        const id = item.identifier || item['@id'] || '';
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const prix = item.offers?.price ? parseInt(String(item.offers.price).replace(/[^\d]/g,'')) : null;
        const adresse = item.name || item.address?.streetAddress || '';
        const sup = item.floorSize?.value ? parseInt(item.floorSize.value) : null;
        const dateStr = item.dateModified || item.dateCreated || '';
        if (dateStr) { try { if (new Date(dateStr) < cutoff) continue; } catch {} }
        if (prix || adresse) listings.push({ mls:id, adresse, ville: item.address?.addressLocality || ville, prix, superficie: sup, dateVente: dateStr ? new Date(dateStr).toLocaleDateString('fr-CA') : '', dateISO: dateStr });
      }
    } catch {}
  }

  // Stratégie 2 — data-id + contexte HTML
  if (listings.length < 2) {
    for (const m of html.matchAll(/data-(?:id|mlsnumber|listing-id)="(\d{6,9})"/gi)) {
      const mls = m[1];
      if (seen.has(mls)) continue;
      seen.add(mls);
      const ctx   = html.substring(Math.max(0, m.index - 100), m.index + 1000);
      const priceM = ctx.match(/(\d{2,3}[\s\u00a0,]\d{3})\s*\$/);
      const prix   = priceM ? parseInt(priceM[1].replace(/[^\d]/g,'')) : null;
      const addrM  = ctx.match(/(?:address|adresse)[^>]{0,50}>([^<]{5,80})/i);
      listings.push({ mls, adresse: addrM?.[1]?.trim() || '', ville, prix, superficie:null, dateVente:'', dateISO:'' });
    }
  }

  return listings.slice(0, 30);
}

// ─── Fallback: send email avec lien Centris.ca public (Shawn 2026-05-14)
// Quand Centris courtier inaccessible OU listing pas dans Dropbox Shawn,
// envoie email pro avec lien Centris.ca public + Cc Shawn auto.
async function _envoyerListingPubliqueLink({ num, email_destination, cc, message_perso, publicUrl }) {
  const token = await getGmailToken();
  if (!token) return `❌ Gmail token absent — pas pouvoir envoyer lien`;
  const ccUserRaw = cc;
  const ccUser = !ccUserRaw ? [] : (Array.isArray(ccUserRaw) ? ccUserRaw : String(ccUserRaw).split(',')).map(s => s.trim()).filter(Boolean);
  const ccFinal = [...new Set([AGENT.email, ...ccUser].filter(e => e && e.toLowerCase() !== email_destination.toLowerCase()))];
  const enc = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  const subject = `Propriété Centris #${num} — ${AGENT.compagnie}`;
  const introMsg = message_perso || `Voici les détails de la propriété Centris #${num} que vous m'avez demandée. Tous les détails (photos, prix, description, taxes, dimensions) sont disponibles via le lien ci-dessous.`;
  // Contenu métier injecté dans INTRO_TEXTE du master template
  const contentHTML = `
<p style="margin:0 0 16px;color:#cccccc;font-size:14px;line-height:1.7;">${escapeHtml(introMsg)}</p>
<div style="background:#111111;border:1px solid #1e1e1e;border-radius:8px;padding:24px;margin:20px 0;text-align:center;">
<div style="color:${AGENT.couleur};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">🏡 Fiche détaillée Centris</div>
<div style="color:#f5f5f7;margin-bottom:18px;font-size:15px;">Cliquez pour voir la propriété complète avec photos:</div>
<a href="${publicUrl}" style="display:inline-block;background:${AGENT.couleur};color:#fff;padding:14px 32px;border-radius:4px;text-decoration:none;font-weight:700;letter-spacing:1px;text-transform:uppercase;font-size:13px;">Voir la fiche complète →</a>
</div>
<p style="margin:16px 0;color:#cccccc;font-size:14px;line-height:1.6;">N'hésitez pas si vous avez des questions — je suis disponible au <strong style="color:${AGENT.couleur};">${AGENT.telephone}</strong>.</p>`;
  // Build HTML avec master template Signature SB (logos + branding)
  let html = await buildEmailFromMasterTpl({
    TITRE_EMAIL: `Propriété Centris #${num}`,
    LABEL_SECTION: `Fiche propriété`,
    TERRITOIRES: `Centris #${num}`,
    HERO_TITRE: `Propriété<br>Centris #${num}.`,
    INTRO_TEXTE: contentHTML,
    CITATION: `Je reste disponible pour toute question concernant ce dossier.`,
  });
  // Fallback HTML inline si template Dropbox indispo (très rare)
  if (!html) {
    html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Arial,sans-serif;background:#0a0a0a;color:#f5f5f7;margin:0;padding:20px;"><div style="max-width:600px;margin:auto;"><div style="border-top:4px solid ${AGENT.couleur};padding:24px 0;"><h2 style="color:#f5f5f7;margin:0 0 8px;">${escapeHtml(AGENT.nom)}</h2><div style="color:#999;font-size:13px;font-style:italic;">${escapeHtml(AGENT.titre)} · ${escapeHtml(AGENT.compagnie)}</div></div>${contentHTML}<div style="border-top:1px solid #1a1a1a;padding-top:16px;color:#666;font-size:12px;">📞 ${AGENT.telephone} · <a href="mailto:${AGENT.email}" style="color:${AGENT.couleur};">${AGENT.email}</a></div></div></body></html>`;
    log('WARN', 'CENTRIS', `Master template Dropbox indispo, fallback HTML inline (sans logos)`);
  }
  const lines = [
    `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
    `To: ${email_destination}`,
    ccFinal.length ? `Cc: ${ccFinal.join(', ')}` : '',
    `Reply-To: ${AGENT.email}`,
    `Subject: ${enc(subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf-8').toString('base64'),
  ].filter(Boolean);
  const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  const sent = await sendEmailLogged({
    via: 'gmail', to: email_destination, cc: ccFinal, subject,
    category: 'centris-fiche-public-link', shawnConsent: true,
    sendFn: () => fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    }),
  });
  if (!sent.ok) return `❌ Email échoué: ${sent.error || sent.status}`;
  auditLogEvent('centris', 'public-link-sent', { num, to: email_destination });
  return `✅ Lien Centris #${num} envoyé à *${email_destination}*\n   🔗 ${publicUrl}\n   Cc: ${ccFinal.join(', ')}\n   _Fiche officielle Matrix inaccessible — envoyé via lien public Centris.ca (contient toutes les infos + photos)._`;
}

// Chercher les VENDUS sur Centris (avec session agent)
// ─── Centris fiche download — outil le plus robuste ─────────────────────
// Télécharge la fiche détaillée PDF d'un listing Centris (peu importe le
// courtier inscripteur) en utilisant les credentials de Shawn. Stratégies:
// 0. Pré-check: listing existe sur Centris.ca public (évite waste session)
// 1. Try patterns URL directs (MX/PrintSheet, fr/agent/...) — vieux portail
// 2. Si rien → fetch page listing + extract liens PDF
// 3. Si tout échoue → fallback _envoyerListingPubliqueLink (lien public)
async function telechargerFicheCentris({ centris_num, email_destination, cc, message_perso }) {
  const num = String(centris_num || '').replace(/\D/g, '').trim();
  if (!num || num.length < 7 || num.length > 9) return `❌ Numéro Centris invalide (7-9 chiffres requis)`;
  if (!email_destination || !/@/.test(email_destination)) return `❌ Email destination requis`;

  // STRATÉGIE 0 — Vérif listing existe sur Centris.ca public (gate against typos/invalid MLS)
  // Si 404 sur public, on évite waste de session courtier sur listing inexistant.
  let listingExistsPublic = false;
  let publicUrl = `https://www.centris.ca/fr/properties~a-vendre/${num}`;
  let listingPublicHtml = null;
  try {
    const r = await fetch(publicUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(15000), redirect: 'follow',
    });
    if (r.ok) {
      listingPublicHtml = await r.text();
      // Page existe si pas "404" et contient signaux listing
      if (!/Property Not Found|404|Page non trouvée/i.test(listingPublicHtml.substring(0, 5000))
          && /MLS|address|adresse|price|prix/i.test(listingPublicHtml.substring(0, 5000))
          && listingPublicHtml.length > 50000) {
        listingExistsPublic = true;
      }
    }
  } catch {}
  if (!listingExistsPublic) {
    return `⚠️ Listing #${num} introuvable sur Centris.ca public.\n\nPossibilités:\n  • MLS invalide ou typo\n  • Listing expiré/retiré\n  • Listing très récent (pas encore indexé)\n\nVérifie le numéro et réessaie. Pour listings dans ton Dropbox, utilise plutôt envoyer_docs_prospect.`;
  }

  if (!process.env.CENTRIS_USER || !process.env.CENTRIS_PASS) {
    return `❌ CENTRIS_USER/PASS non configurés dans Render — impossible d'accéder au portail courtier`;
  }
  // Auto-login si pas connecté
  if (!centrisSession.cookies || Date.now() > centrisSession.expiry) {
    const ok = await centrisLogin();
    if (!ok) {
      // Si login fail, on PEUT quand même envoyer le lien public au client
      log('WARN', 'CENTRIS', `Login échoué, fallback: send lien public`);
      return await _envoyerListingPubliqueLink({ num, email_destination, cc, message_perso, publicUrl });
    }
  }

  // STRATÉGIE 1 — patterns URL PDF directs (testés en ordre)
  // Mise à jour 2026-05-14: agent.centris.ca retiré, faut matrix.centris.ca
  // Note: matrix.centris.ca URLs sont state-based donc difficile en server-side.
  // Si tous échouent → fallback lien public.
  const pdfUrls = [
    `${CENTRIS_BASE}/MX/PrintSheet/${num}`,
    `${CENTRIS_BASE}/MX/PrintSheet?num=${num}`,
    `${CENTRIS_BASE}/fr/agent/listings/${num}/sheet`,
    `${CENTRIS_BASE}/fr/print/${num}`,
    `https://matrix.centris.ca/Matrix/Public/Portal.aspx?L=1&K=1&p=DE-1-1-${num}`,
  ];
  let pdfBuffer = null;
  let pdfSource = null;
  for (const url of pdfUrls) {
    try {
      const res = await fetch(url, {
        headers: { ...CENTRIS_HEADERS, 'Cookie': centrisSession.cookies, 'Referer': CENTRIS_BASE },
        signal: AbortSignal.timeout(30000), redirect: 'follow',
      });
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      // Vérifie magic bytes PDF "%PDF" + taille raisonnable (>5KB)
      if (buf.length > 5000 && buf.slice(0, 4).toString() === '%PDF') {
        pdfBuffer = buf;
        pdfSource = url;
        break;
      }
      // Si HTML retourné, peut contenir lien PDF — strat 2 va le chercher
      if (/text\/html/i.test(ct)) continue;
    } catch (e) { /* retry suivant */ }
  }

  // STRATÉGIE 2 — fallback: fetch page listing + extract liens PDF
  if (!pdfBuffer) {
    const listingUrls = [
      `${CENTRIS_BASE}/fr/agent/listings/${num}`,
      `${CENTRIS_BASE}/fr/listings/${num}`,
      `${CENTRIS_BASE}/property?num=${num}`,
    ];
    for (const url of listingUrls) {
      try {
        const res = await fetch(url, {
          headers: { ...CENTRIS_HEADERS, 'Cookie': centrisSession.cookies, 'Referer': CENTRIS_BASE },
          signal: AbortSignal.timeout(20000), redirect: 'follow',
        });
        if (!res.ok) continue;
        const html = await res.text();
        // Cherche tous liens PDF dans la page
        const pdfMatches = [...html.matchAll(/href=["']([^"']+\.pdf[^"']*)["']/gi)].map(m => m[1]);
        const printMatches = [...html.matchAll(/href=["']([^"']*(?:PrintSheet|print)[^"']*)["']/gi)].map(m => m[1]);
        const candidates = [...new Set([...pdfMatches, ...printMatches])]
          .map(u => u.startsWith('http') ? u : `${CENTRIS_BASE}${u.startsWith('/') ? u : '/' + u}`);
        for (const candUrl of candidates.slice(0, 5)) {
          try {
            const dl = await fetch(candUrl, {
              headers: { ...CENTRIS_HEADERS, 'Cookie': centrisSession.cookies, 'Referer': url },
              signal: AbortSignal.timeout(30000), redirect: 'follow',
            });
            if (!dl.ok) continue;
            const buf = Buffer.from(await dl.arrayBuffer());
            if (buf.length > 5000 && buf.slice(0, 4).toString() === '%PDF') {
              pdfBuffer = buf;
              pdfSource = candUrl;
              break;
            }
          } catch {}
        }
        if (pdfBuffer) break;
      } catch {}
    }
  }

  // STRATÉGIE 3 — fallback CUA (Computer Use Agent) si Matrix HTTP a fail
  // Pilote un vrai Chromium (Browserless ou local) via Claude CUA API pour
  // simuler le clic "Imprimer PDF" sur le portail courtier.
  if (!pdfBuffer) {
    const cua = getCUA();
    if (cua && cua.CUA_AVAILABLE()) {
      log('INFO', 'CENTRIS', `PDF Matrix HTTP non trouvé pour #${num} — tentative CUA browserless`);
      try {
        const cuaRes = await cua.cuaGetCentrisPDF(num);
        if (cuaRes && cuaRes.success && cuaRes.buffer && cuaRes.buffer.length > 5000) {
          pdfBuffer = cuaRes.buffer;
          pdfSource = `CUA${cuaRes.fromCache ? ' (cache 24h)' : ''}`;
          log('OK', 'CENTRIS', `CUA a récupéré PDF #${num} (${Math.round(pdfBuffer.length/1024)}KB) — ${cuaRes.message}`);
        } else {
          log('WARN', 'CENTRIS', `CUA a échoué pour #${num}: ${cuaRes?.message || 'no buffer'}`);
        }
      } catch (e) {
        log('WARN', 'CENTRIS', `CUA exception pour #${num}: ${e.message?.substring(0,150)}`);
      }
    }
  }

  if (!pdfBuffer) {
    // FALLBACK final — listing existe (vérifié strat 0) mais PDF Matrix + CUA inaccessibles
    // Envoie lien public Centris.ca au client (contient toutes les infos + photos)
    log('WARN', 'CENTRIS', `PDF Matrix + CUA tous échoués pour #${num} — fallback lien public`);
    return await _envoyerListingPubliqueLink({ num, email_destination, cc, message_perso, publicUrl });
  }

  // ENVOI EMAIL — via Gmail avec sendEmailLogged (audit + consent attesté)
  const token = await getGmailToken();
  if (!token) return `❌ PDF récupéré (${Math.round(pdfBuffer.length/1024)} KB) mais Gmail token absent`;
  const filename = `Fiche_Centris_${num}.pdf`;
  const subject = `Fiche Centris #${num}${message_perso ? ' — ' + message_perso.substring(0, 40) : ''}`;
  const ccUserRaw = cc;
  const ccUser = !ccUserRaw ? [] : (Array.isArray(ccUserRaw) ? ccUserRaw : String(ccUserRaw).split(',')).map(s => s.trim()).filter(Boolean);
  const ccFinal = [...new Set([AGENT.email, ...ccUser].filter(e => e && e.toLowerCase() !== email_destination.toLowerCase()))];
  const ccLine = ccFinal.length ? [`Cc: ${ccFinal.join(', ')}`] : [];
  const enc = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  const outer = `sbOut${Date.now()}`;
  const introMsg = message_perso || `Voici la fiche détaillée du listing Centris #${num} tel que demandé. Le document complet est en pièce jointe.`;
  const contentHTML = `
<p style="margin:0 0 16px;color:#cccccc;font-size:14px;line-height:1.7;">${escapeHtml(introMsg)}</p>
<div style="background:#111111;border:1px solid #1e1e1e;border-radius:8px;padding:18px;margin:20px 0;">
<div style="color:${AGENT.couleur};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">📎 Pièce jointe</div>
<div style="color:#f5f5f7;font-size:14px;">📄 ${escapeHtml(filename)} <span style="color:#888;">(${Math.round(pdfBuffer.length/1024)} KB)</span></div>
</div>
<p style="margin:16px 0;color:#cccccc;font-size:14px;line-height:1.6;">N'hésitez pas si vous avez des questions — je suis disponible au <strong style="color:${AGENT.couleur};">${AGENT.telephone}</strong>.</p>`;
  let html = await buildEmailFromMasterTpl({
    TITRE_EMAIL: `Fiche Centris #${num}`,
    LABEL_SECTION: `Fiche officielle`,
    TERRITOIRES: `Centris #${num}`,
    HERO_TITRE: `Fiche<br>Centris #${num}.`,
    INTRO_TEXTE: contentHTML,
    CITATION: `Je reste disponible pour répondre à toutes vos questions sur ce dossier.`,
  });
  if (!html) {
    html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Arial,sans-serif;background:#0a0a0a;color:#f5f5f7;margin:0;padding:20px;"><div style="max-width:600px;margin:auto;"><div style="border-top:4px solid ${AGENT.couleur};padding:24px 0;"><h2 style="color:#f5f5f7;margin:0 0 8px;">${escapeHtml(AGENT.nom)}</h2><div style="color:#999;font-size:13px;font-style:italic;">${escapeHtml(AGENT.titre)} · ${escapeHtml(AGENT.compagnie)}</div></div>${contentHTML}<div style="border-top:1px solid #1a1a1a;padding-top:16px;color:#666;font-size:12px;">📞 ${AGENT.telephone} · <a href="mailto:${AGENT.email}" style="color:${AGENT.couleur};">${AGENT.email}</a></div></div></body></html>`;
    log('WARN', 'CENTRIS', `Master template indispo pour fiche #${num}, fallback HTML inline`);
  }
  const lines = [
    `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
    `To: ${email_destination}`,
    ...ccLine,
    `Reply-To: ${AGENT.email}`,
    `Subject: ${enc(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
    `--${outer}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf-8').toString('base64'),
    `--${outer}`,
    `Content-Type: application/pdf`,
    `Content-Disposition: attachment; filename="${enc(filename)}"`,
    'Content-Transfer-Encoding: base64',
    '',
    pdfBuffer.toString('base64'),
    `--${outer}--`,
  ];
  const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  const sent = await sendEmailLogged({
    via: 'gmail', to: email_destination, cc: ccFinal, subject,
    category: 'centris-fiche-download',
    shawnConsent: true, // consent attesté par la commande explicite
    sendFn: () => fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw }),
    }),
  });
  if (!sent.ok) return `❌ PDF récupéré (${Math.round(pdfBuffer.length/1024)} KB) mais envoi Gmail échoué: ${sent.error || sent.status}`;
  auditLogEvent('centris', 'fiche-sent', { num, to: email_destination, bytes: pdfBuffer.length, source: pdfSource });
  return `✅ Fiche Centris #${num} envoyée à *${email_destination}*\n   📄 ${Math.round(pdfBuffer.length/1024)} KB · toi en Cc${ccUser.length ? ' + ' + ccUser.join(', ') : ''}\n   🔗 Source: ${pdfSource}`;
}

async function centrisSearchVendus(type, ville, jours) {
  const ti  = slugType(type);
  const vs  = slugVille(ville);
  const paths = [
    `/fr/${ti.slug}~${ti.genre}~${vs}?view=Vg==&uc=1`,
    `/fr/${ti.slug}~${ti.genre}~${vs}`,
    `/fr/${ti.slug}~vendu~${vs}?view=Vg==`,
    `/fr/${ti.slug}~vendue~${vs}?view=Vg==`,
  ];
  for (const p of paths) {
    try {
      const res = await centrisGet(p);
      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 1000) continue;
      const list = parseCentrisHTML(html, ville, jours);
      if (list.length) { log('OK', 'CENTRIS', `${list.length} vendus: ${p}`); return list; }
    } catch (e) { log('WARN', 'CENTRIS', `${p}: ${e.message}`); }
  }
  return [];
}

// Chercher les ACTIFS (en vigueur) sur Centris
async function centrisSearchActifs(type, ville) {
  const ti  = slugType(type);
  const vs  = slugVille(ville);
  const paths = [
    `/fr/${ti.slug}~a-vendre~${vs}?view=Vg==&uc=1`,
    `/fr/${ti.slug}~a-vendre~${vs}`,
  ];
  for (const p of paths) {
    try {
      const res = await centrisGet(p);
      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 1000) continue;
      const list = parseCentrisHTML(html, ville, 9999); // pas de filtre date pour actifs
      if (list.length) { log('OK', 'CENTRIS', `${list.length} actifs: ${p}`); return list; }
    } catch (e) { log('WARN', 'CENTRIS', `${p}: ${e.message}`); }
  }
  return [];
}

// Télécharger la fiche PDF d'un listing
async function centrisGetFiche(mls) {
  if (!mls) return null;
  const paths = [
    `/fr/listing/pdf/${mls}`,
    `/fr/pdf/listing/${mls}`,
    `/Fiche/${mls}.pdf`,
  ];
  for (const p of paths) {
    try {
      const res = await centrisGet(p);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('pdf') && !ct.includes('application/octet')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5000) { log('OK', 'CENTRIS', `Fiche PDF ${mls}: ${Math.round(buf.length/1024)}KB`); return { buffer: buf, filename: `Centris_${mls}.pdf` }; }
    } catch {}
  }
  return null;
}

// Détails complets d'un listing (données propriété)
async function centrisGetDetails(mls) {
  if (!mls) return {};
  try {
    const res = await centrisGet(`/fr/listing/${mls}`);
    if (!res.ok) return {};
    const html = await res.text();
    return {
      superficie: html.match(/(\d[\d\s,]*)\s*(?:pi²|pi2|sq\.?\s*ft)/i)?.[1]?.replace(/[^\d]/g,'') || null,
      dateVente:  html.match(/(?:vendu?e?|sold)\s*(?:le\s*)?:?\s*(\d{1,2}\s+\w+\s+\d{4})/i)?.[1] || null,
      prixVente:  html.match(/prix\s*(?:de\s*vente)?\s*:?\s*([\d\s,]+)\s*\$/i)?.[1]?.replace(/[^\d]/g,'') || null,
      chambres:   html.match(/(\d+)\s*chambre/i)?.[1] || null,
      sdb:        html.match(/(\d+)\s*salle?\s*(?:de\s*)?bain/i)?.[1] || null,
      annee:      html.match(/(?:année|ann[eé]e?\s+de\s+construction|built)\s*:?\s*(\d{4})/i)?.[1] || null,
    };
  } catch { return {}; }
}

// Fonction principale — chercher comparables (vendus OU actifs)
async function chercherComparablesVendus({ type = 'terrain', ville, jours = 14, statut = 'vendu' }) {
  if (!process.env.CENTRIS_USER) {
    return `❌ CENTRIS_USER/CENTRIS_PASS non configurés dans Render.\nAjouter les env vars CENTRIS_USER et CENTRIS_PASS (valeurs chez Shawn).`;
  }
  if (!ville) return '❌ Précise la ville: ex. "Sainte-Julienne", "Rawdon"';

  const listings = statut === 'actif'
    ? await centrisSearchActifs(type, ville)
    : await centrisSearchVendus(type, ville, jours);

  if (!listings.length) {
    return `Aucun résultat Centris pour "${type}" ${statut === 'actif' ? 'en vigueur' : 'vendu'} à "${ville}".\nEssaie: ${jours+7} jours, ou une ville voisine.`;
  }

  // Enrichir les 6 premiers avec détails complets
  const toEnrich = listings.slice(0, 6);
  const details  = await Promise.all(toEnrich.map(async (l, i) => {
    await new Promise(r => setTimeout(r, i * 300));
    return l.mls ? centrisGetDetails(l.mls) : {};
  }));
  toEnrich.forEach((l, i) => {
    const d = details[i];
    if (d.superficie && !l.superficie) l.superficie = parseInt(d.superficie);
    if (d.dateVente  && !l.dateVente)  l.dateVente  = d.dateVente;
    if (d.prixVente  && !l.prix)       l.prix       = parseInt(d.prixVente);
    if (d.annee) l.annee = d.annee;
  });

  return listings;
}

// Générer le HTML du rapport (style template Signature SB)
function genererRapportHTML(listings, { type, ville, jours, statut = 'vendu' }) {
  const modeLabel  = statut === 'actif' ? 'en vigueur' : 'vendus';
  const typeLabel  = type === 'terrain' ? 'Terrains' : type === 'maison' || type === 'maison_usagee' ? 'Maisons' : (type || 'Propriétés');
  const fmt        = n => n ? `${Number(n).toLocaleString('fr-CA')} $` : '—';
  const fmtSup     = n => n ? `${Number(n).toLocaleString('fr-CA')} pi²` : '—';
  const fmtPp      = (p,s) => (p && s && s > 100) ? `${(p/s).toFixed(2)} $/pi²` : '—';

  const avecPrix  = listings.filter(l => l.prix > 1000);
  const prixMoy   = avecPrix.length ? Math.round(avecPrix.reduce((s,l)=>s+l.prix,0)/avecPrix.length) : 0;
  const prixMin   = avecPrix.length ? Math.min(...avecPrix.map(l=>l.prix)) : 0;
  const prixMax   = avecPrix.length ? Math.max(...avecPrix.map(l=>l.prix)) : 0;
  const avecSup   = listings.filter(l => l.superficie > 100);
  const supMoy    = avecSup.length ? Math.round(avecSup.reduce((s,l)=>s+l.superficie,0)/avecSup.length) : 0;

  const statsBloc = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0;">
<tr>
  <td width="25%" style="padding:4px;"><div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:14px 12px;">
    <div style="color:#aa0721;font-size:24px;font-weight:900;">${listings.length}</div>
    <div style="color:#666;font-size:11px;">${typeLabel} ${modeLabel}${statut==='vendu'?`<br>${jours} derniers jours`:''}</div>
  </div></td>
  <td width="25%" style="padding:4px;"><div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:14px 12px;">
    <div style="color:#aa0721;font-size:18px;font-weight:800;">${fmt(prixMoy)||'—'}</div>
    <div style="color:#666;font-size:11px;">${statut==='actif'?'Prix demandé moyen':'Prix vendu moyen'}</div>
  </div></td>
  <td width="25%" style="padding:4px;"><div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:14px 12px;">
    <div style="color:#f5f5f7;font-size:13px;">${fmt(prixMin)}</div>
    <div style="color:#666;font-size:10px;margin-bottom:6px;">min</div>
    <div style="color:#f5f5f7;font-size:13px;">${fmt(prixMax)}</div>
    <div style="color:#666;font-size:10px;">max</div>
  </div></td>
  ${supMoy ? `<td width="25%" style="padding:4px;"><div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:14px 12px;">
    <div style="color:#aa0721;font-size:18px;font-weight:800;">${fmtSup(supMoy)}</div>
    <div style="color:#666;font-size:11px;">Superficie moy.</div>
  </div></td>` : '<td width="25%"></td>'}
</tr></table>`;

  const lignes = listings.map(l => `
<tr style="border-bottom:1px solid #1a1a1a;">
  <td style="padding:10px 12px;color:#f5f5f7;font-size:13px;vertical-align:top;">
    ${l.adresse || l.titre || 'N/D'}
    ${l.mls ? `<div style="color:#444;font-size:11px;margin-top:2px;">Centris #${l.mls}</div>` : ''}
    ${l.annee ? `<div style="color:#444;font-size:11px;">Année: ${l.annee}</div>` : ''}
  </td>
  <td style="padding:10px 12px;color:#aa0721;font-size:14px;font-weight:800;white-space:nowrap;">${fmt(l.prix)}</td>
  <td style="padding:10px 12px;color:#888;font-size:12px;white-space:nowrap;">${fmtSup(l.superficie)}</td>
  <td style="padding:10px 12px;color:#888;font-size:12px;white-space:nowrap;">${fmtPp(l.prix,l.superficie)}</td>
  <td style="padding:10px 12px;color:#555;font-size:11px;white-space:nowrap;">${l.dateVente || '—'}</td>
</tr>`).join('');

  const tableau = `
<div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;overflow:hidden;margin-top:16px;">
  <div style="color:#aa0721;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:12px 16px 10px;border-bottom:1px solid #1a1a1a;">
    ${typeLabel} ${modeLabel} · ${ville} · Source: Centris.ca (agent ${process.env.CENTRIS_USER||''})
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <thead><tr style="background:#0d0d0d;">
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">PROPRIÉTÉ</th>
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">PRIX</th>
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">SUPERFICIE</th>
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">$/PI²</th>
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">${statut==='actif'?'INSCRIT':'VENDU'}</th>
    </tr></thead>
    <tbody>${lignes}</tbody>
  </table>
</div>`;

  return statsBloc + tableau;
}

// Envoyer le rapport par email avec template Signature SB
async function envoyerRapportComparables({ type = 'terrain', ville, jours = 14, email, statut = 'vendu' }) {
  const dest       = email || AGENT.email;
  const modeLabel  = statut === 'actif' ? 'en vigueur' : 'vendus';
  const typeLabel  = type === 'terrain' ? 'Terrains' : type === 'maison' || type === 'maison_usagee' ? 'Maisons' : (type || 'Propriétés');
  const now        = new Date();
  const dateMois   = now.toLocaleDateString('fr-CA', { month:'long', year:'numeric', timeZone:'America/Toronto' });

  // 1. Chercher les données via Centris (agent authentifié)
  const result = await chercherComparablesVendus({ type, ville, jours, statut });
  if (typeof result === 'string') return result;
  const listings = result;

  // 2. HTML rapport
  const rapportHTML = genererRapportHTML(listings, { type, ville, jours, statut });

  // 3. Lire master template Dropbox
  const tplPath = `${AGENT.dbx_templates}/master_template_signature_sb.html`;
  let template  = null;
  try {
    const tplRes = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: tplPath.startsWith('/') ? tplPath : '/' + tplPath }, true);
    if (tplRes?.ok) template = await tplRes.text();
  } catch {}

  const sujet = `${typeLabel} ${modeLabel} — ${ville} — ${statut==='vendu'?jours+'j':dateMois} | ${AGENT.compagnie}`;

  let htmlFinal;
  if (template && template.length > 5000) {
    const fill = (tpl, params) => { let h = tpl; for (const [k,v] of Object.entries(params)) h = h.split(`{{ params.${k} }}`).join(v??''); return h; };
    const prixMoy = listings.filter(l=>l.prix>1000).length ? Math.round(listings.filter(l=>l.prix>1000).reduce((s,l)=>s+l.prix,0)/listings.filter(l=>l.prix>1000).length).toLocaleString('fr-CA')+' $' : 'N/D';
    htmlFinal = fill(template, {
      TITRE_EMAIL:         `${typeLabel} ${modeLabel} — ${ville}`,
      LABEL_SECTION:       `Centris.ca · ${ville} · ${dateMois}`,
      DATE_MOIS:           dateMois,
      TERRITOIRES:         ville,
      SOUS_TITRE_ANALYSE:  `${typeLabel} ${modeLabel} · ${dateMois}`,
      HERO_TITRE:          `${typeLabel} ${modeLabel}<br>à ${ville}.`,
      INTRO_TEXTE:         `<p style="margin:0 0 16px;color:#cccccc;font-size:14px;">${listings.length} ${typeLabel.toLowerCase()} ${modeLabel} à ${ville}${statut==='vendu'?' dans les '+jours+' derniers jours':''}. Source: Centris.ca — accès agent ${process.env.CENTRIS_USER||''}.</p>`,
      TITRE_SECTION_1:     `Résultats · ${ville} · ${dateMois}`,
      MARCHE_LABEL:        `${typeLabel} ${modeLabel}`,
      PRIX_MEDIAN:         prixMoy,
      VARIATION_PRIX:      `${listings.length} propriétés · Centris.ca`,
      SOURCE_STAT:         `Centris.ca · Accès agent · ${dateMois}`,
      LABEL_TABLEAU:       `Liste complète`,
      TABLEAU_STATS_HTML:  rapportHTML,
      TITRE_SECTION_2:     `Analyse`,
      CITATION:            `Ces données proviennent directement de Centris.ca via votre accès agent. Pour une analyse complète, contactez-moi.`,
      CONTENU_STRATEGIE:   '',
      CTA_TITRE:           `Questions sur le marché?`,
      CTA_SOUS_TITRE:      `Évaluation gratuite, sans engagement.`,
      CTA_URL:             `tel:${AGENT.telephone.replace(/[^\d]/g,'')}`,
      CTA_BOUTON:          `Appeler ${AGENT.prenom} — ${AGENT.telephone}`,
      CTA_NOTE:            `${AGENT.nom} · ${AGENT.compagnie}`,
      REFERENCE_URL:       `tel:${AGENT.telephone.replace(/[^\d]/g,'')}`,
      SOURCES:             `Centris.ca · Accès agent no ${process.env.CENTRIS_USER||''} · ${dateMois}`,
      DESINSCRIPTION_URL:  '',
    });
  } else {
    // Fallback HTML inline brandé
    htmlFinal = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="600" style="max-width:600px;background:#0a0a0a;color:#f5f5f7;">
<tr><td style="background:#aa0721;height:4px;font-size:1px;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 20px;">
  <div style="color:#aa0721;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px;">${AGENT.nom} · ${AGENT.compagnie}</div>
  <h1 style="color:#f5f5f7;font-size:26px;margin:0 0 8px;">${typeLabel} ${modeLabel}<br>à ${ville}</h1>
  <p style="color:#666;font-size:12px;margin:0 0 24px;">Centris.ca · Accès agent · ${dateMois}</p>
  ${rapportHTML}
  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #1e1e1e;color:#555;font-size:12px;">
    ${AGENT.nom} · ${AGENT.telephone} · ${AGENT.site}
  </div>
</td></tr>
</table></td></tr></table>
</body></html>`;
  }

  // 4. Envoyer via Gmail
  const token = await getGmailToken();
  if (!token) return `❌ Gmail non configuré.\nRapport prêt (${listings.length} propriétés) — configure Gmail dans Render.`;

  const boundary = `sb${Date.now()}`;
  const enc      = s => `=?UTF-8?B?${Buffer.from(s,'utf-8').toString('base64')}?=`;
  const plainTxt = `${typeLabel} ${modeLabel} — ${ville}\nSource: Centris.ca (agent ${process.env.CENTRIS_USER||''})\n\n${listings.map((l,i)=>`${i+1}. ${l.adresse||l.titre||'N/D'}${l.mls?' (#'+l.mls+')':''}${l.prix?' — '+Number(l.prix).toLocaleString('fr-CA')+' $':''}${l.superficie?' — '+Number(l.superficie).toLocaleString('fr-CA')+' pi²':''}${l.dateVente?' — '+l.dateVente:''}`).join('\n')}\n\n${AGENT.nom} · ${AGENT.telephone}`;

  const msgLines = [
    `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
    `To: ${dest}`,
    `Reply-To: ${AGENT.email}`,
    `Subject: ${enc(sujet)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    plainTxt,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(htmlFinal,'utf-8').toString('base64'),
    `--${boundary}--`,
  ];
  const raw = Buffer.from(msgLines.join('\r\n'),'utf-8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  await gmailAPI('/messages/send', { method:'POST', body: JSON.stringify({ raw }) });

  const prixMoyNum = listings.filter(l=>l.prix>1000);
  const pm = prixMoyNum.length ? Math.round(prixMoyNum.reduce((s,l)=>s+l.prix,0)/prixMoyNum.length).toLocaleString('fr-CA')+' $' : '';
  return `✅ *Rapport envoyé* à ${dest}\n\n📊 ${listings.length} ${typeLabel.toLowerCase()} ${modeLabel} — ${ville}${statut==='vendu'?' — '+jours+'j':''}\n${pm?'Prix moyen: '+pm+'\n':''}🏠 Source: Centris.ca (agent ${process.env.CENTRIS_USER||''})\n📧 Template Signature SB`;
}

// ─── Outils Claude ────────────────────────────────────────────────────────────
const TOOLS = [
  // ── Pipedrive ──
  { name: 'voir_pipeline',      description: 'Voir tous les deals actifs dans Pipedrive par étape. Pour "mon pipeline", "mes deals", "mes hot leads".', input_schema: { type: 'object', properties: {} } },
  { name: 'chercher_prospect',  description: 'Chercher un prospect dans Pipedrive. Retourne infos, stade, historique, notes. Utiliser AVANT de rédiger tout message.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, email ou téléphone' } }, required: ['terme'] } },
  { name: 'marquer_perdu',      description: 'Marquer un deal comme perdu. Ex: "ça marche pas avec Jean", "cause perdue Tremblay".', input_schema: { type: 'object', properties: { terme: { type: 'string' } }, required: ['terme'] } },
  { name: 'ajouter_note',       description: 'Ajouter une note sur un prospect dans Pipedrive.', input_schema: { type: 'object', properties: { terme: { type: 'string' }, note: { type: 'string' } }, required: ['terme', 'note'] } },
  { name: 'stats_business',     description: 'Tableau de bord: pipeline par étape, performance du mois, taux de conversion.', input_schema: { type: 'object', properties: {} } },
  { name: 'creer_deal',         description: 'Créer un nouveau prospect/deal dans Pipedrive. Utiliser quand Shawn dit "nouveau prospect: [info]" ou reçoit un lead.', input_schema: { type: 'object', properties: { prenom: { type: 'string' }, nom: { type: 'string' }, telephone: { type: 'string' }, email: { type: 'string' }, type: { type: 'string', description: 'terrain, maison_usagee, maison_neuve, construction_neuve, auto_construction, plex' }, source: { type: 'string', description: 'centris, facebook, site_web, reference, appel' }, centris: { type: 'string', description: 'Numéro Centris si disponible' }, note: { type: 'string', description: 'Note initiale: besoin, secteur, budget, délai' } }, required: ['prenom'] } },
  { name: 'planifier_visite',   description: 'Planifier une visite de propriété. Met à jour le deal → Visite prévue + crée activité Pipedrive + sauvegarde pour rappel matin.', input_schema: { type: 'object', properties: { prospect: { type: 'string', description: 'Nom du prospect' }, date: { type: 'string', description: 'Date ISO format YYYY-MM-DDTHH:MM (ex: 2026-04-26T14:00). UTILISE LA DATE COURANTE DU SYSTEM PROMPT, JAMAIS DEVINER L\'ANNÉE.' }, adresse: { type: 'string', description: 'Adresse de la propriété (optionnel)' } }, required: ['prospect', 'date'] } },
  { name: 'voir_visites',      description: 'Voir les visites planifiées (aujourd\'hui + à venir). Pour "mes visites", "c\'est quoi aujourd\'hui".', input_schema: { type: 'object', properties: {} } },
  { name: 'changer_etape',          description: 'Changer l\'étape d\'un deal Pipedrive. Options: nouveau, contacté, discussion, visite prévue, visite faite, offre, gagné.', input_schema: { type: 'object', properties: { terme: { type: 'string' }, etape: { type: 'string' } }, required: ['terme', 'etape'] } },
  { name: 'voir_activites',         description: 'Voir les activités et tâches planifiées pour un deal. "c\'est quoi le prochain step avec Jean?"', input_schema: { type: 'object', properties: { terme: { type: 'string' } }, required: ['terme'] } },
  { name: 'voir_prospect_complet',  description: 'PREMIER outil à appeler pour tout prospect. Vue complète en un appel: stade pipeline, coordonnées (tel+email), toutes les notes, activités, dernier email Gmail, alerte si stagnant. Remplace chercher_prospect pour les analyses.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, email ou téléphone du prospect' } }, required: ['terme'] } },
  { name: 'prospects_stagnants',    description: 'Liste des prospects sans aucune action depuis X jours (défaut: 3j). Pour "c\'est quoi qui stagne?", "qui j\'ai pas contacté?", "qu\'est-ce qui bouge pas?".', input_schema: { type: 'object', properties: { jours: { type: 'number', description: 'Nombre de jours (défaut: 3)' } } } },
  { name: 'historique_contact',     description: 'Timeline chronologique d\'un prospect: notes + activités triées. Compact pour mobile. Pour "c\'est quoi le background de Jean?", "show me the history for Marie".', input_schema: { type: 'object', properties: { terme: { type: 'string' } }, required: ['terme'] } },
  { name: 'repondre_vite',          description: 'Réponse rapide mobile: trouve l\'email du prospect dans Pipedrive AUTOMATIQUEMENT, prépare le brouillon style Shawn. Shawn dit juste son message, le bot fait le reste. Ne pas appeler si email déjà connu — utiliser envoyer_email directement.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom du prospect dans Pipedrive' }, message: { type: 'string', description: 'Texte de la réponse tel que dicté par Shawn' } }, required: ['terme', 'message'] } },
  { name: 'modifier_deal',          description: 'Modifier la valeur, le titre ou la date de clôture d\'un deal.', input_schema: { type: 'object', properties: { terme: { type: 'string' }, valeur: { type: 'number', description: 'Valeur en $ de la transaction' }, titre: { type: 'string' }, dateClose: { type: 'string', description: 'Date ISO YYYY-MM-DD' } }, required: ['terme'] } },
  { name: 'creer_activite',         description: 'Créer une activité/tâche/rappel pour un deal. Types: appel, email, réunion, tâche, visite. UTILISE LA DATE COURANTE DU SYSTEM PROMPT (jamais deviner l\'année). RÈGLES ABSOLUES: (1) ne JAMAIS passer "heure" sauf si Shawn demande explicitement une heure. (2) ZÉRO sujet générique type "Suivi contact/prospect", "Appeler contact/prospect", "Rappeler le prospect" — le bot refuse. Toujours donner un sujet spécifique au client/dossier (ex: "Appel Marie - terrain Rawdon"). (3) Pas de tel ni email connu = NE PAS créer d\'activité de suivi, juste une note.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom du prospect' }, type: { type: 'string', description: 'appel, email, réunion, tâche, visite' }, sujet: { type: 'string', description: 'Sujet SPÉCIFIQUE — JAMAIS générique. Doit nommer le client + l\'action concrète.' }, date: { type: 'string', description: 'Format STRICT YYYY-MM-DD (ex: 2026-04-26). Calculer à partir de la date courante du system prompt.' }, heure: { type: 'string', description: 'OPTIONNEL — Format HH:MM (ex: 14:00). NE PAS PASSER sauf si Shawn demande explicitement une heure.' } }, required: ['terme', 'type'] } },
  { name: 'supprimer_activite',     description: 'SUPPRIMER une activité Pipedrive (doublon, erreur, plus pertinente). Affiche d\'abord les activités d\'un deal pour choisir, ou utilise activity_id direct.', input_schema: { type: 'object', properties: { activity_id: { type: 'number', description: 'ID exact de l\'activité à supprimer (priorité si fourni)' }, terme: { type: 'string', description: 'Nom prospect — le bot affiche les activités du deal et demande quelle supprimer' } } } },
  { name: 'deplacer_activite',      description: 'DÉPLACER une activité d\'un deal vers un autre (utile pour consolider doublons). Source = activity_id, target = nom du deal de destination.', input_schema: { type: 'object', properties: { activity_id: { type: 'number', description: 'ID de l\'activité à déplacer' }, target_deal: { type: 'string', description: 'Nom du deal de destination' } }, required: ['activity_id', 'target_deal'] } },
  { name: 'fusionner_deals',        description: 'FUSIONNER deux deals dupliqués pour un même prospect. Garde le plus récent, transfère activités+notes, supprime l\'autre. Demande confirmation avant.', input_schema: { type: 'object', properties: { deal_garder: { type: 'number', description: 'ID du deal à conserver' }, deal_supprimer: { type: 'number', description: 'ID du deal à fusionner+supprimer' } }, required: ['deal_garder', 'deal_supprimer'] } },
  { name: 'fusionner_personnes',    description: 'FUSIONNER deux personnes dupliquées (même client, 2 fiches). Garde la principale, transfère deals+activités+notes.', input_schema: { type: 'object', properties: { personne_garder: { type: 'number', description: 'ID person à conserver' }, personne_supprimer: { type: 'number', description: 'ID person à fusionner+supprimer' } }, required: ['personne_garder', 'personne_supprimer'] } },
  { name: 'supprimer_deal',         description: 'SUPPRIMER complètement un deal de Pipedrive (irréversible). Utiliser quand un deal a été créé par erreur (test, doublon non-fusionnable, junk). Pour les vrais perdus utiliser plutôt marquer_perdu.', input_schema: { type: 'object', properties: { deal_id: { type: 'number', description: 'ID exact du deal à supprimer' } }, required: ['deal_id'] } },
  { name: 'supprimer_personne',     description: 'SUPPRIMER une personne de Pipedrive (irréversible). Utiliser pour fiches test/doublons non-fusionnables. Si la personne a des deals, fusionner d\'abord.', input_schema: { type: 'object', properties: { personne_id: { type: 'number', description: 'ID person à supprimer' } }, required: ['personne_id'] } },
  { name: 'supprimer_note',         description: 'SUPPRIMER une note Pipedrive (test, erreur). Affiche d\'abord la liste des notes d\'un deal pour choix si terme fourni.', input_schema: { type: 'object', properties: { note_id: { type: 'number', description: 'ID exact de la note' }, terme: { type: 'string', description: 'Nom prospect — affiche les notes du deal pour choix' } } } },
  { name: 'modifier_personne',      description: 'Modifier nom/email/téléphone d\'une personne Pipedrive.', input_schema: { type: 'object', properties: { personne_id: { type: 'number', description: 'ID person' }, nom: { type: 'string' }, email: { type: 'string' }, telephone: { type: 'string' } }, required: ['personne_id'] } },
  { name: 'marquer_gagne',          description: 'Marquer un deal comme GAGNÉ dans Pipedrive avec valeur. Set status=won + stage=55 + value. Vérifie que c\'est bien appliqué après. Préfère cet outil à changer_etape pour les ventes closées.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom du prospect' }, valeur: { type: 'number', description: 'Valeur en $ de la transaction (ex: 2900)' }, devise: { type: 'string', description: 'Code devise (CAD défaut)' } }, required: ['terme', 'valeur'] } },
  { name: 'classer_deal',           description: 'Classer un deal dans la bonne catégorie: type de propriété (terrain/maison_usagee/maison_neuve/plex/etc) ET étape (NOUVEAU→CONTACTÉ→DISCUSSION→VISITE→OFFRE→GAGNÉ). Utilise quand le deal a un type/stage manquant ou faux. Vérifie post-action.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom du prospect ou ID deal' }, type_propriete: { type: 'string', description: 'terrain | maison_usagee | maison_neuve | plex | auto_construction | construction_neuve' }, etape: { type: 'string', description: 'nouveau | contacté | discussion | visite prévue | visite faite | offre | gagné' } }, required: ['terme'] } },
  { name: 'classer_activite',       description: 'Modifier le type/sujet/date d\'une activité existante. Ex: convertir "Appeler Contact" générique en "Appel Marie Dupuis - terrain Rawdon" avec bonne date.', input_schema: { type: 'object', properties: { activity_id: { type: 'number' }, type: { type: 'string', description: 'call | email | meeting | task | visite' }, sujet: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, heure: { type: 'string', description: 'HH:MM' } }, required: ['activity_id'] } },
  // ── Gmail ──
  { name: 'voir_emails_recents', description: 'Voir les emails récents de prospects dans Gmail inbox. Pour "qui a répondu", "nouveaux emails", "mes emails". Exclut les notifications automatiques.', input_schema: { type: 'object', properties: { depuis: { type: 'string', description: 'Période: "1d", "3d", "7d" (défaut: 1d)' } } } },
  { name: 'voir_conversation',   description: 'Voir la conversation Gmail complète avec un prospect (reçus + envoyés, 30 jours). Utiliser AVANT de rédiger un suivi pour avoir tout le contexte.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, prénom ou email du prospect' } }, required: ['terme'] } },
  { name: 'envoyer_email',       description: 'Préparer un brouillon email pour approbation de Shawn. Affiche le brouillon complet — il N\'EST PAS envoyé tant que Shawn ne confirme pas avec "envoie", "go", "ok", "parfait", "d\'accord", etc.', input_schema: { type: 'object', properties: { to: { type: 'string', description: 'Adresse email du destinataire' }, toName: { type: 'string', description: 'Nom du destinataire' }, sujet: { type: 'string', description: 'Objet de l\'email' }, texte: { type: 'string', description: 'Corps de l\'email — texte brut, style Shawn, vouvoiement, max 3 paragraphes courts.' } }, required: ['to', 'sujet', 'texte'] } },
  // ── Centris — Comparables + En vigueur ──
  { name: 'chercher_comparables',         description: 'Chercher propriétés VENDUES sur Centris.ca via accès agent (code 110509). Pour "comparables terrains Sainte-Julienne 14 jours", "maisons vendues Rawdon". Retourne prix, superficie, $/pi², date vendue.', input_schema: { type: 'object', properties: { type: { type: 'string', description: 'terrain, maison, plex, condo (défaut: terrain)' }, ville: { type: 'string', description: 'Ville: Sainte-Julienne, Rawdon, Chertsey, etc.' }, jours: { type: 'number', description: 'Jours en arrière (défaut: 14)' } }, required: ['ville'] } },
  { name: 'proprietes_en_vigueur',        description: 'Chercher propriétés ACTIVES à vendre sur Centris.ca via accès agent. Pour "terrains actifs Sainte-Julienne", "maisons à vendre Rawdon en ce moment". Listings actuels avec prix demandé.', input_schema: { type: 'object', properties: { type: { type: 'string', description: 'terrain, maison, plex (défaut: terrain)' }, ville: { type: 'string', description: 'Ville' } }, required: ['ville'] } },
  { name: 'envoyer_rapport_comparables',  description: 'Chercher sur Centris.ca (agent authentifié) ET envoyer par email avec template Signature SB (logos officiels). Pour "envoie les terrains vendus Sainte-Julienne à [email]". statut: vendu (défaut) ou actif.', input_schema: { type: 'object', properties: { type: { type: 'string', description: 'terrain, maison, plex' }, ville: { type: 'string', description: 'Ville' }, jours: { type: 'number', description: 'Jours (défaut: 14)' }, email: { type: 'string', description: 'Email destination (obligatoire)' }, statut: { type: 'string', description: '"vendu" ou "actif"' } }, required: ['ville', 'email'] } },
  // ── Recherche web ──
  { name: 'rechercher_web',  description: 'Rechercher infos actuelles: taux hypothécaires, stats marché QC, prix construction, réglementations. Enrichit les emails avec données récentes.', input_schema: { type: 'object', properties: { requete: { type: 'string', description: 'Requête précise. Ex: "taux hypothécaire 5 ans fixe Desjardins avril 2025"' } }, required: ['requete'] } },
  // ── GitHub ──
  { name: 'list_github_repos',  description: 'Liste les repos GitHub de Shawn (signaturesb)', input_schema: { type: 'object', properties: {} } },
  { name: 'list_github_files',  description: 'Liste les fichiers dans un dossier d\'un repo GitHub', input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string', description: 'Sous-dossier (vide = racine)' } }, required: ['repo'] } },
  { name: 'read_github_file',   description: 'Lit le contenu d\'un fichier dans un repo GitHub', input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' } }, required: ['repo', 'path'] } },
  { name: 'write_github_file',  description: 'Écrit ou modifie un fichier GitHub (commit direct)', input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' } }, required: ['repo', 'path', 'content'] } },
  // ── Dropbox ──
  { name: 'list_dropbox_folder', description: 'Liste les fichiers dans un dossier Dropbox (documents propriétés, terrains)', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Chemin ("Terrain en ligne" ou "" pour racine)' } }, required: ['path'] } },
  { name: 'read_dropbox_file',   description: 'Lit un fichier texte depuis Dropbox', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'send_dropbox_file',   description: 'Télécharge un PDF/image depuis Dropbox et l\'envoie à Shawn par Telegram', input_schema: { type: 'object', properties: { path: { type: 'string' }, caption: { type: 'string' } }, required: ['path'] } },
  // ── Contacts ──
  { name: 'chercher_contact',  description: 'Chercher dans les contacts iPhone de Shawn (Dropbox /Contacts/contacts.vcf). Trouver tel cell et email perso avant tout suivi. Complète Pipedrive.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, prénom ou numéro de téléphone' } }, required: ['terme'] } },
  // ── Brevo ──
  { name: 'ajouter_brevo',  description: 'Ajouter/mettre à jour un contact dans Brevo. Utiliser quand deal perdu → nurture mensuel, ou nouveau contact à ajouter.', input_schema: { type: 'object', properties: { email: { type: 'string' }, prenom: { type: 'string' }, nom: { type: 'string' }, telephone: { type: 'string' }, liste: { type: 'string', description: 'prospects, acheteurs, vendeurs (défaut: prospects)' } }, required: ['email'] } },
  // ── Fichiers bot ──
  { name: 'read_bot_file',   description: 'Lit un fichier de configuration dans /data/botfiles/', input_schema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] } },
  { name: 'write_bot_file',  description: 'Modifie ou crée un fichier de configuration dans /data/botfiles/', input_schema: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } }, required: ['filename', 'content'] } },
  // ── Listings Dropbox + envoi docs ──
  { name: 'chercher_listing_dropbox', description: 'Chercher un dossier listing dans Dropbox — fouille AUTOMATIQUEMENT les 2 sources: /Terrain en ligne/ ET /Inscription/. Match par ville, adresse ou numéro Centris. Utilise le cache cross-source — résultat instantané. Liste PDFs + photos de chaque dossier trouvé. Source affichée dans la réponse pour traçabilité.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Ville (ex: "Rawdon"), adresse partielle ou numéro Centris (7-9 chiffres)' } }, required: ['terme'] } },
  { name: 'envoyer_docs_prospect',   description: 'Envoie TOUS les docs Dropbox du terrain au client par Gmail (multi-PJ). PDFs passthrough + photos combinées en 1 PDF auto. Template Signature SB + RE/MAX avec logos base64. Match par Centris# ou adresse via index cross-source /Inscription + /Terrain en ligne fusionnés. shawn@signaturesb.com est TOUJOURS AUTOMATIQUEMENT en Cc visible par le client (pas besoin de le spécifier). CCs additionnels (julie@, autres) via le param cc. Note Pipedrive automatique. Utiliser quand Shawn dit "envoie les docs à [nom/email]". Le tool supporte tout — multi-PDF par défaut, CC, envoi même sans deal Pipedrive si email fourni.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom du prospect dans Pipedrive, OU email du client directement si pas encore dans Pipedrive' }, email: { type: 'string', description: 'Email destination (override si Pipedrive email différent)' }, cc: { type: 'string', description: 'CCs ADDITIONNELS en plus de shawn@ qui est auto (ex: "julie@signaturesb.com"). Séparer par virgules si plusieurs.' }, fichier: { type: 'string', description: 'OPTIONNEL — filtrer UN seul PDF (nom partiel). Par défaut: TOUS les docs envoyés.' }, centris: { type: 'string', description: 'OPTIONNEL — # Centris pour forcer match Dropbox (si absent de Pipedrive)' } }, required: ['terme'] } },
  // ── Sync Claude Code ↔ Bot ──
  { name: 'refresh_contexte_session', description: 'Recharger SESSION_LIVE.md depuis GitHub (sync Claude Code ↔ bot). Utiliser quand Shawn mentionne "tu sais pas ça" ou après qu\'il a travaillé dans Claude Code sur son Mac.', input_schema: { type: 'object', properties: {} } },
  // ── Diagnostics ──
  { name: 'tester_dropbox',  description: 'Tester la connexion Dropbox et diagnostiquer les problèmes de tokens. Utiliser quand Dropbox semble brisé.', input_schema: { type: 'object', properties: {} } },
  { name: 'voir_template_dropbox', description: 'Lire les informations du master template email depuis Dropbox. Pour vérifier les placeholders disponibles.', input_schema: { type: 'object', properties: {} } },

  // ── Firecrawl (scraping municipal) ────────────────────────────────────────
  { name: 'scraper_site_municipal', description: 'Scraper le site d\'une municipalité québécoise pour obtenir règlements de zonage, marges latérales, permis, taxes. Cache 30j. Fallback téléphone auto si scrape échoue. Villes: sainte-julienne, rawdon, chertsey, saint-calixte, saint-jean-de-matha, saint-didace, matawinie, d-autray.', input_schema: { type: 'object', properties: { ville: { type: 'string', description: 'Nom ville slug (sainte-julienne, rawdon, chertsey, saint-calixte, saint-jean-de-matha, saint-didace, matawinie, d-autray)' }, sujet: { type: 'string', enum: ['zonage', 'urbanisme', 'permis', 'taxes', 'riveraine'], description: 'Type info (défaut zonage)' } }, required: ['ville'] } },
  { name: 'scraper_url', description: 'Scraper n\'importe quelle URL et extraire markdown (règlements, PDFs convertis, pages gouv). Utiliser mots_cles pour filtrer la section pertinente.', input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL complète https://...' }, mots_cles: { type: 'array', items: { type: 'string' }, description: 'Mots-clés pour filtrer la section (ex: ["marge","latérale","recul"])' } }, required: ['url'] } },
  // ── Recherche web temps réel (Perplexity Sonar) ───────────────────────────
  { name: 'recherche_web', description: 'Recherche web temps réel avec sources citées. Pour stats marché immobilier QC, taux hypothécaires actuels, nouvelles règles OACIQ/AMF, comparables récents. Nécessite PERPLEXITY_API_KEY env var.', input_schema: { type: 'object', properties: { question: { type: 'string', description: 'Question naturelle (ex: "tendance prix terrains Lanaudière 2026", "taux hypothécaire Desjardins aujourd\'hui")' } }, required: ['question'] } },
  // ── Téléchargement PDF + scraping avancé ──────────────────────────────────
  { name: 'telecharger_pdf', description: 'Télécharge un PDF depuis n\'importe quelle URL et l\'envoie direct sur Telegram à Shawn. Utile pour récupérer rapports municipaux, règlements, fiches MLS, certificats de localisation, plans cadastraux. Max 25MB. Retourne URL + taille + envoi confirmé.', input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL complète vers PDF (ex: https://ville.qc.ca/.../zonage.pdf)' }, titre: { type: 'string', description: 'OPTIONNEL — titre/légende pour le PDF dans Telegram' } }, required: ['url'] } },
  { name: 'scraper_avance', description: 'Scrape une URL + extrait automatiquement TOUS les liens PDF trouvés. Utile pour explorer un site municipal/gouvernemental où les docs sont en PDF (ex: page urbanisme avec liens vers règlements, plans, formulaires). Retourne contenu + liste PDFs avec option de les télécharger.', input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL à scraper' }, mots_cles: { type: 'array', items: { type: 'string' }, description: 'OPTIONNEL — filtrer le contenu par mots-clés' }, telecharger_pdfs: { type: 'boolean', description: 'OPTIONNEL — si true, download auto les PDFs trouvés (max 5)' } }, required: ['url'] } },
  { name: 'scraper_pdf_universel', description: 'SCRAPER ULTIME PDF — cascade 3 niveaux (HTTP direct → Firecrawl → Browserless stealth) avec bypass consent walls, anti-bot, JS-rendered. UTILISER quand scraper_avance échoue ou pour sites qui bloquent (cookies wall, Cloudflare, JS SPAs). Auto-click "Accepter cookies"+"J\'accepte". Télécharge auto les PDFs trouvés.', input_schema: { type: 'object', properties: { url: { type: 'string', description: 'URL à scraper' }, mot_cle_filtre: { type: 'string', description: 'OPTIONNEL — filtre PDFs par mot-clé (ex: "zonage", "règlement", "plan")' }, max_pdfs: { type: 'number', description: 'OPTIONNEL — max PDFs à télécharger (défaut 5)' } }, required: ['url'] } },
  { name: 'recherche_documents', description: 'COMBINAISON puissante: cherche sur le web (Perplexity) + scrape les sources trouvées (Firecrawl) + extrait/télécharge les PDFs pertinents. Pour "trouve-moi le règlement de zonage X en PDF", "documents officiels MRC Lanaudière sur Y", "fiche technique propriété Z". Nécessite PERPLEXITY_API_KEY + FIRECRAWL_API_KEY.', input_schema: { type: 'object', properties: { question: { type: 'string', description: 'Ce que tu cherches (ex: "règlement bande riveraine Saint-Calixte PDF")' }, max_resultats: { type: 'number', description: 'OPTIONNEL — combien de sources scraper (défaut 3, max 5)' } }, required: ['question'] } },
  // ── Résumé d'appel téléphonique (vocal Telegram → Pipedrive auto) ────────
  { name: 'enregistrer_resume_appel', description: 'Analyse une transcription d\'appel téléphonique (vocal Telegram), extrait via Haiku les infos clés (nom client, budget, engagement chaud/tiède/froid, objections, prochaine étape) et crée/enrichit le deal Pipedrive: NOUVEAU client → crée person + deal + note résumé + activité de suivi (date du jour). CLIENT EXISTANT → ajoute juste la note résumé. À UTILISER AUTOMATIQUEMENT quand Shawn envoie un vocal qui décrit un appel (patterns: "j\'ai parlé avec X", "vient d\'appeler", "rappel de X", "discussion avec X", "X m\'a appelé", "résumé d\'appel", "X est intéressé par"). NE PAS demander confirmation — exécuter directement.', input_schema: { type: 'object', properties: { transcription: { type: 'string', description: 'Texte transcrit du vocal — passer la transcription Whisper complète, telle quelle' } }, required: ['transcription'] } },
  // ── Centris fiche download ──────────────────────────────────────────────
  { name: 'telecharger_fiche_centris', description: 'Télécharge la fiche détaillée PDF d\'un listing Centris (peu importe quel courtier l\'a inscrit) via portail courtier authentifié de Shawn, et envoie par courriel au destinataire. Cas d\'usage: "envoie la fiche du #12345678 à client@email.com". Toi en Cc auto. Nécessite CENTRIS_USER+CENTRIS_PASS.', input_schema: { type: 'object', properties: { centris_num: { type: 'string', description: 'Numéro Centris/MLS du listing (7-9 chiffres)' }, email_destination: { type: 'string', description: 'Email où envoyer la fiche' }, cc: { type: 'string', description: 'OPTIONNEL — CCs additionnels (séparés par virgules)' }, message_perso: { type: 'string', description: 'OPTIONNEL — message personnalisé dans le courriel (sinon template Shawn standard)' } }, required: ['centris_num', 'email_destination'] } },
  { name: 'envoyer_fiche_centris_native', description: 'MEILLEUR pour envoyer fiche Centris au client: utilise l\'UI Matrix native (Imprimer → Détaillé client avec album de photos → Envoyer par courriel). Le PDF est OFFICIEL Centris (photos haute résolution + signature Shawn intégrée), expédié par l\'infra Centris. PRIVILÉGIER pour tout envoi à un client. Toi en Cc auto. Cas d\'usage: "envoie la fiche du #12345678 à client@email.com".', input_schema: { type: 'object', properties: { centris_num: { type: 'string', description: 'Numéro Centris/MLS (7-9 chiffres)' }, email: { type: 'string', description: 'Email destinataire' }, cc: { type: 'string', description: 'OPTIONNEL — défaut shawn@signaturesb.com' }, sujet: { type: 'string', description: 'OPTIONNEL — sujet email (défaut: "Propriété Centris #N")' }, message: { type: 'string', description: 'OPTIONNEL — corps du courriel (défaut: template standard)' }, format: { type: 'string', enum: ['detaille_client_album_imperial', 'detaille_client_imperial', 'detaille_courtier_album_imperial', 'sommaire_imperial'], description: 'OPTIONNEL — format rapport (défaut album photos)' } }, required: ['centris_num', 'email'] } },
  { name: 'envoyer_tous_documents_zone', description: 'Envoie TOUS les documents d\'un listing Centris (Fiche détaillée + DV + Taxes municipales + Taxes scolaires + Cert localisation + Plans) au destinataire via Zone Centris (zone.centris.ca). Identifie automatiquement le courtier inscripteur. Cas d\'usage: "envoie TOUS les docs du #12345678 à client@email.com". UNE seule action partage tous les documents uploadés par le courtier inscripteur. PLUS COMPLET que envoyer_fiche_centris_native (qui envoie juste la fiche). RECOMMANDÉ: utiliser verifier_listing_centris d\'abord pour vérifier le courtier + liste des docs avant envoi (mode preview sans risque).', input_schema: { type: 'object', properties: { centris_num: { type: 'string', description: 'Numéro Centris (7-9 chiffres)' }, email: { type: 'string', description: 'Email destinataire' }, m_envoyer_copie: { type: 'boolean', description: 'OPTIONNEL — me mettre en copie (défaut false)' }, langue: { type: 'string', enum: ['fr', 'en'], description: 'OPTIONNEL — langue email (défaut fr)' }, message: { type: 'string', description: 'OPTIONNEL — message custom (défaut: message Centris standard)' } }, required: ['centris_num', 'email'] } },
  { name: 'verifier_listing_centris', description: 'PREVIEW SANS ENVOI — vérifie qui est le courtier inscripteur d\'un listing Centris ET liste tous les documents disponibles. ZÉRO email envoyé, juste reconnaissance. Cas d\'usage: "qui vend le #12345678" ou "quels docs sont dispos sur le #12345678" ou "check #12345678 avant d\'envoyer". À utiliser AVANT envoyer_tous_documents_zone pour valider sans risque. Retourne: nom courtier + agence + téléphone + liste des N documents avec tailles.', input_schema: { type: 'object', properties: { centris_num: { type: 'string', description: 'Numéro Centris (7-9 chiffres)' } }, required: ['centris_num'] } },
  { name: 'telecharger_docs_centris_complet', description: 'TOUT-EN-UN: envoie au client la fiche Centris officielle (PDF portail courtier) + TOUS les docs Dropbox matchant (match auto par Centris#). Cas d\'usage: "Envoie tout ce qui est dispo sur #12345678 à client@email.com". Toi en Cc auto sur les 2 envois. Le client reçoit 2 emails (1 avec fiche, 1 avec docs Dropbox).', input_schema: { type: 'object', properties: { centris_num: { type: 'string', description: 'Numéro Centris (7-9 chiffres)' }, email_destination: { type: 'string', description: 'Email du client' }, cc: { type: 'string', description: 'OPTIONNEL — CCs additionnels' }, message_perso: { type: 'string', description: 'OPTIONNEL — message dans email fiche' } }, required: ['centris_num', 'email_destination'] } },
  { name: 'analyser_zonage_adresse', description: 'Trouve et envoie la grille de zonage PDF officielle pour une adresse Lanaudière. Scrape page urbanisme municipal → trouve liens PDF zonage → télécharge → envoie dans Telegram comme document. Optionnellement forward au client par email avec Cc Shawn. Cas d\'usage: "Marges de construction au 123 Ch. Lac Gratten Rawdon" ou "Grille zonage 456 Rue Sarine Sainte-Julienne, envoie à client@email.com".', input_schema: { type: 'object', properties: { adresse: { type: 'string', description: 'Adresse complète avec ville (ex: "123 Chemin Lac Gratten, Rawdon")' }, forward_email: { type: 'string', description: 'OPTIONNEL — email client si demande explicite forward (Shawn dit "envoie à X")' } }, required: ['adresse'] } },
  { name: 'telecharger_annexes_centris', description: 'Récupère TOUTES les annexes Centris d\'un listing via portail courtier authentifié: Déclaration Vendeur (DV), certificat de localisation, plans cadastraux, rapport inspection, etc. Tout ce qui est dans la section "Annexes" du listing Matrix. Cas d\'usage: "Donne-moi la DV du #12345678" ou "Toutes les annexes Centris pour #12345678 à client@email.com".', input_schema: { type: 'object', properties: { centris_num: { type: 'string', description: 'Numéro Centris/MLS (7-9 chiffres)' }, email_destination: { type: 'string', description: 'OPTIONNEL — email client pour forward avec Cc Shawn. Si vide: envoi dans Telegram seulement.' }, filtre: { type: 'string', description: 'OPTIONNEL — filtrer par mot-clé dans nom annexe (ex: "DV", "déclaration", "localisation", "plan"). Si vide: toutes les annexes.' } }, required: ['centris_num'] } },
];

// Cache les tools (statiques) — Anthropic prompt caching sur le dernier tool
// = cache la totalité de la liste TOOLS (envoyée à chaque call). Économise ~90%
// du coût input_tokens des tools. Cache TTL: 5 min (renouvelé à chaque appel).
const TOOLS_WITH_CACHE = TOOLS.map((t, i, arr) => i === arr.length - 1
  ? { ...t, cache_control: { type: 'ephemeral' } }
  : t);

async function executeTool(name, input, chatId) {
  try {
    switch (name) {
      case 'voir_pipeline':        return await getPipeline();
      case 'chercher_prospect':    return await chercherProspect(input.terme);
      case 'marquer_perdu':        return await marquerPerdu(input.terme);
      case 'ajouter_note':         return await ajouterNote(input.terme, input.note);
      case 'stats_business':       return await statsBusiness();
      case 'creer_deal':           return await creerDeal(input);
      case 'planifier_visite':     return await planifierVisite(input);
      case 'voir_visites': {
        const visites = loadJSON(VISITES_FILE, []);
        if (!visites.length) return '📅 Aucune visite planifiée.';
        const now = Date.now();
        const futures = visites.filter(v => new Date(v.date).getTime() > now - 3600000); // +1h passée
        if (!futures.length) return '📅 Aucune visite à venir (toutes passées).';
        const today = new Date().toDateString();
        let txt = `📅 *Visites planifiées — ${futures.length} total*\n\n`;
        for (const v of futures.sort((a, b) => new Date(a.date) - new Date(b.date))) {
          const d   = new Date(v.date);
          const isToday = d.toDateString() === today;
          const dateStr = d.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Toronto' });
          const timeStr = d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
          txt += `${isToday ? '🔴 AUJOURD\'HUI' : '📆'} *${v.nom}*\n${dateStr} à ${timeStr}${v.adresse ? '\n📍 ' + v.adresse : ''}\n\n`;
        }
        return txt.trim();
      }
      case 'changer_etape':           return await changerEtape(input.terme, input.etape);
      case 'voir_activites':          return await voirActivitesDeal(input.terme);
      case 'voir_prospect_complet':   return await voirProspectComplet(input.terme);
      case 'prospects_stagnants':     return await prospectStagnants(input.jours || 3);
      case 'historique_contact':      return await historiqueContact(input.terme);
      case 'repondre_vite':           return await repondreVite(chatId, input.terme, input.message);
      case 'modifier_deal':           return await modifierDeal(input.terme, input);
      case 'creer_activite':          return await creerActivite(input);
      // 🛑 SHAWN 2026-06-09 RÈGLE ABSOLUE: bot a SEULEMENT droit CREATE deal + CREATE activité.
      // JAMAIS DELETE Pipedrive. Si vraiment nécessaire → Shawn fait dans Pipedrive UI directement.
      case 'supprimer_activite':      return `🛑 BLOQUÉ — Shawn 2026-06-09: le bot n'a plus le droit de supprimer dans Pipedrive. Fais-le dans Pipedrive UI.`;
      case 'deplacer_activite':       return await deplacerActivite(input);
      case 'fusionner_deals':         return `🛑 BLOQUÉ — fusion = suppression d'un deal. Fais dans Pipedrive UI.`;
      case 'fusionner_personnes':     return `🛑 BLOQUÉ — fusion = suppression. Fais dans Pipedrive UI.`;
      case 'supprimer_deal':          return `🛑 BLOQUÉ — Shawn 2026-06-09: bot ne supprime pas dans Pipedrive. Fais dans Pipedrive UI.`;
      case 'supprimer_personne':      return `🛑 BLOQUÉ — bot ne supprime pas dans Pipedrive. Fais dans Pipedrive UI.`;
      case 'supprimer_note':          return `🛑 BLOQUÉ — bot ne supprime pas dans Pipedrive. Fais dans Pipedrive UI.`;
      case 'modifier_personne':       return await modifierPersonne(input);
      case 'marquer_gagne':           return await marquerGagne(input);
      case 'classer_deal':            return await classerDeal(input);
      case 'classer_activite':        return await classerActivite(input);
      case 'enregistrer_resume_appel': return await enregistrerResumeAppel(input);
      case 'chercher_comparables': {
        const res = await chercherComparablesVendus({ type: input.type || 'terrain', ville: input.ville, jours: input.jours || 14 });
        if (typeof res === 'string') return res;
        const listings = res;
        const fmt = n => n ? `${Number(n).toLocaleString('fr-CA')} $` : '—';
        const fmtS = n => n ? `${Number(n).toLocaleString('fr-CA')} pi²` : '—';
        const fmtPp = (p,s) => (p&&s&&s>100) ? `${(p/s).toFixed(2)} $/pi²` : '—';
        const avecPrix = listings.filter(l=>l.prix>1000);
        const prixMoy = avecPrix.length ? Math.round(avecPrix.reduce((s,l)=>s+l.prix,0)/avecPrix.length) : 0;
        let txt = `📊 *${listings.length} ${input.type||'terrain'}(s) vendus — ${input.ville} — ${input.jours||14}j*\n`;
        if (prixMoy) txt += `Prix moyen: *${fmt(prixMoy)}*\n`;
        txt += '\n';
        listings.slice(0,12).forEach((l,i) => {
          txt += `${i+1}. ${l.adresse||'Adresse N/D'}${l.mls?' (#'+l.mls+')':''}\n`;
          txt += `   ${fmt(l.prix)} · ${fmtS(l.superficie)} · ${fmtPp(l.prix,l.superficie)}${l.dateVente?' · '+l.dateVente:''}\n`;
        });
        txt += `\n_Source: Pipedrive (deals gagnés)_`;
        if (listings.length > 12) txt += ` · _+ ${listings.length-12} autres — dis "envoie rapport" pour tout par email._`;
        else txt += ` · _Dis "envoie rapport" pour recevoir par email avec template Signature SB._`;
        return txt;
      }
      case 'proprietes_en_vigueur': {
        const res = await chercherComparablesVendus({ type: input.type || 'terrain', ville: input.ville, jours: 9999, statut: 'actif' });
        if (typeof res === 'string') return res;
        const fmt = n => n ? `${Number(n).toLocaleString('fr-CA')} $` : '—';
        const fmtS = n => n ? `${Number(n).toLocaleString('fr-CA')} pi²` : '—';
        let txt = `🏡 *${res.length} ${input.type||'terrain'}(s) en vigueur — ${input.ville}*\nSource: Centris.ca (agent ${process.env.CENTRIS_USER||''})\n\n`;
        res.slice(0,15).forEach((l,i) => {
          txt += `${i+1}. ${l.adresse||'N/D'}${l.mls?' (#'+l.mls+')':''}\n   ${fmt(l.prix)} · ${fmtS(l.superficie)}\n`;
        });
        if (res.length > 15) txt += `\n_+ ${res.length-15} autres — dis "envoie rapport actifs ${input.ville}" pour tout par email._`;
        return txt;
      }
      case 'envoyer_rapport_comparables': return await envoyerRapportComparables({ type: input.type || 'terrain', ville: input.ville, jours: input.jours || 14, email: input.email, statut: input.statut || 'vendu' });
      case 'chercher_listing_dropbox': return await chercherListingDropbox(input.terme);
      case 'envoyer_docs_prospect':    return await envoyerDocsProspect(input.terme, input.email, input.fichier, {
        cc: input.cc ? String(input.cc).split(',').map(s => s.trim()).filter(Boolean) : [],
        centrisHint: input.centris || '',
      });
      case 'voir_emails_recents':  return await voirEmailsRecents(input.depuis || '1d');
      case 'voir_conversation':    return await voirConversation(input.terme);
      case 'envoyer_email': {
        // Stocker le brouillon — ne PAS envoyer encore
        pendingEmails.set(chatId, { to: input.to, toName: input.toName, sujet: input.sujet, texte: input.texte });
        return `📧 *BROUILLON EMAIL — EN ATTENTE D'APPROBATION*\n\n*À:* ${input.toName ? input.toName + ' <' + input.to + '>' : input.to}\n*Objet:* ${input.sujet}\n\n---\n${input.texte}\n---\n\n💬 Dis *"envoie"* pour confirmer, ou modifie ce que tu veux.`;
      }
      case 'rechercher_web':       return await rechercherWeb(input.requete);
      case 'list_github_repos':    return await listGitHubRepos();
      case 'list_github_files':    return await listGitHubFiles(input.repo, input.path || '');
      case 'read_github_file':     return await readGitHubFile(input.repo, input.path);
      case 'write_github_file':    return await writeGitHubFile(input.repo, input.path, input.content, input.message);
      case 'chercher_contact':     return await chercherContact(input.terme);
      case 'ajouter_brevo':        return await ajouterBrevo(input);
      case 'list_dropbox_folder':  return await listDropboxFolder(input.path);
      case 'read_dropbox_file':    return await readDropboxFile(input.path);
      case 'send_dropbox_file': {
        const file = await downloadDropboxFile(input.path);
        if (!file) return `Erreur: impossible de télécharger ${input.path}`;
        await bot.sendDocument(chatId, file.buffer, { caption: input.caption || '' }, { filename: file.filename });
        return `✅ Fichier "${file.filename}" envoyé.`;
      }
      case 'read_bot_file': {
        const dir = path.join(DATA_DIR, 'botfiles');
        const fp  = path.join(dir, path.basename(input.filename));
        if (!fs.existsSync(fp)) return `Fichier introuvable: ${input.filename}`;
        const content = fs.readFileSync(fp, 'utf8');
        return content.length > 8000 ? content.substring(0, 8000) + '\n...[tronqué]' : content;
      }
      case 'write_bot_file': {
        const dir = path.join(DATA_DIR, 'botfiles');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, path.basename(input.filename)), input.content, 'utf8');
        return `✅ "${input.filename}" sauvegardé.`;
      }
      case 'refresh_contexte_session': {
        await loadSessionLiveContext();
        return sessionLiveContext
          ? `✅ *Session rechargée* — ${Math.round(sessionLiveContext.length/1024)}KB\n\n*Contexte actuel:*\n${sessionLiveContext.substring(0, 400)}...`
          : '⚠️ SESSION_LIVE.md vide ou inaccessible.';
      }
      case 'tester_dropbox': {
        const vars = {
          ACCESS_TOKEN: process.env.DROPBOX_ACCESS_TOKEN ? `✅ présent (${process.env.DROPBOX_ACCESS_TOKEN.substring(0,8)}...)` : '❌ absent',
          REFRESH_TOKEN: process.env.DROPBOX_REFRESH_TOKEN ? '✅ présent' : '❌ absent',
          APP_KEY:       process.env.DROPBOX_APP_KEY ? '✅ présent' : '❌ absent',
          APP_SECRET:    process.env.DROPBOX_APP_SECRET ? '✅ présent' : '❌ absent',
        };
        const tokenStatus = dropboxToken ? `✅ token actif (${dropboxToken.substring(0,8)}...)` : '❌ token absent en mémoire';
        let diagMsg = `🔍 *Diagnostic Dropbox*\n\nToken en mémoire: ${tokenStatus}\n\nEnv vars Render:\n`;
        for (const [k, v] of Object.entries(vars)) diagMsg += `• DROPBOX_${k}: ${v}\n`;
        // Tenter un refresh
        const ok = await refreshDropboxToken();
        diagMsg += `\nRefresh token: ${ok ? '✅ Succès' : '❌ Échec'}\n`;
        if (ok) {
          // Tester un vrai appel
          const testRes = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: '', recursive: false });
          if (testRes?.ok) {
            const data = await testRes.json();
            diagMsg += `Connexion API: ✅ OK — ${data.entries?.length || 0} éléments à la racine`;
          } else {
            diagMsg += `Connexion API: ❌ HTTP ${testRes?.status || 'timeout'}`;
          }
        } else {
          diagMsg += `\n⚠️ Vérifier dans Render: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN`;
        }
        return diagMsg;
      }
      case 'voir_template_dropbox': {
        const tplPath = '/Liste de contact/email_templates/master_template_signature_sb.html';
        const res = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: tplPath }, true);
        if (!res || !res.ok) return `❌ Template introuvable: ${tplPath}\nVérifier Dropbox avec tester_dropbox.`;
        const html = await res.text();
        const placeholders = [...html.matchAll(/\{\{\s*params\.(\w+)\s*\}\}/g)].map(m => m[1]);
        const unique = [...new Set(placeholders)];
        const size = Math.round(html.length / 1024);
        return `✅ *Master Template trouvé*\n\nTaille: ${size} KB\nPlaceholders {{ params.X }}: ${unique.length}\n\n${unique.map(p => `• ${p}`).join('\n')}\n\nLogos base64: ${html.includes('data:image/png;base64') ? '✅ présents' : '⚠️ absents'}`;
      }

      case 'scraper_site_municipal': {
        const firecrawl = require('./firecrawl_scraper');
        const { ville, sujet = 'zonage' } = input || {};
        if (!ville) return `❌ Ville requise. Ex: "Sainte-Julienne"`;
        const r = await firecrawl.scrapMunicipalite(ville, sujet);
        if (!r.success) {
          return `⚠️ *Scrape échoué* pour ${r.ville || ville} (${sujet}):\n${r.error}\n\n${r.fallback || ''}`;
        }
        return `✅ *${r.ville}* — ${r.sujet}${r.fromCache ? ` (cache ${r.cached_at?.substring(0, 10)})` : ''}\n` +
               `📍 ${r.url}\n📞 ${r.telephone}${r.note_urbanisme ? ' (' + r.note_urbanisme + ')' : ''}\n` +
               `📊 Quota: ${r.quota}\n\n${r.contenu.substring(0, 3000)}${r.contenu.length > 3000 ? '\n\n...(tronqué)' : ''}`;
      }

      case 'scraper_url': {
        const firecrawl = require('./firecrawl_scraper');
        const { url, mots_cles = [] } = input || {};
        if (!url) return `❌ URL requise`;
        const r = await firecrawl.scrapUrl(url, mots_cles);
        if (!r.success) return `❌ ${r.error}`;
        return `✅ *Scrape réussi*${r.fromCache ? ' (cache)' : ''}\n📍 ${r.url}\n📊 Quota: ${r.quota}\n\n${r.contenu.substring(0, 3000)}${r.contenu.length > 3000 ? '\n\n...(tronqué)' : ''}`;
      }

      case 'recherche_web': {
        if (!process.env.PERPLEXITY_API_KEY) {
          return `❌ PERPLEXITY_API_KEY absent dans Render env vars.\nSign up: perplexity.ai/api → Generate key → ajouter dans dashboard Render.`;
        }
        const { question } = input || {};
        if (!question) return `❌ Question requise`;
        try {
          const r = await fetch('https://api.perplexity.ai/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: 'sonar',
              messages: [
                { role: 'system', content: 'Tu es un assistant expert en immobilier québécois. Réponses courtes (max 300 mots), sources citées, focus Lanaudière/Rive-Nord si pertinent.' },
                { role: 'user', content: question },
              ],
              max_tokens: 500,
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) {
            const err = await r.text().catch(() => '');
            return `❌ Perplexity ${r.status}: ${err.substring(0, 200)}`;
          }
          const data = await r.json();
          const answer = data.choices?.[0]?.message?.content || '(vide)';
          const citations = data.citations || data.choices?.[0]?.message?.citations || [];
          const sources = citations.length ? `\n\n*Sources:*\n${citations.slice(0, 5).map((c, i) => `${i+1}. ${c}`).join('\n')}` : '';
          return `🔍 *${question}*\n\n${answer}${sources}`;
        } catch (e) {
          return `❌ Recherche web: ${e.message.substring(0, 200)}`;
        }
      }

      case 'telecharger_pdf': {
        const { url, titre } = input || {};
        if (!url || !/^https?:\/\//.test(url)) return `❌ URL invalide (doit commencer par http:// ou https://)`;
        try {
          const r = await fetch(url, {
            redirect: 'follow',
            signal: AbortSignal.timeout(60000),
            headers: { 'User-Agent': 'Mozilla/5.0 KiraBot/1.0' },
          });
          if (!r.ok) return `❌ HTTP ${r.status} sur ${url}`;
          const contentType = r.headers.get('content-type') || '';
          const contentLength = parseInt(r.headers.get('content-length') || '0');
          if (contentLength > 25 * 1024 * 1024) return `❌ PDF trop gros (${Math.round(contentLength/1024/1024)}MB > 25MB Telegram limit)`;
          const buf = Buffer.from(await r.arrayBuffer());
          if (buf.length === 0) return `❌ Réponse vide`;
          if (buf.length > 25 * 1024 * 1024) return `❌ Téléchargé ${Math.round(buf.length/1024/1024)}MB > 25MB Telegram limit`;
          // Détection format: PDF magic bytes "%PDF" ou content-type
          const isPDF = buf.slice(0, 4).toString() === '%PDF' || /pdf/i.test(contentType);
          // Nom de fichier: extrait de l'URL ou titre fourni
          const urlName = decodeURIComponent(url.split('/').pop().split('?')[0] || 'document');
          const filename = (titre ? titre.replace(/[^\w\sÀ-ÿ.\-]/g, '_').trim() + '.pdf'
                                  : urlName.endsWith('.pdf') ? urlName : urlName + '.pdf');
          // Envoie via Telegram
          if (!ALLOWED_ID) return `⚠️ ${buf.length} bytes téléchargés mais ALLOWED_ID absent — pas envoyé Telegram`;
          await bot.sendDocument(ALLOWED_ID, buf, {
            caption: `📄 ${titre || filename}\n🔗 ${url.substring(0, 200)}\n📦 ${Math.round(buf.length/1024)} KB`,
          }, { filename, contentType: 'application/pdf' });
          auditLogEvent('download', 'pdf-sent', { url: url.substring(0, 200), bytes: buf.length, isPDF });
          return `✅ PDF envoyé sur Telegram\n📄 ${filename}\n📦 ${Math.round(buf.length/1024)} KB${isPDF ? '' : ' (⚠️ content-type pas PDF, vérifie le contenu)'}`;
        } catch (e) {
          return `❌ Erreur téléchargement: ${e.message.substring(0, 200)}`;
        }
      }

      case 'scraper_avance': {
        const firecrawl = require('./firecrawl_scraper');
        const { url, mots_cles = [], telecharger_pdfs = false } = input || {};
        if (!url) return `❌ URL requise`;
        const r = await firecrawl.scrapUrl(url, mots_cles);
        if (!r.success) return `❌ ${r.error}`;
        // Extraire tous les liens PDF du markdown (format markdown: [text](url.pdf))
        const pdfRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+\.pdf[^\s)]*)\)/gi;
        const pdfs = [];
        let m;
        while ((m = pdfRegex.exec(r.contenu)) !== null) {
          pdfs.push({ text: m[1].substring(0, 80), url: m[2] });
        }
        // Aussi chercher liens PDF "nus" (sans markdown)
        const nakedPdfRegex = /(?<!\]\()https?:\/\/[^\s<>"']+\.pdf\b/gi;
        const nakedPdfs = (r.contenu.match(nakedPdfRegex) || []).filter(u => !pdfs.some(p => p.url === u));
        for (const u of nakedPdfs.slice(0, 10)) pdfs.push({ text: '(lien direct)', url: u });

        let pdfList = '';
        let downloaded = 0;
        if (pdfs.length) {
          pdfList = `\n\n*📎 PDFs trouvés (${pdfs.length}):*\n${pdfs.slice(0, 15).map((p, i) => `${i+1}. ${p.text}\n   ${p.url}`).join('\n')}`;
          if (telecharger_pdfs && ALLOWED_ID) {
            for (const p of pdfs.slice(0, 5)) {
              try {
                const dl = await fetch(p.url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
                if (!dl.ok) continue;
                const buf = Buffer.from(await dl.arrayBuffer());
                if (buf.length === 0 || buf.length > 25 * 1024 * 1024) continue;
                const filename = decodeURIComponent(p.url.split('/').pop().split('?')[0] || 'doc.pdf');
                await bot.sendDocument(ALLOWED_ID, buf, { caption: `📄 ${p.text}\n🔗 ${p.url.substring(0, 200)}` }, { filename, contentType: 'application/pdf' }).catch(() => {});
                downloaded++;
              } catch {}
            }
          }
        }
        return `✅ *Scrape réussi*${r.fromCache ? ' (cache)' : ''}\n📍 ${r.url}\n📊 Quota: ${r.quota}\n\n${r.contenu.substring(0, 2500)}${r.contenu.length > 2500 ? '\n\n...(tronqué)' : ''}${pdfList}${downloaded ? `\n\n✅ ${downloaded} PDF(s) envoyés sur Telegram` : ''}`;
      }

      case 'scraper_pdf_universel': {
        const { url, mot_cle_filtre, max_pdfs } = input || {};
        if (!url || !/^https?:\/\//i.test(url)) return `❌ URL invalide`;
        try {
          const ps = require('./pdf_scraper');
          const r = await ps.findAndDownloadPDFs(url, {
            filterKeyword: mot_cle_filtre,
            maxPDFs: max_pdfs || 5,
          });
          if (!r.success) return `❌ Scraping universel échoué\n${r.message}`;
          // Envoie PDFs sur Telegram
          let sent = 0;
          if (ALLOWED_ID && r.downloaded?.length) {
            for (const doc of r.downloaded) {
              try {
                await bot.sendDocument(ALLOWED_ID, doc.buffer, {
                  caption: `📄 ${doc.text || doc.filename}\n📦 ${Math.round(doc.size/1024)}KB\n🔗 ${doc.url.substring(0, 200)}`,
                  parse_mode: 'Markdown',
                }, { filename: doc.filename, contentType: 'application/pdf' });
                sent++;
              } catch (e) { log('WARN', 'PDF-SCRAPER', `Send: ${e.message}`); }
            }
          }
          return `✅ *Scraping PDF universel — ${r.method}*\n\n` +
                 `📊 ${r.pdf_links_found} PDFs trouvés sur la page\n` +
                 `📥 ${r.downloaded_count} téléchargés${mot_cle_filtre ? ` (filtre: "${mot_cle_filtre}")` : ''}\n` +
                 `📤 ${sent} envoyés sur Telegram\n\n` +
                 r.downloaded.slice(0, 5).map(d => `  📎 ${d.text} (${Math.round(d.size/1024)}KB)`).join('\n');
        } catch (e) {
          return `❌ Exception pdf_scraper: ${e.message?.substring(0, 200)}`;
        }
      }

      case 'telecharger_fiche_centris': {
        return await telechargerFicheCentris(input || {});
      }

      case 'verifier_listing_centris': {
        const { centris_num } = input || {};
        const num = String(centris_num || '').replace(/\D/g, '').trim();
        if (!num || num.length < 7) return `❌ Numéro Centris invalide (7-9 chiffres)`;
        if (!process.env.CENTRIS_USER || !process.env.CENTRIS_PASS) return `❌ CENTRIS_USER/PASS absents`;
        const cuaMod = getCUA();
        if (!cuaMod || !cuaMod.CUA_AVAILABLE()) return `❌ CUA driver indispo`;
        if (!cuaMod.shareCentrisZoneDocuments) return `❌ Function shareCentrisZoneDocuments absente (deploy needed)`;
        log('INFO', 'CENTRIS-ZONE-DRY', `Preview docs #${num}`);
        try {
          const r = await cuaMod.shareCentrisZoneDocuments({ centris_num: num, dry_run: true });
          if (!r.success) return `❌ Preview Zone échoué: ${r.message}`;
          const b = r.broker_info || {};
          const docsTxt = (r.docs_list || []).map((d, i) => `  ${i+1}. ${d.name}${d.size?` (${d.size})`:''}`).join('\n');
          auditLogEvent('centris', 'zone-docs-preview', { num, docs: r.docs_count, broker: b.name });
          return `🔍 *PREVIEW #${num}* — Aucun envoi effectué\n\n` +
                 `*Courtier inscripteur:*\n` +
                 `  • Nom: ${b.name || '?'}\n` +
                 `  • Agence: ${b.agency || '?'}\n` +
                 `  • Tél: ${b.phone || '?'}\n` +
                 `  • Source: ${b.source || '?'}\n\n` +
                 `*${r.docs_count} document${r.docs_count>1?'s':''} disponible${r.docs_count>1?'s':''}:*\n${docsTxt}\n\n` +
                 `🔗 ${r.listing_url}\n\n` +
                 `✅ *Pour envoyer:* "envoie tous les docs du #${num} à client@email.com"`;
        } catch (e) {
          return `❌ Exception preview Zone: ${e.message?.substring(0, 200)}`;
        }
      }

      case 'envoyer_tous_documents_zone': {
        const { centris_num, email, m_envoyer_copie, langue, message } = input || {};
        const num = String(centris_num || '').replace(/\D/g, '').trim();
        if (!num || num.length < 7) return `❌ Numéro Centris invalide (7-9 chiffres)`;
        if (!email || !/@/.test(email)) return `❌ Email destinataire invalide`;
        if (!process.env.CENTRIS_USER || !process.env.CENTRIS_PASS) return `❌ CENTRIS_USER/PASS absents`;
        const cuaMod = getCUA();
        if (!cuaMod || !cuaMod.CUA_AVAILABLE()) return `❌ CUA driver indispo`;
        if (!cuaMod.shareCentrisZoneDocuments) return `❌ Function shareCentrisZoneDocuments absente (deploy needed)`;
        log('INFO', 'CENTRIS-ZONE', `Partage docs #${num} → ${email}`);
        try {
          const r = await cuaMod.shareCentrisZoneDocuments({
            centris_num: num, email,
            sendSelfCopy: m_envoyer_copie === true,
            langue: langue || 'fr', message,
          });
          if (r.success) {
            auditLogEvent('centris', 'zone-docs-shared', { num, email, docs: r.docs_shared, broker: r.broker_info?.name });
            const brokerStr = r.broker_info?.name ? ` (courtier inscripteur: *${r.broker_info.name}* — ${r.broker_info.agency || 'agence ?'})` : '';
            try {
              await sendTelegramWithFallback(
                `📂 *${r.docs_shared} documents Centris #${num} partagés via Zone*\n\n` +
                `📬 À: ${email}\n` +
                `📋 Inclus: Fiche détaillée + DV + Taxes + tout doc uploadé par le courtier inscripteur${brokerStr}\n` +
                `${r.send_self_copy ? '📨 Copie à moi: ✓' : ''}`,
                { category: 'centris-zone-share' }
              ).catch(() => {});
            } catch {}
            return `✅ ${r.docs_shared} documents Centris #${num} partagés à *${email}* via Zone${brokerStr}`;
          }
          return `❌ Partage Zone échoué: ${r.message}\n\nFallback: utilise envoyer_fiche_centris_native (envoie juste la fiche détaillée).`;
        } catch (e) {
          return `❌ Exception partage Zone: ${e.message?.substring(0, 200)}`;
        }
      }

      case 'envoyer_fiche_centris_native': {
        const { centris_num, email, cc, sujet, message, format } = input || {};
        const num = String(centris_num || '').replace(/\D/g, '').trim();
        if (!num || num.length < 7) return `❌ Numéro Centris invalide (7-9 chiffres)`;
        if (!email || !/@/.test(email)) return `❌ Email destinataire invalide`;
        if (!process.env.CENTRIS_USER || !process.env.CENTRIS_PASS) return `❌ CENTRIS_USER/PASS absents Render`;
        const cuaMod = getCUA();
        if (!cuaMod || !cuaMod.CUA_AVAILABLE()) return `❌ CUA driver indispo (playwright manquant)`;
        if (!cuaMod.sendCentrisListingByEmail) return `❌ Fonction sendCentrisListingByEmail absente (deploy needed)`;
        log('INFO', 'CENTRIS-NATIVE', `Envoi fiche #${num} → ${email} (Matrix UI)`);
        try {
          const r = await cuaMod.sendCentrisListingByEmail({
            centris_num: num, email,
            cc: cc || 'shawn@signaturesb.com',
            sujet, message,
            format: format || 'detaille_client_album_imperial',
          });
          if (r.success) {
            auditLogEvent('centris', 'native-sent', { num, email, cc: r.cc, format: r.format });
            // Trace Telegram (visibilité Shawn)
            try {
              await sendTelegramWithFallback(
                `📧 *Fiche Centris #${num} envoyée (Matrix natif)*\n\n` +
                `📬 À: ${email}\n` +
                `📨 Cc: ${r.cc}\n` +
                `📄 Format: ${r.format}\n` +
                `✅ PDF officiel + photos + signature Shawn intégrée`,
                { category: 'centris-native-sent' }
              ).catch(() => {});
            } catch {}
            return `✅ ${r.message}`;
          } else {
            log('WARN', 'CENTRIS-NATIVE', `Échec #${num}: ${r.message}`);
            // Fallback à l'ancien flow HTTP/CUA si disponible
            return `❌ Envoi natif échoué: ${r.message}\n\nFallback: utilise telecharger_fiche_centris à la place.`;
          }
        } catch (e) {
          return `❌ Exception envoi natif: ${e.message?.substring(0, 200)}`;
        }
      }

      case 'telecharger_annexes_centris': {
        const { centris_num, email_destination, filtre } = input || {};
        const num = String(centris_num || '').replace(/\D/g, '').trim();
        if (!num || num.length < 7) return `❌ Numéro Centris invalide`;
        if (!process.env.CENTRIS_USER || !process.env.CENTRIS_PASS) return `❌ CENTRIS_USER/PASS absents`;
        // Login si pas connecté
        if (!centrisSession.cookies || Date.now() > centrisSession.expiry) {
          const ok = await centrisLogin();
          if (!ok) return `❌ Login Centris échoué`;
        }
        // 1. Naviguer page detail comme un humain — tester plusieurs URLs Matrix
        const listingUrls = [
          `${CENTRIS_BASE}/Matrix/Public/Portal.aspx?L=1&K=1&p=DE-1-1-${num}`,
          `${CENTRIS_BASE}/MX/Detail/${num}`,
          `${CENTRIS_BASE}/fr/agent/listings/${num}`,
          `${CENTRIS_BASE}/fr/listings/${num}`,
          `${CENTRIS_BASE}/Detail/${num}`,
        ];
        let detailHtml = null;
        let detailUrl = null;
        for (const url of listingUrls) {
          try {
            const r = await fetch(url, {
              headers: { ...CENTRIS_HEADERS, 'Cookie': centrisSession.cookies, 'Referer': CENTRIS_BASE },
              signal: AbortSignal.timeout(20000), redirect: 'follow',
            });
            if (!r.ok) continue;
            const html = await r.text();
            if (html.length < 5000 || /login|signin|connexion/i.test(html.substring(0, 2000))) continue;
            detailHtml = html;
            detailUrl = r.url || url;
            break;
          } catch {}
        }
        if (!detailHtml) {
          // FALLBACK CUA — pilote vrai navigateur si Matrix HTTP bloqué
          const cuaMod = getCUA();
          if (cuaMod && cuaMod.CUA_AVAILABLE()) {
            log('INFO', 'CENTRIS', `Page detail HTTP non accessible #${num} — tentative annexes via CUA`);
            try {
              const cuaRes = await cuaMod.cuaGetCentrisAnnexes(num, filtre);
              if (cuaRes && cuaRes.success && cuaRes.annexes?.length > 0) {
                // Reformatage compatible avec le reste du flow (toDownload + dl)
                const ok = cuaRes.annexes.map(a => ({
                  buffer: a.buffer, filename: a.filename, label: a.filename,
                  size: a.buffer.length, source: 'CUA'
                }));
                // Envoie Telegram + return msg
                if (ALLOWED_ID) {
                  for (const doc of ok) {
                    await bot.sendDocument(ALLOWED_ID, doc.buffer, {
                      caption: `📎 *${doc.label}*\nCentris #${num} · ${Math.round(doc.size/1024)}KB · via CUA`,
                      parse_mode: 'Markdown',
                    }, { filename: doc.filename, contentType: 'application/pdf' }).catch(e => log('WARN', 'CENTRIS', `Telegram send: ${e.message}`));
                  }
                }
                auditLogEvent('centris', 'annexes-downloaded-cua', { num, count: ok.length, filtre });
                return `📂 *${ok.length} annexes Centris #${num}* récupérées via CUA${filtre ? ` (filtre: "${filtre}")` : ''}\n\n` +
                       ok.map(d => `  📎 ${d.label} (${Math.round(d.size/1024)}KB)`).join('\n');
              }
            } catch (e) {
              log('WARN', 'CENTRIS', `CUA annexes exception: ${e.message?.substring(0,150)}`);
            }
          }
          return `❌ Page detail listing #${num} inaccessible. Vérifie session Centris${cuaMod?.CUA_AVAILABLE() ? ' (CUA aussi échoué)' : ''}.`;
        }
        // 2. Extract TOUS les liens documents/annexes
        // Patterns Centris Matrix:
        //  /Matrix/Public/MediaHandler.ashx?ID=XXX  (PDFs annexes)
        //  /Matrix/Public/Annex.ashx?ID=XXX
        //  /MX/Annex/{id}
        //  href="...déclaration..." href="...DV..." href="...localisation..." href="...plan..."
        const allLinks = [...detailHtml.matchAll(/href=["']([^"']+)["'][^>]*>([^<]{3,120})</gi)]
          .map(m => ({ url: m[1], label: m[2].replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim() }));
        const annexLinks = allLinks.filter(l => {
          const both = (l.url + ' ' + l.label).toLowerCase();
          return /\.pdf|annex|déclaration|declaration|localisation|cadastre|plan|inspection|mediahandler|certificat|servitude|titre/.test(both)
              && !/javascript:|mailto:|tel:|#$/.test(l.url);
        });
        // Dédup
        const seen = new Set();
        const uniqueAnnexes = [];
        for (const a of annexLinks) {
          const key = a.url.split('?')[0];
          if (seen.has(key)) continue;
          seen.add(key);
          uniqueAnnexes.push(a);
        }
        // Filtre optionnel par mot-clé
        let toDownload = uniqueAnnexes;
        if (filtre) {
          const f = filtre.toLowerCase();
          toDownload = uniqueAnnexes.filter(a => (a.url + ' ' + a.label).toLowerCase().includes(f));
        }
        if (!toDownload.length) {
          return `📭 Aucune annexe trouvée pour Centris #${num}${filtre ? ` (filtre: "${filtre}")` : ''}.\n` +
                 `${uniqueAnnexes.length} liens totaux détectés mais aucun match.\n` +
                 `Liens trouvés: ${uniqueAnnexes.slice(0, 5).map(a => a.label || a.url.substring(0, 60)).join(' | ')}`;
        }
        // 3. Download chaque annexe (max 15) — SEQUENTIEL avec délais "humains"
        // pour éviter détection scraping par Centris (rate limit + comportement réel)
        const downloads = [];
        for (let idx = 0; idx < Math.min(toDownload.slice(0, 15).length, 15); idx++) {
          const a = toDownload[idx];
          // Délai aléatoire 800-2400ms entre downloads (comme un humain qui regarde chaque doc)
          if (idx > 0) await new Promise(r => setTimeout(r, 800 + Math.random() * 1600));
          try {
            const absUrl = a.url.startsWith('http') ? a.url : `${CENTRIS_BASE}${a.url.startsWith('/') ? a.url : '/' + a.url}`;
            const dl = await fetch(absUrl, {
              headers: {
                ...CENTRIS_HEADERS,
                'Cookie': centrisSession.cookies,
                'Referer': detailUrl,
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1',
              },
              signal: AbortSignal.timeout(45000), redirect: 'follow',
            });
            if (!dl.ok) { downloads.push({ label: a.label, error: `HTTP ${dl.status}` }); continue; }
            const buf = Buffer.from(await dl.arrayBuffer());
            // Vérifie c'est un PDF (magic bytes)
            if (buf.length < 1000 || buf.slice(0, 4).toString() !== '%PDF') {
              downloads.push({ label: a.label, error: 'pas un PDF' }); continue;
            }
            const cleanLabel = (a.label || `Annexe_${num}`).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
            const filename = `${cleanLabel}_${num}.pdf`;
            downloads.push({ label: a.label, buffer: buf, size: buf.length, filename, url: absUrl });
          } catch (e) { downloads.push({ label: a.label, error: e.message.substring(0, 80) }); }
        }
        const ok = downloads.filter(d => d.buffer);
        const fails = downloads.filter(d => d.error);
        if (!ok.length) {
          return `❌ Aucune annexe téléchargée. ${fails.length} échec(s):\n${fails.slice(0, 5).map(f => `  • ${f.label}: ${f.error}`).join('\n')}`;
        }
        // 4. Envoyer chacune dans Telegram
        if (ALLOWED_ID && chatId) {
          for (const doc of ok) {
            await bot.sendDocument(chatId, doc.buffer, {
              caption: `📎 *${doc.label}*\nCentris #${num} · ${Math.round(doc.size/1024)}KB`,
              parse_mode: 'Markdown',
            }, { filename: doc.filename, contentType: 'application/pdf' }).catch(e => log('WARN', 'CENTRIS', `Telegram send: ${e.message}`));
          }
        }
        // 5. Forward email si demandé (multi-PJ en 1 email)
        let emailMsg = '';
        if (email_destination && /@/.test(email_destination)) {
          const token = await getGmailToken();
          if (!token) { emailMsg = `\n⚠️ Forward client échoué: Gmail token absent`; }
          else {
            const subject = `Annexes Centris #${num}${filtre ? ` — ${filtre}` : ''}`;
            const enc = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
            const outer = `ann${Date.now()}`;
            const pjList = ok.map(d => `<div style="color:#f5f5f7;margin:6px 0;font-size:14px;">📎 ${escapeHtml(d.filename)} <span style="color:#888;">(${Math.round(d.size/1024)}KB)</span></div>`).join('');
            const annexesContent = `
<p style="margin:0 0 16px;color:#cccccc;font-size:14px;line-height:1.7;">Voici les ${ok.length} annexes Centris pour le listing #${num}${filtre ? ` (filtre: <em>${escapeHtml(filtre)}</em>)` : ''}:</p>
<div style="background:#111111;border:1px solid #1e1e1e;border-radius:8px;padding:18px;margin:20px 0;">
<div style="color:${AGENT.couleur};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:12px;">📂 Pièces jointes</div>
${pjList}
</div>
<p style="margin:16px 0;color:#cccccc;font-size:14px;line-height:1.6;">N'hésitez pas si vous avez des questions — je suis disponible au <strong style="color:${AGENT.couleur};">${AGENT.telephone}</strong>.</p>`;
            let html = await buildEmailFromMasterTpl({
              TITRE_EMAIL: `Annexes Centris #${num}`,
              LABEL_SECTION: `Annexes officielles`,
              TERRITOIRES: `Centris #${num}`,
              HERO_TITRE: `Annexes<br>Centris #${num}.`,
              INTRO_TEXTE: annexesContent,
              CITATION: `Je reste disponible pour répondre à toutes vos questions.`,
            });
            if (!html) {
              html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Arial,sans-serif;background:#0a0a0a;color:#f5f5f7;padding:20px;"><div style="max-width:600px;margin:auto;border-top:4px solid ${AGENT.couleur};padding:24px 0;"><h2 style="color:#f5f5f7;">${escapeHtml(AGENT.nom)}</h2>${annexesContent}</div></body></html>`;
              log('WARN', 'CENTRIS', `Master template indispo pour annexes #${num}, fallback inline`);
            }
            const parts = [
              `From: ${AGENT.nom} <${AGENT.email}>`,
              `To: ${email_destination}`,
              `Cc: ${AGENT.email}`,
              `Reply-To: ${AGENT.email}`,
              `Subject: ${enc(subject)}`,
              'MIME-Version: 1.0',
              `Content-Type: multipart/mixed; boundary="${outer}"`,
              '',
              `--${outer}`,
              'Content-Type: text/html; charset=UTF-8',
              'Content-Transfer-Encoding: base64',
              '',
              Buffer.from(html, 'utf-8').toString('base64'),
            ];
            // Cap total taille à 22MB (Gmail limit 25MB avec encoding)
            let totalSize = 0;
            const includedDocs = [];
            for (const d of ok) {
              const encodedSize = Math.ceil(d.size * 4 / 3);
              if (totalSize + encodedSize > 22 * 1024 * 1024) break;
              totalSize += encodedSize;
              includedDocs.push(d);
              parts.push(`--${outer}`);
              parts.push(`Content-Type: application/pdf`);
              parts.push(`Content-Disposition: attachment; filename="${enc(d.filename)}"`);
              parts.push('Content-Transfer-Encoding: base64');
              parts.push('');
              parts.push(d.buffer.toString('base64'));
            }
            parts.push(`--${outer}--`);
            const raw = Buffer.from(parts.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
            const sent = await sendEmailLogged({
              via: 'gmail', to: email_destination, cc: [AGENT.email], subject,
              category: 'centris-annexes-forward', shawnConsent: true,
              sendFn: () => fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ raw }),
              }),
            });
            emailMsg = sent.ok
              ? `\n✅ ${includedDocs.length} annexes envoyées à *${email_destination}* (Cc shawn@)`
              : `\n❌ Email échoué: ${sent.error || sent.status}`;
          }
        }
        auditLogEvent('centris', 'annexes-downloaded', { num, count: ok.length, filtre, forwarded: !!email_destination });
        return `📂 *${ok.length} annexes Centris #${num}* récupérées${filtre ? ` (filtre: "${filtre}")` : ''}\n\n` +
               ok.map(d => `  📎 ${d.label} (${Math.round(d.size/1024)}KB)`).join('\n') +
               (fails.length ? `\n\n⚠️ ${fails.length} échec(s):\n${fails.slice(0, 3).map(f => `  • ${f.label}: ${f.error}`).join('\n')}` : '') +
               emailMsg;
      }

      case 'analyser_zonage_adresse': {
        const { adresse, forward_email } = input || {};
        if (!adresse) return `❌ adresse requise`;
        const _zT0 = Date.now();
        log('INFO', 'ZONAGE', `[STEP 1/5] Parse ville depuis "${adresse}"`);
        // 1. Parse ville depuis l'adresse
        const villesSlug = {
          'sainte-julienne': /sainte[\s-]?julienne|st[\s-]?julienne/i,
          'rawdon': /rawdon/i,
          'chertsey': /chertsey/i,
          'saint-calixte': /saint[\s-]?calixte|st[\s-]?calixte/i,
          'saint-jean-de-matha': /saint[\s-]?jean[\s-]?de[\s-]?matha|st[\s-]?jean[\s-]?de[\s-]?matha/i,
          'saint-didace': /saint[\s-]?didace|st[\s-]?didace/i,
          'matawinie': /matawinie/i,
          'd-autray': /d[\s-]?autray|d'autray/i,
        };
        let ville = null;
        for (const [slug, re] of Object.entries(villesSlug)) {
          if (re.test(adresse)) { ville = slug; break; }
        }
        if (!ville) return `❌ Ville non détectée dans "${adresse}". Villes supportées: ${Object.keys(villesSlug).join(', ')}`;
        log('INFO', 'ZONAGE', `[STEP 1/5] ville détectée: ${ville}`);
        // 2. CASCADE 3 niveaux via pdf_scraper.js (HTTP direct → Firecrawl → Browserless stealth)
        const firecrawl = require('./firecrawl_scraper');
        const muni = firecrawl.MUNICIPALITES?.[ville] || (firecrawl._MUNICIPALITES?.[ville]);
        const urbanismeUrl = muni
          ? `${muni.baseUrl}${muni.pages?.zonage || muni.pages?.urbanisme || ''}`
          : null;
        if (!urbanismeUrl) return `❌ Pas de config urbanisme pour ${ville}`;
        log('INFO', 'ZONAGE', `[STEP 2/5] cascade scrape: ${urbanismeUrl}`);
        let pdfFound = null;
        let scrapeMethod = '?';
        let scrapeMsg = '';
        try {
          const pdfScraper = require('./pdf_scraper');
          const r = await pdfScraper.scrapePDFUniversal(urbanismeUrl, {
            motsCles: ['zonage', 'grille', 'règlement', 'usage', 'marge'],
          });
          scrapeMethod = r.method || '?';
          if (!r.success) {
            scrapeMsg = r.message || 'cascade failed';
            log('WARN', 'ZONAGE', `[STEP 2/5] cascade ÉCHEC (${scrapeMethod}): ${scrapeMsg}`);
            return `⚠️ Scrape ${ville} échoué (cascade L1+L2+L3): ${scrapeMsg}\nContact: ${muni.telephone}${muni.note_urbanisme ? ' ' + muni.note_urbanisme : ''}`;
          }
          log('OK', 'ZONAGE', `[STEP 2/5] cascade OK via ${scrapeMethod} (${r.elapsed_ms || '?'}ms)`);
          // R peut être: directDownload PDF (buffer) OU HTML avec pdf_links
          if (r.buffer && r.method === 'direct-http') {
            // PDF direct trouvé
            pdfFound = { name: r.filename, url: urbanismeUrl, buffer: r.buffer };
          } else {
            // HTML scraped → cherche PDF link zonage
            const pdfLinks = r.pdf_links || [];
            log('INFO', 'ZONAGE', `[STEP 2/5] ${pdfLinks.length} PDF link(s) extraits`);
            const zonagePdf = pdfLinks.find(l =>
              /zonage|grille|règlement|usage|marge/i.test(l.text + ' ' + l.url)
            ) || pdfLinks[0];
            if (zonagePdf) {
              pdfFound = { name: zonagePdf.text || 'Grille zonage', url: zonagePdf.url, buffer: null };
            }
          }
        } catch (e) {
          log('ERROR', 'ZONAGE', `[STEP 2/5] cascade exception: ${e.message}`);
          return `❌ Scrape exception: ${e.message?.substring(0, 200)}`;
        }
        if (!pdfFound) {
          return `⚠️ Aucun PDF zonage trouvé sur le site de ${ville} (cascade L1+L2+L3 OK mais 0 PDF link).\nContact: ${muni.telephone}${muni.note_urbanisme ? ' ' + muni.note_urbanisme : ''}`;
        }
        const pdfUrl = pdfFound.url;
        const pdfLabel = pdfFound.name || 'Grille de zonage';
        log('INFO', 'ZONAGE', `[STEP 3/5] PDF trouvé: ${pdfLabel} → ${pdfUrl.substring(0,80)}`);
        // 3. Download PDF (skip si déjà téléchargé via direct-http)
        let pdfBuffer = pdfFound.buffer;
        if (!pdfBuffer) {
          try {
            const pdfScraper = require('./pdf_scraper');
            const dl = await pdfScraper.downloadDirectPDF(pdfUrl, 60000);
            if (!dl.success) {
              log('ERROR', 'ZONAGE', `[STEP 3/5] download fail: ${dl.message}`);
              return `❌ Download PDF échoué: ${dl.message?.substring(0, 150)}\nURL: ${pdfUrl}`;
            }
            pdfBuffer = dl.buffer;
            if (!pdfBuffer || pdfBuffer.length === 0) return `❌ PDF vide`;
            if (pdfBuffer.length > 25 * 1024 * 1024) return `❌ PDF trop gros (${Math.round(pdfBuffer.length/1024/1024)}MB)`;
            log('OK', 'ZONAGE', `[STEP 3/5] PDF téléchargé ${Math.round(pdfBuffer.length/1024)}KB`);
          } catch (e) { return `❌ Download exception: ${e.message?.substring(0, 100)}`; }
        }
        const filename = `Zonage_${ville}_${Date.now()}.pdf`;
        // 4. Envoyer dans Telegram (Shawn voit)
        if (ALLOWED_ID && chatId) {
          await bot.sendDocument(chatId, pdfBuffer, {
            caption: `🗺 *${pdfLabel}* — ${ville}\nAdresse: ${adresse}\n📎 ${Math.round(pdfBuffer.length/1024)}KB\n🔗 ${pdfUrl.substring(0,80)}`,
            parse_mode: 'Markdown',
          }, { filename, contentType: 'application/pdf' }).catch(e => log('WARN', 'ZONAGE', `Telegram send: ${e.message}`));
        }
        // 5. Forward au client si demandé (avec Cc Shawn auto)
        let forwardMsg = '';
        if (forward_email && /@/.test(forward_email)) {
          try {
            const token = await getGmailToken();
            if (!token) { forwardMsg = `\n⚠️ Forward client échoué: Gmail token absent`; }
            else {
              const subject = `Grille de zonage — ${adresse}`;
              const enc = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
              const outer = `zon${Date.now()}`;
              const zonageContent = `
<p style="margin:0 0 16px;color:#cccccc;font-size:14px;line-height:1.7;">Voici la grille de zonage officielle de la municipalité de <strong style="color:#f5f5f7;">${escapeHtml(ville)}</strong> pour l'adresse <strong style="color:#f5f5f7;">${escapeHtml(adresse)}</strong>.</p>
<div style="background:#111111;border:1px solid #1e1e1e;border-radius:8px;padding:18px;margin:20px 0;">
<div style="color:${AGENT.couleur};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">📎 Document officiel</div>
<div style="color:#f5f5f7;font-size:14px;">🗺 ${escapeHtml(filename)} <span style="color:#888;">(${Math.round(pdfBuffer.length/1024)}KB)</span></div>
</div>
<p style="margin:16px 0;color:#cccccc;font-size:14px;line-height:1.6;">N'hésitez pas si vous avez des questions sur les marges, usages permis ou tout autre détail — je suis disponible au <strong style="color:${AGENT.couleur};">${AGENT.telephone}</strong>.</p>`;
              let html = await buildEmailFromMasterTpl({
                TITRE_EMAIL: `Grille de zonage — ${ville}`,
                LABEL_SECTION: `Document officiel municipal`,
                TERRITOIRES: ville,
                HERO_TITRE: `Grille<br>de zonage.`,
                INTRO_TEXTE: zonageContent,
                CITATION: `Je reste disponible pour vous accompagner dans votre projet.`,
              });
              if (!html) {
                html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Arial,sans-serif;background:#0a0a0a;color:#f5f5f7;padding:20px;"><div style="max-width:600px;margin:auto;border-top:4px solid ${AGENT.couleur};padding:24px 0;"><h2 style="color:#f5f5f7;">${escapeHtml(AGENT.nom)}</h2>${zonageContent}</div></body></html>`;
                log('WARN', 'ZONAGE', `Master template indispo, fallback inline`);
              }
              const ccLine = `Cc: ${AGENT.email}`;
              const lines = [
                `From: ${AGENT.nom} <${AGENT.email}>`,
                `To: ${forward_email}`,
                ccLine,
                `Reply-To: ${AGENT.email}`,
                `Subject: ${enc(subject)}`,
                'MIME-Version: 1.0',
                `Content-Type: multipart/mixed; boundary="${outer}"`,
                '',
                `--${outer}`,
                'Content-Type: text/html; charset=UTF-8',
                'Content-Transfer-Encoding: base64',
                '',
                Buffer.from(html, 'utf-8').toString('base64'),
                `--${outer}`,
                `Content-Type: application/pdf`,
                `Content-Disposition: attachment; filename="${enc(filename)}"`,
                'Content-Transfer-Encoding: base64',
                '',
                pdfBuffer.toString('base64'),
                `--${outer}--`,
              ];
              const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
              const sent = await sendEmailLogged({
                via: 'gmail', to: forward_email, cc: [AGENT.email], subject,
                category: 'zonage-forward',
                shawnConsent: true,
                sendFn: () => fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
                  method: 'POST',
                  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ raw }),
                }),
              });
              forwardMsg = sent.ok ? `\n✅ Email envoyé à *${forward_email}* (Cc shawn@)` : `\n❌ Email échoué: ${sent.error || sent.status}`;
            }
          } catch (e) { forwardMsg = `\n❌ Forward exception: ${e.message?.substring(0,80)}`; }
        }
        auditLogEvent('zonage', 'analysed', { adresse, ville, pdfUrl, forwarded: !!forward_email });
        return `🗺 *Zonage trouvé* — ${ville}\nAdresse: ${adresse}\n📎 PDF envoyé dans Telegram (${Math.round(pdfBuffer.length/1024)}KB)\n🔗 Source: ${pdfUrl.substring(0,100)}${forwardMsg}`;
      }

      case 'telecharger_docs_centris_complet': {
        const { centris_num, email_destination, cc, message_perso } = input || {};
        if (!centris_num || !email_destination) return `❌ centris_num + email_destination requis`;
        const num = String(centris_num).replace(/\D/g, '').trim();
        const results = [];
        // 1. Fiche Centris officielle (portail courtier)
        try {
          const r1 = await telechargerFicheCentris({ centris_num: num, email_destination, cc, message_perso });
          results.push(`📄 *Fiche Centris:*\n${r1}`);
        } catch (e) {
          results.push(`📄 *Fiche Centris:* ❌ ${e.message?.substring(0, 100)}`);
        }
        // 2. Docs Dropbox matching (par Centris#)
        try {
          const r2 = await envoyerDocsProspect(num, email_destination, null, { centrisHint: num });
          results.push(`📁 *Docs Dropbox:*\n${r2}`);
        } catch (e) {
          results.push(`📁 *Docs Dropbox:* ❌ ${e.message?.substring(0, 100)}`);
        }
        auditLogEvent('centris', 'docs-complet-sent', { num, to: email_destination });
        return `✅ *Tout envoyé pour #${num}* → ${email_destination}\n\n${results.join('\n\n')}\n\n_Client a reçu 2 emails: fiche + docs Dropbox. Tu es en Cc sur les 2._`;
      }

      case 'recherche_documents': {
        if (!process.env.PERPLEXITY_API_KEY) return `❌ PERPLEXITY_API_KEY requis`;
        if (!process.env.FIRECRAWL_API_KEY) return `❌ FIRECRAWL_API_KEY requis`;
        const { question, max_resultats = 3 } = input || {};
        if (!question) return `❌ Question requise`;
        const limit = Math.min(parseInt(max_resultats) || 3, 5);
        // Étape 1: Perplexity trouve les meilleures sources
        const queryAugmented = `${question} (sources avec liens directs vers PDF officiels si possible)`;
        let perplexityResp;
        try {
          const r = await fetch('https://api.perplexity.ai/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'sonar',
              messages: [
                { role: 'system', content: 'Tu cherches des documents officiels (PDF, règlements, fiches techniques) immobiliers québécois. Donne des liens DIRECTS vers les sources. Privilégie sites .qc.ca, .gouv.qc.ca, OACIQ, municipalités.' },
                { role: 'user', content: queryAugmented },
              ],
              max_tokens: 600,
            }),
            signal: AbortSignal.timeout(30000),
          });
          if (!r.ok) return `❌ Perplexity ${r.status}`;
          perplexityResp = await r.json();
        } catch (e) { return `❌ Perplexity: ${e.message.substring(0, 200)}`; }

        const answer = perplexityResp.choices?.[0]?.message?.content || '';
        const citations = perplexityResp.citations || [];
        if (!citations.length) return `🔍 *${question}*\n\n${answer}\n\n⚠️ Aucune source citée par Perplexity`;

        // Étape 2: scrape top N sources via Firecrawl
        const firecrawl = require('./firecrawl_scraper');
        const scraped = [];
        const allPdfs = [];
        for (const url of citations.slice(0, limit)) {
          // Si l'URL est déjà un PDF, on télécharge direct
          if (/\.pdf(\?|$)/i.test(url)) { allPdfs.push({ text: 'Source PDF directe', url }); continue; }
          try {
            const sr = await firecrawl.scrapUrl(url, []);
            if (sr.success) {
              scraped.push({ url, contenu: sr.contenu.substring(0, 800) });
              // Extract PDFs from this scrape
              const pdfRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+\.pdf[^\s)]*)\)/gi;
              let m; while ((m = pdfRegex.exec(sr.contenu)) !== null) allPdfs.push({ text: m[1].substring(0, 60), url: m[2] });
              const nakedPdfs = (sr.contenu.match(/(?<!\]\()https?:\/\/[^\s<>"']+\.pdf\b/gi) || []).filter(u => !allPdfs.some(p => p.url === u));
              for (const u of nakedPdfs.slice(0, 5)) allPdfs.push({ text: 'PDF', url: u });
            }
          } catch {}
        }

        // Étape 3: download PDFs trouvés (max 5)
        let downloaded = 0;
        const dlErrors = [];
        for (const p of allPdfs.slice(0, 5)) {
          try {
            const dl = await fetch(p.url, { redirect: 'follow', signal: AbortSignal.timeout(60000), headers: { 'User-Agent': 'Mozilla/5.0 KiraBot/1.0' } });
            if (!dl.ok) { dlErrors.push(`${p.url}: HTTP ${dl.status}`); continue; }
            const buf = Buffer.from(await dl.arrayBuffer());
            if (buf.length === 0 || buf.length > 25 * 1024 * 1024) { dlErrors.push(`${p.url}: ${buf.length === 0 ? 'vide' : 'trop gros'}`); continue; }
            const filename = decodeURIComponent(p.url.split('/').pop().split('?')[0] || 'doc.pdf');
            if (ALLOWED_ID) {
              await bot.sendDocument(ALLOWED_ID, buf, { caption: `📄 ${p.text}\n🔗 ${p.url.substring(0, 200)}` }, { filename, contentType: 'application/pdf' }).catch(() => {});
              downloaded++;
            }
          } catch (e) { dlErrors.push(`${p.url}: ${e.message.substring(0, 60)}`); }
        }

        const lines = [
          `🔍 *${question}*`,
          ``,
          answer.substring(0, 1500),
          ``,
          `*📚 Sources scrapées:* ${scraped.length}/${citations.length}`,
          ...citations.slice(0, limit).map((u, i) => `${i+1}. ${u}`),
        ];
        if (allPdfs.length) lines.push(`\n*📎 PDFs trouvés:* ${allPdfs.length}\n${allPdfs.slice(0, 10).map((p, i) => `${i+1}. ${p.text}\n   ${p.url}`).join('\n')}`);
        if (downloaded) lines.push(`\n✅ ${downloaded} PDF(s) envoyés sur Telegram`);
        if (dlErrors.length) lines.push(`\n⚠️ Échecs téléchargement:\n${dlErrors.slice(0, 3).map(e => '• ' + e).join('\n')}`);
        return lines.join('\n');
      }

      default: return `Outil inconnu: ${name}`;
    }
  } catch (err) {
    return `Erreur outil ${name}: ${err.message}`;
  }
}

// ─── Helper: exécuter un outil avec timeout 30s ───────────────────────────────
async function executeToolSafe(name, input, chatId) {
  return Promise.race([
    executeTool(name, input, chatId),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout outil ${name}`)), 30000))
  ]);
}

// ─── Health score dynamique 0-100 + anomaly detection ───────────────────────
function computeHealthScore() {
  let score = 100;
  const issues = [];
  // Subsystems down (max -30)
  const subsystemsCheck = {
    pipedrive: !!PD_KEY,
    brevo:     !!BREVO_KEY,
    gmail:     !!(process.env.GMAIL_CLIENT_ID && gmailToken),
    dropbox:   !!dropboxToken,
    github:    !!process.env.GITHUB_TOKEN,
  };
  const downSubs = Object.entries(subsystemsCheck).filter(([,v]) => !v).map(([k]) => k);
  if (downSubs.length) { score -= downSubs.length * 8; issues.push(`subsystems_down:${downSubs.join(',')}`); }

  // Errors récentes (max -20)
  const errTotal = metrics.errors.total || 0;
  if (errTotal > 30) { score -= 20; issues.push('errors_high'); }
  else if (errTotal > 10) { score -= 10; issues.push('errors_moderate'); }

  // Webhook health (max -20)
  const wh = global.__webhookHealth;
  if (wh?.status === 'degraded') { score -= 20; issues.push('webhook_degraded'); }
  else if (wh?.consecutiveFails >= 2) { score -= 10; issues.push('webhook_unstable'); }

  // Anthropic credit (max -30)
  if (metrics.lastApiError && /credit|billing|auth/i.test(metrics.lastApiError.message || '')) {
    const age = Date.now() - new Date(metrics.lastApiError.at).getTime();
    if (age < 30*60*1000) { score -= 30; issues.push('anthropic_credit'); }
  }

  // Poller staleness (max -15)
  if (gmailPollerState.lastRun) {
    const minsAgo = (Date.now() - new Date(gmailPollerState.lastRun).getTime()) / 60000;
    if (minsAgo > 20) { score -= 15; issues.push('poller_stale'); }
    else if (minsAgo > 10) { score -= 5; issues.push('poller_slow'); }
  }

  // Circuits ouverts (max -15)
  const openCircuits = Object.values(circuits).filter(c => Date.now() < c.openUntil).length;
  if (openCircuits >= 3) { score -= 15; issues.push(`circuits_open:${openCircuits}`); }
  else if (openCircuits >= 1) { score -= 5; }

  score = Math.max(0, Math.min(100, score));
  const status = score >= 90 ? 'excellent' : score >= 70 ? 'good' : score >= 50 ? 'degraded' : 'critical';
  return { score, status, issues };
}

// Anomaly detection — run every 6h, alert si patterns anormaux
const anomalyState = { lastCheck: 0, lastAlerts: {} };
async function detectAnomalies() {
  anomalyState.lastCheck = Date.now();
  const anomalies = [];
  const now = Date.now();

  // 1. Poller silent >30min (critique)
  if (gmailPollerState.lastRun) {
    const mins = (now - new Date(gmailPollerState.lastRun).getTime()) / 60000;
    if (mins > 30) anomalies.push({ key: 'poller_silent', msg: `Poller silencieux depuis ${Math.round(mins)}min`, severity: 'high' });
  }

  // 2. Zero leads en 24h (alors qu'on s'y attend — check poller actif)
  // NB: ignorer l'alerte si totalsDedup > 0 (dedup fonctionne = c'est normal qu'aucun
  // nouveau lead ne soit processé si tout l'historique est déjà vu).
  // NB2: les emails peuvent être classifiés en noSource/junk/lowInfo — c'est PAS forcément
  // un bug. Seuil élevé + breakdown détaillé pour différencier "personne n'écrit" vs "parser cassé".
  const pollerStatsRef = pollerStats;
  const totalActivityAll = (pollerStatsRef.totalsProcessed || 0) + (pollerStatsRef.totalsDedup || 0)
                          + (pollerStatsRef.totalsNoSource || 0) + (pollerStatsRef.totalsJunk || 0)
                          + (pollerStatsRef.totalsLowInfo || 0);
  const totalProcessingSignal = (pollerStatsRef.totalsProcessed || 0) + (pollerStatsRef.totalsDedup || 0);
  // Vrai bug = beaucoup d'emails classés "noSource" (pas reconnu) + 0 traité réel.
  // Si tout va dans noSource sans aucun traité, le détecteur de source est probablement cassé.
  // Mais seuil >1000 emails (au lieu de >0) pour réduire le bruit.
  if (pollerStatsRef.runs > 200 && totalProcessingSignal === 0 && (pollerStatsRef.totalsNoSource || 0) > 1000) {
    const breakdown = [
      `${pollerStatsRef.totalsNoSource} noSource`,
      `${pollerStatsRef.totalsJunk || 0} junk`,
      `${pollerStatsRef.totalsLowInfo || 0} lowInfo`,
      `${pollerStatsRef.totalsDedup || 0} dedup`,
      `${pollerStatsRef.totalsProcessed || 0} processed`,
    ].join(' · ');
    anomalies.push({
      key: 'no_leads_processed',
      msg: `Source detector cassé? ${pollerStatsRef.totalsFound} emails vus / ${breakdown}`,
      severity: 'high'
    });
  }

  // 2b. Silence poller anormal en heures ouvrables.
  // Définition VRAIE du silence: 0 lead processé OU dedup'd depuis le boot
  // après >500 polls (pas juste 0 auto-sent: un lead peut être auto_skipped,
  // no_dropbox_match, blocked, etc. — c'est de l'activité légitime).
  const nowDate = new Date();
  const torontoHour = (nowDate.getUTCHours() - 4 + 24) % 24;
  const torontoDay = nowDate.getUTCDay();
  const isBusinessHours = torontoDay >= 1 && torontoDay <= 5 && torontoHour >= 8 && torontoHour <= 20;
  const totalActivity = (pollerStatsRef.totalsProcessed || 0) + (pollerStatsRef.totalsDedup || 0);
  if (isBusinessHours && pollerStatsRef.runs > 500 && totalActivity === 0 && (pollerStatsRef.totalsFound || 0) > 100) {
    anomalies.push({
      key: 'business_silence',
      msg: `${pollerStatsRef.runs} polls + ${pollerStatsRef.totalsFound} emails mais 0 lead vu — source detection ou parser cassé`,
      severity: 'high',
    });
  }
  // 2b-bis: alerte SOFT si 0 auto-sent ET 0 pending depuis longtemps (peut-être
  // que tous les leads sont auto_skipped ou no_match). Severity medium.
  if (isBusinessHours && pollerStatsRef.runs > 1000 &&
      (pollerStatsRef.totalsAutoSent || 0) === 0 &&
      (pollerStatsRef.totalsPending || 0) === 0 &&
      (pollerStatsRef.totalsProcessed || 0) > 5) {
    const reasons = [];
    if (pollerStatsRef.totalsNoMatch) reasons.push(`${pollerStatsRef.totalsNoMatch} no_dropbox_match`);
    if (pollerStatsRef.totalsAutoSkipped) reasons.push(`${pollerStatsRef.totalsAutoSkipped} auto_skipped`);
    if (pollerStatsRef.totalsAutoFailed) reasons.push(`${pollerStatsRef.totalsAutoFailed} auto_failed`);
    if (pollerStatsRef.totalsBlocked) reasons.push(`${pollerStatsRef.totalsBlocked} blocked`);
    anomalies.push({
      key: 'no_auto_send_warning',
      msg: `${pollerStatsRef.totalsProcessed} leads traités mais 0 auto-sent · ${reasons.join(' · ') || 'voir /lead-audit'}`,
      severity: 'medium',
    });
  }

  // 2c. Pendings qui s'accumulent (>5 pendingDocSends OU >3 pendingLeads needsName)
  const pendingDocsCount = typeof pendingDocSends !== 'undefined' ? pendingDocSends.size : 0;
  const pendingNamesCount = typeof pendingLeads !== 'undefined' ? pendingLeads.filter(l => l.needsName).length : 0;
  if (pendingDocsCount > 5) anomalies.push({ key: 'pending_docs_pileup', msg: `${pendingDocsCount} pending doc-sends accumulés — auto-send bloqué?`, severity: 'medium' });
  if (pendingNamesCount > 3) anomalies.push({ key: 'pending_names_pileup', msg: `${pendingNamesCount} leads sans nom valide — parser AI peut-être cassé`, severity: 'medium' });

  // 2d. Retry counter dangereusement haut (lead coincé en boucle)
  const highRetries = Object.entries(leadRetryState || {}).filter(([,v]) => v.count >= 3).length;
  if (highRetries >= 2) {
    anomalies.push({ key: 'high_retry_leads', msg: `${highRetries} leads avec >=3 retries — issue technique persistante`, severity: 'medium' });
  }

  // 3. Cost spike aujourd'hui >$20
  const todayCost = costTracker.daily[today()] || 0;
  if (todayCost > 20) anomalies.push({ key: 'cost_spike', msg: `$${todayCost.toFixed(2)} dépensé aujourd'hui — inhabituel`, severity: 'medium' });

  // 4. Taux erreur >20% sur les dernières 100 calls
  const claudeCalls = metrics.api.claude || 0;
  const errTotal = metrics.errors.total || 0;
  if (claudeCalls > 20 && (errTotal / claudeCalls) > 0.2) {
    anomalies.push({ key: 'error_rate_high', msg: `${Math.round(100*errTotal/claudeCalls)}% erreurs (${errTotal}/${claudeCalls})`, severity: 'high' });
  }

  // 5. Health score <70
  const hs = computeHealthScore();
  if (hs.score < 70) anomalies.push({ key: 'health_low', msg: `Score ${hs.score}/100 — issues: ${hs.issues.join(', ')}`, severity: hs.score < 50 ? 'high' : 'medium' });

  // Alerte Telegram avec cooldown 6h par anomalie (high severity → 2h cooldown)
  for (const a of anomalies) {
    const cooldown = a.severity === 'high' ? 2 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
    const lastAlert = anomalyState.lastAlerts[a.key] || 0;
    if (now - lastAlert > cooldown) {
      anomalyState.lastAlerts[a.key] = now;
      const msg = `⚠️ *Anomalie détectée (${a.severity})*\n${a.msg}`;
      // sendTelegramWithFallback: md → plain → email
      if (typeof sendTelegramWithFallback === 'function') {
        sendTelegramWithFallback(msg, { category: 'anomaly', key: a.key }).catch(() => {});
      } else if (ALLOWED_ID) {
        bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' }).catch(() => {});
      }
      auditLogEvent('anomaly', a.key, { msg: a.msg, severity: a.severity });
    }
  }
  return anomalies;
}

// ─── Rate limiting anti-abuse sur webhooks (par IP + route) ──────────────────
const webhookRateMap = new Map(); // "ip:url" → [timestamps recent]
function webhookRateOK(ip, url, maxPerMin = 20) {
  const key = `${ip}:${url}`;
  const now = Date.now();
  const window = 60 * 1000;
  let hits = webhookRateMap.get(key) || [];
  hits = hits.filter(t => now - t < window);
  if (hits.length >= maxPerMin) return false;
  hits.push(now);
  webhookRateMap.set(key, hits);
  // Purge périodique
  if (webhookRateMap.size > 500) {
    for (const [k, arr] of webhookRateMap) if (!arr.some(t => now - t < window)) webhookRateMap.delete(k);
  }
  return true;
}

// ─── Audit log persistant — actions sensibles tracées ────────────────────────
// Stocke dans Gist (survit aux redeploys) les actions: deploys, env changes,
// auth failures, key usage. Shawn peut consulter via /audit.
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
let auditLog = loadJSON(AUDIT_FILE, []);
function auditLogEvent(category, event, details = {}) {
  auditLog.push({ at: new Date().toISOString(), category, event, details });
  if (auditLog.length > 1000) auditLog = auditLog.slice(-1000);
  saveJSON(AUDIT_FILE, auditLog);
  log('INFO', 'AUDIT', `${category}/${event} ${JSON.stringify(details).substring(0, 100)}`);
}

// ─── HEALTH CHECK APIs (boot + cron horaire) ─────────────────────────────────
// Détecte tôt les bugs API critiques (ex: Pipedrive filter qui bypass).
// Stocké data/health.json + endpoint /admin/health + alerte Telegram si dégradation.
const HEALTH_FILE = path.join(DATA_DIR, 'health.json');
let healthState = loadJSON(HEALTH_FILE, { lastRun: null, checks: {}, history: [] });

async function testApisHealth() {
  const results = {};
  const fail = [];
  // 1. Pipedrive — vérifie que /deals/{id}/activities filtre correctement
  try {
    if (PD_KEY) {
      const r = await pdGet('/deals?limit=1');
      const oneDeal = r?.data?.[0];
      if (oneDeal) {
        const acts = await pdGet(`/deals/${oneDeal.id}/activities?limit=20`);
        const list = acts?.data || [];
        const allBelongToDeal = list.every(a => a.deal_id === oneDeal.id || a.deal_id == null);
        results.pipedrive = { ok: allBelongToDeal, sample_deal: oneDeal.id, returned: list.length, all_filtered: allBelongToDeal };
        if (!allBelongToDeal) fail.push('Pipedrive: /deals/{id}/activities returns wrong deals');
      } else { results.pipedrive = { ok: true, note: 'no deals' }; }
    } else { results.pipedrive = { ok: false, error: 'PIPEDRIVE_API_KEY missing' }; fail.push('Pipedrive key missing'); }
  } catch (e) { results.pipedrive = { ok: false, error: e.message }; fail.push(`Pipedrive: ${e.message}`); }
  // 2. Brevo
  try {
    if (process.env.BREVO_API_KEY) {
      const r = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (r.ok) {
        const d = await r.json();
        results.brevo = { ok: true, email: d.email, plan: d.plan?.[0]?.type, credits: d.plan?.[0]?.credits };
      } else { results.brevo = { ok: false, status: r.status }; fail.push(`Brevo HTTP ${r.status}`); }
    } else { results.brevo = { ok: false, error: 'key missing' }; fail.push('Brevo key missing'); }
  } catch (e) { results.brevo = { ok: false, error: e.message }; fail.push(`Brevo: ${e.message}`); }
  // 3. Dropbox
  try {
    if (dropboxToken) {
      const r = await dropboxAPI('https://api.dropboxapi.com/2/users/get_current_account', null);
      if (r?.ok) { const d = await r.json(); results.dropbox = { ok: true, account_type: d.account_type?.['.tag'], email: d.email }; }
      else { results.dropbox = { ok: false, status: r?.status }; fail.push('Dropbox check failed'); }
    } else { results.dropbox = { ok: false, error: 'no token' }; fail.push('Dropbox not connected'); }
  } catch (e) { results.dropbox = { ok: false, error: e.message }; fail.push(`Dropbox: ${e.message}`); }
  // 4. Anthropic
  try {
    if (process.env.ANTHROPIC_API_KEY) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(8000)
      });
      results.anthropic = { ok: r.ok, status: r.status };
      if (!r.ok) fail.push(`Anthropic HTTP ${r.status}`);
    } else { results.anthropic = { ok: false, error: 'key missing' }; fail.push('Anthropic key missing'); }
  } catch (e) { results.anthropic = { ok: false, error: e.message }; fail.push(`Anthropic: ${e.message}`); }
  // 5. Transcription audio — AssemblyAI primaire OU OpenAI Whisper fallback
  // Shawn 2026-05-13: AssemblyAI 5h/mois gratuit suffit pour Zapier workflow.
  // OpenAI = fallback only. Health OK si AU MOINS UN provider configuré.
  try {
    const hasAAI = !!process.env.ASSEMBLYAI_API_KEY;
    const hasOAI = !!process.env.OPENAI_API_KEY;
    if (hasAAI) {
      // Test AssemblyAI: GET /v2/transcript/dummy retourne 404 (auth OK) ou 401 (auth KO)
      const r = await fetch('https://api.assemblyai.com/v2/transcript', {
        method: 'GET',
        headers: { 'Authorization': process.env.ASSEMBLYAI_API_KEY },
        signal: AbortSignal.timeout(8000)
      });
      // Codes acceptés: 200, 400 (params manquants mais auth OK), 405 (méthode KO mais auth OK)
      const aaiOk = r.status < 500 && r.status !== 401 && r.status !== 403;
      results.transcribe = { ok: aaiOk, provider: 'assemblyai', status: r.status, fallback_openai: hasOAI };
      if (!aaiOk && !hasOAI) fail.push(`Transcribe AssemblyAI HTTP ${r.status} et pas de fallback OpenAI`);
    } else if (hasOAI) {
      const r = await fetch('https://api.openai.com/v1/models', {
        headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
        signal: AbortSignal.timeout(8000)
      });
      results.transcribe = { ok: r.ok, provider: 'openai-whisper', status: r.status };
      if (!r.ok) fail.push(`OpenAI HTTP ${r.status}`);
    } else {
      results.transcribe = { ok: false, error: 'aucun provider configuré (AssemblyAI ni OpenAI)' };
      fail.push('Transcription: ni AssemblyAI ni OpenAI configuré');
    }
  } catch (e) { results.transcribe = { ok: false, error: e.message }; fail.push(`Transcribe: ${e.message}`); }

  const allOk = fail.length === 0;
  healthState.lastRun = new Date().toISOString();
  healthState.checks = results;
  healthState.lastFailures = fail;
  // Garde 30 derniers runs
  healthState.history = healthState.history || [];
  healthState.history.push({ at: healthState.lastRun, ok: allOk, fails: fail });
  if (healthState.history.length > 30) healthState.history = healthState.history.slice(-30);
  saveJSON(HEALTH_FILE, healthState);

  // Alerte Telegram si nouveau fail (pas de spam si même fail récurrent)
  const lastAlertKey = `lastHealthAlert_${fail.sort().join('|')}`;
  if (!allOk && !healthState[lastAlertKey] && ALLOWED_ID) {
    healthState[lastAlertKey] = healthState.lastRun;
    saveJSON(HEALTH_FILE, healthState);
    const msg = `🩺 *HEALTH CHECK FAILED*\n\n${fail.map(f => `❌ ${f}`).join('\n')}\n\n_Tape /health pour détails_`;
    sendTelegramWithFallback(msg, { category: 'health-fail' }).catch(() => {});
  }
  if (allOk) {
    // Reset alert flags si tout OK
    Object.keys(healthState).filter(k => k.startsWith('lastHealthAlert_')).forEach(k => delete healthState[k]);
    saveJSON(HEALTH_FILE, healthState);
  }
  log(allOk ? 'OK' : 'WARN', 'HEALTH', `${allOk ? 'all green' : `${fail.length} fail`}: ${Object.keys(results).map(k => `${k}=${results[k].ok?'✅':'❌'}`).join(' ')}`);
  return { allOk, results, failures: fail };
}

// ─── BACKUP HELPER (snapshot avant action destructive) ────────────────────────
async function backupBeforeAction(label, items) {
  if (!items || !items.length) return { backed_up: 0, dropbox_path: null };
  // Auto-refresh si pas de token (vs skip avant) — résout 401 fréquent (Shawn 2026-05-13)
  if (!dropboxToken) {
    log('WARN', 'BACKUP', `Pas de Dropbox token — tentative refresh pour ${label}`);
    const ok = await refreshDropboxToken();
    if (!ok) {
      // Fallback: persistent disk Render
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const localPath = path.join(DATA_DIR, 'backups', `${label}_${ts}.json`);
        require('fs').mkdirSync(require('path').dirname(localPath), { recursive: true });
        require('fs').writeFileSync(localPath, JSON.stringify({ at: new Date().toISOString(), label, count: items.length, items }, null, 2));
        log('OK', 'BACKUP', `${label}: ${items.length} items → ${localPath} (local fallback)`);
        return { backed_up: items.length, dropbox_path: null, local_path: localPath, fallback: 'local' };
      } catch (e) {
        return { backed_up: 0, dropbox_path: null, error: 'no dropbox + local fail' };
      }
    }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dbxPath = `/Backups/${label}_${ts}.json`;
  const content = JSON.stringify({ at: new Date().toISOString(), label, count: items.length, items }, null, 2);
  const buffer = Buffer.from(content, 'utf-8');
  const doUpload = async () => fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${dropboxToken}`,
      'Dropbox-API-Arg': JSON.stringify({ path: dbxPath, mode: 'add', autorename: true, mute: true }),
      'Content-Type': 'application/octet-stream',
    },
    body: buffer,
  });
  try {
    let res = await doUpload();
    // Auto-retry sur 401 (token expiré pendant l'opération) — comme dropboxAPI wrapper
    if (res.status === 401) {
      log('WARN', 'BACKUP', `${label}: token expiré, refresh + retry`);
      const ok = await refreshDropboxToken();
      if (ok) res = await doUpload();
    }
    if (res.ok) {
      const data = await res.json();
      log('OK', 'BACKUP', `${label}: ${items.length} items → ${data.path_lower}`);
      return { backed_up: items.length, dropbox_path: data.path_lower };
    } else {
      const err = await res.text();
      log('WARN', 'BACKUP', `${label} fail: ${res.status} ${err.substring(0, 100)}`);
      // Fallback local disk si Dropbox toujours en échec après retry
      try {
        const localPath = path.join(DATA_DIR, 'backups', `${label}_${ts}.json`);
        require('fs').mkdirSync(require('path').dirname(localPath), { recursive: true });
        require('fs').writeFileSync(localPath, content);
        log('OK', 'BACKUP', `${label}: fallback → ${localPath}`);
        return { backed_up: items.length, dropbox_path: null, local_path: localPath, fallback: 'local_after_401' };
      } catch {
        return { backed_up: 0, dropbox_path: null, error: `HTTP ${res.status}` };
      }
    }
  } catch (e) {
    log('WARN', 'BACKUP', `${label} exception: ${e.message}`);
    return { backed_up: 0, dropbox_path: null, error: e.message };
  }
}

// ─── Cost tracking Anthropic ─────────────────────────────────────────────────
// Prix par million tokens (2026 pricing Anthropic — confirmed docs.claude.com 2026-06-09)
const PRICING = {
  'claude-fable-5':     { in: 10.00, out: 50.00, cache_read: 1.00,  cache_write: 12.50 }, // GA 2026-06-09 — Mythos-class, top-tier
  'claude-mythos-5':    { in: 10.00, out: 50.00, cache_read: 1.00,  cache_write: 12.50 }, // Invitation-only Glasswing
  'claude-opus-4-8':    { in:  5.00, out: 25.00, cache_read: 0.50,  cache_write:  6.25 },
  'claude-opus-4-7':    { in:  5.00, out: 25.00, cache_read: 0.50,  cache_write:  6.25 }, // legacy fallback
  'claude-sonnet-4-6':  { in:  3.00, out: 15.00, cache_read: 0.30,  cache_write:  3.75 },
  'claude-haiku-4-5':   { in:  1.00, out:  5.00, cache_read: 0.10,  cache_write:  1.25 },
};
const COST_FILE = path.join(DATA_DIR, 'cost_tracker.json');
let costTracker = loadJSON(COST_FILE, { daily: {}, monthly: {}, total: 0, byModel: {}, alertsSent: {} });

// ─── OpenAI Whisper cost tracking ────────────────────────────────────────────
// Whisper: $0.006 per minute audio (2026 pricing)
const OPENAI_COST_FILE = path.join(DATA_DIR, 'openai_cost.json');
let openaiCost = loadJSON(OPENAI_COST_FILE, { daily: {}, monthly: {}, total: 0, totalMinutes: 0 });
function trackWhisperCost(durationSec) {
  if (!durationSec || durationSec <= 0) return;
  const minutes = durationSec / 60;
  const cost = minutes * 0.006;
  const d = today(), m = thisMonth();
  openaiCost.daily[d]   = (openaiCost.daily[d]   || 0) + cost;
  openaiCost.monthly[m] = (openaiCost.monthly[m] || 0) + cost;
  openaiCost.total += cost;
  openaiCost.totalMinutes = (openaiCost.totalMinutes || 0) + minutes;
  // Purge daily >30j
  const cutoffDay = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  Object.keys(openaiCost.daily).forEach(k => { if (k < cutoffDay) delete openaiCost.daily[k]; });
  saveJSON(OPENAI_COST_FILE, openaiCost);
}

// ─── Abonnements business (fixes + variables) ────────────────────────────────
// Source de vérité pour le coût total mensuel de la business.
// Shawn met à jour les prix via /sub_set <id> <prix_USD> ou /sub_set <id> <prix_CAD> CAD
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');
const DEFAULTS_VERSION = 2; // bump pour forcer re-seed sur prochain boot
const DEFAULT_SUBS = [
  // ── INFRA & DEV ───────────────────────────────────────────────────────────
  { id: 'render',       name: 'Render Hosting',        category: 'Infra',   price_usd: 7,     est: true,  notes: 'Web service Starter ~$7/mo (à confirmer dashboard)' },
  { id: 'github',       name: 'GitHub',                category: 'Dev',     price_usd: 0,     est: false, notes: 'Free tier' },
  { id: 'claude_code',  name: 'Claude Code (Shawn)',   category: 'Dev',     price_usd: 158,   est: false, notes: 'Confirmé Shawn 2026-05-03: $158/mois' },
  { id: 'domain',       name: 'Domaine signaturesb.com', category: 'Infra', price_usd: 1.25,  est: true,  notes: 'Annuel ~$15 ÷ 12' },
  // ── PIPEDRIVE — payé annuel, exclu du mensuel (Shawn 2026-05-03) ─────────
  // Pas dans la liste mensuelle. Recalculer si plan change.
  // ── STORAGE ───────────────────────────────────────────────────────────────
  // Confirmé via API Dropbox: account_type=pro, 3.3 TB → Dropbox Essentials/Professional
  { id: 'dropbox',      name: 'Dropbox Essentials (3 TB)', category: 'Storage', price_usd: 19.99, est: false, notes: 'Confirmé via API: account_type=pro, 3300 GB allocated. Tier Essentials 3 TB.' },
  // ── EMAIL ─────────────────────────────────────────────────────────────────
  // Confirmé via API Brevo: subscription active, 17,995 sendLimit credits/mo → Starter tier
  { id: 'brevo',        name: 'Brevo Starter (~20K emails)', category: 'Email', price_usd: 29, est: true, notes: 'Confirmé via API: subscription active, 17,995 send credits/mo. Tier Starter (~$29/mo). Confirmer prix exact dans dashboard Brevo.' },
  // ── APIs PAY-PER-USE (variables) ──────────────────────────────────────────
  { id: 'anthropic_api', name: 'Anthropic API (bot)',   category: 'API',    variable: true,   notes: 'Pay-as-you-go — voir /cout pour détails' },
  { id: 'openai',        name: 'OpenAI Whisper',        category: 'API',    variable: true,   notes: 'Pay-as-you-go $0.006/min audio — auto-tracké' },
  { id: 'firecrawl',    name: 'Firecrawl',             category: 'API', price_usd: 0,    est: false, notes: 'Free tier (500 scrapes/mo) — actif' },
  // ── COMMUNICATION ─────────────────────────────────────────────────────────
  { id: 'telegram',     name: 'Telegram Bot',          category: 'Comm',    price_usd: 0,     est: false, notes: 'Gratuit' },
  // ── À VENIR (planifiés) ───────────────────────────────────────────────────
  { id: 'tapeacall',    name: 'TapeACall (planifié)',  category: 'Phone',   price_usd: 11.99, est: true,  pending: true, notes: 'Pas encore actif — pour enregistrement appels' },
  { id: 'zapier',       name: 'Zapier (planifié)',     category: 'Automation', price_usd: 19.99, est: true, pending: true, notes: 'Pas encore actif — pour TapeACall→Bot' },
];
let subscriptions = loadJSON(SUBS_FILE, { items: DEFAULT_SUBS, lastUpdate: new Date().toISOString(), usd_to_cad: 1.36, defaultsVersion: DEFAULTS_VERSION });
// Migration: si DEFAULTS_VERSION changé, on RESET les items (préserve user-set prices via merge intelligent)
{
  const oldVersion = subscriptions.defaultsVersion || 0;
  if (oldVersion < DEFAULTS_VERSION) {
    // Nouvelle version — reset items mais préserve les prix confirmés (est:false) déjà set par Shawn
    const userConfirmed = (subscriptions.items || []).filter(s => s.confirmedAt && !s.est).reduce((acc, s) => { acc[s.id] = s; return acc; }, {});
    subscriptions.items = DEFAULT_SUBS.map(def => userConfirmed[def.id] || { ...def });
    subscriptions.defaultsVersion = DEFAULTS_VERSION;
    subscriptions.migratedAt = new Date().toISOString();
    saveJSON(SUBS_FILE, subscriptions);
    log('OK', 'SUBS', `Migration v${oldVersion}→v${DEFAULTS_VERSION}: ${subscriptions.items.length} items, ${Object.keys(userConfirmed).length} prix Shawn préservés`);
  } else {
    // Même version — juste ajouter les nouveaux items qui n'existent pas
    const existingIds = new Set((subscriptions.items || []).map(s => s.id));
    for (const def of DEFAULT_SUBS) {
      if (!existingIds.has(def.id)) subscriptions.items.push(def);
    }
    saveJSON(SUBS_FILE, subscriptions);
  }
}

function getMonthlyVariableCosts() {
  const m = thisMonth();
  // Anthropic API (bot — pas Claude Code)
  const anthro = costTracker.monthly[m] || 0;
  // OpenAI Whisper
  const openai = openaiCost.monthly[m] || 0;
  // Projection: extrapoler sur jour-mois
  const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate();
  const daysElapsed = Math.max(1, new Date().getDate());
  return {
    anthropic_actual: anthro,
    anthropic_projected: anthro / daysElapsed * daysInMonth,
    openai_actual: openai,
    openai_projected: openai / daysElapsed * daysInMonth,
    openai_minutes: openaiCost.totalMinutes || 0,
  };
}

function formatBusinessReport() {
  const rate = subscriptions.usd_to_cad || 1.36;
  const v = getMonthlyVariableCosts();
  // Grouper par catégorie
  const byCategory = {};
  let totalUsdFixed = 0, totalCadFixed = 0;
  const pending = [];
  for (const s of subscriptions.items) {
    if (s.pending) { pending.push(s); continue; }
    if (s.variable) continue;
    const cat = s.category || 'Autre';
    if (!byCategory[cat]) byCategory[cat] = [];
    let usdEq = 0, cadEq = 0;
    if (s.price_usd != null) { usdEq = s.price_usd; cadEq = s.price_usd * rate; }
    else if (s.price_cad != null) { cadEq = s.price_cad; usdEq = s.price_cad / rate; }
    totalUsdFixed += usdEq; totalCadFixed += cadEq;
    byCategory[cat].push({ ...s, usdEq, cadEq });
  }
  const lines = [];
  lines.push(`💰 *RAPPORT COÛT BUSINESS — ${new Date().toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })}*`);
  lines.push(`_Taux USD→CAD: ${rate}_\n`);

  // Section: abonnements fixes par catégorie
  for (const cat of Object.keys(byCategory).sort()) {
    lines.push(`*${cat}*`);
    for (const s of byCategory[cat]) {
      const priceLine = s.price_usd != null
        ? `$${s.price_usd.toFixed(2)} USD ≈ $${(s.price_usd * rate).toFixed(2)} CAD`
        : s.price_cad != null
          ? `$${s.price_cad.toFixed(2)} CAD ≈ $${(s.price_cad / rate).toFixed(2)} USD`
          : '*?*';
      const flag = s.est ? ' 🔸' : ''; // 🔸 = estimation
      lines.push(`  • ${s.name}: ${priceLine}${flag}`);
    }
    lines.push('');
  }

  // Section: APIs variables
  lines.push(`*API Pay-As-You-Go (ce mois)*`);
  lines.push(`  • Anthropic (bot): $${v.anthropic_actual.toFixed(2)} actuel · proj. $${v.anthropic_projected.toFixed(2)}`);
  lines.push(`  • OpenAI Whisper: $${v.openai_actual.toFixed(2)} actuel · proj. $${v.openai_projected.toFixed(2)} (${v.openai_minutes.toFixed(0)} min audio)`);
  const anthroProjCad = v.anthropic_projected * rate;
  const openaiProjCad = v.openai_projected * rate;
  const totalVarUsd = v.anthropic_projected + v.openai_projected;
  const totalVarCad = anthroProjCad + openaiProjCad;
  lines.push('');

  // GRAND TOTAL
  const grandTotalUsd = totalUsdFixed + totalVarUsd;
  const grandTotalCad = totalCadFixed + totalVarCad;
  lines.push(`━━━━━━━━━━━━━━━━━━━━━━━`);
  lines.push(`*🏆 TOTAL MENSUEL PROJETÉ*`);
  lines.push(`USD: *$${grandTotalUsd.toFixed(2)}*  ·  CAD: *$${grandTotalCad.toFixed(2)}*`);
  lines.push(`  Fixes: $${totalUsdFixed.toFixed(2)} USD ($${totalCadFixed.toFixed(2)} CAD)`);
  lines.push(`  Variables: $${totalVarUsd.toFixed(2)} USD ($${totalVarCad.toFixed(2)} CAD)`);
  lines.push('');

  if (pending.length) {
    lines.push(`*🆕 Planifiés (pas encore actifs)*`);
    for (const s of pending) {
      const usd = s.price_usd || 0;
      lines.push(`  • ${s.name}: $${usd.toFixed(2)} USD → impact +$${(usd * rate).toFixed(2)} CAD/mo`);
    }
    lines.push('');
  }

  lines.push(`🔸 = estimation à confirmer · 📝 ajuste avec \`/sub_set <id> <prix>\` (ex: \`/sub_set pipedrive 49.90\`)`);
  lines.push(`📋 IDs: ${subscriptions.items.filter(s => !s.variable && !s.pending).map(s => s.id).join(', ')}`);
  return lines.join('\n');
}
function today() { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return new Date().toISOString().slice(0, 7); }
function trackCost(model, usage) {
  if (!usage) return 0;
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  const inp = (usage.input_tokens || 0) / 1e6 * p.in;
  const out = (usage.output_tokens || 0) / 1e6 * p.out;
  const cacheRead  = (usage.cache_read_input_tokens  || 0) / 1e6 * p.cache_read;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) / 1e6 * p.cache_write;
  const cost = inp + out + cacheRead + cacheWrite;
  const d = today(), m = thisMonth();
  costTracker.daily[d]   = (costTracker.daily[d]   || 0) + cost;
  costTracker.monthly[m] = (costTracker.monthly[m] || 0) + cost;
  costTracker.total += cost;
  costTracker.byModel[model] = (costTracker.byModel[model] || 0) + cost;
  // Cache hit metrics — verify prompt caching effectiveness
  costTracker.cacheStats = costTracker.cacheStats || { hits: 0, writes: 0, totalInput: 0, totalCacheRead: 0 };
  costTracker.cacheStats.totalInput     += (usage.input_tokens || 0);
  costTracker.cacheStats.totalCacheRead += (usage.cache_read_input_tokens || 0);
  if (usage.cache_read_input_tokens > 0) costTracker.cacheStats.hits++;
  if (usage.cache_creation_input_tokens > 0) costTracker.cacheStats.writes++;
  // Purge daily >30j, monthly >12m
  const cutoffDay = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  Object.keys(costTracker.daily).forEach(k => { if (k < cutoffDay) delete costTracker.daily[k]; });
  saveJSON(COST_FILE, costTracker);
  // Alertes seuils (anti-runaway)
  const todayCost = costTracker.daily[d];
  const monthCost = costTracker.monthly[m];
  if (todayCost > 10 && !costTracker.alertsSent[`d${d}-10`]) {
    costTracker.alertsSent[`d${d}-10`] = true;
    saveJSON(COST_FILE, costTracker);
    sendTelegramWithFallback(`💰 *Coût Anthropic aujourd'hui: $${todayCost.toFixed(2)}*\nSeuil 10$/jour atteint. Mois: $${monthCost.toFixed(2)}.`, { category: 'cost-daily-threshold' }).catch(() => {});
  }
  // Spike alert — coût aujourd'hui > 3× moyenne 7 derniers jours
  const last7 = Object.entries(costTracker.daily || {})
    .filter(([k]) => k < d)
    .sort((a,b) => b[0].localeCompare(a[0]))
    .slice(0, 7)
    .map(([,v]) => v);
  if (last7.length >= 3) {
    const avg = last7.reduce((s,v) => s+v, 0) / last7.length;
    if (todayCost > 3 * avg && todayCost > 1 && !costTracker.alertsSent[`spike${d}`]) {
      costTracker.alertsSent[`spike${d}`] = true;
      saveJSON(COST_FILE, costTracker);
      sendTelegramWithFallback(`📈 *Spike Anthropic*\nAujourd'hui: $${todayCost.toFixed(2)} (${(todayCost/avg).toFixed(1)}× moyenne 7j: $${avg.toFixed(2)})\n\n_Vérifie /cout pour breakdown par modèle._`, { category: 'cost-spike' }).catch(() => {});
    }
  }
  if (monthCost > 100 && !costTracker.alertsSent[`m${m}-100`]) {
    costTracker.alertsSent[`m${m}-100`] = true;
    saveJSON(COST_FILE, costTracker);
    sendTelegramWithFallback(`💰 *Anthropic mois: $${monthCost.toFixed(2)}*\nSeuil 100$/mois atteint. Vérifier usage dans /cout.`, { category: 'cost-monthly-threshold' }).catch(() => {});
  }
  return cost; // pour CONV_BUDGET_USD check dans tool loop
}

// ─── Routing auto modèle selon type de tâche ─────────────────────────────────
// Sonnet 4.6 par défaut (5x moins cher), switch Opus 4.8 auto sur mots-clés
// qui indiquent recherche/analyse/stratégie/négociation/optimisation.
// Shawn peut toujours forcer via /opus ou /sonnet ou /haiku.
// OPUS 4.8 triggers — analyses + recherches + comparaisons (cas standards)
const OPUS_TRIGGERS = /\b(analys|optim|recherch|compar|[eé]val|estim|march[eé]\s+(?:immo|actuel)|rapport\s+(?:march[eé]|vente|pro)|plan\s+d['e]action|pr[eé]vis|penser|think|r[eé]fl[eé]ch|deep\s+dive|pourquoi|analys(?:e|er)\s+ce|regarde\s+(?:en\s+)?d[eé]tail|(?:quel|combien|calcul).*prix|prix\s+(?:du?\s*march|de\s+vente|[àa]\s+mettre|demand|conseil|juste)|conseil\s+prix)/i;
// FABLE 5 triggers — ANALYSES / STRATÉGIES / NÉGOCIATIONS (préférence Shawn 2026-06-09: mode hybride)
const FABLE_TRIGGERS = /\b(strat[eé]g|n[eé]goci|ultra|fable|mythos|maximum|le\s+meilleur\s+mod[eè]le|le\s+plus\s+puissant|top.tier|profondeur\s+max|analyse\s+ultime|strat[eé]gie\s+majeure|cerveau|rapport\s+annuel|portefeuille\s+complet)/i;
const MODEL_DEFAULT = 'claude-sonnet-4-6';
function pickModelForMessage(userMsg) {
  // Shawn a explicitement forcé un modèle non-default (/opus, /fable, /haiku) → respecter
  if (currentModel !== MODEL_DEFAULT) return currentModel;
  // Env var MODEL définie → respecter
  if (process.env.MODEL) return currentModel;
  // FABLE 5 — top-tier sur demande explicite seulement (2× coût Opus)
  if (FABLE_TRIGGERS.test(userMsg || '')) {
    log('INFO', 'ROUTER', `Fable 5 demandé explicitement → top-tier ($10/$50)`);
    return 'claude-fable-5';
  }
  // Thinking mode activé → toujours Opus (deep reasoning)
  if (thinkingMode) return 'claude-opus-4-8';
  // Mot-clé complexité/stratégie/analyse détecté → Opus pour CE message uniquement
  if (OPUS_TRIGGERS.test(userMsg || '')) {
    log('INFO', 'ROUTER', `Complexité détectée → Opus 4.8 pour cette requête`);
    return 'claude-opus-4-8';
  }
  // Défaut: Sonnet (envoi docs, emails, deals, conversation — 5x moins cher)
  return MODEL_DEFAULT;
}

// ─── Appel Claude (boucle agentique, prompt caching, routing auto modèle) ────
async function callClaude(chatId, userMsg, retries = 3) {
  if (!checkRateLimit()) {
    const err = new Error('Rate limit local atteint — 15 req/min'); err.status = 429;
    throw err;
  }
  circuitCheck('claude');
  mTick('messages', 'text');

  const msgIndex = getHistory(chatId).length;
  addMsg(chatId, 'user', userMsg);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const localModel    = pickModelForMessage(userMsg);
      const localThinking = thinkingMode;
      // Validation: garantit premier=user, alternance, dernier=user
      let messages = validateMessagesForAPI(
        getHistory(chatId).map(m => ({ role: m.role, content: m.content }))
      );
      if (!messages.length) {
        log('WARN', 'CLAUDE', 'Messages vides après validation — reset historique');
        chats.delete(chatId);
        addMsg(chatId, 'user', userMsg);
        messages = [{ role: 'user', content: userMsg }];
      }
      let finalReply = null;
      let allMemos   = [];
      // BUDGET GUARD (audit P0 #3): cap par conversation
      // Empêche les boucles tool_use coûteuses (Opus = $15/M output → 12 rounds × 16k = ~$3)
      const CONV_BUDGET_USD = parseFloat(process.env.CONV_BUDGET_USD || '2.50');
      let convCostUSD = 0;
      let consecutiveToolErrors = 0; // si même tool fail 3× → abort
      let lastFailedTool = null;
      for (let round = 0; round < 12; round++) {
        // Hard stop sur budget conversation dépassé
        if (convCostUSD >= CONV_BUDGET_USD) {
          log('WARN', 'CLAUDE', `Budget conversation atteint ($${convCostUSD.toFixed(2)} >= $${CONV_BUDGET_USD}) — abort round ${round}`);
          finalReply = `⚠️ J'arrête ici — j'ai dépassé le budget conversation ($${convCostUSD.toFixed(2)}). Reformule ta demande de façon plus directe pour économiser.`;
          break;
        }
        const systemBlocks = [{ type: 'text', text: SYSTEM_BASE, cache_control: { type: 'ephemeral' } }];
        const dyn = getSystemDynamic();
        if (dyn) systemBlocks.push({ type: 'text', text: dyn });
        const params = {
          model: localModel, max_tokens: 16384,
          system: systemBlocks,
          tools: TOOLS_WITH_CACHE, messages,
        };
        if (localThinking) params.thinking = { type: 'enabled', budget_tokens: 10000 };
        mTick('api', 'claude');
        const res = await claude.messages.create(params);
        circuitSuccess('claude');
        const usdCost = trackCost(localModel, res.usage);
        if (typeof usdCost === 'number') convCostUSD += usdCost;
        if (res.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: res.content });
          const toolBlocks = res.content.filter(b => b.type === 'tool_use');
          const results = await Promise.all(toolBlocks.map(async b => {
            log('INFO', 'TOOL', `${b.name}(${JSON.stringify(b.input).substring(0, 80)})`);
            mTick('tools', b.name);
            const result = await executeToolSafe(b.name, b.input, chatId);
            return { type: 'tool_result', tool_use_id: b.id, content: String(result), _toolName: b.name };
          }));
          // Détecter pattern: même outil fail 3× consécutifs → abort
          const errorTools = results.filter(r => /^(❌|⚠️|Erreur|Error|HTTP \d{3})/i.test(r.content));
          if (errorTools.length > 0 && errorTools.length === results.length) {
            const tn = errorTools[0]._toolName;
            if (tn === lastFailedTool) consecutiveToolErrors++;
            else { consecutiveToolErrors = 1; lastFailedTool = tn; }
            if (consecutiveToolErrors >= 3) {
              log('WARN', 'CLAUDE', `Tool ${tn} a échoué 3× consécutifs — abort conversation`);
              finalReply = `⚠️ L'outil ${tn} a échoué 3 fois de suite (${errorTools[0].content.substring(0, 100)}). J'arrête pour éviter une boucle. Vérifie le service/clé puis réessaie.`;
              messages.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content })) });
              break;
            }
          } else {
            consecutiveToolErrors = 0; lastFailedTool = null;
          }
          messages.push({ role: 'user', content: results.map(r => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content })) });
          continue;
        }
        const text = res.content.find(b => b.type === 'text')?.text;
        if (!text) { log('WARN', 'CLAUDE', `round ${round}: réponse sans bloc texte (stop=${res.stop_reason})`); }
        const { cleaned, memos } = extractMemos(text || '_(vide)_');
        finalReply = cleaned;
        allMemos   = memos;
        break;
      }
      if (convCostUSD > 0) log('INFO', 'CLAUDE', `Conversation coût: $${convCostUSD.toFixed(3)}`);
      if (!finalReply) finalReply = '_(délai dépassé — réessaie)_';
      addMsg(chatId, 'assistant', finalReply);
      return { reply: finalReply, memos: allMemos };
    } catch (err) {
      log('ERR', 'CLAUDE', `attempt ${attempt}: HTTP ${err.status || '?'} — ${err.message?.substring(0, 120)}`);
      metrics.errors.total++;
      metrics.errors.byStatus[err.status || 'unknown'] = (metrics.errors.byStatus[err.status || 'unknown'] || 0) + 1;
      // Capturer dernier message d'erreur pour diagnostic (/health)
      metrics.lastApiError = {
        at: new Date().toISOString(),
        status: err.status || null,
        message: (err.message || String(err)).substring(0, 300),
      };
      // Circuit breaker: seulement sur erreurs transient (500+/429), pas sur 400 (user error)
      if (err.status === 429 || err.status === 529 || err.status >= 500) circuitFail('claude');

      // 400 = erreur structurelle (NON retryable) → nettoyer et abandonner
      if (err.status === 400) {
        const msg = err.message || '';
        // Cas spécifique: thinking incompatible → désactiver et retry 1 fois
        if (thinkingMode && msg.toLowerCase().includes('thinking') && attempt < retries) {
          log('WARN', 'CLAUDE', 'Thinking incompatible — retry sans thinking');
          thinkingMode = false;
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        // Cas "prefilling" / "prepend" / conversation corrompue → reset
        if (msg.toLowerCase().match(/prefill|prepend|assistant.*pre|first.*user|role/)) {
          log('WARN', 'CLAUDE', 'Historique corrompu — reset automatique');
          chats.delete(chatId);
          scheduleHistSave();
        }
        // Rollback et abandonner (pas de retry 400)
        const h = getHistory(chatId);
        if (h.length > msgIndex && h[msgIndex]?.role === 'user') h.splice(msgIndex, 1);
        scheduleHistSave();
        throw err;
      }

      const retryable = err.status === 429 || err.status === 529 || err.status >= 500;
      if (retryable && attempt < retries) {
        // Backoff exponentiel pour 429 (plus long)
        const delay = err.status === 429 ? attempt * 8000 : attempt * 3000;
        log('INFO', 'CLAUDE', `Retry ${attempt}/${retries} dans ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        const h = getHistory(chatId);
        if (h.length > msgIndex && h[msgIndex]?.role === 'user') h.splice(msgIndex, 1);
        scheduleHistSave();
        throw err;
      }
    }
  }
}

// ─── Appel Claude direct (vision/multimodal — sans historique alourdi) ────────
async function callClaudeVision(chatId, content, contextLabel) {
  // Rate limiter
  if (!checkRateLimit()) {
    const err = new Error('Rate limit local atteint'); err.status = 429;
    throw err;
  }

  const h = getHistory(chatId);
  h.push({ role: 'user', content });
  if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);

  try {
    // Validation des messages avant l'envoi
    let messages = validateMessagesForAPI(h.map(m => ({ role: m.role, content: m.content })));
    if (!messages.length) {
      // Fallback: envoyer juste l'image/doc sans historique
      messages = [{ role: 'user', content }];
    }
    const localModel    = currentModel;
    const localThinking = thinkingMode;
    const systemBlocks  = [{ type: 'text', text: SYSTEM_BASE, cache_control: { type: 'ephemeral' } }];
    const dyn = getSystemDynamic();
    if (dyn) systemBlocks.push({ type: 'text', text: dyn });
    const params = {
      model: localModel, max_tokens: 16384,
      system: systemBlocks,
      tools: TOOLS_WITH_CACHE, messages,
    };
    if (localThinking) params.thinking = { type: 'enabled', budget_tokens: 10000 };

    let finalReply = null;
    let allMemos   = [];
    for (let round = 0; round < 6; round++) {
      const res = await claude.messages.create(params);
      if (res.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: res.content });
        const toolBlocks = res.content.filter(b => b.type === 'tool_use');
        const results = await Promise.all(toolBlocks.map(async b => {
          log('INFO', 'TOOL', `vision:${b.name}(${JSON.stringify(b.input).substring(0, 60)})`);
          const result = await executeToolSafe(b.name, b.input, chatId);
          return { type: 'tool_result', tool_use_id: b.id, content: String(result) };
        }));
        messages.push({ role: 'user', content: results });
        continue;
      }
      const text = res.content.find(b => b.type === 'text')?.text || '_(vide)_';
      const { cleaned, memos } = extractMemos(text);
      finalReply = cleaned;
      allMemos   = memos;
      break;
    }
    finalReply = finalReply || '_(délai dépassé)_';

    // Remplacer le contenu multimodal dans l'historique par un placeholder compact
    h[h.length - 1] = { role: 'user', content: contextLabel };
    h.push({ role: 'assistant', content: finalReply });
    if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);
    scheduleHistSave();

    return { reply: finalReply, memos: allMemos };
  } catch (err) {
    // Rollback — retirer l'entrée image/PDF ajoutée
    if (h[h.length - 1]?.role === 'user') h.pop();
    // Si 400 lié à historique → reset complet
    if (err.status === 400 && (err.message || '').toLowerCase().match(/prefill|prepend|assistant.*pre|first.*user|role/)) {
      log('WARN', 'VISION', 'Historique corrompu — reset');
      chats.delete(chatId);
      scheduleHistSave();
    }
    scheduleHistSave();
    throw err;
  }
}

// ─── Envoyer (découpe + fallback Markdown propre) ────────────────────────────
function stripMarkdown(s) {
  // Nettoie les entités Telegram invalides plutôt que tout perdre
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // gras double → texte
    .replace(/\*([^*\n]+)\*/g, '$1')      // gras simple → texte
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')        // italique → texte
    .replace(/`([^`]+)`/g, '$1')          // code → texte
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // liens → texte
}
async function sendChunk(chatId, chunk) {
  try {
    return await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch {
    return bot.sendMessage(chatId, stripMarkdown(chunk), { disable_web_page_preview: true });
  }
}
async function send(chatId, text) {
  const MAX = 4000;
  const str = String(text || '');
  if (str.length <= MAX) return sendChunk(chatId, str);
  const chunks = [];
  let buf = '';
  for (const ligne of str.split('\n')) {
    if ((buf + '\n' + ligne).length > MAX) { if (buf) chunks.push(buf.trim()); buf = ligne; }
    else { buf = buf ? buf + '\n' + ligne : ligne; }
  }
  if (buf.trim()) chunks.push(buf.trim());
  for (const chunk of chunks) await sendChunk(chatId, chunk);
}

// ─── Guard ────────────────────────────────────────────────────────────────────
function isAllowed(msg) {
  if (!msg.from) return false;
  return !ALLOWED_ID || msg.from.id === ALLOWED_ID;
}

// ─── Confirmation envoi email ─────────────────────────────────────────────────
const CONFIRM_REGEX = /^(envoie[!.]?|envoie[- ]le[!.]?|parfait[!.]?|go[!.]?|oui[!.]?|ok[!.]?|d'accord[!.]?|send[!.]?|c'est bon[!.]?|ça marche[!.]?)$/i;

async function handleEmailConfirmation(chatId, text) {
  if (!CONFIRM_REGEX.test(text.trim())) return false;
  const pending = pendingEmails.get(chatId);
  if (!pending) return false;

  let sent = false;
  let method = '';

  // 1. Essayer Gmail (priorité)
  try {
    const token = await getGmailToken(); // retourne string ou null — jamais throw ici
    if (token) {
      await envoyerEmailGmail(pending);
      sent = true;
      method = 'Gmail';
    }
  } catch (e) {
    log('WARN', 'EMAIL', `Gmail fail: ${e.message} — tentative Brevo`);
  }

  // 2. Fallback Brevo si Gmail a échoué ou non configuré
  if (!sent) {
    try {
      if (!BREVO_KEY) throw new Error('BREVO_API_KEY manquant dans Render');
      const ok = await envoyerEmailBrevo({ to: pending.to, toName: pending.toName, subject: pending.sujet, textContent: pending.texte });
      if (!ok) throw new Error('Brevo HTTP error');
      sent = true;
      method = 'Brevo';
    } catch (e) {
      log('ERR', 'EMAIL', `Brevo fail: ${e.message}`);
    }
  }

  if (!sent) {
    await send(chatId, `❌ Email non envoyé — Gmail et Brevo en échec.\n_Brouillon conservé — dis "envoie" pour réessayer ou vérifie /status._`);
    return true;
  }

  pendingEmails.delete(chatId); // supprimer SEULEMENT après succès confirmé
  logActivity(`Email envoyé (${method}) → ${pending.to} — "${pending.sujet.substring(0,60)}"`);
  mTick('emailsSent', 0); metrics.emailsSent++;
  await send(chatId, `✅ *Email envoyé* (${method})\nÀ: ${pending.toName || pending.to}\nObjet: ${pending.sujet}`);
  return true;
}

// ─── Handlers Telegram ────────────────────────────────────────────────────────
function registerHandlers() {

  // ─── INLINE BUTTONS handler — clicks sous les notifs lead ─────────────────
  // Format callback_data:
  //   send:<email>    → exécute envoi docs (consent attesté par le click)
  //   cancel:<email>  → supprime pending
  //   audit:<query>   → affiche /lead-audit pour ce lead
  bot.on('callback_query', async (cbq) => {
    if (!cbq.from || String(cbq.from.id) !== String(ALLOWED_ID)) {
      return bot.answerCallbackQuery(cbq.id, { text: '🚫 Non autorisé' }).catch(() => {});
    }
    const data = cbq.data || '';
    const [action, ...rest] = data.split(':');
    const arg = rest.join(':');
    const chatId = cbq.message?.chat?.id;
    const msgId = cbq.message?.message_id;

    try {
      if (action === 'send' && arg) {
        const pending = pendingDocSends.get(arg);
        if (!pending) {
          await bot.answerCallbackQuery(cbq.id, { text: '⚠️ Pending introuvable (déjà traité?)' });
          return;
        }
        await bot.answerCallbackQuery(cbq.id, { text: '📤 Envoi en cours...' });
        pending._shawnConsent = true; // CLICK = consent attesté + tracé
        savePendingDocs();
        // Édite le message original pour montrer le statut
        if (chatId && msgId) {
          await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '⏳ Envoi en cours...', callback_data: 'noop' }]] },
            { chat_id: chatId, message_id: msgId }).catch(() => {});
        }
        const r = await envoyerDocsAuto({ ...pending, _shawnConsent: true });
        if (r.sent) {
          pendingDocSends.delete(arg);
          await bot.sendMessage(chatId, `✅ *Envoyé* à ${arg}\n${pending.match?.pdfs?.length || '?'} docs · ${Math.round((r.deliveryMs||0)/1000)}s`, { parse_mode: 'Markdown' });
          auditLogEvent('inline-send', 'docs-sent', { email: arg, via: 'inline-button' });
        } else {
          await bot.sendMessage(chatId, `⚠️ Échec: ${r.error || r.reason || 'unknown'}`);
        }
      } else if (action === 'cancel' && arg) {
        if (pendingDocSends.has(arg)) {
          pendingDocSends.delete(arg);
          await bot.answerCallbackQuery(cbq.id, { text: '🗑 Annulé' });
          if (chatId && msgId) {
            await bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '🗑 Annulé', callback_data: 'noop' }]] },
              { chat_id: chatId, message_id: msgId }).catch(() => {});
          }
          auditLogEvent('inline-cancel', 'pending_cancelled', { email: arg, via: 'inline-button' });
        } else {
          await bot.answerCallbackQuery(cbq.id, { text: '⚠️ Déjà annulé/envoyé' });
        }
      } else if (action === 'audit' && arg) {
        await bot.answerCallbackQuery(cbq.id, { text: '🔍 Audit...' });
        const events = (auditLog || []).filter(e =>
          e.category === 'lead' && (
            e.details?.msgId === arg ||
            e.details?.extracted?.email?.toLowerCase() === arg.toLowerCase() ||
            e.details?.extracted?.centris === arg
          )
        ).slice(-3).reverse();
        if (!events.length) {
          await bot.sendMessage(chatId, `❌ Aucun audit trouvé pour ${arg}`);
        } else {
          const ev = events[0];
          const d = ev.details || {};
          const ext = d.extracted || {};
          const m = d.match || {};
          const summary = [
            `🔍 *Audit lead* — ${new Date(ev.at).toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}`,
            `Décision: \`${d.decision}\``,
            `Source: ${d.source} | Sujet: ${d.subject?.substring(0, 60)}`,
            ``,
            `*Extracté:* ${ext.nom || '?'} · ${ext.email || '?'} · ${ext.telephone || '?'} · #${ext.centris || '?'}`,
            `*Match:* ${m.found ? '✅' : '❌'} score ${m.score}/100 · ${m.strategy} · ${m.pdfCount || 0} docs`,
            d.dealId ? `*Deal:* ✅ #${d.dealId}` : '*Deal:* ❌',
          ].join('\n');
          await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
        }
      } else if (action === 'cmp_send' || action === 'cmp_cancel' || action === 'cmp_preview') {
        if (!BREVO_KEY) {
          await bot.answerCallbackQuery(cbq.id, { text: '❌ BREVO_API_KEY manquant' });
          return;
        }
        const campaignId = arg;
        if (action === 'cmp_preview') {
          await bot.answerCallbackQuery(cbq.id, { text: '👁 Récupération preview...' });
          try {
            const r = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}`, {
              headers: { 'api-key': BREVO_KEY }, signal: AbortSignal.timeout(15000),
            });
            const c = await r.json();
            const recipients = c.recipients || {};
            const stats = c.statistics?.globalStats || {};
            const txt = [
              `*Campagne #${campaignId}*`,
              `Sujet: ${c.subject?.substring(0, 100) || '?'}`,
              `Listes: ${(recipients.listIds || []).join(', ') || '?'}`,
              `Exclusions: ${(recipients.exclusionListIds || []).length} listes`,
              `Type: ${c.type || '?'}`,
              `Status: ${c.status}`,
              `Scheduled: ${c.scheduledAt ? new Date(c.scheduledAt).toLocaleString('fr-CA', { timeZone: 'America/Toronto' }) : '?'}`,
              `Sender: ${c.sender?.email || '?'}`,
              ``,
              `*Aperçu HTML (premier 500 chars):*`,
              `\`${(c.htmlContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').substring(0, 500)}\``,
            ].join('\n');
            await bot.sendMessage(chatId, txt, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, txt.replace(/[*_`]/g, '')).catch(() => {}));
          } catch (e) {
            await bot.sendMessage(chatId, `❌ Preview: ${e.message?.substring(0, 200)}`);
          }
        } else {
          // BUG FIX 2026-04-25: PUT /status?status=queued envoie IMMÉDIATEMENT
          // (ignore scheduledAt). Pour confirmer une campagne suspendue ET
          // respecter sa date prévue, on update via PUT /emailCampaigns/{id}
          // avec le scheduledAt récupéré — Brevo bascule en "queued for schedule".
          if (action === 'cmp_send') {
            await bot.answerCallbackQuery(cbq.id, { text: '⏳ Confirmation...' });
            try {
              // 1. Fetch scheduledAt actuel
              const det = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}`, {
                headers: { 'api-key': BREVO_KEY }, signal: AbortSignal.timeout(15000),
              }).then(r => r.json());
              const sched = det.scheduledAt;
              const schedMs = sched ? new Date(sched).getTime() : 0;
              const isFuture = schedMs > Date.now() + 60000; // >1 min dans le futur

              // 2a. Si scheduledAt dans le futur → PUT scheduledAt (Brevo respecte la date)
              // 2b. Si pas de scheduledAt ou passé → POST sendNow (envoi immédiat)
              let r, label;
              if (isFuture) {
                r = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}`, {
                  method: 'PUT',
                  headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ scheduledAt: sched }),
                  signal: AbortSignal.timeout(15000),
                });
                label = `✅ Confirmé — envoi ${new Date(sched).toLocaleString('fr-CA', { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'short' })}`;
              } else {
                r = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/sendNow`, {
                  method: 'POST',
                  headers: { 'api-key': BREVO_KEY }, signal: AbortSignal.timeout(15000),
                });
                label = `✅ Envoyée maintenant`;
              }
              if (r.ok || r.status === 204) {
                // 🚀 Cc Shawn auto (règle 2026-05-13): sendTest parallèle pour copie identique
                const shawnCc = process.env.SHAWN_EMAIL || 'shawn@signaturesb.com';
                fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/sendTest`, {
                  method: 'POST',
                  headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ emailTo: [shawnCc] }),
                }).catch(e => log('WARN', 'BREVO', `sendTest Cc fail #${campaignId}: ${e.message}`));
                if (chatId && msgId) {
                  const newMarkup = { inline_keyboard: [[{ text: label, callback_data: 'noop' }]] };
                  await bot.editMessageReplyMarkup(newMarkup, { chat_id: chatId, message_id: msgId }).catch(() => {});
                }
                await bot.sendMessage(chatId, label);
                // Approval registry — empêche safetyCheckCampagnes de re-suspend
                approveCampaign(campaignId);
                auditLogEvent('campaign', 'confirmed', { campaignId, scheduledAt: sched, mode: isFuture ? 'scheduled' : 'sendNow' });
              } else {
                const err = await r.text().catch(() => '');
                await bot.sendMessage(chatId, `❌ Brevo ${r.status}: ${err.substring(0, 200)}`);
              }
            } catch (e) {
              await bot.sendMessage(chatId, `❌ ${e.message?.substring(0, 200)}`);
            }
          } else { // cmp_cancel
            await bot.answerCallbackQuery(cbq.id, { text: '🚫 Annulation...' });
            try {
              const r = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/status`, {
                method: 'PUT',
                headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'suspended' }),
                signal: AbortSignal.timeout(15000),
              });
              if (r.ok || r.status === 204) {
                if (chatId && msgId) {
                  const newMarkup = { inline_keyboard: [[{ text: '🚫 Annulé', callback_data: 'noop' }]] };
                  await bot.editMessageReplyMarkup(newMarkup, { chat_id: chatId, message_id: msgId }).catch(() => {});
                }
                auditLogEvent('campaign', 'cancelled', { campaignId });
              } else {
                const err = await r.text().catch(() => '');
                await bot.sendMessage(chatId, `❌ Brevo ${r.status}: ${err.substring(0, 200)}`);
              }
            } catch (e) {
              await bot.sendMessage(chatId, `❌ ${e.message?.substring(0, 200)}`);
            }
          }
        }
      } else if (action === 'noop') {
        await bot.answerCallbackQuery(cbq.id);
      } else {
        await bot.answerCallbackQuery(cbq.id, { text: '❓ Action inconnue' });
      }
    } catch (e) {
      log('WARN', 'CALLBACK', `${data}: ${e.message.substring(0, 150)}`);
      bot.answerCallbackQuery(cbq.id, { text: `❌ Erreur: ${e.message.substring(0, 60)}` }).catch(() => {});
    }
  });

  bot.onText(/\/start/, msg => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(msg.chat.id,
      `👋 Salut Shawn\\!\n\n*Surveillance automatique:*\n📧 Leads Gmail \\(Centris/RE\\-MAX\\) → deal \\+ J\\+0 auto\n📸 Photo/terrain → analyse Opus 4\\.7\n📄 PDF contrat/offre → extraction clés\n🎤 Vocal → action\n\n*Commandes:*\n/pipeline · /stats · /stagnants · /emails\n/checkemail — Scanner leads manqués\n/poller — Statut du poller Gmail\n/lead \\[info\\] — Créer prospect\n/status · /reset · /penser`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  bot.onText(/\/reset/, msg => {
    if (!isAllowed(msg)) return;
    chats.delete(msg.chat.id);
    pendingEmails.delete(msg.chat.id);
    scheduleHistSave();
    bot.sendMessage(msg.chat.id, '🔄 Nouvelle conversation. Je t\'écoute!');
  });

  bot.onText(/\/status/, msg => {
    if (!isAllowed(msg)) return;
    const h = getHistory(msg.chat.id);
    const uptime = Math.floor(process.uptime() / 60);
    const gmailOk      = !!(process.env.GMAIL_CLIENT_ID);
    const whisperOk    = !!(process.env.OPENAI_API_KEY);
    const centrisOk    = !!(process.env.CENTRIS_USER && centrisSession.authenticated);
    const dbxOk        = !!(dropboxToken && process.env.DROPBOX_REFRESH_TOKEN);
    const pollerLast   = gmailPollerState.lastRun ? new Date(gmailPollerState.lastRun).toLocaleTimeString('fr-CA', { hour:'2-digit', minute:'2-digit', timeZone:'America/Toronto' }) : 'jamais';
    bot.sendMessage(msg.chat.id,
      `✅ *Kira — ${TOOLS.length} outils*\n🎯 Routing auto · base: \`${currentModel.replace('claude-','')}\` · Opus sur analyse/stratégie\n${thinkingMode?'🧠 thinking ON':'⚡'} | Uptime: ${uptime}min | Mémos: ${kiramem.facts.length}\n\nPipedrive: ${PD_KEY?'✅':'❌'} | Brevo: ${BREVO_KEY?'✅':'❌'}\nGmail: ${gmailOk?'✅':'⚠️'} | Dropbox: ${dbxOk?'✅':'❌'}\nCentris: ${centrisOk?`✅ (${process.env.CENTRIS_USER})`:'⏳'}\nWhisper: ${whisperOk?'✅':'⚠️ OPENAI manquant'}\nPoller: ${gmailOk?`✅ ${pollerLast} (${gmailPollerState.totalLeads||0} leads)`:'❌'}\n\n/opus ou /haiku pour forcer · /penser pour thinking profond`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── Commandes poller ────────────────────────────────────────────────────────
  // ─── Metrics — observabilité depuis Telegram ──────────────────────────────────
  bot.onText(/\/metrics/, async msg => {
    if (!isAllowed(msg)) return;
    const uptimeS = Math.floor((Date.now() - metrics.startedAt) / 1000);
    const uptime  = `${Math.floor(uptimeS/3600)}h ${Math.floor((uptimeS%3600)/60)}m`;
    const topTools = Object.entries(metrics.tools).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k}: ${v}`).join(', ') || 'aucun';
    const errorsByCode = Object.entries(metrics.errors.byStatus).map(([k,v])=>`${k}:${v}`).join(', ') || '0';
    const openCircuits = Object.entries(circuits).filter(([,v])=>Date.now()<v.openUntil).map(([k])=>k).join(', ') || 'aucun';
    const txt = `📊 *Métriques — ${uptime}*\n\n*Messages reçus:*\ntext: ${metrics.messages.text} · voice: ${metrics.messages.voice} · photo: ${metrics.messages.photo} · pdf: ${metrics.messages.pdf}\n\n*API calls:*\nClaude: ${metrics.api.claude} · Pipedrive: ${metrics.api.pipedrive}\nGmail: ${metrics.api.gmail} · Dropbox: ${metrics.api.dropbox}\nCentris: ${metrics.api.centris} · Brevo: ${metrics.api.brevo}\n\n*Top outils:*\n${topTools}\n\n*Erreurs:* ${metrics.errors.total} (${errorsByCode})\n*Leads:* ${metrics.leads} · *Emails envoyés:* ${metrics.emailsSent}\n*Circuit breakers ouverts:* ${openCircuits}\n\nEndpoint JSON complet: ${AGENT.site.startsWith('http')?AGENT.site:'https://signaturesb-bot-s272.onrender.com'}/health`;
    bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown' });
  });

  // ─── Test Centris agent ────────────────────────────────────────────────────────
  bot.onText(/\/centris/, async msg => {
    if (!isAllowed(msg)) return;
    if (!process.env.CENTRIS_USER) {
      return bot.sendMessage(msg.chat.id, '❌ CENTRIS_USER non configuré dans Render.');
    }
    await bot.sendMessage(msg.chat.id, `🔐 Test connexion Centris (agent ${process.env.CENTRIS_USER})...`);
    const ok = await centrisLogin();
    if (ok) {
      await bot.sendMessage(msg.chat.id, `✅ *Centris connecté!*\nAgent: ${process.env.CENTRIS_USER}\nSession active 2h\n\nEssaie: "comparables terrains Rawdon 14 jours"`, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(msg.chat.id, `❌ *Centris: connexion échouée*\nVérifier:\n• CENTRIS_USER=${process.env.CENTRIS_USER}\n• CENTRIS_PASS configuré\n• Compte actif sur centris.ca`, { parse_mode: 'Markdown' });
    }
  });

  bot.onText(/\/checkemail/, async msg => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, '🔍 Scan 48h — leads éventuellement manqués...');
    // Forcer scan 48h en passant un `forceSince` au lieu de manipuler le state
    await runGmailLeadPoller({ forceSince: '48h' }).catch(e =>
      bot.sendMessage(msg.chat.id, `❌ Poller: ${e.message}`)
    );
    const s = pollerStats.lastScan;
    await bot.sendMessage(msg.chat.id,
      `✅ Scan terminé\n\n` +
      `📬 ${s.found} emails trouvés\n` +
      `🗑 ${s.junk} junk filtered\n` +
      `🔍 ${s.noSource} sans source\n` +
      `⚠️ ${s.lowInfo} info insuffisante (P0 alert envoyée si >0)\n` +
      `✅ ${s.processed} traités | 🚀 ${s.autoSent || 0} auto-sent | ⏳ ${s.pending || 0} pending | 📋 ${s.dealCreated} deals\n` +
      `♻️ ${s.dedup || 0} dedup skip · ❌ ${s.errors} erreurs\n\n` +
      `Total depuis boot: ${gmailPollerState.totalLeads} leads`
    );
  });

  // Confirmer envoi docs depuis pending (zone 80-89 confirmation requise)
  bot.onText(/^envoie\s+(?:les\s+)?docs?\s+(?:à|a)\s+(\S+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const target = match[1].toLowerCase().trim();
    // Trouver dans pendingDocSends par email exact ou nom
    let pending = null;
    for (const [email, p] of pendingDocSends) {
      if (email.toLowerCase() === target || p.nom?.toLowerCase().includes(target.toLowerCase())) {
        pending = p;
        pendingDocSends.delete(email);
        break;
      }
    }
    if (!pending) {
      return bot.sendMessage(msg.chat.id, `❌ Aucun pending match pour "${target}". Utilise /pending pour voir la liste.`);
    }
    await bot.sendMessage(msg.chat.id, `📤 Envoi docs à ${pending.email}...`);
    pending._shawnConsent = true; // attestation pour auto-recovery futur
    try {
      const r = await envoyerDocsAuto({ ...pending, _shawnConsent: true });
      if (r.sent) {
        await bot.sendMessage(msg.chat.id, `✅ Envoyé · ${pending.match.pdfs.length} PDFs · ${Math.round(r.deliveryMs/1000)}s`);
        auditLogEvent('manual-send', 'docs-sent', { email: pending.email, confirmed: true });
      } else {
        await bot.sendMessage(msg.chat.id, `⚠️ Échec: ${r.error || r.reason}`);
      }
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  // Annuler un pending docs
  bot.onText(/^(?:annule|cancel)\s+(\S+)/i, (msg, match) => {
    if (!isAllowed(msg)) return;
    const target = match[1].toLowerCase().trim();
    let cancelled = null;
    for (const [email, p] of pendingDocSends) {
      if (email.toLowerCase() === target || p.nom?.toLowerCase().includes(target.toLowerCase())) {
        cancelled = email;
        pendingDocSends.delete(email);
        break;
      }
    }
    bot.sendMessage(msg.chat.id, cancelled ? `🗑 Annulé: ${cancelled}` : `❌ Aucun pending pour "${target}"`);
  });

  // Voir liste pending docs
  bot.onText(/\/pending/, msg => {
    if (!isAllowed(msg)) return;
    const pendingNames = pendingLeads.filter(l => l.needsName);
    if (pendingDocSends.size === 0 && pendingNames.length === 0) {
      return bot.sendMessage(msg.chat.id, '✅ Aucun lead ni doc en attente');
    }
    const parts = [];
    if (pendingNames.length) {
      const lines = pendingNames.slice(-10).map(l => {
        const e = l.extracted || {};
        const age = Math.round((Date.now() - l.ts) / 60000);
        return `• ${l.id.slice(-6)} · ${e.email || e.telephone || '?'} · ${e.centris ? '#'+e.centris : (e.adresse || '?')} · il y a ${age}min`;
      }).join('\n');
      parts.push(`⚠️ *Noms à confirmer (${pendingNames.length})*\n${lines}\n_Réponds \`nom Prénom Nom\` pour le plus récent._`);
    }
    if (pendingDocSends.size) {
      const lines = [...pendingDocSends.values()].map(p =>
        `• ${p.nom || p.email} · score ${p.match?.score} · ${p.match?.pdfs.length} PDFs → \`envoie les docs à ${p.email}\``
      ).join('\n');
      parts.push(`📦 *Docs en attente (${pendingDocSends.size})*\n${lines}`);
    }
    bot.sendMessage(msg.chat.id, parts.join('\n\n'), { parse_mode: 'Markdown' });
  });

  // "nom Prénom Nom" → complète le plus récent pending lead + relance traiterNouveauLead
  // Ex: "nom Jean Tremblay" après alerte P1 "⚠️ Lead reçu — nom non identifié"
  bot.onText(/^nom\s+(.+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const nomProspect = (match[1] || '').trim();
    if (!isValidProspectName(nomProspect)) {
      return bot.sendMessage(msg.chat.id, `❌ "${nomProspect}" n'est pas un nom valide. Essaie: \`nom Prénom Nom\``, { parse_mode: 'Markdown' });
    }
    const pendingNames = pendingLeads.filter(l => l.needsName);
    if (!pendingNames.length) {
      return bot.sendMessage(msg.chat.id, '✅ Aucun lead en attente de nom.');
    }
    // Prendre le plus récent
    const pending = pendingNames[pendingNames.length - 1];
    pending.nom = nomProspect;
    pending.needsName = false;
    pending.resolvedAt = Date.now();
    // Retirer du tableau pending (garder historique resolved si besoin)
    pendingLeads = pendingLeads.filter(l => l.id !== pending.id);
    savePendingLeads();

    await bot.sendMessage(msg.chat.id, `⏳ Reprise du lead avec *${nomProspect}*...`, { parse_mode: 'Markdown' });
    try {
      const leadComplet = { ...pending.extracted, nom: nomProspect };
      await traiterNouveauLead(leadComplet, pending.msgId, pending.from, pending.subject, pending.source, { skipDedup: true });
    } catch (e) {
      log('ERR', 'PENDING', `Replay lead ${pending.id}: ${e.message}`);
      bot.sendMessage(msg.chat.id, `❌ Erreur replay lead: ${e.message.substring(0, 200)}`).catch(() => {});
    }
  });

  // Pause/resume auto-envoi global
  bot.onText(/\/pauseauto/, msg => {
    if (!isAllowed(msg)) return;
    autoSendPaused = !autoSendPaused;
    bot.sendMessage(msg.chat.id, autoSendPaused
      ? '⏸ Auto-envoi docs PAUSÉ — tout passera en brouillon jusqu\'à /pauseauto'
      : '▶️ Auto-envoi docs REPRIS — envois ≥90 automatiques.');
  });

  bot.onText(/\/score|\/sante/, async msg => {
    if (!isAllowed(msg)) return;
    const h = computeHealthScore();
    const emoji = h.score >= 90 ? '🟢' : h.score >= 70 ? '🟡' : h.score >= 50 ? '🟠' : '🔴';
    const anomalies = await detectAnomalies();
    const anomaliesStr = anomalies.length
      ? '\n\n*Anomalies détectées:*\n' + anomalies.map(a => `• ${a.severity === 'high' ? '🚨' : '⚠️'} ${a.msg}`).join('\n')
      : '\n\n✅ Aucune anomalie';
    bot.sendMessage(msg.chat.id,
      `${emoji} *Health Score: ${h.score}/100*\nStatus: \`${h.status}\`\n\n` +
      (h.issues.length ? `*Issues:*\n${h.issues.map(i => `• ${i}`).join('\n')}` : '✅ Tous systèmes OK') +
      anomaliesStr,
      { parse_mode: 'Markdown' }
    );
  });

  // /today — agenda du jour en 1 vue (visites, pending, stats 24h, anomalies)
  bot.onText(/\/today|\/jour|\/agenda/i, async msg => {
    if (!isAllowed(msg)) return;
    const now = new Date();
    const todayStr = now.toDateString();
    const ago24h = Date.now() - 24 * 3600 * 1000;

    // 1. Visites aujourd'hui
    const visites = loadJSON(VISITES_FILE, []);
    const visitesToday = visites.filter(v => new Date(v.date).toDateString() === todayStr)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    // 2. Pending
    const pendingNames = pendingLeads.filter(l => l.needsName);
    const pendingDocs = typeof pendingDocSends !== 'undefined' ? [...pendingDocSends.values()] : [];

    // 3. Stats poller 24h (grosso modo — basé sur totalsDepuisBoot)
    const pollerLastRun = gmailPollerState.lastRun ? new Date(gmailPollerState.lastRun) : null;
    const pollerAge = pollerLastRun ? Math.round((Date.now() - pollerLastRun.getTime()) / 60000) : null;

    // 4. Leads audit trail 24h
    const recentLeads = (auditLog || []).filter(e =>
      e.category === 'lead' && new Date(e.at).getTime() > ago24h
    );
    const leadsByDecision = {};
    for (const e of recentLeads) {
      const d = e.details?.decision || 'unknown';
      leadsByDecision[d] = (leadsByDecision[d] || 0) + 1;
    }

    // 5. Anomalies actives
    const anomalies = await detectAnomalies().catch(() => []);

    // Compose message
    const lines = [];
    const dateStr = now.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Toronto' });
    lines.push(`📅 *Aujourd'hui — ${dateStr}*`);
    lines.push('');

    // Visites
    if (visitesToday.length) {
      lines.push(`🏡 *Visites (${visitesToday.length})*`);
      for (const v of visitesToday) {
        const t = new Date(v.date).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
        lines.push(`  ${t} — ${v.nom}${v.adresse ? ' · ' + v.adresse : ''}`);
      }
      lines.push('');
    } else {
      lines.push('🏡 Aucune visite aujourd\'hui');
      lines.push('');
    }

    // Action requise
    const actions = [];
    if (pendingNames.length) actions.push(`⚠️ *${pendingNames.length} lead(s) sans nom* — réponds \`nom Prénom Nom\``);
    if (pendingDocs.length) actions.push(`📦 *${pendingDocs.length} doc(s) en attente* — \`/pending\` pour liste`);
    if (anomalies.length) {
      for (const a of anomalies.slice(0, 3)) {
        actions.push(`${a.severity === 'high' ? '🚨' : '⚠️'} ${a.msg}`);
      }
    }
    if (actions.length) {
      lines.push('*Action requise:*');
      for (const a of actions) lines.push(`  ${a}`);
      lines.push('');
    }

    // Stats 24h
    lines.push('*Leads 24h:*');
    if (Object.keys(leadsByDecision).length === 0) {
      lines.push(`  Aucun lead traité dans les 24h`);
    } else {
      const decisionEmoji = {
        auto_sent: '🚀', pending_preview_sent: '📦', pending_invalid_name: '⚠️',
        dedup_skipped: '♻️', auto_failed: '❌', auto_exception: '❌',
        auto_skipped: '⏭', no_dropbox_match: '🔍', blocked_suspect_name: '🛑',
        multiple_candidates: '🔀', max_retries_exhausted: '💀',
        skipped_no_email_or_deal: '📭',
      };
      for (const [d, n] of Object.entries(leadsByDecision).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${decisionEmoji[d] || '•'} ${d}: ${n}`);
      }
    }
    lines.push('');

    // Stats poller cumulatives (pourquoi 0 auto-sent éventuel)
    const ps = pollerStats;
    if (ps.totalsProcessed > 0 && (ps.totalsAutoSent || 0) === 0) {
      lines.push('⚠️ *Aucun auto-sent depuis boot — pourquoi?*');
      const breakdown = [];
      if (ps.totalsNoMatch) breakdown.push(`🔍 ${ps.totalsNoMatch} no_dropbox_match`);
      if (ps.totalsAutoSkipped) breakdown.push(`⏭ ${ps.totalsAutoSkipped} auto_skipped (score <${process.env.AUTO_SEND_THRESHOLD || 75})`);
      if (ps.totalsAutoFailed) breakdown.push(`❌ ${ps.totalsAutoFailed} auto_failed`);
      if (ps.totalsBlocked) breakdown.push(`🛑 ${ps.totalsBlocked} blocked_suspect_name`);
      if (ps.totalsSkippedNoEmail) breakdown.push(`📭 ${ps.totalsSkippedNoEmail} pas d'email`);
      lines.push(...breakdown.map(b => `  ${b}`));
      lines.push(`  💡 Inspect: \`/lead-audit <email>\` pour voir le détail d'un lead`);
      lines.push('');
    }

    // Poller health
    if (pollerAge !== null) {
      const healthEmoji = pollerAge < 2 ? '🟢' : pollerAge < 10 ? '🟡' : '🔴';
      lines.push(`${healthEmoji} Poller: dernier run il y a ${pollerAge}min`);
    } else {
      lines.push('🔴 Poller: jamais tourné');
    }

    // Cost
    const todayCost = costTracker?.daily?.[today()] || 0;
    if (todayCost > 0) lines.push(`💰 Coût Anthropic aujourd'hui: $${todayCost.toFixed(2)}`);

    await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' }).catch(() =>
      bot.sendMessage(msg.chat.id, lines.join('\n').replace(/[*_`]/g, '')).catch(() => {})
    );
  });

  // /logs [N] [cat] — tail ring buffer depuis Telegram (debug rapide)
  bot.onText(/\/logs(?:\s+(\d+))?(?:\s+(\w+))?/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const tail = Math.min(50, parseInt(match[1] || '20'));
    const catFilter = (match[2] || '').toUpperCase();
    let entries = logRingBuffer.slice(-tail);
    if (catFilter) entries = entries.filter(e => String(e.cat).toUpperCase().includes(catFilter));
    if (!entries.length) return bot.sendMessage(msg.chat.id, `Aucun log${catFilter ? ` pour cat=${catFilter}` : ''}.`);
    const lines = entries.slice(-20).map(e => {
      const ts = new Date(e.ts).toLocaleTimeString('fr-CA', { hour12: false });
      return `${ts} [${e.niveau}|${e.cat}] ${String(e.msg).substring(0, 120)}`;
    }).join('\n');
    // Telegram limite 4096 chars — tronque si trop long
    const txt = `\`\`\`\n${lines.substring(0, 3500)}\n\`\`\``;
    bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown' }).catch(() =>
      bot.sendMessage(msg.chat.id, lines.substring(0, 3500)).catch(() => {})
    );
  });

  // /quota (alias /plan) — état des quotas SaaS du plan courant
  bot.onText(/\/quota|\/plan\b/i, async msg => {
    if (!isAllowed(msg)) return;
    try {
      const { getQuotaSnapshot } = require('./plan_quotas');
      const snap = getQuotaSnapshot(AGENT.plan || 'solo');
      const lines = [
        `💼 *Plan ${snap.plan}* — ${snap.pricePerMonth}$/mois`,
        `Tenant: \`${AGENT.tenantId || 'default'}\``,
        ``,
        `*Quotas:*`,
      ];
      for (const [r, q] of Object.entries(snap.resources)) {
        const emoji = q.status === 'blocked' ? '🔴' : q.status === 'warn' ? '🟡' : '🟢';
        const label = r.replace(/PerDay$/, '/j').replace(/PerMonth$/, '/mois');
        const limStr = q.limit === Infinity ? '∞' : q.limit;
        const pctStr = q.limit !== Infinity ? ` (${q.pct}%)` : '';
        lines.push(`${emoji} ${label}: ${q.current}/${limStr}${pctStr}`);
      }
      lines.push('');
      lines.push(`*Features:*`);
      for (const [f, ok] of Object.entries(snap.features)) {
        lines.push(`  ${ok ? '✅' : '❌'} ${f}`);
      }
      await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ Quota: ${e.message.substring(0, 200)}`);
    }
  });

  // /help (alias /aide /commandes) — liste auto-générée des commandes + tools
  bot.onText(/\/help|\/aide|\/commandes/i, async msg => {
    if (!isAllowed(msg)) return;
    const sections = [
      '*🎯 ACTIONS LEAD*',
      '`/today` `/jour` `/agenda` — agenda du jour',
      '`/pending` — leads + docs en attente',
      '`/lead-audit <query>` — trace lead',
      '`/retry-centris <#>` — récupère lead dedup',
      '`/retry-email <email>` — équivalent par email',
      '`/forcelead <msgId>` — force traitement Gmail msg',
      '`/test-email <#> [email]` — simule lead factice',
      '`/flush-pending` — retry tous pendings (avec consent)',
      '`nom Prénom Nom` — complète pending lead',
      '`envoie les docs à <email>` — confirme envoi',
      '`annule <email>` — annule pending',
      '',
      '*📊 STATUS / DIAGNOSTIC*',
      '`/diagnose` `/diag` — test 13 composants',
      '`/score` `/sante` — health score 0-100',
      '`/cout` `/cost` — coûts Anthropic + cache',
      '`/quota` `/plan` — plan SaaS + quotas',
      '`/checkemail` — scan manuel 48h',
      '`/poller` — stats Gmail poller',
      '`/logs [N] [cat]` — dernières N logs',
      '`/firecrawl` — quota scraping',
      '',
      '*🔧 OPS*',
      '`/pauseauto` — toggle auto-envoi global',
      '`/baseline` — marque tous leads vus comme déjà traités',
      '`/backup` — backup Gist manuel',
      '`/cleanemail` — purge emails GitHub/Render/CI',
      '`/parselead <msgId>` — debug parser',
      '`/status` `/reset` `/start`',
      '',
      `*🛠 TOOLS DISPONIBLES* (${TOOLS.length})`,
      '_Kira utilise ces outils automatiquement quand tu lui parles:_',
      ...TOOLS.map(t => `• \`${t.name}\``).reduce((acc, line) => {
        const last = acc[acc.length - 1] || '';
        if (last.length + line.length > 80) acc.push(line); else acc[acc.length - 1] = last ? last + ' · ' + line : line;
        return acc;
      }, []),
    ].join('\n');
    // Telegram limite 4096 chars — split si trop long
    const chunks = [];
    let current = '';
    for (const line of sections.split('\n')) {
      if ((current + line + '\n').length > 3800) { chunks.push(current); current = ''; }
      current += line + '\n';
    }
    if (current) chunks.push(current);
    for (const chunk of chunks) {
      await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' }).catch(() =>
        bot.sendMessage(msg.chat.id, chunk.replace(/[*_`]/g, '')).catch(() => {})
      );
    }
  });

  // /analyse [question] — CERVEAU STRATÉGIQUE Opus 4.8 (analyse profonde + actions)
  // Sans question → rapport hebdo complet. Avec question → réponse spécifique.
  // Latence ~30-60s (analyse profonde de tout le pipeline + audit + mémoire).
  bot.onText(/^\/analyse(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const question = match[1]?.trim() || null;
    await bot.sendMessage(msg.chat.id, question
      ? `🧠 *Analyse stratégique en cours...* (${question})\n_Opus 4.8 — 30-60s pour examiner pipeline + ventes + mémoire_`
      : `🧠 *Rapport stratégique hebdo en cours...*\n_Opus 4.8 — analyse profonde de toutes tes données_`, { parse_mode: 'Markdown' });
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    try {
      const reply = await analyseStrategique(question);
      clearInterval(typing);
      const chunks = [];
      for (let i = 0; i < reply.length; i += 3800) chunks.push(reply.slice(i, i + 3800));
      for (const c of chunks) {
        await bot.sendMessage(msg.chat.id, c, { parse_mode: 'Markdown' }).catch(() =>
          bot.sendMessage(msg.chat.id, c.replace(/[*_`]/g, '')).catch(() => {})
        );
      }
    } catch (e) {
      clearInterval(typing);
      await bot.sendMessage(msg.chat.id, `❌ Analyse: ${e.message?.substring(0, 300)}`);
    }
  });

  // /insights — DASHBOARD STRATÉGIQUE pour augmenter ventes
  // Connecte Pipedrive + audit log + mémoire pour identifier:
  //   • Leads chauds (haute probabilité conversion)
  //   • Deals à risque (stagnants depuis X jours)
  //   • Opportunités cross-sell (matchs récurrents)
  //   • Actions recommandées immédiates
  bot.onText(/^\/insights|\/strategie|\/intelligence/i, async msg => {
    if (!isAllowed(msg)) return;
    if (!PD_KEY) return bot.sendMessage(msg.chat.id, '❌ PIPEDRIVE_API_KEY requis pour /insights');
    await bot.sendMessage(msg.chat.id, `🧠 *Analyse stratégique en cours...*\n_(Pipedrive + audit log + mémoire)_`, { parse_mode: 'Markdown' });

    const t0 = Date.now();
    // Parallélisation: tout en même temps
    const [actifs, gagnes, leadsAudit] = await Promise.all([
      pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`).catch(() => null),
      pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=won&limit=50`).catch(() => null),
      Promise.resolve((auditLog || []).filter(e => e.category === 'lead').slice(-100)),
    ]);
    const dealsActifs = actifs?.data || [];
    const dealsGagnes = gagnes?.data || [];
    const now = Date.now();

    // 1. LEADS CHAUDS — score basé sur activité récente + étape avancée + qualité extraction
    const leadsChauds = [];
    for (const d of dealsActifs) {
      const ageJ = d.add_time ? Math.floor((now - new Date(d.add_time).getTime()) / 86400000) : 999;
      const lastActJ = d.last_activity_date ? Math.floor((now - new Date(d.last_activity_date).getTime()) / 86400000) : 999;
      let score = 50;
      // Étape avancée = chaud
      if (d.stage_id === 52) score += 25; // visite prévue
      if (d.stage_id === 53) score += 30; // visite faite
      if (d.stage_id === 54) score += 35; // offre
      // Activité récente
      if (lastActJ <= 1) score += 20;
      else if (lastActJ <= 3) score += 10;
      else if (lastActJ > 14) score -= 20;
      // Lead frais
      if (ageJ <= 7) score += 15;
      // Valeur deal
      if (d.value > 200000) score += 10;
      if (score >= 80) leadsChauds.push({ deal: d, score, ageJ, lastActJ });
    }
    leadsChauds.sort((a, b) => b.score - a.score);

    // 2. DEALS À RISQUE — actifs mais aucune activité récente OU stagnants
    const dealsRisque = [];
    for (const d of dealsActifs) {
      const ageJ = d.add_time ? Math.floor((now - new Date(d.add_time).getTime()) / 86400000) : 0;
      const lastActJ = d.last_activity_date ? Math.floor((now - new Date(d.last_activity_date).getTime()) / 86400000) : ageJ;
      // Stagnant = aucune action depuis 7j+ ET ouvert depuis >5j
      if (lastActJ >= 7 && ageJ >= 5 && d.stage_id !== 55) {
        dealsRisque.push({ deal: d, ageJ, lastActJ });
      }
    }
    dealsRisque.sort((a, b) => b.lastActJ - a.lastActJ);

    // 3. PATTERNS LEADS récents — quelle source convertit le mieux?
    const sourceStats = {};
    for (const e of leadsAudit) {
      const src = e.details?.source || 'inconnu';
      const dec = e.details?.decision || 'unknown';
      sourceStats[src] = sourceStats[src] || { total: 0, autoSent: 0, pending: 0, dedup: 0 };
      sourceStats[src].total++;
      if (dec === 'auto_sent') sourceStats[src].autoSent++;
      else if (dec.startsWith('pending')) sourceStats[src].pending++;
      else if (dec === 'dedup_skipped') sourceStats[src].dedup++;
    }

    // 4. WINS récents — moyenne valeur deal gagné dernier 30j
    const recentWins = dealsGagnes.filter(d => {
      const closeT = d.close_time || d.won_time;
      return closeT && (now - new Date(closeT).getTime()) < 30 * 86400000;
    });
    const avgWonValue = recentWins.length ? recentWins.reduce((s, d) => s + (d.value || 0), 0) / recentWins.length : 0;
    const totalWonValue = recentWins.reduce((s, d) => s + (d.value || 0), 0);

    const dur = ((Date.now() - t0) / 1000).toFixed(1);
    const lines = [
      `🧠 *Insights Stratégiques* (${dur}s)`,
      ``,
      `*📈 Wins 30 derniers jours:*`,
      `  ${recentWins.length} deals gagnés · $${totalWonValue.toLocaleString('fr-CA')} total`,
      `  Moyenne par deal: $${Math.round(avgWonValue).toLocaleString('fr-CA')}`,
      ``,
    ];

    // Leads chauds
    if (leadsChauds.length) {
      lines.push(`*🔥 LEADS CHAUDS — priorité contact (${leadsChauds.length}):*`);
      for (const { deal, score, ageJ, lastActJ } of leadsChauds.slice(0, 5)) {
        const stage = (typeof PD_STAGES !== 'undefined' && PD_STAGES[deal.stage_id]) || `stage ${deal.stage_id}`;
        lines.push(`  🌶 *${deal.title}* (score ${score})`);
        lines.push(`     ${stage} · ${ageJ}j · dernière act ${lastActJ}j`);
        if (deal.value > 0) lines.push(`     Valeur: $${deal.value.toLocaleString('fr-CA')}`);
      }
      lines.push('');
    }

    // Deals à risque
    if (dealsRisque.length) {
      lines.push(`*⚠️ DEALS À RISQUE — relance recommandée (${dealsRisque.length}):*`);
      for (const { deal, ageJ, lastActJ } of dealsRisque.slice(0, 5)) {
        const stage = (typeof PD_STAGES !== 'undefined' && PD_STAGES[deal.stage_id]) || `stage ${deal.stage_id}`;
        lines.push(`  ❄️  *${deal.title}*`);
        lines.push(`     ${stage} · ${ageJ}j ouvert · ${lastActJ}j sans contact`);
        lines.push(`     💡 Suggestion: \`creer_activite ${deal.title} appel\``);
      }
      lines.push('');
    }

    // Patterns sources
    const sortedSources = Object.entries(sourceStats).sort((a, b) => b[1].total - a[1].total);
    if (sortedSources.length) {
      lines.push(`*📊 SOURCES (${leadsAudit.length} leads récents):*`);
      for (const [src, s] of sortedSources.slice(0, 5)) {
        const conversionRate = s.total > 0 ? Math.round((s.autoSent / s.total) * 100) : 0;
        lines.push(`  ${src}: ${s.total} leads · ${s.autoSent} auto-sent (${conversionRate}%) · ${s.pending} pending`);
      }
      lines.push('');
    }

    // Pipeline summary
    const stageGroups = {};
    for (const d of dealsActifs) {
      const stage = (typeof PD_STAGES !== 'undefined' && PD_STAGES[d.stage_id]) || `stage ${d.stage_id}`;
      stageGroups[stage] = (stageGroups[stage] || 0) + 1;
    }
    if (Object.keys(stageGroups).length) {
      lines.push(`*📂 PIPELINE actuel (${dealsActifs.length} deals actifs):*`);
      for (const [s, n] of Object.entries(stageGroups).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${s}: ${n}`);
      }
      lines.push('');
    }

    // Actions recommandées
    lines.push(`*⚡ ACTIONS RECOMMANDÉES AUJOURD'HUI:*`);
    if (leadsChauds.length > 0) lines.push(`  📞 Appeler les ${Math.min(3, leadsChauds.length)} leads les plus chauds (score >80)`);
    if (dealsRisque.length > 0) lines.push(`  💬 Relancer ${dealsRisque.length} deal(s) stagnant(s) >7j`);
    if (recentWins.length === 0) lines.push(`  ⚠️ Aucun deal gagné en 30j — analyser le pipeline`);
    if (!leadsChauds.length && !dealsRisque.length) lines.push(`  ✅ Pipeline propre — focus prospection`);

    const txt = lines.join('\n');
    const chunks = [];
    for (let i = 0; i < txt.length; i += 3800) chunks.push(txt.slice(i, i + 3800));
    for (const c of chunks) {
      await bot.sendMessage(msg.chat.id, c, { parse_mode: 'Markdown' }).catch(() =>
        bot.sendMessage(msg.chat.id, c.replace(/[*_`]/g, '')).catch(() => {})
      );
    }
  });

  // /recent [heures] — TOUT ce que le bot a fait dans les N dernières heures
  // Audit log + email outbox + webhooks + erreurs, tout en 1 message.
  // Pour: "qu'est-ce qui s'est passé pendant que j'étais sur le terrain?"
  bot.onText(/^\/recent(?:\s+(\d+))?/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const hours = Math.min(72, Math.max(1, parseInt(match[1] || '12')));
    const cutoff = Date.now() - hours * 3600 * 1000;
    await bot.sendMessage(msg.chat.id, `📜 *Activité bot — dernières ${hours}h*`, { parse_mode: 'Markdown' });

    // 1. Audit log — leads, sends, alertes
    const events = (auditLog || []).filter(e => new Date(e.at).getTime() > cutoff);
    const byCategory = {};
    for (const e of events) byCategory[e.category] = (byCategory[e.category] || 0) + 1;

    // 2. Email outbox — envois courriels
    const outboxRecent = (emailOutbox || []).filter(e => e.ts > cutoff);

    // 3. Anomalies récentes
    const anomalies = events.filter(e => e.category === 'anomaly');

    const lines = [];

    // Leads par décision
    const leadEvents = events.filter(e => e.category === 'lead');
    if (leadEvents.length) {
      const byDecision = {};
      for (const e of leadEvents) {
        const d = e.details?.decision || 'unknown';
        byDecision[d] = (byDecision[d] || 0) + 1;
      }
      lines.push(`*🎯 Leads (${leadEvents.length}):*`);
      const decEmoji = {
        auto_sent: '🚀', pending_preview_sent: '📦', pending_invalid_name: '⚠️',
        dedup_skipped: '♻️', auto_failed: '❌', auto_skipped: '⏭',
        no_dropbox_match: '🔍', blocked_suspect_name: '🛑',
        skipped_no_email_or_deal: '📭', noSource_suspect: '🤔',
      };
      for (const [d, n] of Object.entries(byDecision).sort((a, b) => b[1] - a[1])) {
        lines.push(`  ${decEmoji[d] || '•'} ${d}: ${n}`);
      }
      // Top 5 leads détaillés
      lines.push('');
      lines.push(`*Détails (5 plus récents):*`);
      for (const e of leadEvents.slice(-5).reverse()) {
        const d = e.details || {};
        const ext = d.extracted || {};
        const time = new Date(e.at).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
        lines.push(`  ${time} · ${decEmoji[d.decision] || '•'} ${ext.email || ext.nom || '(?)'} ${ext.centris ? '#' + ext.centris : ''} → \`${d.decision}\``);
      }
      lines.push('');
    }

    // Envois email
    if (outboxRecent.length) {
      const sent = outboxRecent.filter(e => e.outcome === 'sent');
      const failed = outboxRecent.filter(e => e.outcome !== 'sent');
      lines.push(`*📤 Envois courriels (${outboxRecent.length}):*`);
      lines.push(`  ✅ ${sent.length} envoyés · ❌ ${failed.length} échoués`);
      for (const e of outboxRecent.slice(-5).reverse()) {
        const time = new Date(e.ts).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
        const ico = e.outcome === 'sent' ? '✅' : '❌';
        const consent = e.shawnConsent ? '🔓' : '🔒';
        lines.push(`  ${time} ${ico}${consent} → ${e.to} · ${(e.subject || '').substring(0, 50)}`);
      }
      lines.push('');
    }

    // Anomalies
    if (anomalies.length) {
      lines.push(`*🚨 Anomalies (${anomalies.length}):*`);
      for (const a of anomalies.slice(-3).reverse()) {
        const time = new Date(a.at).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
        lines.push(`  ${time} · ${a.event}: ${(a.details?.msg || '').substring(0, 80)}`);
      }
      lines.push('');
    }

    // Autres catégories (notify, audit, auto-recovery, etc.)
    const otherCats = Object.keys(byCategory).filter(c => !['lead', 'anomaly'].includes(c));
    if (otherCats.length) {
      lines.push(`*📋 Autres (${otherCats.length} catégories):*`);
      for (const c of otherCats) lines.push(`  • ${c}: ${byCategory[c]}`);
    }

    if (!leadEvents.length && !outboxRecent.length && !anomalies.length) {
      lines.push(`✅ Aucune activité significative dans les ${hours}h`);
      lines.push(`_(audit total: ${(auditLog || []).length} events, outbox: ${(emailOutbox || []).length})_`);
    }

    const txt = lines.join('\n');
    // Auto-split si >4000 chars
    const chunks = [];
    for (let i = 0; i < txt.length; i += 3800) chunks.push(txt.slice(i, i + 3800));
    for (const c of chunks) {
      await bot.sendMessage(msg.chat.id, c, { parse_mode: 'Markdown' }).catch(() =>
        bot.sendMessage(msg.chat.id, c.replace(/[*_`]/g, '')).catch(() => {})
      );
    }
  });

  // /cookies <string> — capture cookies session Centris depuis Chrome (one-time setup)
  // Procédure utilisateur: Chrome → matrix.centris.ca (login + MFA) → DevTools (Cmd+Opt+I)
  // → Application → Cookies → matrix.centris.ca → copy tous les cookies
  // (ou plus simple: Network tab → click une requête → headers → "Cookie:" copy value)
  bot.onText(/^\/cookies\s+(.+)/is, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const raw = match[1].trim();
    // Parse — accepte 2 formats:
    //   1. Header style: "Cookie: name1=val1; name2=val2"
    //   2. Plain: "name1=val1; name2=val2"
    //   3. JSON array of {name, value} (DevTools export)
    let cookieStr = '';
    try {
      if (raw.startsWith('[') || raw.startsWith('{')) {
        const arr = JSON.parse(raw);
        cookieStr = (Array.isArray(arr) ? arr : [arr])
          .map(c => `${c.name}=${c.value}`).join('; ');
      } else {
        cookieStr = raw.replace(/^Cookie:\s*/i, '').trim();
      }
    } catch (e) {
      return bot.sendMessage(msg.chat.id, `❌ Format cookies invalide. Attendu: string Cookie header OU JSON array de DevTools.\n\nExemple:\n\`/cookies _ga=GA1.2.123; .centris_auth=xyz; ...\``, { parse_mode: 'Markdown' });
    }
    if (!cookieStr || cookieStr.length < 50) {
      return bot.sendMessage(msg.chat.id, `❌ Cookie string trop courte (${cookieStr.length} chars). Devrait faire 500-3000 chars.`);
    }
    // Validation rapide: doit contenir au moins quelques tokens centris-related
    const tokens = ['centris', 'auth', 'session', '_ga', 'aspnet'];
    const hasIndicator = tokens.some(t => cookieStr.toLowerCase().includes(t));
    if (!hasIndicator) {
      return bot.sendMessage(msg.chat.id, `⚠️ Ces cookies ne ressemblent pas à du Centris/Auth0. Continue quand même? Re-tape \`/cookies-force <string>\` si tu es sûr.`, { parse_mode: 'Markdown' });
    }
    // Test ces cookies contre matrix.centris.ca
    await bot.sendMessage(msg.chat.id, `🔍 Test des cookies contre matrix.centris.ca...`);
    try {
      const testRes = await fetch('https://matrix.centris.ca/Matrix/Default.aspx', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
          'Cookie': cookieStr,
        },
        redirect: 'manual',
      });
      const isAuth = testRes.status === 200 || (testRes.status >= 300 && testRes.status < 400 && !(testRes.headers.get('location') || '').includes('Login'));
      if (!isAuth) {
        return bot.sendMessage(msg.chat.id, `❌ Cookies refusés par Centris (HTTP ${testRes.status}). Re-login dans Chrome + recopie les cookies.`);
      }
    } catch (e) {
      return bot.sendMessage(msg.chat.id, `❌ Test cookies exception: ${e.message?.substring(0, 200)}`);
    }
    // Save 25j (typique session Centris longue durée)
    centrisSession = {
      cookies: cookieStr,
      expiry: Date.now() + 25 * 24 * 3600 * 1000,
      authenticated: true,
      lastLoginAt: Date.now(),
      via: 'manual-capture',
    };
    saveCentrisSessionToDisk();
    auditLogEvent('centris', 'cookies-captured', { length: cookieStr.length });
    await bot.sendMessage(msg.chat.id,
      `✅ *Cookies Centris validés et sauvegardés*\n\n` +
      `📦 ${cookieStr.length} chars · session valide ~25 jours\n` +
      `🗄️ Persisté disque + backup Gist\n\n` +
      `Tu peux maintenant utiliser:\n` +
      `• \`/fiche <#> <email>\` — envoie fiche d'un listing\n` +
      `• \`/info <#>\` — dashboard propriété\n` +
      `• Outils \`telecharger_fiche_centris\`, \`chercher_comparables\` (langage naturel)\n\n` +
      `Le bot te pingera quand les cookies vont expirer (~25j).`,
      { parse_mode: 'Markdown' }
    );
  });

  // /centris-status — vérifie si cookies valides + expiry
  bot.onText(/^\/centris[-_]?status/i, async msg => {
    if (!isAllowed(msg)) return;
    if (!centrisSession.cookies) {
      return bot.sendMessage(msg.chat.id,
        `⚠️ *Aucun cookies Centris*\n\nFais le setup une fois:\n` +
        `1. Login matrix.centris.ca dans Chrome (avec MFA)\n` +
        `2. DevTools (Cmd+Opt+I) → Network → click une requête → header "Cookie:" → copy\n` +
        `3. Tape \`/cookies <le_string>\`\n\n` +
        `Le bot test la validité, save 25j, et te ping quand expire.`,
        { parse_mode: 'Markdown' }
      );
    }
    const remainingMs = centrisSession.expiry - Date.now();
    const remainingDays = Math.round(remainingMs / 86400000);
    const lastLogin = centrisSession.lastLoginAt ? new Date(centrisSession.lastLoginAt).toLocaleString('fr-CA', { timeZone: 'America/Toronto' }) : '?';
    bot.sendMessage(msg.chat.id,
      `🍪 *Centris session*\n` +
      `Expire dans: ${remainingDays > 0 ? `*${remainingDays} jours*` : '🔴 EXPIRÉ — re-capture nécessaire'}\n` +
      `Cookies: ${centrisSession.cookies.length} chars\n` +
      `Capturé: ${lastLogin}\n` +
      `Via: ${centrisSession.via || '?'}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /login_centris — déclenche login OAuth complet avec injection MFA auto
  // Coordonné avec le bridge Mac sms-bridge.js qui forward le code SMS au bot.
  bot.onText(/^\/login[-_]?centris\b/i, async msg => {
    if (!isAllowed(msg)) return;
    if (!process.env.CENTRIS_USER || !process.env.CENTRIS_PASS) {
      return bot.sendMessage(msg.chat.id, '❌ CENTRIS_USER/CENTRIS_PASS manquants dans Render env vars');
    }
    const bridgeAlive = smsBridgeHealth.alive && (Date.now() - smsBridgeHealth.lastHeartbeat) < 10 * 60 * 1000;
    await bot.sendMessage(msg.chat.id,
      `🔐 *Login Centris OAuth + MFA*\n` +
      `Bridge Mac SMS: ${bridgeAlive ? '🟢 actif' : '⚠️ pas de heartbeat <10min'}\n` +
      `_Le bot va recevoir un SMS code → bridge forward → injection auto._\n` +
      `_Patience ~30-60s, surtout pour le SMS_`,
      { parse_mode: 'Markdown' }
    );
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    try {
      const result = await centrisOAuthLoginWithMFA({ mfaTimeoutMs: 120000 });
      clearInterval(typing);
      if (result.ok) {
        await bot.sendMessage(msg.chat.id,
          `✅ *Login Centris OK*\n` +
          `Cookies: ${result.cookieCount} · session valide 24h\n` +
          `Tu peux maintenant utiliser \`/fiche <#> <email>\``,
          { parse_mode: 'Markdown' }
        );
        auditLogEvent('centris', 'oauth-login-success', { cookies: result.cookieCount });
      } else {
        await bot.sendMessage(msg.chat.id, `❌ *Login échoué:* ${result.error}`, { parse_mode: 'Markdown' });
        auditLogEvent('centris', 'oauth-login-failed', { error: result.error });
      }
    } catch (e) {
      clearInterval(typing);
      await bot.sendMessage(msg.chat.id, `❌ Exception: ${e.message?.substring(0, 200)}`);
    }
  });

  // /fiche <#centris> <email> [message_perso] — télécharge fiche Centris + envoie
  // Cas usage: tu es sur le terrain, client demande info sur un autre listing pas
  // à toi → /fiche 12345678 client@gmail.com → bot fetch + envoie en 10s.
  bot.onText(/^\/fiche\s+(\d{7,9})\s+(\S+@\S+)(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const num = match[1];
    const email = match[2];
    const message_perso = match[3]?.trim() || null;
    await bot.sendMessage(msg.chat.id, `📥 *Fiche Centris #${num}* → ${email}\n_Login Centris + download + envoi (10-30s)_`, { parse_mode: 'Markdown' });
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    try {
      const result = await telechargerFicheCentris({ centris_num: num, email_destination: email, message_perso });
      clearInterval(typing);
      await bot.sendMessage(msg.chat.id, String(result).substring(0, 4000), { parse_mode: 'Markdown' }).catch(() =>
        bot.sendMessage(msg.chat.id, String(result).substring(0, 4000).replace(/[*_`]/g, '')).catch(() => {})
      );
    } catch (e) {
      clearInterval(typing);
      await bot.sendMessage(msg.chat.id, `❌ Erreur: ${e.message?.substring(0, 300)}`);
    }
  });

  // /info <#Centris ou adresse> — DASHBOARD complet d'une propriété (terrain mode)
  // Pour Shawn sur le terrain avec un client: tout en 1 commande, parallel calls.
  // Retourne deal Pipedrive + dossier Dropbox + photos + info zonage + comparables.
  bot.onText(/^\/info\s+(.+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const query = match[1].trim();
    const isCentris = /^\d{7,9}$/.test(query);
    await bot.sendMessage(msg.chat.id, `🔎 *Recherche complète:* \`${query}\`\n_${isCentris ? 'Centris# détecté' : 'recherche par adresse/nom'}_`, { parse_mode: 'Markdown' });

    // PARALLÉLISATION — toutes les lookups en parallèle (3-5s total au lieu de 15s)
    const t0 = Date.now();
    const tasks = [
      // 1. Pipedrive deal lookup
      (async () => {
        if (!PD_KEY) return null;
        try {
          const sr = await pdGet(`/deals/search?term=${encodeURIComponent(query)}&limit=3`).catch(() => null);
          const deals = sr?.data?.items || [];
          return deals.length ? deals : null;
        } catch { return null; }
      })(),
      // 2. Dropbox match (cherche dossier propriété)
      (async () => {
        try {
          if (typeof matchDropboxAvance === 'function') {
            return await matchDropboxAvance(isCentris ? query : null, isCentris ? null : query);
          }
        } catch {}
        return null;
      })(),
      // 3. Comparables Centris si disponible (skip si pas auth)
      (async () => {
        if (!process.env.CENTRIS_USER) return null;
        // Pas de scrape lourd ici — juste info de base
        return { skipped: 'Centris comparables sur demande explicite' };
      })(),
    ];
    const [deals, dbxMatch, centrisInfo] = await Promise.all(tasks);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    // Compose le rapport
    const lines = [`📊 *Dashboard propriété* — ${query} (${elapsed}s)`, ''];

    // Pipedrive
    if (deals && deals.length) {
      lines.push(`*🏢 Pipedrive (${deals.length} deal${deals.length > 1 ? 's' : ''}):*`);
      for (const d of deals.slice(0, 3)) {
        const item = d.item;
        const stage = (typeof PD_STAGES !== 'undefined' && PD_STAGES[item.stage_id]) || `stage ${item.stage_id}`;
        lines.push(`  • ${item.title} · ${stage}${item.value ? ' · $' + item.value : ''}`);
      }
      lines.push('');
    } else if (PD_KEY) {
      lines.push(`*🏢 Pipedrive:* aucun deal trouvé\n`);
    }

    // Dropbox
    if (dbxMatch?.folder) {
      const f = dbxMatch.folder;
      lines.push(`*📁 Dropbox:* \`${f.adresse || f.name}\` (score ${dbxMatch.score})`);
      lines.push(`  📄 ${dbxMatch.pdfs?.length || 0} document(s) prêts`);
      if (dbxMatch.pdfs?.length) {
        const top = dbxMatch.pdfs.slice(0, 5).map(p => `  • ${p.name}`).join('\n');
        lines.push(top);
      }
      lines.push('');
    } else if (dbxMatch?.candidates?.length) {
      lines.push(`*📁 Dropbox:* candidats trouvés:`);
      for (const c of dbxMatch.candidates.slice(0, 3)) {
        lines.push(`  • ${c.folder.adresse || c.folder.name} (score ${c.score})`);
      }
      lines.push('');
    } else {
      lines.push(`*📁 Dropbox:* aucun match — vérifie nom dossier\n`);
    }

    // Suggestions actions
    lines.push(`*⚡ Actions rapides:*`);
    if (dbxMatch?.folder && deals && deals[0]?.item?.person_id) {
      lines.push(`  \`envoie les docs à <email>\` — livre dossier au prospect`);
    }
    if (process.env.PERPLEXITY_API_KEY) {
      lines.push(`  \`/cherche zonage ${isCentris ? '#' + query : query}\` — règlement municipal`);
    }
    lines.push(`  \`/lead-audit ${query}\` — historique complet`);

    const txt = lines.join('\n');
    await bot.sendMessage(msg.chat.id, txt.substring(0, 4000), { parse_mode: 'Markdown' }).catch(() =>
      bot.sendMessage(msg.chat.id, txt.substring(0, 4000).replace(/[*_`]/g, '')).catch(() => {})
    );
  });

  // ─── RACCOURCIS WEB RESEARCH ─────────────────────────────────────────────
  // /pdf <url>       — télécharge n'importe quel PDF + envoie sur Telegram
  // /scrape <url>    — scrape page + extract liens PDF (+ download top 5)
  // /cherche <query> — Perplexity + Firecrawl + auto-download PDFs trouvés
  bot.onText(/^\/pdf\s+(\S+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const url = match[1].trim();
    await bot.sendMessage(msg.chat.id, `📥 Téléchargement: ${url}...`);
    const result = await executeToolSafe('telecharger_pdf', { url }, msg.chat.id).catch(e => `❌ ${e.message}`);
    await bot.sendMessage(msg.chat.id, String(result).substring(0, 4000));
  });

  bot.onText(/^\/scrape\s+(\S+)(?:\s+(.*))?/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const url = match[1].trim();
    const motsCles = match[2] ? match[2].split(/[,\s]+/).filter(Boolean) : [];
    await bot.sendMessage(msg.chat.id, `🌐 Scrape ${url}${motsCles.length ? ' filtrant: ' + motsCles.join(',') : ''}...`);
    const result = await executeToolSafe('scraper_avance', { url, mots_cles: motsCles, telecharger_pdfs: true }, msg.chat.id).catch(e => `❌ ${e.message}`);
    // Split if too long for Telegram
    const txt = String(result);
    const chunks = [];
    for (let i = 0; i < txt.length; i += 3500) chunks.push(txt.slice(i, i + 3500));
    for (const c of chunks) await bot.sendMessage(msg.chat.id, c, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(msg.chat.id, c).catch(() => {}));
  });

  bot.onText(/^\/cherche\s+(.+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const question = match[1].trim();
    await bot.sendMessage(msg.chat.id, `🔍 Recherche: "${question}"\n_(Perplexity → Firecrawl → download auto)_`, { parse_mode: 'Markdown' });
    const result = await executeToolSafe('recherche_documents', { question, max_resultats: 3 }, msg.chat.id).catch(e => `❌ ${e.message}`);
    const txt = String(result);
    const chunks = [];
    for (let i = 0; i < txt.length; i += 3500) chunks.push(txt.slice(i, i + 3500));
    for (const c of chunks) await bot.sendMessage(msg.chat.id, c, { parse_mode: 'Markdown' }).catch(() => bot.sendMessage(msg.chat.id, c).catch(() => {}));
  });

  // /extract [msgId|last|N] — extract info contact (email/tél/Centris#) de n'importe
  // quel email reçu, même si pas détecté comme lead. Utile pour récupérer info même
  // si Pipedrive a échoué ou si le format est inhabituel.
  // Sans arg: dernier email Gmail. Avec arg "last 5": 5 derniers. Avec msgId: spécifique.
  // /setsecret KEY VALUE — stocke un secret dans Dropbox /bot-secrets/<KEY>.txt
  // ET injecte dans process.env immédiatement (sans redeploy Render).
  // Permet d'ajouter FIRECRAWL_API_KEY, PERPLEXITY_API_KEY, etc. en 1 message.
  bot.onText(/^\/setsecret\s+(\S+)\s+(.+)/i, async (msg, m) => {
    if (!isAllowed(msg)) return;
    const key = m[1].toUpperCase().trim();
    const value = m[2].trim();
    if (!/^[A-Z0-9_]+$/.test(key)) return bot.sendMessage(msg.chat.id, `❌ Clé invalide: ${key} (lettres+chiffres+underscore seulement)`);
    if (value.length < 8) return bot.sendMessage(msg.chat.id, `❌ Valeur trop courte (min 8 chars)`);
    try {
      const ok = await uploadDropboxSecret(key, value);
      if (!ok) return bot.sendMessage(msg.chat.id, `❌ Upload Dropbox échoué`);
      process.env[key] = value;
      const masked = value.length > 12 ? value.substring(0, 6) + '...' + value.substring(value.length - 4) : '***';
      await bot.sendMessage(msg.chat.id, `✅ *${key}* sauvegardé\n\n• Dropbox: \`/bot-secrets/${key}.txt\`\n• process.env: actif live\n• Valeur: \`${masked}\`\n\n_Persiste à travers les redeploys Render._`, { parse_mode: 'Markdown' });
      // Auto-delete le message original (contient la clé en clair)
      try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch {}
    } catch (e) { bot.sendMessage(msg.chat.id, `❌ Erreur: ${e.message}`); }
  });

  // /menage — audit Pipedrive ULTRA (deals doublons + activités + orphans + génériques)
  bot.onText(/^\/menage|\/m[ée]nage|\/audit|\/clean/i, async msg => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, `🧹 *Audit ultra-perfectionné en cours...*\n_Scanne tous deals/activités, fusionne doublons, supprime orphans._`, { parse_mode: 'Markdown' });
    try {
      const stats = await auditPipedriveUltra();
      if (!stats || stats.error) {
        await bot.sendMessage(msg.chat.id, `❌ ${stats?.error || 'erreur'}`);
        return;
      }
      const total = stats.dealsFusionnes + stats.activitesDoublons + stats.activitesOrphans + stats.activitesSansContact;
      await bot.sendMessage(msg.chat.id,
        `✅ *Audit terminé*\n\n` +
        `• ${stats.dealsFusionnes} deals doublons fusionnés\n` +
        `• ${stats.activitesDoublons} activités doublons → done\n` +
        `• ${stats.activitesOrphans} orphans supprimées\n` +
        `• ${stats.activitesSansContact} sans contact supprimées\n\n` +
        `*Total: ${total} entrées nettoyées.*\n\n` +
        (total === 0 ? `_Pipeline déjà propre._` : `_1 deal + 1 activité max par personne maintenant._`),
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  // /dedup — nettoie doublons activités sur tous les deals open (manuel)
  // /dedup #DEAL_ID — nettoie un deal spécifique
  bot.onText(/^\/dedup(?:\s+#?(\d+))?/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const dealArg = match?.[1] ? parseInt(match[1]) : null;
    await bot.sendMessage(msg.chat.id, `🧹 *Dedup en cours...*${dealArg ? ` deal #${dealArg}` : ' tous deals open'}`, { parse_mode: 'Markdown' });

    try {
      if (dealArg) {
        const res = await nettoyerDoublonsActivites(dealArg);
        const dInfo = await pdGet(`/deals/${dealArg}`).then(r => r?.data).catch(() => null);
        await bot.sendMessage(msg.chat.id,
          `✅ *Deal #${dealArg}* ${dInfo ? `(${dInfo.title})` : ''}\n` +
          `${res.gardees} groupe(s) gardé(s)\n` +
          `${res.supprimees} doublon(s) supprimé(s)`,
          { parse_mode: 'Markdown' }
        );
      } else {
        const r = await runDedupHebdo();
        await bot.sendMessage(msg.chat.id,
          `✅ *Dedup terminé*\n\n` +
          `${r?.totalDeals || 0} deals scannés\n` +
          `${r?.totalSupprimees || 0} doublon(s) supprimé(s)`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ Erreur: ${e.message}`);
    }
  });

  // /listsecrets — affiche les clés stockées dans Dropbox (sans valeurs)
  bot.onText(/^\/listsecrets$/i, async (msg) => {
    if (!isAllowed(msg)) return;
    try {
      const res = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: '/bot-secrets', recursive: false });
      if (!res?.ok) return bot.sendMessage(msg.chat.id, `📭 Aucun secret stocké (dossier /bot-secrets vide ou absent)`);
      const data = await res.json();
      const keys = (data.entries || []).filter(e => e['.tag'] === 'file' && e.name.endsWith('.txt')).map(e => e.name.replace(/\.txt$/, ''));
      if (!keys.length) return bot.sendMessage(msg.chat.id, `📭 Aucun secret stocké`);
      const lines = keys.map(k => `• \`${k}\` ${process.env[k] ? '✅' : '⚠️ pas en process.env'}`).join('\n');
      bot.sendMessage(msg.chat.id, `🔐 *Secrets Dropbox (${keys.length})*\n\n${lines}\n\n_Pour ajouter:_ \`/setsecret KEY VALUE\``, { parse_mode: 'Markdown' });
    } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
  });

  bot.onText(/^\/extract(?:\s+(.+))?/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const arg = (match[1] || '').trim();
    if (!process.env.GMAIL_CLIENT_ID) return bot.sendMessage(msg.chat.id, '❌ Gmail pas configuré');
    await bot.sendMessage(msg.chat.id, `🔍 *Extraction contact info...*\n_${arg || 'dernier email reçu'}_`, { parse_mode: 'Markdown' });

    let msgIds = [];
    try {
      if (/^[a-zA-Z0-9_-]{10,}$/.test(arg)) {
        msgIds = [arg]; // msgId Gmail spécifique
      } else {
        const limit = parseInt(arg) || 1;
        const list = await gmailAPI(`/messages?maxResults=${Math.min(limit, 10)}&q=in:inbox`).catch(() => null);
        msgIds = (list?.messages || []).slice(0, Math.min(limit, 5)).map(m => m.id);
      }
      if (!msgIds.length) return bot.sendMessage(msg.chat.id, `❌ Aucun email trouvé`);

      for (const id of msgIds) {
        try {
          const full = await gmailAPI(`/messages/${id}?format=full`).catch(() => null);
          if (!full) continue;
          const hdrs = full.payload?.headers || [];
          const get = n => hdrs.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
          const from = get('from');
          const subject = get('subject');
          const date = get('date');
          const body = gmailExtractBody(full.payload);

          // Extract via regex
          let lead = parseLeadEmail(body, subject, from);
          let infoCount = [lead.nom, lead.email, lead.telephone, lead.centris, lead.adresse].filter(Boolean).length;

          // AI deep scrape si <4 fields
          if (infoCount < 4 && API_KEY) {
            try {
              const enriched = await parseLeadEmailWithAI(body, subject, from, lead, {
                apiKey: API_KEY, logger: log, htmlBody: body,
              });
              if (enriched && (enriched.nom || enriched.email || enriched.centris)) {
                lead = enriched;
                infoCount = [lead.nom, lead.email, lead.telephone, lead.centris, lead.adresse].filter(Boolean).length;
              }
            } catch {}
          }

          const source = detectLeadSource(from, subject) || { source: 'inconnu', label: 'Source inconnue' };
          const lines = [
            `📧 *Email \`${id.substring(0, 12)}...\`*`,
            `📨 *De:* ${from?.substring(0, 80) || '?'}`,
            `📝 *Sujet:* ${subject?.substring(0, 80) || '?'}`,
            `📅 ${date?.substring(0, 30) || '?'}`,
            `🏷 Source: ${source.label}`,
            ``,
            `*🎯 Info extraite (${infoCount}/5):*`,
            `  👤 Nom: ${lead.nom || '_(non trouvé)_'}`,
            `  📞 Tél: ${lead.telephone || '_(non trouvé)_'}`,
            `  ✉️ Email: ${lead.email || '_(non trouvé)_'}`,
            `  🏡 Centris: ${lead.centris || '_(non trouvé)_'}`,
            `  📍 Adresse: ${lead.adresse || '_(non trouvé)_'}`,
            `  📦 Type: ${lead.type || 'terrain'}`,
          ];

          // Buttons inline pour actions rapides
          const buttons = [];
          if (lead.email) {
            buttons.push({ text: '🚀 Envoyer fiche', callback_data: `extract_send:${id}` });
          }
          if (lead.centris && lead.email) {
            buttons.push({ text: '📊 Info terrain', callback_data: `audit:${lead.centris}` });
          }
          buttons.push({ text: '🔄 Re-process', callback_data: `extract_reprocess:${id}` });

          const replyMarkup = buttons.length ? { inline_keyboard: [buttons] } : undefined;
          await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown', reply_markup: replyMarkup }).catch(() =>
            bot.sendMessage(msg.chat.id, lines.join('\n').replace(/[*_`]/g, ''), replyMarkup ? { reply_markup: replyMarkup } : {}).catch(() => {})
          );
        } catch (e) {
          await bot.sendMessage(msg.chat.id, `⚠️ Extract msg ${id.substring(0, 12)}: ${e.message?.substring(0, 100)}`);
        }
      }
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message?.substring(0, 200)}`);
    }
  });

  // /campaigns — liste campagnes Brevo suspended + boutons inline confirm/cancel
  // Remplace le système confirmserver Mac fragile (Cloudflare tunnel volatile).
  // Bot appelle directement Brevo API → robuste, jamais down.
  bot.onText(/^\/campaigns?\b|\/courriels?\b|\/envois?\b/i, async msg => {
    if (!isAllowed(msg)) return;
    if (!BREVO_KEY) return bot.sendMessage(msg.chat.id, '❌ BREVO_API_KEY requis');
    await bot.sendMessage(msg.chat.id, `📧 *Recherche campagnes en attente...*`, { parse_mode: 'Markdown' });
    try {
      const r = await fetch('https://api.brevo.com/v3/emailCampaigns?status=suspended&limit=20', {
        headers: { 'api-key': BREVO_KEY, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return bot.sendMessage(msg.chat.id, `❌ Brevo HTTP ${r.status}`);
      const data = await r.json();
      const campaigns = data.campaigns || [];
      if (!campaigns.length) {
        return bot.sendMessage(msg.chat.id, `✅ Aucune campagne en attente (suspended: 0)`);
      }
      // Trier par scheduledAt asc (plus proche en premier)
      campaigns.sort((a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0));
      // Header summary
      await bot.sendMessage(msg.chat.id,
        `📧 *${campaigns.length} campagne(s) en attente de confirmation*\n_Click ✅ pour activer · 🚫 pour annuler · 👁 pour preview_`,
        { parse_mode: 'Markdown' }
      );
      // Une bulle par campagne avec inline buttons
      for (const c of campaigns.slice(0, 10)) {
        const sched = c.scheduledAt ? new Date(c.scheduledAt).toLocaleString('fr-CA', { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'short' }) : '?';
        const txt = `*#${c.id}* · ${c.name?.substring(0, 60) || '?'}\n📅 ${sched}\n📋 ${c.subject?.substring(0, 80) || '?'}`;
        const replyMarkup = {
          inline_keyboard: [[
            { text: '✅ Confirmer', callback_data: `cmp_send:${c.id}` },
            { text: '🚫 Annuler', callback_data: `cmp_cancel:${c.id}` },
            { text: '👁 Preview', callback_data: `cmp_preview:${c.id}` },
          ]],
        };
        await bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown', reply_markup: replyMarkup }).catch(() =>
          bot.sendMessage(msg.chat.id, txt.replace(/[*_`]/g, ''), { reply_markup: replyMarkup }).catch(() => {})
        );
      }
      if (campaigns.length > 10) {
        await bot.sendMessage(msg.chat.id, `_+ ${campaigns.length - 10} autres — utilise dashboard Brevo pour gérer_`, { parse_mode: 'Markdown' });
      }
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ ${e.message?.substring(0, 200)}`);
    }
  });

  // /firecrawl — statut quota + dernières villes scrapées
  bot.onText(/\/firecrawl\b/i, async msg => {
    if (!isAllowed(msg)) return;
    try {
      const { getQuotaStatus, MUNICIPALITES } = require('./firecrawl_scraper');
      const q = getQuotaStatus();
      const villes = Object.keys(MUNICIPALITES).join(', ');
      await bot.sendMessage(msg.chat.id,
        `🔥 *Firecrawl Status*\n${q.statut}\n` +
        `📊 ${q.utilise}/${q.quota} scrapes utilisés (${q.pourcentage}%)\n` +
        `✅ Restant ce mois: ${q.restant}\n` +
        `📅 Mois: ${q.mois}\n\n` +
        `*Villes pré-configurées:*\n${villes}\n\n` +
        `Exemples: "grille de zonage Sainte-Julienne" · "règlement riveraine Rawdon" · "permis Chertsey"`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ Firecrawl: ${e.message.substring(0, 200)}`);
    }
  });

  // /diagnose — test EN LIVE chaque composant critique + rapport RED/YELLOW/GREEN
  // Diagnostic en 1 commande. Utile après deploy ou quand un truc semble cassé.
  bot.onText(/\/diagnose|\/diag\b/, async msg => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, '🔬 Diagnostic en cours — tests live sur tous les composants...');
    const checks = [];
    const t0 = Date.now();

    // 1. Gmail API (list 1 message)
    try {
      const r = await gmailAPI('/messages?maxResults=1').catch(() => null);
      checks.push({ name: 'Gmail API', ok: !!r?.messages, detail: r?.messages ? `${r.messages.length} msg ok` : 'échec list' });
    } catch (e) { checks.push({ name: 'Gmail API', ok: false, detail: e.message.substring(0, 80) }); }

    // 2. Gmail token (refresh check)
    try {
      const tok = await getGmailToken();
      checks.push({ name: 'Gmail token', ok: !!tok, detail: tok ? `valide (${tok.substring(0,10)}...)` : 'NULL — refresh échoué' });
    } catch (e) { checks.push({ name: 'Gmail token', ok: false, detail: e.message.substring(0, 80) }); }

    // 3. Dropbox API
    try {
      const r = await dropboxAPI('https://api.dropboxapi.com/2/users/get_current_account', {});
      checks.push({ name: 'Dropbox API', ok: !!r?.ok, detail: r?.ok ? 'auth ok' : `HTTP ${r?.status || '?'}` });
    } catch (e) { checks.push({ name: 'Dropbox API', ok: false, detail: e.message.substring(0, 80) }); }

    // 4. Dropbox index
    const idxCount = dropboxIndex?.folders?.length || 0;
    checks.push({ name: 'Dropbox index', ok: idxCount > 10, detail: `${idxCount} dossiers (legacy: ${dropboxTerrains.length} terrains)` });

    // 5. Pipedrive API
    if (PD_KEY) {
      try {
        const r = await pdGet('/users/me').catch(() => null);
        checks.push({ name: 'Pipedrive API', ok: !!r?.data, detail: r?.data ? `user ${r.data.email}` : 'échec' });
      } catch (e) { checks.push({ name: 'Pipedrive API', ok: false, detail: e.message.substring(0, 80) }); }
    } else { checks.push({ name: 'Pipedrive API', ok: false, detail: 'PD_KEY manquant' }); }

    // 6. Anthropic API (Haiku ping léger)
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10000),
      });
      checks.push({ name: 'Anthropic API', ok: r.ok, detail: r.ok ? 'haiku ping ok' : `HTTP ${r.status}` });
    } catch (e) { checks.push({ name: 'Anthropic API', ok: false, detail: e.message.substring(0, 80) }); }

    // 7. Telegram webhook
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const pending = j.result?.pending_update_count || 0;
      checks.push({ name: 'Telegram webhook', ok: !!j.result?.url && pending < 10, detail: j.result?.url ? `url ok, pending=${pending}` : 'pas configuré' });
    } catch (e) { checks.push({ name: 'Telegram webhook', ok: false, detail: e.message.substring(0, 80) }); }

    // 8. Disque (DATA_DIR writable)
    try {
      const testFile = path.join(DATA_DIR, '.diag_write');
      fs.writeFileSync(testFile, String(Date.now()));
      fs.unlinkSync(testFile);
      checks.push({ name: 'Disque (DATA_DIR)', ok: true, detail: DATA_DIR });
    } catch (e) { checks.push({ name: 'Disque (DATA_DIR)', ok: false, detail: e.message.substring(0, 80) }); }

    // 9. Poller fraîcheur
    const lastRunMs = gmailPollerState.lastRun ? Date.now() - new Date(gmailPollerState.lastRun).getTime() : Infinity;
    checks.push({ name: 'Poller activité', ok: lastRunMs < 5 * 60 * 1000, detail: `dernier run il y a ${Math.round(lastRunMs / 1000)}s` });

    // 10. Pending counts
    const pDocs = typeof pendingDocSends !== 'undefined' ? pendingDocSends.size : 0;
    const pNames = pendingLeads.filter(l => l.needsName).length;
    checks.push({ name: 'Pending', ok: pDocs < 5 && pNames < 3, detail: `${pDocs} docs + ${pNames} noms en attente` });

    // 11. Retry state
    const stuckRetries = Object.entries(leadRetryState || {}).filter(([, v]) => v.count >= 3).length;
    checks.push({ name: 'Retry counter', ok: stuckRetries === 0, detail: stuckRetries ? `${stuckRetries} leads coincés` : 'aucun blocage' });

    // 12. Cost tracker (jour)
    const todayCost = costTracker?.daily?.[today()] || 0;
    checks.push({ name: 'Coût aujourd\'hui', ok: todayCost < 10, detail: `$${todayCost.toFixed(2)}` });

    // 13. Health score global
    const h = computeHealthScore();
    checks.push({ name: 'Health score', ok: h.score >= 70, detail: `${h.score}/100 (${h.status})` });

    const dur = Date.now() - t0;
    const nOK = checks.filter(c => c.ok).length;
    const nFail = checks.length - nOK;
    const globalEmoji = nFail === 0 ? '🟢' : nFail <= 2 ? '🟡' : '🔴';
    const lines = checks.map(c => `${c.ok ? '✅' : '🔴'} *${c.name}* — ${c.detail}`);
    const summary = [
      `${globalEmoji} *Diagnostic complet* (${dur}ms)`,
      ``,
      `${nOK}/${checks.length} systèmes OK`,
      ``,
      ...lines,
    ].join('\n');
    await bot.sendMessage(chatId, summary, { parse_mode: 'Markdown' }).catch(() =>
      bot.sendMessage(chatId, summary.replace(/[*_`]/g, '')).catch(() => {})
    );
  });

  // /test-email <centris#> [email] — simule un lead Centris factice pour valider le pipeline
  // Utile après deploy pour vérifier auto-send de bout en bout sans attendre un vrai Centris.
  // Ex: /test-email 26621771 testprospect@example.com
  bot.onText(/\/test[-_]?email\s+(\d{7,9})(?:\s+(\S+@\S+))?/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const centrisNum = match[1];
    const email = match[2] || 'test-prospect@example.com';
    await bot.sendMessage(msg.chat.id, `🧪 *Test pipeline* — Centris #${centrisNum}, email ${email}`, { parse_mode: 'Markdown' });

    const fakeLead = {
      nom: 'Test Prospect',
      telephone: '5145551234',
      email,
      centris: centrisNum,
      adresse: '',
      type: 'terrain',
    };
    const fakeMsgId = `test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const fakeFrom = 'Centris Test <noreply@centris.ca>';
    const fakeSubject = `TEST — Demande Centris #${centrisNum}`;
    const fakeSource = { source: 'centris', label: 'Centris.ca (TEST)' };

    try {
      const result = await traiterNouveauLead(fakeLead, fakeMsgId, fakeFrom, fakeSubject, fakeSource, { skipDedup: true });
      await bot.sendMessage(msg.chat.id,
        `🧪 *Résultat test*\n` +
        `Décision: \`${result?.decision || '(void)'}\`\n` +
        `Deal ID: ${result?.dealId || '(aucun)'}\n` +
        `Notif envoyée: ${result?.notifySent ? '✅' : '❌'}\n\n` +
        `Run \`/lead-audit ${fakeMsgId}\` pour trace complète.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ Test a throw: ${e.message.substring(0, 200)}`);
    }
  });

  // /flush-pending — retry IMMÉDIATEMENT tous les pendingDocSends (bypass seuil 5min)
  bot.onText(/\/flush[-_]?pending/i, async msg => {
    if (!isAllowed(msg)) return;
    const n = pendingDocSends.size;
    if (n === 0) return bot.sendMessage(msg.chat.id, '✅ Aucun pending à flush.');
    await bot.sendMessage(msg.chat.id, `⚡ Flush ${n} pending doc-sends (force retry — consent Shawn)...`);
    let sent = 0, failed = 0;
    for (const [email, pending] of [...pendingDocSends.entries()]) {
      try {
        // Shawn a tapé /flush-pending = consent explicit pour TOUS les pending
        const r = await envoyerDocsAuto({ ...pending, _shawnConsent: true });
        if (r.sent) { pendingDocSends.delete(email); sent++; }
        else if (r.skipped) log('INFO', 'FLUSH', `${email}: ${r.reason}`);
        else failed++;
      } catch (e) { failed++; log('WARN', 'FLUSH', `${email}: ${e.message.substring(0, 100)}`); }
    }
    await bot.sendMessage(msg.chat.id, `✅ Flush terminé — ${sent} envoyés, ${failed} échoués.`);
  });

  bot.onText(/\/backup/, async msg => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, '💾 Backup en cours...');
    try {
      await savePollerStateToGist();
      await bot.sendMessage(msg.chat.id,
        `✅ Backup complet dans Gist\n\n` +
        `• Poller: ${gmailPollerState.processed.length} IDs, ${gmailPollerState.totalLeads} leads\n` +
        `• Dédup: ${recentLeadsByKey.size} entrées\n` +
        `• Mémoire Kira: ${kiramem.facts.length} faits\n` +
        `• Audit: ${auditLog.length} events\n\n` +
        `Restaure auto au prochain boot.`
      );
      auditLogEvent('backup', 'manual', { processed: gmailPollerState.processed.length });
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  // ─── /business — coût total de la business (fixes + variables) ──────────
  bot.onText(/\/business|\/abonnements|\/couts_business/, msg => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(msg.chat.id, formatBusinessReport(), { parse_mode: 'Markdown', disable_web_page_preview: true });
  });

  // ─── /sub_set <id> <prix> [USD|CAD] — ajuster prix abonnement
  bot.onText(/\/sub[_-]?set\s+(\S+)\s+(\d+(?:\.\d+)?)\s*(USD|CAD|usd|cad)?/i, (msg, match) => {
    if (!isAllowed(msg)) return;
    const id = match[1].toLowerCase();
    const price = parseFloat(match[2]);
    const currency = (match[3] || 'USD').toUpperCase();
    const sub = subscriptions.items.find(s => s.id === id);
    if (!sub) {
      bot.sendMessage(msg.chat.id, `❌ ID "${id}" inconnu.\n\nIDs valides: ${subscriptions.items.filter(s => !s.variable).map(s => s.id).join(', ')}`);
      return;
    }
    if (sub.variable) {
      bot.sendMessage(msg.chat.id, `❌ ${sub.name} est variable (pay-as-you-go) — pas de prix fixe à set.`);
      return;
    }
    if (currency === 'CAD') { sub.price_cad = price; sub.price_usd = null; }
    else                    { sub.price_usd = price; sub.price_cad = null; }
    sub.est = false;
    sub.confirmedAt = new Date().toISOString();
    subscriptions.lastUpdate = new Date().toISOString();
    saveJSON(SUBS_FILE, subscriptions);
    bot.sendMessage(msg.chat.id, `✅ ${sub.name}: $${price.toFixed(2)} ${currency} confirmé.\n_Voir le total: /business_`, { parse_mode: 'Markdown' });
  });

  // ─── /sub_add <name> <prix> [category] — nouvel abonnement
  bot.onText(/\/sub[_-]?add\s+"([^"]+)"\s+(\d+(?:\.\d+)?)\s*(\S+)?/i, (msg, match) => {
    if (!isAllowed(msg)) return;
    const name = match[1];
    const price = parseFloat(match[2]);
    const category = match[3] || 'Autre';
    const id = name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').substring(0, 30);
    if (subscriptions.items.find(s => s.id === id)) {
      bot.sendMessage(msg.chat.id, `❌ Existe déjà: ${id}. Utilise /sub_set pour modifier.`);
      return;
    }
    subscriptions.items.push({ id, name, category, price_usd: price, est: false, confirmedAt: new Date().toISOString() });
    subscriptions.lastUpdate = new Date().toISOString();
    saveJSON(SUBS_FILE, subscriptions);
    bot.sendMessage(msg.chat.id, `✅ Ajouté: ${name} ($${price.toFixed(2)} USD, ${category})\nID: \`${id}\``, { parse_mode: 'Markdown' });
  });

  // ─── /sub_remove <id> — retirer un abonnement
  bot.onText(/\/sub[_-]?remove\s+(\S+)/i, (msg, match) => {
    if (!isAllowed(msg)) return;
    const id = match[1].toLowerCase();
    const before = subscriptions.items.length;
    subscriptions.items = subscriptions.items.filter(s => s.id !== id);
    if (subscriptions.items.length === before) {
      bot.sendMessage(msg.chat.id, `❌ ID "${id}" introuvable.`);
      return;
    }
    saveJSON(SUBS_FILE, subscriptions);
    bot.sendMessage(msg.chat.id, `🗑 Retiré: ${id}`);
  });

  bot.onText(/\/cout|\/cost/, msg => {
    if (!isAllowed(msg)) return;
    const d = today(), m = thisMonth();
    const todayCost = costTracker.daily[d] || 0;
    const monthCost = costTracker.monthly[m] || 0;
    const totalCost = costTracker.total || 0;
    const byModel = Object.entries(costTracker.byModel || {})
      .sort((a,b) => b[1] - a[1])
      .map(([k,v]) => `  ${k.replace('claude-','')}: $${v.toFixed(2)}`)
      .join('\n') || '  —';
    // Projection mensuelle basée sur jours écoulés
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate();
    const daysElapsed = new Date().getDate();
    const projection = daysElapsed > 0 ? (monthCost / daysElapsed * daysInMonth) : 0;
    // Cache stats — confirme efficacité prompt caching
    const cs = costTracker.cacheStats || {};
    const cacheRatio = cs.totalInput > 0 ? Math.round((cs.totalCacheRead / (cs.totalInput + cs.totalCacheRead)) * 100) : 0;
    const cacheLine = cs.hits ? `\n🚀 Cache: ${cs.hits} hits / ${cs.writes} writes · ${cacheRatio}% input depuis cache` : '';
    bot.sendMessage(msg.chat.id,
      `💰 *Coût Anthropic*\n\n` +
      `📅 Aujourd'hui: *$${todayCost.toFixed(4)}*\n` +
      `📆 Ce mois: *$${monthCost.toFixed(2)}*\n` +
      `📊 Projection mois: ~$${projection.toFixed(2)}\n` +
      `🏆 Total cumul: $${totalCost.toFixed(2)}\n\n` +
      `*Par modèle:*\n${byModel}${cacheLine}\n\n` +
      `Seuils d'alerte: $10/jour · $100/mois`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/baseline|\/cutoff|\/leadsreset/, async msg => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, '⏱ Baseline: tous les leads actuels → marqués comme déjà vus (pas de notifs) — seuls les nouveaux après MAINTENANT seront notifiés.');
    try {
      const token = await getGmailToken();
      if (!token) return bot.sendMessage(msg.chat.id, '❌ Gmail non configuré');
      const shawnEmail = AGENT.email.toLowerCase();
      const queries = [
        `newer_than:7d from:centris NOT from:${shawnEmail}`,
        `newer_than:7d from:remax NOT from:${shawnEmail}`,
        `newer_than:7d from:realtor NOT from:${shawnEmail}`,
        `newer_than:7d from:duproprio NOT from:${shawnEmail}`,
        `newer_than:7d subject:(demande OR "intéress" OR inquiry) NOT from:${shawnEmail}`,
      ];
      let marked = 0;
      const seen = new Set();
      for (const q of queries) {
        const list = await gmailAPI(`/messages?maxResults=50&q=${encodeURIComponent(q)}`).catch(() => null);
        if (!list?.messages?.length) continue;
        for (const m of list.messages) {
          if (seen.has(m.id) || gmailPollerState.processed.includes(m.id)) continue;
          seen.add(m.id);
          gmailPollerState.processed.push(m.id);
          marked++;
          // Extraire aussi email/tel/centris du message pour peupler recentLeadsByKey
          try {
            const full = await gmailAPI(`/messages/${m.id}?format=full`).catch(() => null);
            if (full) {
              const hdrs = full.payload?.headers || [];
              const get = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
              const from    = get('from');
              const subject = get('subject');
              const body    = gmailExtractBody(full.payload);
              if (!isJunkLeadEmail(subject, from, body)) {
                const source = detectLeadSource(from, subject);
                if (source) {
                  const lead = parseLeadEmail(body, subject, from);
                  // Baseline: marque dans dedup sans notifier (ancienne logique: mark-on-sight)
                  markLeadProcessed({
                    email: lead.email,
                    telephone: lead.telephone,
                    centris: lead.centris,
                    nom: lead.nom,
                    source: source.source,
                  });
                }
              }
            }
          } catch {}
        }
      }
      // Cutoff au moment présent — seuls emails futurs traités
      gmailPollerState.lastRun = new Date().toISOString();
      // FIFO max 500
      if (gmailPollerState.processed.length > 500) {
        gmailPollerState.processed = gmailPollerState.processed.slice(-500);
      }
      saveJSON(POLLER_FILE, gmailPollerState); schedulePollerSave();
      await bot.sendMessage(msg.chat.id,
        `✅ Baseline fait.\n\n` +
        `📧 ${marked} emails marqués comme déjà vus\n` +
        `🔒 ${recentLeadsByKey.size} leads dans dédup\n` +
        `⏱ Cutoff: ${new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}\n\n` +
        `À partir de maintenant, SEULS les nouveaux leads qui rentrent après cette minute seront notifiés sur Telegram.`
      );
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  bot.onText(/\/cleanemail/, async msg => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, '🧹 Nettoyage emails GitHub/CI/Dependabot (30 derniers jours)...');
    const res = await autoTrashGitHubNoise({ maxAge: '30d' });
    await bot.sendMessage(msg.chat.id, res.error
      ? `❌ ${res.error}`
      : `✅ ${res.trashed} emails mis à la corbeille.\n\nAuto-clean: boot + tous les jours à 6h.`);
  });

  // /retry-centris <#> → purge COMPLÈTE: dedup keys (centris+email+tel+nom) +
  // processed msgIds + retry counters, puis scan 48h. Pour récupérer un lead
  // dedup'd sous l'ancien flow. Ex: /retry-centris 26621771 → retraite Erika.
  bot.onText(/\/retry[-_]?centris\s+(\d{7,9})/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const centrisNum = match[1];
    await bot.sendMessage(msg.chat.id, `🔄 Purge dedup complète + scan pour Centris #${centrisNum}...`);

    // 1a. Purger clé centris directe
    let purgedKeys = 0;
    const centrisKey = 'c:' + centrisNum;
    if (recentLeadsByKey.has(centrisKey)) { recentLeadsByKey.delete(centrisKey); purgedKeys++; }

    // 2. Chercher Gmail msgIds qui mentionnent ce # → extraire email/tel/nom,
    //    purger AUSSI leurs clés dedup (sinon le lead reste bloqué par l'email)
    let purgedIds = 0;
    let extractedCount = 0;
    try {
      const list = await gmailAPI(`/messages?maxResults=20&q=${encodeURIComponent(centrisNum)}`).catch(() => null);
      const msgs = list?.messages || [];
      for (const m of msgs) {
        const idx = gmailPollerState.processed.indexOf(m.id);
        if (idx >= 0) { gmailPollerState.processed.splice(idx, 1); purgedIds++; }
        if (leadRetryState[m.id]) delete leadRetryState[m.id];

        // Extraire email/tel/nom pour purger leurs clés dedup respectives
        try {
          const full = await gmailAPI(`/messages/${m.id}?format=full`).catch(() => null);
          if (full) {
            const hdrs = full.payload?.headers || [];
            const get = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
            const from    = get('from');
            const subject = get('subject');
            const body    = gmailExtractBody(full.payload);
            const lead = parseLeadEmail(body, subject, from);
            const source = detectLeadSource(from, subject);
            if (source && lead) {
              const keys = buildLeadKeys({
                email: lead.email, telephone: lead.telephone,
                centris: lead.centris || centrisNum, nom: lead.nom, source: source.source,
              });
              for (const k of keys) {
                if (recentLeadsByKey.has(k)) { recentLeadsByKey.delete(k); purgedKeys++; }
              }
              extractedCount++;
            }
          }
        } catch {}
      }
      saveLeadRetryState();
      saveLeadsDedup();
      saveJSON(POLLER_FILE, gmailPollerState);
    } catch (e) {
      log('WARN', 'RETRY', `Gmail search: ${e.message}`);
    }

    await bot.sendMessage(msg.chat.id,
      `✅ Purge complète:\n` +
      `   • ${purgedKeys} clé(s) dedup (centris + email + tel + nom)\n` +
      `   • ${purgedIds} msgId(s) processed\n` +
      `   • ${extractedCount} email(s) analysé(s)\n` +
      `🚀 Scan 48h lancé — traitement complet au prochain cycle.`);
    runGmailLeadPoller({ forceSince: '48h' }).catch(e =>
      bot.sendMessage(msg.chat.id, `⚠️ Scan exception: ${e.message.substring(0, 200)}`).catch(() => {})
    );
  });

  // /retry-email <email> → même chose mais par email au lieu de Centris#
  bot.onText(/\/retry[-_]?email\s+(\S+@\S+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const email = match[1].trim().toLowerCase();
    await bot.sendMessage(msg.chat.id, `🔄 Purge dedup + scan pour ${email}...`);
    let purgedKeys = 0;
    const prefix = 'e:' + email;
    for (const k of [...recentLeadsByKey.keys()]) {
      if (k === prefix) { recentLeadsByKey.delete(k); purgedKeys++; }
    }
    saveLeadsDedup();
    let purgedIds = 0;
    try {
      const list = await gmailAPI(`/messages?maxResults=20&q=from:${encodeURIComponent(email)}`).catch(() => null);
      const msgs = list?.messages || [];
      for (const m of msgs) {
        const idx = gmailPollerState.processed.indexOf(m.id);
        if (idx >= 0) { gmailPollerState.processed.splice(idx, 1); purgedIds++; }
        if (leadRetryState[m.id]) delete leadRetryState[m.id];
      }
      saveLeadRetryState();
      saveJSON(POLLER_FILE, gmailPollerState);
    } catch {}
    await bot.sendMessage(msg.chat.id,
      `✅ Purgé: ${purgedKeys} clé(s) + ${purgedIds} msgId(s)\n🚀 Scan 48h lancé.`);
    runGmailLeadPoller({ forceSince: '48h' }).catch(() => {});
  });

  bot.onText(/\/forcelead\s+([a-zA-Z0-9_-]+)/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const msgId = match[1];
    await bot.sendMessage(msg.chat.id, `🎯 Force process email Gmail ${msgId}...`);
    // Retirer l'ID de processed[] pour forcer retraitement
    const idx = gmailPollerState.processed.indexOf(msgId);
    if (idx >= 0) gmailPollerState.processed.splice(idx, 1);
    await runGmailLeadPoller({ singleMsgId: msgId }).catch(e =>
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`)
    );
    const s = pollerStats.lastScan;
    await bot.sendMessage(msg.chat.id,
      s.autoSent > 0  ? `✅ Lead auto-envoyé (${s.autoSent})!` :
      s.dealCreated > 0 ? `✅ Deal Pipedrive créé (${s.dealCreated})` :
      s.pending > 0   ? `⏳ Lead en pending (${s.pending}) — check /pending` :
      s.processed > 0 ? `✅ Lead traité (${s.processed}) — décision: voir /lead-audit ${msgId}` :
      s.lowInfo > 0   ? `⚠️ Info insuffisante même après AI fallback` :
      s.junk > 0      ? `🗑 Filtré comme junk` :
      s.noSource > 0  ? `🔍 Pas reconnu comme lead (source inconnue)` :
      `❌ Aucun traitement — vérifie Gmail ID`
    );
  });

  // /lead-audit <email|centris|msgId> — trace complète du parcours d'un lead
  bot.onText(/\/lead[-_]?audit\s+(.+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const q = match[1].trim().toLowerCase();
    const events = (auditLog || []).filter(e => e.category === 'lead').reverse();
    const hits = events.filter(e => {
      const d = e.details || {};
      return d.msgId === q
        || (d.extracted?.email || '').toLowerCase() === q
        || (d.extracted?.centris || '') === q
        || (d.extracted?.email || '').toLowerCase().includes(q)
        || (d.extracted?.nom || '').toLowerCase().includes(q)
        || String(d.dealId || '') === q;
    }).slice(0, 3);
    if (!hits.length) {
      return bot.sendMessage(msg.chat.id,
        `❌ Aucun lead audit trouvé pour "${q}"\n\n` +
        `Essaie avec: email complet, # Centris (7-9 digits), Gmail messageId, dealId Pipedrive, ou partie du nom.\n` +
        `${events.length} lead(s) en audit total.`
      );
    }
    for (const ev of hits) {
      const d = ev.details || {};
      const ext = d.extracted || {};
      const m = d.match || {};
      const lines = [
        `🔍 *Audit lead* — ${new Date(ev.at).toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}`,
        `*Décision:* \`${d.decision}\``,
        ``,
        `*Source:* ${d.source || '?'}`,
        `*Sujet:* ${d.subject || '?'}`,
        `*From:* ${d.from || '?'}`,
        `*MsgId:* \`${d.msgId || '?'}\``,
        ``,
        `*📋 Infos extraites:*`,
        `  Nom: \`${ext.nom || '(vide)'}\``,
        `  Tél: \`${ext.telephone || '(vide)'}\``,
        `  Email: \`${ext.email || '(vide)'}\``,
        `  Centris: \`${ext.centris || '(vide)'}\``,
        `  Adresse: \`${ext.adresse || '(vide)'}\``,
        `  MinInfo: ${d.hasMinInfo ? '✅' : '❌'}`,
        ``,
        `*🏢 Pipedrive:*`,
        `  Deal créé: ${d.dealCreated ? `✅ #${d.dealId}` : '❌'}`,
        ``,
        `*📁 Match Dropbox:*`,
        `  Trouvé: ${m.found ? '✅' : '❌'}`,
        `  Score: ${m.score}/100 (seuil: ${d.threshold})`,
        `  Stratégie: \`${m.strategy}\``,
        `  Dossier: \`${m.folder || '(aucun)'}\``,
        `  Sources: ${(m.sources || []).join(', ') || '(aucune)'}`,
        `  Fichiers: ${m.pdfCount || 0}`,
      ];
      if (d.suspectName) lines.push(``, `⚠️ *Nom suspect détecté:* \`${d.suspectName}\` — bloqué par garde-fou`);
      if (d.deliveryMs) lines.push(``, `📮 *Livraison:* ${Math.round(d.deliveryMs/1000)}s · ${d.attempts || 1} tentative(s)`);
      if (d.error) lines.push(``, `❌ *Erreur:* \`${d.error}\``);
      if (d.skipReason) lines.push(``, `⏭ *Skip:* ${d.skipReason}`);

      await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(msg.chat.id, lines.join('\n').replace(/[*_`]/g, ''));
      });
    }
  });

  // /diag — vue santé système complète en un seul coup d'œil (fine pointe)
  bot.onText(/\/diag/i, async msg => {
    if (!isAllowed(msg)) return;
    try {
      const now = Date.now();
      const uptime = Math.floor(process.uptime());
      const mem = process.memoryUsage();
      const memMB = (n) => Math.round(n / 1024 / 1024);
      const pollerAgeMin = gmailPollerState?.lastRun ? Math.round((now - new Date(gmailPollerState.lastRun).getTime()) / 60000) : -1;
      const idxAgeMin = dropboxIndex?.builtAt ? Math.round((now - dropboxIndex.builtAt) / 60000) : -1;
      const autoEnvoiRecent = (autoEnvoiState?.log || []).slice(0, 10);
      const autoEnvoiOk = autoEnvoiRecent.filter(l => l.success).length;
      const autoEnvoiFail = autoEnvoiRecent.filter(l => !l.success).length;
      const circuitsOpen = Object.entries(circuits || {}).filter(([,c]) => c.openUntil > now).map(([n]) => n);
      const healthScore = typeof computeHealthScore === 'function' ? computeHealthScore() : null;

      // Status emoji par subsystem
      const st = (ok) => ok ? '✅' : '❌';
      const warn = (b) => b ? '⚠️' : '✅';

      const lines = [
        `🩺 *DIAGNOSTIC SYSTÈME*`,
        ``,
        `*Runtime:*`,
        `  ⏱ Uptime: ${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`,
        `  💾 RAM: ${memMB(mem.rss)}MB (heap ${memMB(mem.heapUsed)}/${memMB(mem.heapTotal)}MB)`,
        `  🧠 Modèle: \`${currentModel || 'claude-sonnet-4-6'}\``,
        ``,
        `*Subsystems:*`,
        `  ${st(!!PD_KEY)} Pipedrive`,
        `  ${st(!!BREVO_KEY)} Brevo`,
        `  ${st(!!process.env.GMAIL_CLIENT_ID)} Gmail API`,
        `  ${st(!!process.env.DROPBOX_REFRESH_TOKEN)} Dropbox`,
        `  ${st(!!process.env.GITHUB_TOKEN)} GitHub`,
        `  ${st(!!process.env.OPENAI_API_KEY)} Whisper (OPTIONAL)`,
        ``,
        `*Dropbox Index:*`,
        `  ${warn(idxAgeMin > 60 || idxAgeMin < 0)} Âge: ${idxAgeMin >= 0 ? idxAgeMin + 'min' : 'jamais'}`,
        `  📁 ${dropboxIndex?.totalFolders || 0} dossiers · 📄 ${dropboxIndex?.totalFiles || 0} fichiers`,
        `  🔢 ${Object.keys(dropboxIndex?.byCentris || {}).length} Centris# · 🛣 ${Object.keys(dropboxIndex?.byStreet || {}).length} rues`,
        ``,
        `*Gmail Poller:*`,
        `  ${warn(pollerAgeMin > 10 || pollerAgeMin < 0)} Dernière run: ${pollerAgeMin >= 0 ? pollerAgeMin + 'min ago' : 'jamais'}`,
        `  📧 Total leads traités: ${gmailPollerState?.totalLeads || 0}`,
        ``,
        `*Auto-envoi (10 derniers):*`,
        `  ✅ Succès: ${autoEnvoiOk} · ❌ Échecs: ${autoEnvoiFail}`,
        `  📊 Total all-time: ${autoEnvoiState?.totalAuto || 0} envoyés, ${autoEnvoiState?.totalFails || 0} échecs`,
        ``,
        `*Circuits:*`,
        circuitsOpen.length ? `  🔴 Ouverts: ${circuitsOpen.join(', ')}` : `  ✅ Tous fermés`,
        ``,
        `*Rate limits:*`,
        `  📥 Messages: ${metrics?.messages?.text || 0} text, ${metrics?.messages?.photo || 0} photo, ${metrics?.messages?.voice || 0} voice`,
        `  🔌 API calls: Claude=${metrics?.api?.claude || 0} Gmail=${metrics?.api?.gmail || 0} Dropbox=${metrics?.api?.dropbox || 0}`,
        `  ❌ Errors: ${metrics?.errors?.total || 0}`,
        ``,
        `*Pending:*`,
        `  📦 Doc sends: ${pendingDocSends?.size || 0}`,
        `  📧 Email drafts: ${pendingEmails?.size || 0}`,
        healthScore ? `\n*Health Score:* ${healthScore.score}/100 (${healthScore.status})` : '',
      ].filter(Boolean).join('\n');

      await bot.sendMessage(msg.chat.id, lines, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(msg.chat.id, lines.replace(/[*_`]/g, ''));
      });
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ Diag crashed: ${e.message}`);
    }
  });

  // /dropbox-reindex — force rebuild de l'index Dropbox complet (toutes inscriptions)
  bot.onText(/\/dropbox[-_]?reindex/i, async msg => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, '🔄 Rebuild index Dropbox complet (peut prendre 10-30s)...');
    try {
      const idx = await buildDropboxIndex();
      const ago = idx.builtAt ? `${Math.round((Date.now() - idx.builtAt) / 1000)}s` : 'maintenant';
      await bot.sendMessage(msg.chat.id,
        `✅ *Index Dropbox reconstruit*\n` +
        `   📁 ${idx.totalFolders} dossiers\n` +
        `   📄 ${idx.totalFiles} fichiers indexés\n` +
        `   🔢 ${Object.keys(idx.byCentris).length} Centris# indexés\n` +
        `   🛣 ${Object.keys(idx.byStreet).length} tokens de rue\n` +
        `   ⏱ construit il y a ${ago}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ Reindex échoué: ${e.message}`);
    }
  });

  // /dropbox-stats — vue rapide de l'état de l'index
  bot.onText(/\/dropbox[-_]?stats/i, async msg => {
    if (!isAllowed(msg)) return;
    const idx = dropboxIndex;
    if (!idx.folders?.length) {
      return bot.sendMessage(msg.chat.id, `⚠️ Index pas encore construit. Lance \`/dropbox-reindex\``, { parse_mode: 'Markdown' });
    }
    const ageMin = Math.round((Date.now() - idx.builtAt) / 60000);
    // Compte par source (chaque folder peut avoir plusieurs sources après merge)
    const bySource = {};
    for (const f of idx.folders) {
      for (const s of (f.sources || [f.source])) {
        bySource[s] = (bySource[s] || 0) + 1;
      }
    }
    const mergedFolders = idx.folders.filter(f => (f.sources?.length || 1) > 1).length;
    const withCentris = idx.folders.filter(f => f.centris).length;
    const withoutCentris = idx.folders.length - withCentris;
    const sourceLines = Object.entries(bySource).sort((a,b) => b[1]-a[1]).map(([s,c]) => `   • ${s} → ${c} dossiers`).join('\n');
    await bot.sendMessage(msg.chat.id,
      `📊 *Index Dropbox*\n` +
      `⏱ Dernier build: il y a ${ageMin} min\n` +
      `📁 Dossiers uniques: ${idx.totalFolders}${mergedFolders ? ` (🔀 ${mergedFolders} mergés cross-source)` : ''}\n` +
      `   ✅ avec Centris#: ${withCentris}\n` +
      `   ⚠️ sans Centris#: ${withoutCentris}\n` +
      `📄 Fichiers indexés: ${idx.totalFiles}\n` +
      `🗂 Sources scannées (${Object.keys(bySource).length}):\n${sourceLines}\n` +
      `🔢 ${Object.keys(idx.byCentris).length} Centris# indexés\n` +
      `🛣 ${Object.keys(idx.byStreet).length} tokens rue indexés`,
      { parse_mode: 'Markdown' }
    );
  });

  // /dropbox-find <requête> — cherche dans l'index par Centris#, adresse, rue
  // Ex: /dropbox-find 12582379  /dropbox-find chemin du lac  /dropbox-find 456 rue principale
  bot.onText(/\/dropbox[-_]?find\s+(.+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const q = match[1].trim();
    if (!dropboxIndex.folders?.length) {
      return bot.sendMessage(msg.chat.id, `⚠️ Index vide. Lance \`/dropbox-reindex\``, { parse_mode: 'Markdown' });
    }

    // Essaie Centris# si numérique, sinon adresse/rue
    const isNum = /^\d{7,9}$/.test(q);
    const result = fastDropboxMatch(
      isNum ? { centris: q, adresse: '', rue: '' } : { centris: '', adresse: q, rue: q }
    );

    if (!result) {
      // Fallback: top 5 matches fuzzy par tokens
      const tokens = q.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/\s+/).filter(t => t.length >= 3);
      const scored = dropboxIndex.folders.map(f => ({
        folder: f,
        score: tokens.filter(t => f.name.toLowerCase().includes(t) || f.adresse.toLowerCase().includes(t)).length
      })).filter(x => x.score > 0).sort((a,b) => b.score - a.score).slice(0, 5);
      if (!scored.length) return bot.sendMessage(msg.chat.id, `❌ Rien trouvé pour "${q}"`);
      const list = scored.map(s => `  • *${s.folder.adresse || s.folder.name}* (${s.folder.files.length} fichiers, Centris: ${s.folder.centris || '?'})`).join('\n');
      return bot.sendMessage(msg.chat.id, `🔍 *${scored.length} candidats pour "${q}":*\n${list}`, { parse_mode: 'Markdown' });
    }

    const f = result.folder;
    const fileList = f.files.slice(0, 15).map(x => `   📄 ${x.name}`).join('\n');
    const more = f.files.length > 15 ? `\n   …et ${f.files.length - 15} autres` : '';
    const sources = f.sources?.length ? f.sources.join(', ') : (f.source || '?');
    const mergedBadge = f.sources?.length > 1 ? ` 🔀 *MERGED ${f.sources.length} sources*` : '';
    const allPaths = f.allPaths?.length ? f.allPaths.map(p => `   \`${p}\``).join('\n') : `   \`${f.path}\``;
    await bot.sendMessage(msg.chat.id,
      `✅ *Match: ${f.adresse || f.name}*${mergedBadge}\n` +
      `Strategy: ${result.strategy} · Score: ${result.score}/100\n` +
      `Centris: ${f.centris || '(aucun)'}\n` +
      `Sources (${f.sources?.length || 1}): ${sources}\n` +
      `Chemins:\n${allPaths}\n` +
      `📦 ${f.files.length} fichier${f.files.length>1?'s':''} (mergés cross-source, dédup par nom):\n${fileList}${more}`,
      { parse_mode: 'Markdown' }
    );
  });

  // /parselead <messageId> — teste extraction sans créer deal. Montre regex + AI side-by-side
  bot.onText(/\/parselead\s+([a-zA-Z0-9_-]+)/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const msgId = match[1];
    try {
      await bot.sendMessage(msg.chat.id, `🔍 Parse diagnostic Gmail ${msgId}...`);
      const full = await gmailAPI(`/messages/${msgId}?format=full`);
      const hdrs = full.payload?.headers || [];
      const get  = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
      const from    = get('from');
      const subject = get('subject');
      const body    = gmailExtractBody(full.payload);
      const bodies  = gmailExtractAllBodies(full.payload);

      const source = detectLeadSource(from, subject);
      const junk = isJunkLeadEmail(subject, from, body);
      const rgx = parseLeadEmail(body, subject, from);
      const rgxCount = [rgx.nom, rgx.email, rgx.telephone, rgx.centris, rgx.adresse].filter(Boolean).length;

      let ai = null, aiCount = 0;
      if (API_KEY) {
        ai = await parseLeadEmailWithAI(body, subject, from, { nom:'', telephone:'', email:'', centris:'', adresse:'', type:'' }, {
          apiKey: API_KEY, logger: log, htmlBody: bodies.html,
        });
        aiCount = [ai.nom, ai.email, ai.telephone, ai.centris, ai.adresse].filter(Boolean).length;
      }

      const fmt = (o) => [
        `  • Nom: \`${o.nom || '(vide)'}\``,
        `  • Tél: \`${o.telephone || '(vide)'}\``,
        `  • Email: \`${o.email || '(vide)'}\``,
        `  • Centris: \`${o.centris || '(vide)'}\``,
        `  • Adresse: \`${o.adresse || '(vide)'}\``,
        `  • Type: \`${o.type || '(vide)'}\``,
      ].join('\n');

      const confLine = ai?.confidence
        ? `\n*Confidence AI:* nom=${ai.confidence.nom||0}% tel=${ai.confidence.telephone||0}% email=${ai.confidence.email||0}% centris=${ai.confidence.centris||0}% adresse=${ai.confidence.adresse||0}%`
        : '';

      const report = [
        `📧 *Parse diagnostic — ${msgId}*`,
        ``,
        `*De:* \`${from.substring(0, 80)}\``,
        `*Sujet:* \`${subject.substring(0, 80)}\``,
        `*Source:* ${source?.label || '(aucune)'} · *Junk:* ${junk ? 'oui' : 'non'}`,
        `*Body:* plain=${bodies.plain.length}c, html=${bodies.html.length}c`,
        ``,
        `🔹 *REGEX (${rgxCount}/5 infos)*`,
        fmt(rgx),
        ``,
        API_KEY ? `🔸 *AI Sonnet 4.6 tool-use (${aiCount}/5 infos)*` : `🔸 *AI désactivé (ANTHROPIC_API_KEY absent)*`,
        ai ? fmt(ai) : '',
        confLine,
        ai?.message ? `\n*Message client:* _${ai.message.substring(0, 200)}_` : '',
      ].filter(Boolean).join('\n');

      await bot.sendMessage(msg.chat.id, report, { parse_mode: 'Markdown' }).catch(e => {
        // Fallback sans markdown si entities cassent
        bot.sendMessage(msg.chat.id, report.replace(/[*_`]/g, '')).catch(() => {});
      });
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ Parse diagnostic échoué: ${e.message}`);
    }
  });

  bot.onText(/\/poller|\/leadstats/, msg => {
    if (!isAllowed(msg)) return;
    const last    = gmailPollerState.lastRun ? new Date(gmailPollerState.lastRun).toLocaleTimeString('fr-CA', { timeZone: 'America/Toronto' }) : 'jamais';
    const gmailOk = !!(process.env.GMAIL_CLIENT_ID);
    const s = pollerStats.lastScan;
    const t = pollerStats;
    bot.sendMessage(msg.chat.id,
      `📧 *Gmail Lead Poller*\n` +
      `Statut: ${gmailOk ? '✅ Actif' : '❌ Gmail non configuré'}\n` +
      `Dernier scan: ${last} (${pollerStats.lastDuration}ms)\n` +
      `Runs: ${pollerStats.runs}\n\n` +
      `*Dernier scan:*\n` +
      `📬 Trouvés: ${s.found} · 🗑 Junk: ${s.junk}\n` +
      `🔍 Pas source: ${s.noSource} · ⚠️ Low info: ${s.lowInfo}\n` +
      `✅ Traités: ${s.processed || 0} · 🚀 Auto-sent: ${s.autoSent || 0} · ⏳ Pending: ${s.pending || 0}\n` +
      `📋 Deals Pipedrive: ${s.dealCreated} · ♻️ Dedup: ${s.dedup || 0} · ❌ Erreurs: ${s.errors}\n\n` +
      `*Cumulatif:*\n` +
      `Total leads: ${gmailPollerState.totalLeads || 0}\n` +
      `Total found: ${t.totalsFound} · Junk: ${t.totalsJunk}\n` +
      `Traités: ${t.totalsProcessed || 0} · Auto-sent: ${t.totalsAutoSent || 0} · Pending: ${t.totalsPending || 0}\n` +
      `Deals Pipedrive: ${t.totalsDealCreated} · Low info: ${t.totalsLowInfo}\n` +
      `IDs mémorisés: ${gmailPollerState.processed?.length || 0}\n` +
      (pollerStats.lastError ? `\n⚠️ Dernière erreur: ${pollerStats.lastError.substring(0, 100)}` : '') +
      `\n\nCommandes:\n/checkemail — scan 48h\n/forcelead <id> — force retraitement\n/retry-centris <#> — reprendre lead dedup'd\n/retry-email <email> — reprendre par email`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/autoenvoi/, msg => {
    if (!isAllowed(msg)) return;
    const total   = autoEnvoiState.totalAuto || 0;
    const fails   = autoEnvoiState.totalFails || 0;
    const rate    = (total + fails) > 0 ? Math.round(100 * total / (total + fails)) : 0;
    const recent  = (autoEnvoiState.log || []).slice(0, 5);
    const avgMs   = recent.filter(l => l.success).reduce((s, l, _, a) => s + (l.deliveryMs || 0) / (a.length || 1), 0);
    let txt = `🚀 *Auto-envoi docs*\n\n`;
    txt += `Succès: ${total} · Échecs: ${fails} · Taux: ${rate}%\n`;
    txt += `Temps moyen: ${Math.round(avgMs / 1000)}s\n\n`;
    txt += `*5 derniers:*\n`;
    if (!recent.length) txt += '_(aucun auto-envoi encore)_';
    else txt += recent.map(l => {
      const when = new Date(l.timestamp).toLocaleString('fr-CA', { timeZone:'America/Toronto', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
      return l.success
        ? `✅ ${when} — ${l.email} · ${l.pdfsCount}PDFs · ${l.strategy}(${l.score}) · ${Math.round(l.deliveryMs/1000)}s`
        : `❌ ${when} — ${l.email} · ${String(l.error).substring(0, 60)}`;
    }).join('\n');
    bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/pipeline/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const result = await getPipeline();
    clearInterval(typing);
    await send(msg.chat.id, result);
  });

  bot.onText(/\/stats/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const result = await statsBusiness();
    clearInterval(typing);
    await send(msg.chat.id, result);
  });

  bot.onText(/\/emails/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const result = await voirEmailsRecents('1d');
    clearInterval(typing);
    await send(msg.chat.id, result);
  });

  bot.onText(/\/memoire/, msg => {
    if (!isAllowed(msg)) return;
    if (!kiramem.facts.length) return bot.sendMessage(msg.chat.id, '🧠 Aucun fait mémorisé pour l\'instant.');
    const list = kiramem.facts.map((f, i) => `${i+1}. ${f}`).join('\n');
    bot.sendMessage(msg.chat.id, `🧠 *Mémoire persistante:*\n\n${list}`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/oublier/, msg => {
    if (!isAllowed(msg)) return;
    kiramem.facts = [];
    kiramem.updatedAt = new Date().toISOString();
    saveJSON(MEM_FILE, kiramem);
    saveMemoryToGist().catch(() => {});
    bot.sendMessage(msg.chat.id, '🗑️ Mémoire effacée (local + Gist).');
  });

  bot.onText(/\/opus/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-opus-4-8';
    bot.sendMessage(msg.chat.id, '🚀 Mode Opus 4.8 activé — le plus puissant (défaut).');
  });

  bot.onText(/\/fable/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-fable-5';
    bot.sendMessage(msg.chat.id, '🔮 *Mode Fable 5 activé* — Mythos-class top-tier\n\n⚠️ Coût: $10/$50 par MTok (2× plus cher qu\'Opus 4.8)\nÀ utiliser pour analyse ultime / stratégie majeure / reasoning complexe\n\nRevenir au défaut: /sonnet', { parse_mode: 'Markdown' });
  });

  bot.onText(/\/sonnet/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-sonnet-4-6';
    bot.sendMessage(msg.chat.id, '🧠 Mode Sonnet activé — rapide et fort.');
  });

  bot.onText(/\/haiku/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-haiku-4-5';
    bot.sendMessage(msg.chat.id, '⚡ Mode Haiku activé — ultra-rapide et léger.');
  });

  bot.onText(/\/penser/, msg => {
    if (!isAllowed(msg)) return;
    thinkingMode = !thinkingMode;
    bot.sendMessage(msg.chat.id, thinkingMode
      ? '🧠 *Mode réflexion ON* — Opus 4.8 pense en profondeur avant chaque réponse.\nIdéal: stratégie de prix, analyse marché complexe, négociation.\nPlus lent mais beaucoup plus précis.'
      : '⚡ *Mode réflexion OFF* — Réponses rapides.',
      { parse_mode: 'Markdown' }
    );
  });

  // ─── Commandes rapides mobile ────────────────────────────────────────────────
  bot.onText(/\/stagnants/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const result = await prospectStagnants(3);
    clearInterval(typing);
    await send(msg.chat.id, result);
  });

  // /relances — sur glace (J+1/J+3/J+7 désactivé temporairement)

  bot.onText(/\/lead (.+)/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const info = match[1];
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const { reply } = await callClaude(msg.chat.id, `Nouveau prospect: ${info}. Crée le deal dans Pipedrive immédiatement.`);
    clearInterval(typing);
    await send(msg.chat.id, reply);
  });

  // ─── /configure_openai — flow self-service login + auto-detect clé
  // Tap = ouvre OpenAI dans Telegram inline browser. Shawn login + crée
  // la clé + paste dans Telegram. Le bot auto-détecte sk-* et l'installe.
  bot.onText(/\/configure[_-]?openai/, msg => {
    if (!isAllowed(msg)) return;
    const text =
      `🔑 *Configuration OpenAI — flow auto-détection*\n\n` +
      `**Étape 1**: Tape le lien ci-dessous (s'ouvre dans ton navigateur):\n` +
      `https://platform.openai.com/api-keys\n\n` +
      `**Étape 2**: Login (Google le + rapide), puis click "Create new secret key" → nom: \`Kira Bot\` → Create.\n\n` +
      `**Étape 3**: Copie la valeur (sk-proj-...) et colle-la simplement dans CE chat.\n\n` +
      `Le bot détecte automatiquement les valeurs commençant par \`sk-\` et les installe via /setsecret. ` +
      `Pas besoin de taper la commande /setsecret toi-même.\n\n` +
      `🛡 Auto-test contre l'API OpenAI avant save.\n` +
      `🔒 Ton message est auto-supprimé après save (la clé reste pas visible dans le chat).`;
    bot.sendMessage(msg.chat.id, text, {
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [[
          { text: '🔗 Ouvrir OpenAI API Keys', url: 'https://platform.openai.com/api-keys' }
        ]],
      },
    });
  });

  // ─── /keys — récap clés API (status visible, sans value)
  bot.onText(/\/keys|\/cles/, msg => {
    if (!isAllowed(msg)) return;
    const services = {
      'Anthropic (Claude)':       !!process.env.ANTHROPIC_API_KEY,
      'OpenAI (Whisper)':          !!process.env.OPENAI_API_KEY,
      'Pipedrive (CRM)':          !!process.env.PIPEDRIVE_API_KEY,
      'Brevo (mailing)':          !!process.env.BREVO_API_KEY,
      'Telegram Bot':             !!process.env.TELEGRAM_BOT_TOKEN,
      'Gmail (read+send)':        !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN),
      'Dropbox':                   !!process.env.DROPBOX_REFRESH_TOKEN,
      'Centris (courtier)':       !!(process.env.CENTRIS_USER && process.env.CENTRIS_PASS),
      'Firecrawl (scraping)':     !!process.env.FIRECRAWL_API_KEY,
      'Perplexity (recherche)':   !!process.env.PERPLEXITY_API_KEY,
      'GitHub (write status)':    !!process.env.GITHUB_TOKEN,
      'Render API (env push)':    !!process.env.RENDER_API_KEY,
    };
    const lines = ['🔑 *Clés API — Status*', ''];
    const critical = ['Anthropic (Claude)', 'Telegram Bot', 'Pipedrive (CRM)'];
    const optional = ['Render API (env push)', 'GitHub (write status)'];
    for (const [name, ok] of Object.entries(services)) {
      const icon = ok ? '✅' : (critical.includes(name) ? '🔴' : (optional.includes(name) ? '⚪' : '⚠️'));
      const note = !ok && critical.includes(name) ? ' *(CRITIQUE)*' : '';
      lines.push(`${icon} ${name}${note}`);
    }
    const missing = Object.entries(services).filter(([,ok]) => !ok).map(([n]) => n);
    if (missing.length) {
      lines.push('');
      lines.push(`_${missing.length} clé(s) manquante(s) — pour ajouter:_`);
      lines.push('`/setsecret KEY_NAME valeur` (persiste via Dropbox)');
    } else {
      lines.push('\n✨ Toutes les clés configurées.');
    }
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // ─── /health — health check live + détails ──────────────────────────────
  bot.onText(/\/health/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    try {
      const r = await testApisHealth();
      clearInterval(typing);
      const lines = [`🩺 *Health Check — ${r.allOk ? '✅ Tout vert' : '❌ Dégradation'}*`, ''];
      for (const [k, c] of Object.entries(r.results)) {
        lines.push(`${c.ok ? '✅' : '❌'} *${k}*: ${c.ok ? 'OK' : (c.error || `HTTP ${c.status}`)}`);
      }
      if (r.failures.length) lines.push('', '⚠️ ' + r.failures.join(' · '));
      await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e) {
      clearInterval(typing);
      await bot.sendMessage(msg.chat.id, `❌ Health check err: ${e.message}`);
    }
  });

  // ─── /audit — derniers 15 events audit log ──────────────────────────────
  bot.onText(/\/audit(?:\s+(\S+))?/, (msg, match) => {
    if (!isAllowed(msg)) return;
    const cat = match[1];
    const filtered = cat ? auditLog.filter(e => e.category === cat) : auditLog;
    const recent = filtered.slice(-15).reverse();
    if (!recent.length) { bot.sendMessage(msg.chat.id, `📋 Audit log vide${cat ? ` pour catégorie "${cat}"` : ''}.`); return; }
    const lines = [`📋 *Audit log — ${recent.length} derniers ${cat ? `(catégorie ${cat})` : ''}*`, ''];
    for (const e of recent) {
      const t = new Date(e.at).toLocaleString('fr-CA', { timeZone: 'America/Toronto', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      lines.push(`\`${t}\` _${e.category}_ · ${e.event}`);
    }
    bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  });

  // ─── /safetycheck — déclenche manuellement le safety check campagnes ────
  bot.onText(/\/safety[_-]?check/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    try {
      await safetyCheckCampagnes();
      clearInterval(typing);
      const approved = Object.keys(campaignApprovals.approved || {}).length;
      bot.sendMessage(msg.chat.id, `🛡️ Safety check exécuté.\n${approved} campagne(s) dans le registre d'approbation.\n\n_Si campagnes non-approuvées détectées, alerte Telegram séparée envoyée._`);
    } catch (e) {
      clearInterval(typing);
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  // ─── /cancelcampagne <id> — annule une campagne Brevo ───────────────────
  bot.onText(/\/cancel[_-]?campagne\s+(\d+)/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const id = match[1];
    try {
      const r = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}/status`, {
        method: 'PUT',
        headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'suspended' }),
      });
      if (r.ok || r.status === 204) {
        auditLogEvent('campaign', 'cancelled-via-telegram', { id });
        bot.sendMessage(msg.chat.id, `🚫 Campagne #${id} suspended.`);
      } else { bot.sendMessage(msg.chat.id, `❌ Brevo HTTP ${r.status}`); }
    } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /preview <id> — envoie preview campagne à shawn@ (dédup 1/jour) ────
  bot.onText(/\/preview(?:_force)?\s+(\d+)/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const id = match[1];
    const force = /preview_force/.test(msg.text);
    try {
      const url = `https://signaturesb-bot-s272.onrender.com/admin/brevo-send-preview?id=${id}${force ? '&force=1' : ''}`;
      const r = await fetch(url);
      const data = await r.json();
      if (data.dedup_skipped) {
        bot.sendMessage(msg.chat.id, `⏭️ Preview #${id} déjà envoyé aujourd'hui.\n_${data.note}_\n\nUtilise /preview_force ${id} pour forcer.`, { parse_mode: 'Markdown' });
      } else if (data.sent) {
        bot.sendMessage(msg.chat.id, `📧 Preview campagne *${data.campaign?.name || id}* envoyé à ${data.to}\nSubject: _${data.campaign?.subject || ''}_`, { parse_mode: 'Markdown' });
      } else {
        bot.sendMessage(msg.chat.id, `❌ Brevo: ${data.error || 'unknown'}`);
      }
    } catch (e) { bot.sendMessage(msg.chat.id, `❌ ${e.message}`); }
  });

  // ─── /dashboard — URL signée vers /admin/dashboard ──────────────────────
  bot.onText(/\/dashboard/, msg => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(msg.chat.id, `📊 *Dashboard admin*\n\nhttps://signaturesb-bot-s272.onrender.com/admin/dashboard\n\n_Tout en un coup d'œil: health, coûts, campagnes, audit, abonnements._`, { parse_mode: 'Markdown', disable_web_page_preview: true });
  });

  // ─── /dernier_appel — re-affiche le dernier résumé d'appel + lien Pipedrive
  bot.onText(/\/dernier[_-]?appel/, async msg => {
    if (!isAllowed(msg)) return;
    const recents = (auditLog || []).filter(e => e.category === 'appel').slice(-1);
    if (!recents.length) {
      await bot.sendMessage(msg.chat.id, '📞 Aucun résumé d\'appel enregistré encore.');
      return;
    }
    const last = recents[0];
    const d = last.details || {};
    const when = new Date(last.timestamp).toLocaleString('fr-CA', { timeZone: 'America/Toronto', day:'numeric', month:'long', hour:'2-digit', minute:'2-digit' });
    const dealUrl = d.deal_id ? `https://signaturesb.pipedrive.com/deal/${d.deal_id}` : null;
    const lines = [
      `📞 *Dernier résumé d'appel — ${when}*`,
      '',
      `${last.event}`,
      `🌡️ Engagement: ${(d.engagement || '—').toUpperCase()}`,
      d.is_new ? '✨ Nouveau deal créé' : '♻️ Deal existant enrichi',
      d.noteOk ? '✅ Note Pipedrive OK' : '⚠️ Note: échec',
      '⏭️ Pas d\'activité auto (suivi auto désactivé — règle Shawn 2026-05-05)',
      d.analyseErr ? `\n⚠️ Haiku partiel: ${d.analyseErr.substring(0, 80)}` : '',
      dealUrl ? `\n🔗 ${dealUrl}` : '',
    ].filter(Boolean);
    await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown', disable_web_page_preview: true });
  });

  // ─── /test_appel <texte> — preview analyse Haiku SANS écrire dans Pipedrive
  bot.onText(/\/test[_-]?appel\s+([\s\S]+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const transcription = match[1].trim();
    if (transcription.length < 20) {
      await bot.sendMessage(msg.chat.id, '❌ Texte trop court (min 20 chars).');
      return;
    }
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    try {
      const json = await analyserAppelHaiku(transcription);
      const matched = json.nom_complet || json.telephone || json.centris_number || json.prenom
        ? await _matcherProspectFuzzy(json) : null;
      const lines = [
        `🧪 *TEST analyse Haiku (DRY-RUN)*`,
        `_Aucune écriture Pipedrive — preview seulement._\n`,
        `👤 Nom: ${json.nom_complet || '—'}`,
        `📱 Tel: ${json.telephone || '—'}`,
        `📧 Email: ${json.email || '—'}`,
        `🔢 Centris: ${json.centris_number || '—'}`,
        `🏠 Type: ${json.type_propriete || '—'}`,
        `💰 Budget: ${json.budget ? Number(json.budget).toLocaleString('fr-CA') + ' $' : '—'}`,
        `🌡️ Engagement: ${(json.engagement_client || '—').toUpperCase()}`,
        `🎯 ${json.objectif_appel || '—'}`,
        '',
        `🔑 Points clés:`,
        ...(json.points_cles || []).map(p => `• ${p}`),
        json.objections?.length ? `\n⚠️ Objections:\n${json.objections.map(o => `• ${o}`).join('\n')}` : '',
        `\n➡️ Prochaine étape: ${json.prochaine_etape || '—'}`,
        json.suivi_date ? `📅 Suivi suggéré: ${json.suivi_date}${json.suivi_heure ? ' ' + json.suivi_heure : ''}` : '',
        json.alerte ? `\n🚨 ${json.alerte}` : '',
        '',
        matched?.deal ? `✅ *Match Pipedrive:* ${matched.deal.title} (#${matched.deal.id})${matched.ambiguous ? ` — ⚠️ ${matched.ambiguous} matchs` : ''}` : '⚠️ *Aucun match Pipedrive* — créerait un nouveau deal en mode auto',
      ].filter(Boolean);
      clearInterval(typing);
      await bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e) {
      clearInterval(typing);
      await bot.sendMessage(msg.chat.id, `❌ Test échec: ${e.message}`);
    }
  });

  // ─── Messages texte ──────────────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    const text   = msg.text;
    if (!text || text.startsWith('/')) return;
    if (isDuplicate(msg.message_id)) return;

    log('IN', 'MSG', text.substring(0, 80));

    // ─── AUTO-DÉTECTION CLÉS API (sk-, fc-, pplx-, rnd_) ──────────────────
    // Si Shawn paste une clé API valide, auto-install via setsecret pattern.
    // Permet de configurer sans taper /setsecret manuellement.
    const keyPatterns = [
      { regex: /\b(sk-proj-[A-Za-z0-9_-]{30,})\b/, env: 'OPENAI_API_KEY', test_url: 'https://api.openai.com/v1/models', service: 'OpenAI Whisper' },
      { regex: /\b(sk-[A-Za-z0-9_-]{40,})\b/,       env: 'OPENAI_API_KEY', test_url: 'https://api.openai.com/v1/models', service: 'OpenAI Whisper' },
      { regex: /\b(sk-ant-[A-Za-z0-9_-]{40,})\b/,   env: 'ANTHROPIC_API_KEY', service: 'Anthropic Claude' },
      { regex: /\b(fc-[a-f0-9]{30,})\b/,            env: 'FIRECRAWL_API_KEY', test_url: 'https://api.firecrawl.dev/v1/scrape', service: 'Firecrawl' },
      { regex: /\b(pplx-[a-zA-Z0-9]{30,})\b/,       env: 'PERPLEXITY_API_KEY', service: 'Perplexity' },
      { regex: /\b(rnd_[A-Za-z0-9]{20,})\b/,        env: 'RENDER_API_KEY', service: 'Render' },
    ];
    for (const p of keyPatterns) {
      const m = text.match(p.regex);
      if (!m) continue;
      const value = m[1];
      try {
        // Auto-supprimer le message original (sécurité)
        bot.deleteMessage(chatId, msg.message_id).catch(() => {});
        bot.sendMessage(chatId, `🔑 Clé ${p.service} détectée — installation...`).catch(() => {});
        // Test optionnel
        if (p.test_url) {
          const tr = await fetch(p.test_url, {
            headers: { 'Authorization': `Bearer ${value}` },
            signal: AbortSignal.timeout(10000),
          }).catch(() => null);
          if (!tr || !tr.ok) {
            await bot.sendMessage(chatId, `❌ Test API ${p.service} échoué (HTTP ${tr?.status || '?'}). Clé invalide ou expirée — pas installée.`);
            continue;
          }
        }
        const ok = await uploadDropboxSecret(p.env, value);
        if (ok) {
          process.env[p.env] = value;
          auditLogEvent('secret', 'auto-detected', { env: p.env, service: p.service });
          await bot.sendMessage(chatId, `✅ *${p.service}* configuré avec succès\n\nEnv: \`${p.env}\`\nPersisté: Dropbox /bot-secrets/\nActif: live (sans redeploy)`, { parse_mode: 'Markdown' });
          // Run health check pour confirmer
          setTimeout(() => testApisHealth().catch(() => {}), 500);
        } else {
          await bot.sendMessage(chatId, `⚠️ Clé valide mais Dropbox upload fail. Réessaie ou tape \`/setsecret ${p.env} ${value.substring(0,6)}...\``);
        }
      } catch (e) { await bot.sendMessage(chatId, `❌ ${e.message}`); }
      return; // Sort du handler après auto-install
    }

    // Vérifier si c'est une confirmation d'envoi d'email
    if (await handleEmailConfirmation(chatId, text)) return;

    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    try {
      const { reply, memos } = await callClaude(chatId, text);
      clearInterval(typing);
      await send(chatId, reply);
      if (memos.length) {
        await bot.sendMessage(chatId, `📝 *Mémorisé:* ${memos.join(' | ')}`, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      clearInterval(typing);
      log('ERR', 'MSG', `${err.status || '?'}: ${err.message?.substring(0,150)}`);
      await bot.sendMessage(chatId, formatAPIError(err));
    }
  });

  // ─── Messages vocaux (Whisper) ────────────────────────────────────────────────
  bot.on('voice', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    if (isDuplicate(msg.message_id)) return;

    if (!process.env.OPENAI_API_KEY) {
      // Dégradation gracieuse: sauve le vocal dans Dropbox /Audio/<timestamp>.ogg
      // pour que Shawn ne perde pas l'info même sans Whisper
      try {
        const fileInfo = await bot.getFile(msg.voice.file_id);
        const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
        const r = await fetch(fileUrl);
        const buffer = Buffer.from(await r.arrayBuffer());
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const dbxPath = `/Audio/voicememo_${ts}.ogg`;
        const up = await fetch('https://content.dropboxapi.com/2/files/upload', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${dropboxToken}`,
            'Dropbox-API-Arg': JSON.stringify({ path: dbxPath, mode: 'add', autorename: true, mute: true }),
            'Content-Type': 'application/octet-stream',
          },
          body: buffer,
        });
        const saved = up.ok;
        await bot.sendMessage(chatId, `🎙 Vocal reçu (${msg.voice.duration}s) — Whisper KO\n\n${saved ? `✅ Audio sauvé Dropbox: \`${dbxPath}\`` : '❌ Backup Dropbox aussi échoué'}\n\n*Pour activer transcription auto:*\nVa sur https://platform.openai.com/api-keys → crée une clé → tape \`/setsecret OPENAI_API_KEY sk-proj-...\`\n_~$1/mois pour 30 appels × 5min._`, { parse_mode: 'Markdown', disable_web_page_preview: true });
      } catch (e) { await bot.sendMessage(chatId, `⚠️ Whisper KO + sauvegarde échoué: ${e.message.substring(0,100)}`); }
      return;
    }

    log('IN', 'VOICE', `${msg.voice.duration}s`);
    mTick('messages', 'voice');
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const fileInfo = await bot.getFile(msg.voice.file_id);
      const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      const res      = await fetch(fileUrl);
      const buffer   = Buffer.from(await res.arrayBuffer());

      // Contexte récent: noms prospects récents + Centris# actifs
      // Whisper utilise ça comme "biais" pour mieux reconnaître ces mots
      const recentNames = (auditLog || [])
        .filter(e => e.category === 'lead' && e.details?.extracted)
        .slice(-10)
        .flatMap(e => [e.details.extracted.nom, e.details.extracted.centris ? `#${e.details.extracted.centris}` : null])
        .filter(Boolean)
        .join(', ');
      const recentContext = recentNames || '';

      const texte = await transcrire(buffer, { recentContext });

      // Track Whisper cost ($0.006/min)
      if (msg.voice?.duration) trackWhisperCost(msg.voice.duration);

      if (!texte) { await bot.sendMessage(chatId, '❌ Impossible de transcrire ce message vocal.'); return; }

      log('OK', 'VOICE', `Transcrit: "${texte.substring(0, 60)}"`);
      await bot.sendMessage(chatId, `🎤 _${texte}_`, { parse_mode: 'Markdown' });

      const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
      try {
        const { reply, memos } = await callClaude(chatId, texte);
        clearInterval(typing);
        await send(chatId, reply);
        if (memos.length) await bot.sendMessage(chatId, `📝 *Mémorisé:* ${memos.join(' | ')}`, { parse_mode: 'Markdown' });
      } catch (err) {
        clearInterval(typing);
        log('ERR', 'VOICE-MSG', `${err.status||'?'}: ${err.message?.substring(0,120)}`);
        await bot.sendMessage(chatId, formatAPIError(err));
      }
    } catch (err) {
      log('ERR', 'VOICE', err.message);
      await bot.sendMessage(chatId, `❌ Erreur vocal: ${err.message.substring(0, 120)}`);
    }
  });

  // ─── Photos (vision Opus 4.8) ────────────────────────────────────────────────
  bot.on('photo', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    if (isDuplicate(msg.message_id)) return;

    const photo   = msg.photo[msg.photo.length - 1]; // Résolution max
    const caption = msg.caption || 'Analyse cette photo en contexte immobilier québécois. Qu\'est-ce que tu vois? Qu\'est-ce que je dois savoir?';

    log('IN', 'PHOTO', `${photo.width}x${photo.height} — "${caption.substring(0, 60)}"`);
    mTick('messages', 'photo');
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const dlController = new AbortController();
      const dlTimeout    = setTimeout(() => dlController.abort(), 20000);
      let fileInfo, buffer;
      try {
        fileInfo = await bot.getFile(photo.file_id);
        if (!fileInfo.file_path) throw new Error('Telegram: file_path manquant');
        const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
        const fetchRes = await fetch(fileUrl, { signal: dlController.signal });
        buffer = Buffer.from(await fetchRes.arrayBuffer());
      } finally { clearTimeout(dlTimeout); }

      if (buffer.length === 0) throw new Error('Fichier vide reçu de Telegram');
      if (buffer.length > 5 * 1024 * 1024) {
        clearInterval(typing);
        await bot.sendMessage(chatId, '⚠️ Image trop grosse (max 5MB). Compresse et réessaie.');
        return;
      }

      const base64    = buffer.toString('base64');
      const mediaType = fileInfo.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const content   = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: caption }
      ];
      const contextLabel = `[PHOTO envoyée: ${photo.width}x${photo.height}] "${caption.substring(0, 80)}"`;

      const { reply, memos } = await callClaudeVision(chatId, content, contextLabel);
      clearInterval(typing);
      await send(chatId, reply);
      if (memos.length) await bot.sendMessage(chatId, `📝 *Mémorisé:* ${memos.join(' | ')}`, { parse_mode: 'Markdown' });

    } catch (err) {
      clearInterval(typing);
      log('ERR', 'PHOTO', `${err.status||'?'}: ${err.message?.substring(0,150)}`);
      await bot.sendMessage(chatId, `❌ Analyse photo: ${formatAPIError(err)}`);
    }
  });

  // ─── Documents PDF (analyse contrats, rapports, évaluations) ─────────────────
  bot.on('document', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    if (isDuplicate(msg.message_id)) return;

    const doc     = msg.document;
    const caption = msg.caption || 'Analyse ce document. Extrais les informations clés et dis-moi ce que je dois savoir.';

    if (doc.mime_type !== 'application/pdf') {
      await bot.sendMessage(chatId, `⚠️ Format non supporté: \`${doc.mime_type || 'inconnu'}\`. Envoie un PDF.`, { parse_mode: 'Markdown' });
      return;
    }
    if (doc.file_size > 10 * 1024 * 1024) {
      await bot.sendMessage(chatId, '⚠️ PDF trop gros (max 10MB).');
      return;
    }

    log('IN', 'PDF', `${doc.file_name} — ${Math.round(doc.file_size / 1024)}KB`);
    mTick('messages', 'pdf');
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const dlController = new AbortController();
      const dlTimeout    = setTimeout(() => dlController.abort(), 25000);
      let fileInfo, buffer;
      try {
        fileInfo = await bot.getFile(doc.file_id);
        if (!fileInfo.file_path) throw new Error('Telegram: file_path manquant');
        const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
        const fetchRes = await fetch(fileUrl, { signal: dlController.signal });
        buffer = Buffer.from(await fetchRes.arrayBuffer());
      } finally { clearTimeout(dlTimeout); }
      if (buffer.length === 0) throw new Error('Fichier PDF vide reçu de Telegram');
      const base64   = buffer.toString('base64');
      const content  = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: caption }
      ];
      const contextLabel = `[PDF: ${doc.file_name}] "${caption.substring(0, 80)}"`;

      const { reply, memos } = await callClaudeVision(chatId, content, contextLabel);
      clearInterval(typing);
      await send(chatId, reply);
      if (memos.length) await bot.sendMessage(chatId, `📝 *Mémorisé:* ${memos.join(' | ')}`, { parse_mode: 'Markdown' });

    } catch (err) {
      clearInterval(typing);
      log('ERR', 'PDF', `${err.status||'?'}: ${err.message?.substring(0,150)}`);
      await bot.sendMessage(chatId, `❌ Analyse PDF: ${formatAPIError(err)}`);
    }
  });

  // Mode webhook — pas de polling errors à gérer (bot.processUpdate reçoit les messages)
  bot.on('webhook_error', err => log('WARN', 'TG', `Webhook: ${err.message}`));
}

// ─── Tâches quotidiennes (sans node-cron) ─────────────────────────────────────
const lastCron = {
  digest: null, suivi: null, visites: null, sync: null, trashCI: null,
  // Pipedrive proactive (anti-perte-de-lead)
  stagnant: null, morningProactive: null, j1NotCalled: null, hygiene: null, weeklyDigest: null,
  // Veille J-1 backup + dedup hebdo activités + audit ultra quotidien
  veilleCampaign: null, dedupHebdo: null, auditUltra: null
};

// Module proactive — 5 features anti-perte-de-lead, lazy require pour startup rapide
let _proactive = null;
function getProactive() {
  if (_proactive) return _proactive;
  try {
    _proactive = require('./pipedrive_proactive');
    _proactive.init({
      pdGet,
      sendTG: (msg, opts) => sendTelegramWithFallback(msg, { ...opts, category: 'pipedrive-proactive' }),
      AGENT,
      log
    });
    log('OK', 'PROACTIVE', 'Module pipedrive_proactive chargé');
    return _proactive;
  } catch (e) {
    log('ERR', 'PROACTIVE', `Load failed: ${e.message}`);
    return null;
  }
}

// ─── Détection doublons DEALS (mêmes person_id, plusieurs open) ─────────
async function detecterDoublonsDeals() {
  if (!PD_KEY) return [];
  const r = await pdGet(`/deals?status=open&limit=500`);
  const deals = r?.data || [];
  const byPerson = new Map();
  for (const d of deals) {
    const pid = typeof d.person_id === 'object' ? d.person_id?.value : d.person_id;
    if (!pid) continue;
    if (!byPerson.has(pid)) byPerson.set(pid, []);
    byPerson.get(pid).push(d);
  }
  const groupes = [];
  for (const [pid, group] of byPerson) {
    if (group.length < 2) continue;
    group.sort((a, b) => new Date(b.add_time).getTime() - new Date(a.add_time).getTime());
    groupes.push({
      personId: pid,
      personName: group[0].person_name || `Person #${pid}`,
      deals: group.map(d => ({ id: d.id, title: d.title, addTime: d.add_time, stageId: d.stage_id })),
    });
  }
  return groupes;
}

// ─── Audit Pipedrive ULTRA — auto-cleanup tout (sécurité maximale) ────────
async function auditPipedriveUltra() {
  if (!PD_KEY) return null;
  log('INFO', 'AUDIT', 'Audit ultra-perfectionné démarré...');
  const stats = { dealsFusionnes: 0, activitesDoublons: 0, activitesOrphans: 0, activitesSansContact: 0 };

  try {
    // 1. PERSONS avec ≥2 deals open → fusion auto (garde + récent)
    const allDealsRes = await pdGet('/deals?status=open&limit=500');
    const allDeals = allDealsRes?.data || [];
    const dealsByPerson = new Map();
    for (const d of allDeals) {
      const pid = typeof d.person_id === 'object' ? d.person_id?.value : d.person_id;
      if (!pid) continue;
      if (!dealsByPerson.has(pid)) dealsByPerson.set(pid, []);
      dealsByPerson.get(pid).push(d);
    }
    for (const [, deals] of dealsByPerson) {
      if (deals.length < 2) continue;
      deals.sort((a, b) => new Date(b.add_time).getTime() - new Date(a.add_time).getTime());
      const keep = deals[0];
      for (let i = 1; i < deals.length; i++) {
        try {
          const r = await fetch(`https://api.pipedrive.com/v1/deals/${deals[i].id}/merge?api_token=${PD_KEY}`, {
            method: 'PUT', headers: {'content-type':'application/json'},
            body: JSON.stringify({ merge_with_id: keep.id })
          });
          if ((await r.json()).success) stats.dealsFusionnes++;
        } catch {}
      }
    }

    // 2. ACTIVITÉS doublons par deal — 1 par deal max
    const allActsRes = await pdGet('/activities?done=0&limit=500');
    const allActs = (allActsRes?.data || []).filter(a => a.deal_id);
    const actsByDeal = new Map();
    for (const a of allActs) {
      if (!actsByDeal.has(a.deal_id)) actsByDeal.set(a.deal_id, []);
      actsByDeal.get(a.deal_id).push(a);
    }
    for (const [, list] of actsByDeal) {
      if (list.length < 2) continue;
      list.sort((a, b) => new Date(b.add_time).getTime() - new Date(a.add_time).getTime());
      for (let i = 1; i < list.length; i++) {
        try {
          await fetch(`https://api.pipedrive.com/v1/activities/${list[i].id}?api_token=${PD_KEY}`, {
            method: 'PUT', headers: {'content-type':'application/json'}, body: JSON.stringify({ done: 1 })
          });
          stats.activitesDoublons++;
        } catch {}
      }
    }

    // 3. ORPHANS — activité sans deal_id OU deal supprimé → DELETE
    const refreshRes = await pdGet('/activities?done=0&limit=500');
    for (const a of (refreshRes?.data || [])) {
      if (!a.deal_id) {
        try {
          await fetch(`https://api.pipedrive.com/v1/activities/${a.id}?api_token=${PD_KEY}`, { method: 'DELETE' });
          stats.activitesOrphans++;
        } catch {}
        continue;
      }
      const d = await pdGet(`/deals/${a.deal_id}`).catch(() => null);
      if (!d?.success || d?.data?.status === 'deleted') {
        try {
          await fetch(`https://api.pipedrive.com/v1/activities/${a.id}?api_token=${PD_KEY}`, { method: 'DELETE' });
          stats.activitesOrphans++;
        } catch {}
      }
    }

    // 4. ACTIVITÉS génériques sans info contact → DELETE
    const finalRes = await pdGet('/activities?done=0&limit=500');
    for (const a of (finalRes?.data || [])) {
      const isGeneric = /^📞?\s*Appeler\s*(Contact|Nouveau prospect|Prospect)?$/i.test(a.subject || '') ||
                         /^Appel(er)?\s*$/i.test(a.subject || '');
      if (!isGeneric) continue;
      let person = null;
      if (a.person_id) { try { person = (await pdGet(`/persons/${a.person_id}`))?.data; } catch {} }
      const hasInfo = (person?.name && person.name.length > 2 && !/^(nouveau prospect|prospect|contact)$/i.test(person.name)) ||
                       person?.email?.[0]?.value || person?.phone?.[0]?.value;
      if (!hasInfo) {
        try {
          await fetch(`https://api.pipedrive.com/v1/activities/${a.id}?api_token=${PD_KEY}`, { method: 'DELETE' });
          stats.activitesSansContact++;
        } catch {}
      }
    }

    log('OK', 'AUDIT', `Cleanup ultra: ${JSON.stringify(stats)}`);
    return stats;
  } catch (e) {
    log('ERR', 'AUDIT', `auditPipedriveUltra: ${e.message}`);
    return { error: e.message };
  }
}

// ─── Dedup hebdo activités + détection doublons deals (dimanche 21h) ─────
async function runDedupHebdo() {
  if (!PD_KEY) return;
  log('INFO', 'DEDUP', 'Dedup hebdo — scan deals open...');
  let totalDeals = 0, totalSupprimees = 0;
  let doublonsDeals = [];
  try {
    const r = await pdGet(`/deals?status=open&limit=500`);
    const deals = r?.data || [];
    totalDeals = deals.length;
    // 1. Activités doublons par deal (auto-cleanup safe)
    for (const d of deals) {
      const res = await nettoyerDoublonsActivites(d.id);
      totalSupprimees += res.supprimees || 0;
    }
    // 2. Détection doublons DEALS (alerte uniquement, pas auto-merge)
    doublonsDeals = await detecterDoublonsDeals();
    log('OK', 'DEDUP', `Hebdo: ${totalSupprimees} activité(s) doublon(s) sur ${totalDeals} deals · ${doublonsDeals.length} groupe(s) deals doublons`);

    let msg = '';
    if (totalSupprimees > 0) {
      msg += `🧹 *Dedup hebdo activités*\n${totalSupprimees} doublon(s) supprimé(s) sur ${totalDeals} deals\n\n`;
    }
    if (doublonsDeals.length > 0) {
      msg += `⚠️ *${doublonsDeals.length} personne(s) avec deals dupliqués:*\n\n`;
      for (const g of doublonsDeals.slice(0, 8)) {
        msg += `*${g.personName}*\n`;
        for (const d of g.deals) msg += `  • #${d.id} ${d.title.substring(0, 40)}\n`;
        msg += `  → fusionner: "fusionne deal ${g.deals[1].id} dans ${g.deals[0].id}"\n\n`;
      }
      msg += `_Le bot utilise auto le + récent pour les nouveaux leads, mais les doublons existants restent jusqu'à fusion manuelle (sécurité)._`;
    }
    if (msg) {
      await sendTelegramWithFallback(msg, { category: 'dedup-hebdo' }).catch(() => {});
    }
  } catch (e) { log('ERR', 'DEDUP', `runDedupHebdo: ${e.message}`); }
  return { totalDeals, totalSupprimees, doublonsDealsCount: doublonsDeals.length };
}

// ─── REGISTRE D'APPROBATION CAMPAGNES (Shawn 2026-05-05) ────────────────────
// Shawn doit EXPLICITEMENT approuver chaque campagne via /campaigns avant envoi.
// Toute campagne scheduledAt sans approval entry → suspendue auto + alerte.
const CAMPAIGN_APPROVALS_FILE = path.join(DATA_DIR, 'campaigns_approved.json');
let campaignApprovals = loadJSON(CAMPAIGN_APPROVALS_FILE, { approved: {} });
function approveCampaign(id) {
  campaignApprovals.approved[String(id)] = { approvedAt: new Date().toISOString() };
  saveJSON(CAMPAIGN_APPROVALS_FILE, campaignApprovals);
}
function isCampaignApproved(id) {
  return !!campaignApprovals.approved[String(id)];
}

// ─── SAFETY CHECK CAMPAGNES — cron horaire (Shawn 2026-05-05) ────────────────
// Scanne TOUTES les campagnes Brevo schedulées dans les 48h prochaines.
// Si campagne NON approuvée par Shawn → SUSPEND auto + alerte Telegram.
// + envoie preview email pour ré-approbation.
async function safetyCheckCampagnes() {
  if (!BREVO_KEY) return;
  try {
    const now = Date.now();
    const limit48h = now + 48 * 3600 * 1000;
    // Scanner TOUS les statuts (queued, in_process, scheduled, suspended)
    const statuses = ['queued', 'in_process'];
    const campaigns = [];
    for (const st of statuses) {
      const r = await fetch(`https://api.brevo.com/v3/emailCampaigns?status=${st}&limit=100`, {
        headers: { 'api-key': BREVO_KEY, 'accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (r.ok) {
        const d = await r.json();
        campaigns.push(...(d.campaigns || []).map(c => ({ ...c, _scanStatus: st })));
      }
    }
    const upcoming = campaigns.filter(c => {
      if (!c.scheduledAt) return false;
      const t = new Date(c.scheduledAt).getTime();
      return t > now && t <= limit48h;
    });
    let suspended = 0, alerts = [];
    for (const c of upcoming) {
      if (isCampaignApproved(c.id)) continue;
      // Non approuvée → suspend immédiatement
      try {
        const sr = await fetch(`https://api.brevo.com/v3/emailCampaigns/${c.id}/status`, {
          method: 'PUT',
          headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ status: 'suspended' }),
          signal: AbortSignal.timeout(10000),
        });
        if (sr.ok || sr.status === 204) {
          suspended++;
          // Envoie preview test
          await fetch(`https://api.brevo.com/v3/emailCampaigns/${c.id}/sendTest`, {
            method: 'POST',
            headers: { 'api-key': BREVO_KEY, 'content-type': 'application/json' },
            body: JSON.stringify({ emailTo: [SHAWN_EMAIL] }),
            signal: AbortSignal.timeout(10000),
          }).catch(() => {});
          const sched = new Date(c.scheduledAt).toLocaleString('fr-CA', { timeZone: 'America/Toronto', dateStyle: 'short', timeStyle: 'short' });
          alerts.push(`🚨 *${c.name}* (#${c.id})\n   Schedulée ${sched} sans approbation → SUSPENDUE\n   Subject: ${(c.subject||'').substring(0,80)}`);
        }
      } catch (e) { log('WARN', 'SAFETY', `Suspend ${c.id}: ${e.message}`); }
    }
    if (alerts.length) {
      const tgMsg = `🛡️ *SAFETY CHECK CAMPAGNES*\n_Cron horaire — ${alerts.length} campagne(s) non approuvée(s) suspendue(s)_\n\n` + alerts.join('\n\n') + `\n\n→ Tape \`/campaigns\` pour reviewer + approuver`;
      await sendTelegramWithFallback(tgMsg, { category: 'safety-campaigns' }).catch(() => {});
    }
    if (suspended > 0) log('OK', 'SAFETY', `${suspended} campagne(s) suspendue(s) auto (non approuvées)`);
  } catch (e) { log('WARN', 'SAFETY', `safetyCheck: ${e.message}`); }
}

// ─── Veille J-1 backup côté Render (au cas où Mac dort) ─────────────────
async function checkVeilleCampagnesBackup() {
  if (!BREVO_KEY) return;
  log('INFO', 'VEILLE', 'Backup check campagnes suspended pour demain...');

  // Demain en Eastern
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Toronto' }); // YYYY-MM-DD

  // Liste suspended
  const r = await fetch('https://api.brevo.com/v3/emailCampaigns?status=suspended&limit=50', {
    headers: { 'api-key': BREVO_KEY, 'accept': 'application/json' },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) { log('WARN', 'VEILLE', `Brevo HTTP ${r.status}`); return; }
  const data = await r.json();
  // BUG FIX 2026-05-05: ne plus filtrer par tag — préviewer TOUTES les campagnes
  // suspended schedulées demain. La campagne "Vendeurs" sans tag [AUTO]/[REENG]
  // était ignorée et partait sans preview/confirmation.
  const camps = (data.campaigns || []);
  const targets = camps.filter(c => {
    const d = (c.scheduledAt || '').split('T')[0];
    return d === tomorrowKey;
  });

  if (!targets.length) {
    log('INFO', 'VEILLE', `Aucune campagne pour demain (${tomorrowKey})`);
    return;
  }

  // État dédup persistant
  const STATE_FILE = require('fs').existsSync('/data') ? '/data/veille_state.json' : '/tmp/veille_state.json';
  let state = {};
  try { state = JSON.parse(require('fs').readFileSync(STATE_FILE, 'utf8')); } catch {}

  for (const camp of targets) {
    const dedupKey = `veille_${camp.id}_${tomorrowKey}`;
    if (state[dedupKey]) { log('INFO', 'VEILLE', `${dedupKey} déjà fait (Mac scheduler probablement)`); continue; }

    // 1. Envoie preview via GMAIL API (Brevo sendTest hold → unreliable)
    // On fetch le HTML campagne + send via Gmail OAuth (delivery garantie).
    let testOK = false;
    let previewError = null;
    try {
      const detRes = await fetch(`https://api.brevo.com/v3/emailCampaigns/${camp.id}`, {
        headers: { 'api-key': BREVO_KEY }, signal: AbortSignal.timeout(15000)
      });
      const campFull = detRes.ok ? await detRes.json() : null;
      const html = campFull?.htmlContent;
      const subj = campFull?.subject || camp.name;
      const gmailTok = await getGmailToken();
      if (html && gmailTok) {
        const enc = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
        const lines = [
          `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
          `To: ${SHAWN_EMAIL}`,
          `Reply-To: ${AGENT.email}`,
          `Subject: ${enc(`[VEILLE J-1] ${subj}`)}`,
          'MIME-Version: 1.0',
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: base64', '',
          Buffer.from(html, 'utf-8').toString('base64'),
        ];
        const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
        const gm = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${gmailTok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ raw }),
          signal: AbortSignal.timeout(15000),
        });
        testOK = gm.ok;
        if (!gm.ok) previewError = `Gmail ${gm.status}`;
      } else if (!html) {
        previewError = 'no htmlContent';
      } else {
        previewError = 'gmail token absent';
      }
    } catch (e) { log('WARN', 'VEILLE', `preview-gmail err: ${e.message}`); previewError = e.message?.substring(0, 80); }

    // 2. Notif Telegram
    const det = await fetch(`https://api.brevo.com/v3/emailCampaigns/${camp.id}`, {
      headers: { 'api-key': BREVO_KEY }, signal: AbortSignal.timeout(10000)
    }).then(r => r.json()).catch(() => ({}));
    const segMatch = (camp.name || '').match(/\[(?:AUTO|REENG|TERRAINS)\]\s*([^·\d][^·]*?)(?:\s*[·\d]|$)/);
    const segment = segMatch ? segMatch[1].trim() : 'Campagne';
    const lists = det.recipients?.lists || det.recipients?.listIds || [];
    const dateStr = new Date(camp.scheduledAt).toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Toronto' });

    const tgText = `📧 *Campagne demain à 10h*\n\n` +
      `*${segment}* · #${camp.id}\n` +
      `📅 ${dateStr}\n` +
      `👥 listes [${lists.join(',')}]\n` +
      `📝 ${(det.subject || camp.subject || '').substring(0, 80)}\n\n` +
      (testOK ? `📬 *Preview envoyé via Gmail* à shawn@signaturesb.com — sujet \\[VEILLE J-1\\]\n\n` : `⚠️ Preview échoué (${previewError || '?'}) — utilise \`/admin/preview-via-gmail?id=${camp.id}\`\n\n`) +
      `_Rien ne s'envoie sans ton ✅ Confirmer ci-dessous._`;

    // Boutons inline direct (1 click, pas besoin de taper /campaigns)
    const replyMarkup = {
      inline_keyboard: [[
        { text: '✅ Confirmer', callback_data: `cmp_send:${camp.id}` },
        { text: '🚫 Annuler', callback_data: `cmp_cancel:${camp.id}` },
        { text: '👁 Preview', callback_data: `cmp_preview:${camp.id}` },
      ]],
    };
    await sendTelegramWithFallback(tgText, { category: 'veille-backup', replyMarkup }).catch(() => {});
    state[dedupKey] = new Date().toISOString();
    log('OK', 'VEILLE', `Notif backup #${camp.id} envoyée`);
  }

  try {
    require('fs').mkdirSync(require('path').dirname(STATE_FILE), { recursive: true });
    require('fs').writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

async function runDigestJulie() {
  // 🧊 SUR GLACE par défaut — Shawn ne veut pas d'emails auto sans accord.
  // Pour réactiver: /setsecret DIGEST_JULIE_ENABLED true (effet immédiat).
  if (process.env.DIGEST_JULIE_ENABLED !== 'true') return;
  if (!PD_KEY || !BREVO_KEY) return;
  try {
    const [nouveaux, enDiscussion, visitesAujourdhui] = await Promise.all([
      pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&stage_id=49&status=open&limit=30`),
      pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&stage_id=51&status=open&limit=30`),
      pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&stage_id=52&status=open&limit=30`),
    ]);
    const today = new Date().toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Toronto' });
    let body = `Bonjour Julie,\n\nVoici le résumé pipeline du ${today}.\n\n`;
    if (nouveaux?.data?.length) { body += `NOUVEAUX LEADS (${nouveaux.data.length}):\n`; nouveaux.data.forEach(d => body += `• ${d.title}\n`); body += '\n'; }
    if (enDiscussion?.data?.length) { body += `EN DISCUSSION (${enDiscussion.data.length}):\n`; enDiscussion.data.forEach(d => body += `• ${d.title}\n`); body += '\n'; }
    if (visitesAujourdhui?.data?.length) { body += `VISITES PRÉVUES (${visitesAujourdhui.data.length}):\n`; visitesAujourdhui.data.forEach(d => body += `• ${d.title}\n`); body += '\n'; }
    if (!nouveaux?.data?.length && !enDiscussion?.data?.length && !visitesAujourdhui?.data?.length) return; // Rien à envoyer
    body += 'Bonne journée!\nKira — Signature SB';
    const ok = await envoyerEmailBrevo({ to: JULIE_EMAIL, toName: 'Julie', subject: `📋 Pipeline — ${today}`, textContent: body });
    if (ok) log('OK', 'CRON', 'Digest Julie envoyé');
  } catch (e) { log('ERR', 'CRON', `Digest: ${e.message}`); }
}

async function runSuiviQuotidien() {
  if (!PD_KEY || !ALLOWED_ID) return;
  try {
    const data = await pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`);
    const deals = data?.data || [];
    const now = Date.now();
    const relances = [];
    for (const deal of deals) {
      if (deal.stage_id > 51) continue;
      const j1 = deal[PD_FIELD_SUIVI_J1];
      const j3 = deal[PD_FIELD_SUIVI_J3];
      const j7 = deal[PD_FIELD_SUIVI_J7];
      const created = new Date(deal.add_time).getTime();
      const joursDep = (now - created) / 86400000;
      if (!j1 && joursDep >= 1)          relances.push({ deal, type: 'J+1 (premier contact)', emoji: '🟢' });
      else if (j1 && !j3 && joursDep >= 3) relances.push({ deal, type: 'J+3 (validation intérêt)', emoji: '🟡' });
      else if (j1 && j3 && !j7 && joursDep >= 7) relances.push({ deal, type: 'J+7 (DERNIER — décision)', emoji: '🔴' });
    }
    if (!relances.length) return;
    let msg = `📋 *Suivi du jour — ${relances.length} prospect${relances.length > 1 ? 's' : ''} à relancer:*\n\n`;
    for (const { deal, type, emoji } of relances) {
      const stage = PD_STAGES[deal.stage_id] || '';
      msg += `${emoji} *${deal.title}* — ${type}\n  ${stage}\n`;
    }
    msg += '\n_Dis "relance [nom]" pour que je rédige le message._';
    await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) { log('ERR', 'CRON', `Suivi: ${e.message}`); }
}

// 📊 Briefing quotidien 7h30 — vue 360°: visites du jour + stagnants + prochaine campagne
async function briefingMatin() {
  if (!ALLOWED_ID) return;
  try {
    const today = new Date();
    const todayStr = today.toDateString();
    const dateStr = today.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Toronto' });

    // 1. Visites du jour
    const visites = loadJSON(VISITES_FILE, []);
    const visitesAujourdhui = visites.filter(v => new Date(v.date).toDateString() === todayStr);
    let visitesBlock = '';
    if (visitesAujourdhui.length === 0) {
      visitesBlock = `📅 *Visites:* aucune aujourd'hui`;
    } else {
      const lignes = visitesAujourdhui
        .sort((a, b) => new Date(a.date) - new Date(b.date))
        .map(v => {
          const h = new Date(v.date).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
          return `  • ${h} — ${v.nom}${v.adresse ? ' @ ' + v.adresse : ''}`;
        });
      visitesBlock = `📅 *Visites (${visitesAujourdhui.length}):*\n${lignes.join('\n')}`;
    }

    // 2. Prospects stagnants (3 jours sans action) — top 5
    let stagnantsBlock = '';
    try {
      const stagText = await prospectStagnants(3);
      // Extract just the count + top 5 lignes
      const lignes = String(stagText || '').split('\n').filter(l => l.trim()).slice(0, 6);
      stagnantsBlock = lignes.length ? `\n🐌 *Stagnants 3j+:*\n${lignes.slice(0, 6).join('\n')}` : '';
    } catch (e) { /* silencieux */ }

    // 3. Prochaine campagne mailing (depuis mailingPlanCache déjà refresh chaque heure)
    let campagneBlock = '';
    if (mailingPlanCache?.text) {
      // Extract le 1er bullet "• #N Nom · date" du plan
      const m = mailingPlanCache.text.match(/• #(\d+)\s+([^·]+)·\s*([^·]+)·\s*(✅[^\n]+|⏸[^\n]+)/);
      if (m) {
        campagneBlock = `\n📧 *Prochaine campagne:* #${m[1]} ${m[2].trim()} — ${m[3].trim()} ${m[4].trim()}`;
      }
    }

    // 4. Construire et envoyer
    const msg = [
      `☀️ *Briefing — ${dateStr}*`,
      ``,
      visitesBlock,
      stagnantsBlock,
      campagneBlock,
      ``,
      `_7h30 · auto · /campaigns pour confirmer mailing · /pipeline pour stagnants détaillés_`,
    ].filter(Boolean).join('\n');

    await sendTelegramWithFallback(msg, { category: 'briefing-matin' }).catch(() => {});
    log('OK', 'CRON', `Briefing 7h30 envoyé (${visitesAujourdhui.length} visites)`);
  } catch (e) {
    log('WARN', 'CRON', `briefingMatin: ${e.message}`);
  }
}

// 🛡️ Cron purge auto activités génériques Pipedrive — TOUTES LES HEURES
// 2026-06-01: dealmonitor désactivé (vraie source). Cron horaire = filet sécurité.
// Si > 0 détectées = une NOUVELLE source est apparue → ALERTE Telegram immédiate.
async function pipedriveCleanupAuto() {
  if (!ALLOWED_ID || !process.env.WEBHOOK_SECRET) return;
  try {
    const port = process.env.PORT || 3000;
    const url = `http://127.0.0.1:${port}/admin/pipedrive-cleanup?dry=0&notify=0&token=${encodeURIComponent(process.env.WEBHOOK_SECRET)}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) { log('WARN', 'CRON', `pdCleanupAuto HTTP ${r.status}`); return; }
    const out = await r.json();
    const g = out.generiques || {};
    const d = out.doublons || {};
    const nc = out.no_contact || {};
    const sh = out.shawn || {};
    const total = (g.deleted || 0) + (d.fermes || 0) + (nc.fermes || 0) + (sh.deleted || 0);
    if (total > 0) {
      // 🚨 Si génériques > 0 = NOUVELLE source apparue (dealmonitor désactivé 2026-06-01)
      // Alerte spéciale pour identifier le coupable
      const alertGeneric = (g.deleted || 0) > 0
        ? `\n🚨 *NOUVELLE SOURCE détectée!* ${g.deleted} activité(s) génériques créées depuis 1h.\nVérifie tes LaunchAgents Mac + Zapier/Make.com + autres scripts qui appellent l'API Pipedrive.\nLes 9 LaunchAgents historiques sont propres — c'est qqch de nouveau.\n`
        : '';
      const msg = [
        `🧼 *Pipedrive cleanup cron horaire*`,
        ``,
        `✅ ${g.deleted || 0} activité(s) générique(s) supprimée(s)`,
        `✅ ${d.fermes || 0} doublon(s) fermé(s)`,
        `✅ ${nc.fermes || 0} activité(s) sans coordonnées fermée(s)`,
        `✅ ${sh.deleted || 0} activité(s) Shawn-as-contact supprimée(s)`,
        `📊 Scanné: ${out.total_scanned || '?'}`,
        alertGeneric,
        out.retards?.count > 0 ? `⚠️ ${out.retards.count} retard(s) (audit only)` : '',
      ].filter(Boolean).join('\n');
      await sendTelegramWithFallback(msg, { category: 'pipedrive-cleanup-cron' }).catch(() => {});
    }
    log('OK', 'CRON', `pdCleanupAuto: ${total} cleanup actions (génériques=${g.deleted} doublons=${d.fermes} no_contact=${nc.fermes} shawn=${sh.deleted})`);
  } catch (e) {
    log('WARN', 'CRON', `pdCleanupAuto: ${e.message}`);
  }
}

async function rappelVisitesMatin() {
  if (!ALLOWED_ID) return;
  try {
    const visites = loadJSON(VISITES_FILE, []);
    const today   = new Date().toDateString();
    const visitesDuJour = visites.filter(v => new Date(v.date).toDateString() === today);
    if (!visitesDuJour.length) return;
    let msg = `📅 *Visites d'aujourd'hui — ${visitesDuJour.length}:*\n\n`;
    for (const v of visitesDuJour.sort((a, b) => new Date(a.date) - new Date(b.date))) {
      const heure = new Date(v.date).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
      msg += `🏡 *${v.nom}* — ${heure}${v.adresse ? '\n📍 ' + v.adresse : ''}\n\n`;
    }
    await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) { log('ERR', 'CRON', `Visites: ${e.message}`); }
}

async function syncStatusGitHub() {
  if (!process.env.GITHUB_TOKEN) return;
  const now = new Date();
  const ts  = now.toLocaleDateString('fr-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone:'America/Toronto' })
            + ' à ' + now.toLocaleTimeString('fr-CA', { hour:'2-digit', minute:'2-digit', timeZone:'America/Toronto' });
  try {
    // PRIVACY: on ne publie PLUS les noms de clients ni les deals individuels.
    // Juste des stats agrégées anonymes pour monitoring.
    let totalActifs = 0, gagnesMois = 0, perdusMois = 0;
    let stagesCounts = {};
    if (PD_KEY) {
      const [actifs, gagnes, perdus] = await Promise.all([
        pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`).catch(()=>null),
        pdGet('/deals?status=won&limit=100').catch(()=>null),
        pdGet('/deals?status=lost&limit=100').catch(()=>null),
      ]);
      totalActifs = (actifs?.data||[]).length;
      for (const d of (actifs?.data||[])) {
        const stage = PD_STAGES[d.stage_id] || `Étape ${d.stage_id}`;
        stagesCounts[stage] = (stagesCounts[stage]||0) + 1;
      }
      const m = now.getMonth();
      gagnesMois = (gagnes?.data||[]).filter(d=>new Date(d.won_time||0).getMonth()===m).length;
      perdusMois = (perdus?.data||[]).filter(d=>new Date(d.lost_time||0).getMonth()===m).length;
    }
    const visites    = loadJSON(VISITES_FILE, []);
    const prochaines = visites.filter(v => new Date(v.date).getTime() > Date.now()).length;

    const content = [
      `# Bot Signature SB — Rapport système`,
      `_${ts}_`,
      ``,
      `## Système`,
      `- Modèle: \`${currentModel}\` | Outils: ${TOOLS.length}`,
      `- Uptime: ${Math.floor(process.uptime()/60)}min`,
      `- Gmail Poller: ${gmailPollerState.totalLeads||0} leads traités (cumul)`,
      `- Dropbox: ${dropboxTerrains.length} terrains en cache`,
      ``,
      `## Pipeline (stats agrégées, sans identifier)`,
      `- Deals actifs: ${totalActifs}`,
      ...Object.entries(stagesCounts).map(([s,n]) => `  - ${s}: ${n}`),
      ``,
      `## Ce mois`,
      `- ✅ Gagnés: ${gagnesMois} | ❌ Perdus: ${perdusMois}`,
      `- 📅 Visites à venir (count): ${prochaines}`,
      ``,
      `> Privacy: ce fichier est public. Aucun nom/email/téléphone client.`,
      `> Pour les détails: Pipedrive directement ou \`/pipeline\` sur Telegram.`,
    ].join('\n');

    await writeGitHubFile('kira-bot', 'BOT_STATUS.md', content, `Sync: ${now.toISOString().split('T')[0]}`);
    log('OK', 'SYNC', `BOT_STATUS.md → kira-bot (stats anonymes, ${totalActifs} deals)`);
  } catch (e) { log('WARN', 'SYNC', `GitHub sync: ${e.message}`); }
}

function startDailyTasks() {
  // KEEP-ALIVE — self-ping /health toutes les 10 min pour empêcher Render de
  // mettre le service en veille (spin-down après inactivité sur certains plans).
  // Fire-and-forget, zéro impact si déjà actif.
  const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://signaturesb-bot-s272.onrender.com';
  setInterval(() => {
    fetch(`${SELF_URL}/`, { method: 'GET', signal: AbortSignal.timeout(8000) })
      .then(r => r.ok ? null : log('WARN', 'KEEPALIVE', `self-ping ${r.status}`))
      .catch(e => log('WARN', 'KEEPALIVE', `self-ping: ${e.message.substring(0, 60)}`));
  }, 10 * 60 * 1000);

  // CENTRIS COOKIES EXPIRY ALERT — ping si <3j avant expiry (max 1×/jour)
  let _lastCentrisExpiryAlert = 0;
  setInterval(() => {
    if (!centrisSession.cookies || centrisSession.via !== 'manual-capture') return;
    const remaining = centrisSession.expiry - Date.now();
    const days = remaining / 86400000;
    const cooldown = 23 * 60 * 60 * 1000;
    if (days < 3 && days > 0 && Date.now() - _lastCentrisExpiryAlert > cooldown) {
      _lastCentrisExpiryAlert = Date.now();
      sendTelegramWithFallback(
        `🍪 *Cookies Centris expirent dans ${Math.round(days)} jour(s)*\n\n` +
        `Pour éviter coupure du service /fiche:\n` +
        `1. Login matrix.centris.ca dans Chrome (avec MFA si demandé)\n` +
        `2. DevTools (Cmd+Opt+I) → Network → click une requête → "Cookie" header → copy\n` +
        `3. \`/cookies <le_string>\` — bot test + save 25 jours de plus\n\n` +
        `60 secondes total.`,
        { category: 'centris-cookies-expiring', days }
      ).catch(() => {});
    } else if (days <= 0 && Date.now() - _lastCentrisExpiryAlert > cooldown) {
      _lastCentrisExpiryAlert = Date.now();
      sendTelegramWithFallback(
        `🔴 *Cookies Centris EXPIRÉS*\n\nLes outils \`/fiche\`, comparables, etc. ne fonctionneront plus tant que tu n'auras pas re-capturé.\n\nProcédure (60 sec):\n1. matrix.centris.ca dans Chrome\n2. DevTools → Cookies → copy\n3. \`/cookies <string>\``,
        { category: 'centris-cookies-expired' }
      ).catch(() => {});
    }
  }, 6 * 60 * 60 * 1000); // check toutes les 6h

  // LEAD AGING ESCALATION — ping si pending >4h (max 1×/jour par lead)
  // Évite qu'un pending reste silencieusement oublié si Shawn n'a pas vu la notif.
  // Wrappé safeCron: throw interne ne casse PAS l'interval.
  safeCron('lead-aging', async () => {
    if (!ALLOWED_ID) return;
    const now = Date.now();
    const AGE_LIMIT = 4 * 60 * 60 * 1000; // 4h
    const DAILY_COOLDOWN = 23 * 60 * 60 * 1000; // ~1×/jour

    // 1. Pending leads needsName
    for (const p of pendingLeads.filter(l => l.needsName)) {
      if (now - p.ts < AGE_LIMIT) continue;
      if (p._lastEscalation && now - p._lastEscalation < DAILY_COOLDOWN) continue;
      p._lastEscalation = now;
      const ageH = Math.round((now - p.ts) / 3600000);
      const e = p.extracted || {};
      await sendTelegramWithFallback(
        `⏰ *Lead pending depuis ${ageH}h* — nom toujours manquant\n` +
        `📧 ${e.email || '(vide)'}\n🏡 ${e.centris ? '#' + e.centris : (e.adresse || '?')}\n\n` +
        `Réponds \`nom Prénom Nom\` pour reprendre OU \`/pending\` pour tout voir.`,
        { category: 'lead-aging-escalation', pendingId: p.id, ageH }
      );
      savePendingLeads(); // pour persister _lastEscalation
    }

    // 2. Pending docs
    for (const [email, p] of (typeof pendingDocSends !== 'undefined' ? pendingDocSends.entries() : [])) {
      const age = now - (p._firstSeen || now);
      if (age < AGE_LIMIT) continue;
      if (p._lastEscalation && now - p._lastEscalation < DAILY_COOLDOWN) continue;
      p._lastEscalation = now;
      savePendingDocs();
      const ageH = Math.round(age / 3600000);
      await sendTelegramWithFallback(
        `⏰ *Docs en attente depuis ${ageH}h* — ${email}\n` +
        `Score: ${p.match?.score || '?'} · ${p.match?.pdfs?.length || '?'} PDFs\n\n` +
        `\`envoie les docs à ${email}\` OU \`annule ${email}\``,
        { category: 'pending-docs-aging', email, ageH }
      );
    }
  }, 30 * 60 * 1000); // toutes les 30min — wrappé safeCron

  // ─── BREVO AUTOMATION AUDIT (cron 6h) ────────────────────────────────────
  // Liste les automations Brevo actives et alerte Shawn si un nouveau workflow
  // est apparu (= peut envoyer des emails sans son contrôle direct via Telegram).
  let _knownBrevoWorkflows = new Set();
  setInterval(async () => {
    if (!BREVO_KEY) return;
    try {
      // Brevo API: GET /automations/workflows
      const r = await fetch('https://api.brevo.com/v3/automations/workflows?limit=50', {
        headers: { 'api-key': BREVO_KEY, 'accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        // Endpoint Automation peut nécessiter un plan payant — silencieux si pas dispo
        return;
      }
      const data = await r.json().catch(() => null);
      const workflows = (data?.workflows || []).filter(w => w.enabled);
      const currentIds = new Set(workflows.map(w => String(w.id)));

      // Nouveaux workflows (présents maintenant mais pas avant)
      const newOnes = [...currentIds].filter(id => !_knownBrevoWorkflows.has(id));
      if (newOnes.length > 0 && _knownBrevoWorkflows.size > 0) {
        // Skip premier run (init list, pas de comparaison)
        const newDetails = workflows.filter(w => newOnes.includes(String(w.id)));
        const alertMsg = [
          `🚨 *Nouvelle automation Brevo activée*`,
          ``,
          `${newOnes.length} nouvelle(s) automation(s) détectée(s) — peuvent envoyer des courriels au client:`,
          ``,
          ...newDetails.slice(0, 5).map(w => `• \`${w.name || w.id}\` — créée ${w.createdAt || '?'}`),
          ``,
          `Si tu n'as pas créé ces automations, va sur app.brevo.com → Automations → Pause immédiat.`,
        ].join('\n');
        await sendTelegramWithFallback(alertMsg, { category: 'brevo-new-automation', count: newOnes.length }).catch(()=>{});
        auditLogEvent('audit', 'brevo_new_automation', { ids: newOnes, count: newOnes.length });
      }
      _knownBrevoWorkflows = currentIds;
      log('OK', 'AUDIT', `Brevo: ${workflows.length} workflow(s) actif(s)`);
    } catch (e) {
      log('WARN', 'AUDIT', `Brevo audit: ${e.message.substring(0, 100)}`);
    }
  }, 6 * 60 * 60 * 1000);

  // ─── AUDIT SENT FOLDER — détection envois non-autorisés (cron 1h) ─────────
  // Compare Gmail Sent folder vs emailOutbox local. Tout email envoyé sans
  // passer par sendEmailLogged() apparaîtra dans Sent mais PAS dans l'outbox
  // = ENVOI HORS BOT = alerte 🚨 immédiate Shawn (sécurité ultime).
  let _lastSentAuditAt = 0;
  setInterval(async () => {
    if (!process.env.GMAIL_CLIENT_ID) return;
    try {
      const sinceMs = Math.max(_lastSentAuditAt, Date.now() - 90 * 60 * 1000); // 90min ou depuis dernier check
      const sinceQ = `after:${Math.floor(sinceMs / 1000)}`;
      const list = await gmailAPI(`/messages?maxResults=50&q=in:sent ${encodeURIComponent(sinceQ)}`).catch(() => null);
      const messages = list?.messages || [];
      if (!messages.length) { _lastSentAuditAt = Date.now(); return; }

      const suspects = [];
      for (const m of messages) {
        try {
          const full = await gmailAPI(`/messages/${m.id}?format=metadata&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`).catch(() => null);
          if (!full) continue;
          const hdrs = full.payload?.headers || [];
          const get = n => hdrs.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
          const to = get('To').toLowerCase();
          const subject = get('Subject').substring(0, 200);
          const dateMs = parseInt(full.internalDate || '0');

          // Skip emails à shawn@ lui-même (sont des notifs internes/backups, légitimes)
          if (to.includes(AGENT.email.toLowerCase()) && !to.includes(',')) continue;

          // Cherche match dans outbox dans une fenêtre ±5min
          const matched = emailOutbox.find(o =>
            o.to === to.replace(/.*<([^>]+)>.*/, '$1').trim() &&
            Math.abs(o.ts - dateMs) < 5 * 60 * 1000 &&
            (o.subject?.substring(0, 60) === subject.substring(0, 60) ||
             subject.includes(o.subject?.substring(0, 30) || ''))
          );
          if (!matched) {
            suspects.push({ msgId: m.id, to, subject, dateMs, dateISO: new Date(dateMs).toISOString() });
          }
        } catch {}
      }

      if (suspects.length > 0) {
        log('WARN', 'AUDIT', `🚨 ${suspects.length} email(s) dans Sent SANS trace dans outbox`);
        const alertMsg = [
          `🚨 *ALERTE SÉCURITÉ — Email(s) envoyé(s) HORS du bot*`,
          ``,
          `${suspects.length} email(s) trouvé(s) dans Gmail Sent sans trace dans email_outbox.`,
          `Ça veut dire qu'un envoi est parti sans passer par le bot (autre app, web, mailing-masse?).`,
          ``,
          ...suspects.slice(0, 5).map((s, i) =>
            `${i+1}. À: \`${s.to}\`\n   Sujet: ${s.subject}\n   Heure: ${s.dateISO}\n   MsgId: \`${s.msgId}\``
          ),
          ``,
          suspects.length > 5 ? `+${suspects.length - 5} autres...` : '',
          `*Investigue:* dossier Sent Gmail + check si quelqu'un a accès à shawn@`,
        ].filter(Boolean).join('\n');
        await sendTelegramWithFallback(alertMsg, { category: 'audit-sent-anomaly', count: suspects.length }).catch(()=>{});
        auditLogEvent('audit', 'sent_folder_anomaly', { count: suspects.length, suspects: suspects.slice(0, 10) });
      } else {
        log('OK', 'AUDIT', `Sent folder: ${messages.length} email(s) tous tracés dans outbox`);
      }
      _lastSentAuditAt = Date.now();
    } catch (e) {
      log('WARN', 'AUDIT', `Sent audit: ${e.message.substring(0, 150)}`);
    }
  }, 60 * 60 * 1000); // toutes les heures

  // MEMORY MONITORING — alerte si heap >85% (préviens OOM avant crash Render)
  // Render starter plan = 512MB RSS. Node heapTotal s'ajuste dynamiquement mais
  // si heapUsed approche rss limit → pression GC + risque crash.
  let _lastMemAlert = 0;
  setInterval(() => {
    try {
      const mem = process.memoryUsage();
      const heapPct = (mem.heapUsed / mem.heapTotal) * 100;
      const rssMB = Math.round(mem.rss / 1024 / 1024);
      const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
      // Alert si heap >85% ET RSS >400MB (proche limit 512MB Render starter)
      const cooldown = 30 * 60 * 1000; // max 1 alert/30min
      if (heapPct > 85 && rssMB > 400 && Date.now() - _lastMemAlert > cooldown) {
        _lastMemAlert = Date.now();
        log('WARN', 'MEMORY', `Heap ${heapPct.toFixed(0)}% | heap ${heapUsedMB}/${heapTotalMB}MB | RSS ${rssMB}MB`);
        if (typeof sendTelegramWithFallback === 'function') {
          sendTelegramWithFallback(
            `🧠 *Memory pressure élevée*\nHeap ${heapPct.toFixed(0)}% (${heapUsedMB}/${heapTotalMB}MB)\nRSS ${rssMB}MB / ~512MB limit\n\nInvestiguer si persiste — possible memory leak.`,
            { category: 'memory-pressure', heapPct: heapPct.toFixed(0), rssMB }
          ).catch(() => {});
        }
        auditLogEvent('memory', 'high_pressure', { heapPct: heapPct.toFixed(0), heapUsedMB, heapTotalMB, rssMB });
      }
    } catch (e) { /* non-bloquant */ }
  }, 5 * 60 * 1000);

  // AUTO-RECOVERY pendingDocSends — toutes les 2min, retry les envois en attente
  // qui ont plus de 5min. Premier retry possible à ~7min, pas 30min. Max 4 cycles
  // auto (13min total) avant abandon explicite via Telegram. Un prospect attend pas.
  setInterval(async () => {
    if (autoSendPaused || !pendingDocSends || pendingDocSends.size === 0) return;
    const now = Date.now();
    const toRetry = [];
    for (const [email, pending] of pendingDocSends.entries()) {
      const age = now - (pending._firstSeen || now);
      if (age < 5 * 60 * 1000) continue; // <5min → laisse une chance au premier envoi
      pending._recoveryAttempts = (pending._recoveryAttempts || 0) + 1;
      if (pending._recoveryAttempts > 4) continue; // abandon après 4 cycles
      toRetry.push({ email, pending });
    }
    if (!toRetry.length) return;
    log('INFO', 'RECOVERY', `Auto-retry ${toRetry.length} pendingDocSends (>5min)`);
    for (const { email, pending } of toRetry) {
      try {
        // RÈGLE CONSENT: ne retry QUE si Shawn avait déjà confirmé l'envoi
        // (envoyerDocsAuto a échoué après son "envoie"). Sinon, juste notifier.
        if (!pending._shawnConsent) {
          await sendTelegramWithFallback(
            `⏰ *Lead pending sans consent* — ${email}\n` +
            `Match score ${pending.match?.score || '?'} · ${pending.match?.pdfs?.length || '?'} PDFs prêts.\n` +
            `Réponds \`envoie les docs à ${email}\` pour livrer OU \`annule ${email}\`.`,
            { category: 'pending-awaiting-consent', email }
          );
          continue; // pas de retry sans accord explicite
        }
        const r = await envoyerDocsAuto({ ...pending, _shawnConsent: true });
        if (r.sent) {
          pendingDocSends.delete(email);
          await sendTelegramWithFallback(
            `🔄 *Auto-recovery* — docs finalement envoyés à ${email}\n   Après ${pending._recoveryAttempts} tentative(s) de récupération · ${r.match?.pdfs?.length || '?'} PDFs`,
            { category: 'auto-recovery-success', email }
          );
          auditLogEvent('auto-recovery', 'success', { email, attempts: pending._recoveryAttempts });
        } else if (r.skipped) {
          log('INFO', 'RECOVERY', `${email}: skip (${r.reason})`);
        } else if (pending._recoveryAttempts >= 4) {
          await sendTelegramWithFallback(
            `⚠️ *Auto-recovery ABANDONNÉ* pour ${email}\n   ${pending._recoveryAttempts} tentatives ratées — intervention manuelle requise\n   \`envoie les docs à ${email}\``,
            { category: 'auto-recovery-gaveup', email }
          );
          auditLogEvent('auto-recovery', 'gave_up', { email, attempts: pending._recoveryAttempts });
        }
      } catch (e) {
        log('WARN', 'RECOVERY', `${email}: ${e.message.substring(0, 150)}`);
      }
    }
  }, 2 * 60 * 1000); // Toutes les 2min — premier retry possible à ~7min après un fail

  // (pendingDocSends.set wrappé au niveau init — tag _firstSeen + auto-persist)

  // Rafraîchissement BOT_STATUS.md chaque heure (au lieu de 1×/jour)
  // Garantit que Claude Code peut toujours reprendre avec l'état le plus récent
  setInterval(() => syncStatusGitHub().catch(() => {}), 60 * 60 * 1000);

  // Sync bidirectionnelle Claude Code ↔ bot
  // - Lire SESSION_LIVE.md depuis GitHub (ce que Claude Code a écrit) toutes les 3 min
  // - Écrire BOT_ACTIVITY.md vers GitHub (ce que le bot a fait) toutes les 10 min
  setInterval(() => loadSessionLiveContext().catch(() => {}), 3 * 60 * 1000);
  setInterval(() => writeBotActivity().catch(() => {}), 10 * 60 * 1000);

  setInterval(() => {
    const now = new Date();
    const heure    = now.toLocaleString('fr-CA', { hour: 'numeric', hour12: false, timeZone: 'America/Toronto' });
    const h        = parseInt(heure);
    // Fix crash 2026-05-20 'm is not defined': définir m AU NIVEAU DU SETINTERVAL
    // pour que toutes les conditions h+m fonctionnent (avant: m seulement
    // dans le if PROACTIVE_ENABLED, donc crash si désactivé).
    const m        = now.getMinutes();
    const todayStr = now.toDateString();
    if (h === 6  && lastCron.trashCI !== todayStr)  { lastCron.trashCI = todayStr; autoTrashGitHubNoise(); }
    if (h === 7  && lastCron.visites !== todayStr)  { lastCron.visites = todayStr; rappelVisitesMatin(); }
    if (h === 8  && lastCron.digest  !== todayStr)  { lastCron.digest  = todayStr; runDigestJulie(); }
    // 🛡️ Cron purge Pipedrive — TOUTES LES HEURES (pas juste 6h30)
    // 🛑 SHAWN 2026-06-09 RÈGLE ABSOLUE: PAS de suppression Pipedrive auto.
    // 5h du matin = cron a supprimé des activités sans son consentement. Plus jamais.
    // L'automation Pipedrive doit partir DIRECTEMENT de Pipedrive UI (Workflow Automation).
    // Le bot a SEULEMENT le droit de CREATE deal + CREATE activité — JAMAIS DELETE.
    // Cron pipedriveCleanupAuto DÉSACTIVÉ (pour réactiver: retirer ce commentaire).
    // if (m === 30 && lastCron.pdCleanupHour !== `${todayStr}_${h}`) {
    //   lastCron.pdCleanupHour = `${todayStr}_${h}`;
    //   pipedriveCleanupAuto().catch(e => log('WARN', 'CRON', `pdCleanup: ${e.message}`));
    // }
    // 📊 Cron 7h30 — Briefing matin (visites + stagnants + prochaine campagne)
    if (h === 7 && m >= 30 && lastCron.briefing !== todayStr) {
      lastCron.briefing = todayStr;
      briefingMatin().catch(e => log('WARN', 'CRON', `briefing: ${e.message}`));
    }

    // ── Market Intelligence refresh ──────────────────────────────────────────
    // Stratégie Shawn: spot-check toutes 3 semaines (full) + refresh "fresh" sources
    // (taux hypothèque + Banque Canada) toutes 72h
    if (h === 5 && lastCron.marketFullRefresh !== todayStr) {
      // Full refresh: dimanche matin uniquement (1 fois/semaine = ~3 fois en 3 sem)
      // Combiné avec freshCheck → spot-check toutes ~3 semaines comme demandé
      const dayOfWeek = now.getDay(); // 0=Sun
      const snap = (() => { try { return require('./market_intelligence').marketStatus(); } catch { return null; }})();
      const ageHours = snap?.age_hours || 9999;
      // Full scrape si: dimanche matin OU snapshot trop vieux (> 21 jours)
      if (dayOfWeek === 0 || ageHours > 21 * 24) {
        lastCron.marketFullRefresh = todayStr;
        (async () => {
          try {
            const mi = require('./market_intelligence');
            log('INFO', 'MARKET', `Full refresh démarré (snapshot ${ageHours}h ago, dow=${dayOfWeek})`);
            const r = await mi.refreshMarketSnapshot();
            log('OK', 'MARKET', `Full: ${Object.keys(r.data||{}).length} ok, ${Object.keys(r.errors||{}).length} fail`);
          } catch (e) { log('ERR', 'MARKET', `Full refresh: ${e.message}`); }
        })();
      } else {
        // Fresh-only: taux qui bougent souvent (banque_canada, multipret, planipret)
        lastCron.marketFullRefresh = todayStr;
        (async () => {
          try {
            const mi = require('./market_intelligence');
            const r = await mi.refreshMarketSnapshot({ sources: ['banque_canada', 'multipret', 'planipret'] });
            log('OK', 'MARKET', `Fresh refresh: ${Object.keys(r.data||{}).length} ok`);
          } catch (e) { log('ERR', 'MARKET', `Fresh: ${e.message}`); }
        })();
      }
    }

    // ── Pipedrive Proactive — 5 features anti-perte-de-lead ──────────────────
    // 🧊 SUR GLACE — désactivé jusqu'à ordre Shawn. Pour réactiver: tape dans
    // Telegram /setsecret PROACTIVE_ENABLED true → effet immédiat (sans redeploy).
    if (process.env.PROACTIVE_ENABLED === 'true') {
      // m est défini au niveau du setInterval ci-dessus — pas de redéclaration
      if (h === 6 && m === 0 && lastCron.stagnant !== todayStr) {
        lastCron.stagnant = todayStr;
        getProactive()?.stagnantDeals?.().catch(e => log('WARN', 'PROACTIVE', `stagnant: ${e.message}`));
      }
      if (h === 8 && m === 30 && lastCron.morningProactive !== todayStr) {
        lastCron.morningProactive = todayStr;
        getProactive()?.morningReport?.().catch(e => log('WARN', 'PROACTIVE', `morning: ${e.message}`));
      }
      if (h === 17 && m === 0 && lastCron.j1NotCalled !== todayStr) {
        lastCron.j1NotCalled = todayStr;
        getProactive()?.alerteJ1NotCalled?.().catch(e => log('WARN', 'PROACTIVE', `j1: ${e.message}`));
      }
      if (h === 23 && m === 0 && lastCron.hygiene !== todayStr) {
        lastCron.hygiene = todayStr;
        getProactive()?.crmHygiene?.().catch(e => log('WARN', 'PROACTIVE', `hygiene: ${e.message}`));
      }
      if (now.getDay() === 0 && h === 18 && m === 0 && lastCron.weeklyDigest !== todayStr) {
        lastCron.weeklyDigest = todayStr;
        getProactive()?.weeklyDigest?.().catch(e => log('WARN', 'PROACTIVE', `weekly: ${e.message}`));
      }
    }
    // CERVEAU STRATÉGIQUE — rapport hebdo dimanche 7h (Opus 4.8 deep analysis)
    if (now.getDay() === 0 && h === 7 && lastCron.strategic !== todayStr) {
      lastCron.strategic = todayStr;
      analyseStrategique(null).then(report => {
        if (report && !report.startsWith('❌')) {
          sendTelegramWithFallback(`🧠 *Rapport stratégique hebdo*\n\n${report.substring(0, 3500)}`,
            { category: 'weekly-strategic-report' }).catch(() => {});
        }
      }).catch(() => {});
    }
    // J+1/J+3/J+7 sur glace — réactiver avec: lastCron.suivi check + runSuiviQuotidien()
    // if (h === 9  && lastCron.suivi   !== todayStr)  { lastCron.suivi   = todayStr; runSuiviQuotidien(); }

    // ── AUDIT ULTRA QUOTIDIEN 5h matin — auto-cleanup tout (deals/activités/orphans) ──
    if (h === 5 && m === 0 && lastCron.auditUltra !== todayStr) {
      lastCron.auditUltra = todayStr;
      auditPipedriveUltra().then(stats => {
        if (stats && (stats.dealsFusionnes + stats.activitesDoublons + stats.activitesOrphans + stats.activitesSansContact) > 0) {
          sendTelegramWithFallback(
            `🧹 *Audit Pipedrive nocturne*\n\n` +
            `• ${stats.dealsFusionnes} deals doublons fusionnés\n` +
            `• ${stats.activitesDoublons} activités doublons → done\n` +
            `• ${stats.activitesOrphans} orphans supprimées\n` +
            `• ${stats.activitesSansContact} sans contact supprimées\n\n` +
            `_Pipeline propre. 1 deal + 1 activité max par personne._`,
            { category: 'audit-ultra' }
          ).catch(() => {});
        }
      }).catch(e => log('WARN', 'AUDIT', `${e.message}`));
    }

    // ── DEDUP HEBDO dimanche 21h — backup du daily ──
    if (now.getDay() === 0 && h === 21 && m === 0 && lastCron.dedupHebdo !== todayStr) {
      lastCron.dedupHebdo = todayStr;
      runDedupHebdo().catch(e => log('WARN', 'DEDUP', `Hebdo: ${e.message}`));
    }

    // ── VEILLE J-1 SUR RENDER (Shawn 2026-05-13) — source de vérité primaire ─
    // Bug réel (perdu #39 24-avril + #40 8-mai): Mac scheduler.js LaunchAgent
    // dort si Mac fermé pendant la fenêtre 18-23h Eastern. Render tourne 24/7,
    // donc on déplace la veille J-1 ici. La fonction interne fait dédup par
    // campagne (clé veille_<id>_<date>) dans fichier persistent — donc safe
    // même si réessayé plusieurs fois OU si Mac scheduler fait pareil.
    //
    // FENÊTRE ÉLARGIE 19h-23h Eastern (vs h===19 strict avant) — tolère redeploy
    // Render. Toute heure dans la fenêtre = exécution; dédup interne empêche spam.
    if (h >= 19 && h <= 23 && lastCron.veilleCampaign !== todayStr) {
      lastCron.veilleCampaign = todayStr;
      checkVeilleCampagnesBackup().catch(e => log('WARN', 'VEILLE', `${e.message}`));
    }

    // ── SAFETY CHECK CAMPAGNES — TOUTES les heures (Shawn 2026-05-05) ────────
    // Bug réel: campagne #34 [AUTO] Vendeurs scheduled sans approval.
    // Filet de sécurité: scan toutes les campagnes queued/in_process schedulées
    // dans les 48h. Sans approval explicite → suspend + alerte Telegram.
    if (m < 5 && lastCron.safetyHourly !== `${todayStr}-${h}`) {
      lastCron.safetyHourly = `${todayStr}-${h}`;
      safetyCheckCampagnes().catch(e => log('WARN', 'SAFETY', `${e.message}`));
    }
  }, 60 * 1000);
  // MONITORING PROACTIF — vérifie santé système toutes les 10 min, alerte Telegram si problème
  let monitoringState = { pollerAlertSent: false, autoEnvoiStreak: 0, lastAutoEnvoiAlert: 0 };
  setInterval(async () => {
    if (!ALLOWED_ID) return;
    const alerts = [];
    // 1. Poller silence > 10 min
    if (gmailPollerState.lastRun) {
      const minsAgo = (Date.now() - new Date(gmailPollerState.lastRun).getTime()) / 60000;
      if (minsAgo > 10) {
        if (!monitoringState.pollerAlertSent) {
          alerts.push(`🔴 *Gmail Poller silencieux depuis ${Math.round(minsAgo)}min* (devrait tourner aux 5min)`);
          monitoringState.pollerAlertSent = true;
        }
      } else monitoringState.pollerAlertSent = false;
    }
    // 2. Streak échecs auto-envoi (≥3 fails consécutifs → alerte, max 1×/h)
    const recent = (autoEnvoiState.log || []).slice(0, 5);
    const recentFails = recent.slice(0, 3).filter(l => !l.success).length;
    if (recentFails >= 3 && (Date.now() - monitoringState.lastAutoEnvoiAlert) > 3600000) {
      alerts.push(`🔴 *Auto-envoi docs ÉCHOUÉ 3 fois consécutifs* — vérifier Gmail/Dropbox.\n${recent.slice(0,3).map(l => `  • ${l.email}: ${String(l.error).substring(0,60)}`).join('\n')}`);
      monitoringState.lastAutoEnvoiAlert = Date.now();
    }
    // 3. Circuits ouverts prolongés
    for (const [name, c] of Object.entries(circuits)) {
      if (c.openUntil > Date.now() && c.fails >= 10) {
        alerts.push(`🔴 *Circuit ${name} OUVERT* (${c.fails} fails) — API down prolongée`);
      }
    }
    // Envoyer les alertes
    for (const a of alerts) {
      await bot.sendMessage(ALLOWED_ID, a, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }, 10 * 60 * 1000);

  log('OK', 'CRON', 'Tâches: visites 7h, digest 8h→Julie, sync BOT_STATUS chaque heure, monitoring 10min');
}

// ─── Webhooks intelligents ────────────────────────────────────────────────────
async function handleWebhook(route, data) {
  if (!ALLOWED_ID) return;
  try {

    // ── CENTRIS — Lead entrant → deal auto + J+0 prêt ────────────────────────
    if (route === '/webhook/centris') {
      const nom     = (data.nom || data.name || 'Inconnu').trim();
      const tel     = data.telephone || data.tel || data.phone || '';
      const email   = data.email || '';
      const listing = data.url_listing || data.url || data.centris_url || '';
      const typeRaw = (data.type || listing).toLowerCase();

      // DÉDUP CROSS-SOURCE multi-clé: si ce lead a déjà été notifié (par email,
      // tel, centris# OU nom+source), skip. Évite doublons quand Centris webhook
      // + Gmail email pour le même prospect.
      const centrisForDedup = listing.match(/\/(\d{7,9})\b/)?.[1] || data.centris || '';
      if (leadAlreadyNotifiedRecently({ email, telephone: tel, centris: centrisForDedup, nom, source: 'centris' })) {
        log('INFO', 'WEBHOOK', `Centris dédup: ${nom} (${email||tel||centrisForDedup}) déjà notifié — skip`);
        return;
      }

      // Détecter le type depuis l'URL ou les données
      let type = 'terrain';
      if (/maison|house|résidentiel|residential/.test(typeRaw))    type = 'maison_usagee';
      else if (/plex|duplex|triplex|quadruplex/.test(typeRaw))     type = 'plex';
      else if (/construction|neuve?|new/.test(typeRaw))            type = 'construction_neuve';

      // Extraire numéro Centris de l'URL
      const centrisMatch = listing.match(/\/(\d{7,9})\b/);
      const centrisNum   = centrisMatch?.[1] || data.centris || '';

      // AUTO-CRÉER le deal dans Pipedrive
      let dealResult = null;
      let dealId     = null;
      if (PD_KEY) {
        try {
          const parts = nom.split(' ');
          dealResult = await creerDeal({
            prenom: parts[0], nom: parts.slice(1).join(' '),
            telephone: tel, email, type,
            source: 'centris', centris: centrisNum,
            note: `Lead Centris — ${new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}\nURL: ${listing}`
          });
          // Récupérer l'ID du deal créé pour le J+0
          const sr = await pdGet(`/deals/search?term=${encodeURIComponent(nom)}&limit=1`);
          dealId = sr?.data?.items?.[0]?.item?.id;
        } catch(e) { dealResult = `⚠️ Erreur deal: ${e.message}`; }
      }

      // Brouillon J+0 automatique
      const typeLabel = { terrain:'terrain', maison_usagee:'propriété', plex:'plex', construction_neuve:'construction neuve' }[type] || 'propriété';
      const j0texte = `Bonjour,\n\nMerci de votre intérêt pour ce ${typeLabel}${centrisNum ? ` (Centris #${centrisNum})` : ''}.\n\nJe communique avec vous pour vous donner plus d'informations et répondre à vos questions. Quand seriez-vous disponible pour qu'on se parle?\n\nAu plaisir,\n${AGENT.nom}\n${AGENT.titre} | ${AGENT.compagnie}\n📞 ${AGENT.telephone}\n${AGENT.email}`;

      if (email) {
        pendingEmails.set(ALLOWED_ID, { to: email, toName: nom, sujet: `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} — ${AGENT.compagnie}`, texte: j0texte });
      }

      let msg = `🏡 *Nouveau lead Centris!*\n\n👤 *${nom}*${tel ? '\n📞 ' + tel : ''}${email ? '\n✉️ ' + email : ''}${listing ? '\n🔗 ' + listing : ''}\nType: ${type}${centrisNum ? ' | #' + centrisNum : ''}\n\n`;
      msg += dealResult ? `${dealResult}\n\n` : '';
      if (email) {
        msg += `📧 *J+0 prêt:*\n_"${j0texte.substring(0, 120)}..."_\n\nDis *"envoie"* pour envoyer maintenant.`;
      } else {
        msg += `⚠️ Pas d'email — appelle directement: ${tel || 'tel non fourni'}`;
      }
      await sendTelegramWithFallback(msg, { category: 'webhook-centris', centris: centrisNum, email });
      // Mark dedup APRÈS notification — si crash avant, webhook retry ne causera pas doublon
      markLeadProcessed({ email, telephone: tel, centris: centrisForDedup, nom, source: 'centris' });
    }

    // ── SMS ENTRANT — Match Pipedrive + contexte + brouillon réponse ──────────
    if (route === '/webhook/sms') {
      const from  = data.from || data.numero || '';
      const msg   = data.body || data.message || '';
      const nom   = data.nom || '';

      let contextMsg = `📱 *SMS entrant*\n\nDe: *${nom || from}*\n_"${msg.substring(0, 300)}"_\n\n`;

      // Chercher dans Pipedrive par téléphone ou nom
      let dealContext = '';
      if (PD_KEY && (from || nom)) {
        try {
          const terme = nom || from.replace(/\D/g, '');
          const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=1`);
          const deal = sr?.data?.items?.[0]?.item;
          if (deal) {
            const stage = PD_STAGES[deal.stage_id] || deal.stage_id;
            dealContext = `📊 *Pipedrive:* ${deal.title} — ${stage}\n\n`;
            // Brouillon réponse rapide
            const reponse = `Bonjour,\n\nMerci pour votre message. Je vous reviens rapidement.\n\nAu plaisir,\n${AGENT.nom}\n${AGENT.titre} | ${AGENT.compagnie}\n📞 ${AGENT.telephone}\n${AGENT.email}`;
            if (deal.person_id) {
              const person = await pdGet(`/persons/${deal.person_id}`);
              const emailP = person?.data?.email?.[0]?.value;
              if (emailP) {
                pendingEmails.set(ALLOWED_ID, { to: emailP, toName: deal.title, sujet: 'RE: votre message', texte: reponse });
                dealContext += `📧 Réponse email prête — dis *"envoie"* ou modifie d'abord.\n\n`;
              }
            }
          } else {
            dealContext = `❓ *Pas trouvé dans Pipedrive* — dis "crée prospect ${nom || from}" si nouveau.\n\n`;
          }
        } catch {}
      }

      await bot.sendMessage(ALLOWED_ID, contextMsg + dealContext + `_Dis "voir ${nom || from}" pour le contexte complet._`, { parse_mode: 'Markdown' });

      // Ajouter note Pipedrive si deal trouvé
      if (PD_KEY && (nom || from)) {
        const sr = await pdGet(`/deals/search?term=${encodeURIComponent(nom || from)}&limit=1`).catch(() => null);
        const deal = sr?.data?.items?.[0]?.item;
        if (deal) await pdPost('/notes', { deal_id: deal.id, content: `SMS reçu: "${msg}"` }).catch(() => {});
      }
    }

    // ── REPLY EMAIL — Prospect a répondu → contexte + brouillon ─────────────
    if (route === '/webhook/reply') {
      const de    = data.from || data.email || '';
      const sujet = data.subject || '';
      const corps = (data.body || data.text || '').trim();
      const nom   = data.nom || de.split('@')[0];

      let contextMsg = `📧 *Réponse de prospect!*\n\nDe: *${nom}* (${de})\nObjet: ${sujet}\n\n_"${corps.substring(0, 400)}${corps.length > 400 ? '...' : ''}"_\n\n`;

      // Chercher dans Pipedrive + charger contexte
      let dealContext = '';
      if (PD_KEY && de) {
        try {
          const sr = await pdGet(`/deals/search?term=${encodeURIComponent(nom)}&limit=1`);
          const deal = sr?.data?.items?.[0]?.item;
          if (deal) {
            const stage = PD_STAGES[deal.stage_id] || deal.stage_id;
            dealContext = `📊 *Pipedrive:* ${deal.title} — ${stage}\n`;
            // Avancer l'étape si premier contact
            if (deal.stage_id === 49) {
              await pdPut(`/deals/${deal.id}`, { stage_id: 50 }).catch(() => {});
              dealContext += `➡️ Étape: Nouveau lead → *Contacté* ✅\n`;
            }
            // Ajouter note
            await pdPost('/notes', { deal_id: deal.id, content: `Email reçu [${sujet}]: "${corps.substring(0, 500)}"` }).catch(() => {});
            dealContext += `📝 Note ajoutée dans Pipedrive\n\n`;

            // Brouillon réponse
            const reponse = `Bonjour,\n\nMerci pour votre réponse. Je vous reviens dès que possible.\n\nAu plaisir,\n${AGENT.nom}\n${AGENT.titre} | ${AGENT.compagnie}\n📞 ${AGENT.telephone}\n${AGENT.email}`;
            pendingEmails.set(ALLOWED_ID, { to: de, toName: nom, sujet: `RE: ${sujet}`, texte: reponse });
            dealContext += `📧 Brouillon réponse prêt — dis *"envoie"* ou précise ce que tu veux répondre.`;
          } else {
            dealContext = `❓ *${nom}* pas dans Pipedrive.\nDis "crée prospect ${nom}" si c'est un nouveau lead.\n\nBrouillon réponse? Dis "réponds à ${nom}"`;
          }
        } catch(e) { dealContext = `_(Pipedrive: ${e.message.substring(0,80)})_`; }
      }

      await bot.sendMessage(ALLOWED_ID, contextMsg + dealContext, { parse_mode: 'Markdown' });
    }

  } catch (e) { log('ERR', 'WEBHOOK', e.message); }
}

// ─── Arrêt propre ─────────────────────────────────────────────────────────────
// Graceful shutdown: flush TOUT sur disque + attendre traitements en cours max 15s
// avant d'exit. Render envoie SIGTERM puis kill dans 30s → on a le temps.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', 'SHUTDOWN', `${signal} reçu — arrêt propre démarré`);

  const timeoutMs = 15000;
  const start = Date.now();

  // 1. Stop acceptation nouvelles tâches (timer save + poller handled elsewhere)
  if (typeof saveTimer !== 'undefined' && saveTimer) clearTimeout(saveTimer);

  // 2. Flush TOUT l'état sur disque (synchrone pour garantir)
  try {
    saveJSON(HIST_FILE, Object.fromEntries(chats));
    log('OK', 'SHUTDOWN', 'chats history flushé');
  } catch (e) { log('WARN', 'SHUTDOWN', `chats: ${e.message}`); }
  try {
    if (typeof savePendingLeads === 'function') savePendingLeads();
    if (typeof savePendingDocs === 'function') savePendingDocs();
    if (typeof saveLeadRetryState === 'function') saveLeadRetryState();
    if (typeof saveLeadsDedup === 'function') saveLeadsDedup();
    if (typeof gmailPollerState !== 'undefined') saveJSON(POLLER_FILE, gmailPollerState);
    if (typeof autoEnvoiState !== 'undefined') saveJSON(AUTOENVOI_FILE, autoEnvoiState);
    log('OK', 'SHUTDOWN', 'pending/retry/dedup/poller/autoenvoi flushés');
  } catch (e) { log('WARN', 'SHUTDOWN', `state flush: ${e.message}`); }

  // 3. Backup Gist (async mais borné)
  try {
    await Promise.race([
      saveMemoryToGist().catch(() => {}),
      new Promise(r => setTimeout(r, 5000)),
    ]);
    await Promise.race([
      (typeof savePollerStateToGist === 'function' ? savePollerStateToGist() : Promise.resolve()).catch(() => {}),
      new Promise(r => setTimeout(r, 5000)),
    ]);
    log('OK', 'SHUTDOWN', 'Gist backup tenté');
  } catch {}

  const elapsed = Date.now() - start;
  log('OK', 'SHUTDOWN', `arrêt propre complet en ${elapsed}ms`);
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ─── HTTP server (health + webhooks) ─────────────────────────────────────────
// ─── Security headers (helmet-like, sans dépendance Express) ──────────────────
// Appliqués à toutes les réponses pour XSS/clickjacking/MIME-sniff protection
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
}

const server = http.createServer(async (req, res) => {
  applySecurityHeaders(res);
  const url = (req.url || '/').split('?')[0];

  // ── Kubernetes-style health probes ────────────────────────────────────────
  // /healthz: liveness (le process tourne)
  // /readyz: readiness (toutes les deps OK)
  // Existing /health: full JSON détaillé (observabilité)
  if (req.method === 'GET' && url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  if (req.method === 'GET' && url === '/readyz') {
    // Ready si Anthropic + Brevo + Pipedrive keys présents
    const ready = !!(process.env.ANTHROPIC_API_KEY && process.env.BREVO_API_KEY && process.env.PIPEDRIVE_API_KEY);
    res.writeHead(ready ? 200 : 503, { 'Content-Type': 'text/plain' });
    res.end(ready ? 'READY' : 'NOT_READY');
    return;
  }

  // ── Health endpoint détaillé (JSON) — observabilité complète ──────────────
  if (req.method === 'GET' && url === '/health') {
    const uptimeS = Math.floor((Date.now() - metrics.startedAt) / 1000);
    const commit = (process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown').substring(0, 7);
    const branch = process.env.RENDER_GIT_BRANCH || 'unknown';
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime_sec: uptimeS,
      uptime_human: `${Math.floor(uptimeS/3600)}h ${Math.floor((uptimeS%3600)/60)}m`,
      commit,
      branch,
      model: currentModel,
      thinking: thinkingMode,
      tools: TOOLS.length,
      mémos: kiramem.facts.length,
      subsystems: {
        pipedrive:  !!PD_KEY,
        brevo:      !!BREVO_KEY,
        gmail:      !!(process.env.GMAIL_CLIENT_ID && gmailToken),
        dropbox:    !!dropboxToken,
        centris:    centrisSession.authenticated,
        github:     !!process.env.GITHUB_TOKEN,
        whisper:    !!process.env.OPENAI_API_KEY,
        gist:       !!gistId,
      },
      metrics,
      circuits: Object.fromEntries(
        Object.entries(circuits).map(([k,v]) => [k, {
          fails: v.fails,
          open:  Date.now() < v.openUntil,
          open_remaining_sec: Math.max(0, Math.ceil((v.openUntil - Date.now())/1000)),
        }])
      ),
      session_live_kb: Math.round((sessionLiveContext?.length||0)/1024),
      dropbox_terrains: dropboxTerrains.length,
      gmail_poller: {
        total_leads: gmailPollerState.totalLeads||0,
        last_run: gmailPollerState.lastRun,
        stats: pollerStats,  // runs + lastScan breakdown + totals + lastError
      },
      cost: {
        today_usd:       Number((costTracker.daily[today()] || 0).toFixed(4)),
        this_month_usd:  Number((costTracker.monthly[thisMonth()] || 0).toFixed(2)),
        total_usd:       Number(costTracker.total.toFixed(2)),
        by_model:        Object.fromEntries(Object.entries(costTracker.byModel).map(([k,v])=>[k, Number(v.toFixed(2))])),
      },
      webhook_health: global.__webhookHealth || { status: 'not_initialized' },
      health_score: computeHealthScore(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health, null, 2));
    return;
  }

  // ── Dashboard HTML — stats temps réel avec branding Signature SB ──────────
  if (req.method === 'GET' && url === '/dashboard') {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized — add ?token=WEBHOOK_SECRET');
      return;
    }
    const uptimeS = Math.floor((Date.now() - metrics.startedAt) / 1000);
    const pollerLast = gmailPollerState.lastRun ? new Date(gmailPollerState.lastRun) : null;
    const minsAgo = pollerLast ? Math.floor((Date.now() - pollerLast.getTime()) / 60000) : null;
    const autoStats = {
      total: autoEnvoiState.totalAuto || 0,
      fails: autoEnvoiState.totalFails || 0,
      rate: ((autoEnvoiState.totalAuto||0) + (autoEnvoiState.totalFails||0)) > 0
        ? Math.round(100 * (autoEnvoiState.totalAuto||0) / ((autoEnvoiState.totalAuto||0) + (autoEnvoiState.totalFails||0)))
        : 0,
    };
    const recent = (autoEnvoiState.log || []).slice(0, 10);
    const avgMs = recent.filter(l => l.success).reduce((s, l, _, a) => s + (l.deliveryMs||0)/(a.length||1), 0);
    const pollerHealth = minsAgo === null ? '⚪ jamais' : minsAgo > 10 ? `🔴 ${minsAgo}min` : `🟢 ${minsAgo}min`;
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard — Signature SB Bot</title><style>
body{margin:0;background:#0a0a0a;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;padding:16px;}
.container{max-width:900px;margin:0 auto}
.header{border-bottom:3px solid #aa0721;padding:20px 0;margin-bottom:24px}
.header h1{margin:0;font-size:22px;letter-spacing:2px;text-transform:uppercase}
.header .sub{color:#888;font-size:12px;margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:24px}
.card{background:#111;border:1px solid #1e1e1e;border-left:3px solid #aa0721;border-radius:4px;padding:16px 18px}
.card .label{color:#888;font-size:10px;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px}
.card .value{font-family:Georgia,serif;font-size:32px;font-weight:700;line-height:1}
.card .sub{color:#aaa;font-size:12px;margin-top:6px}
.green{color:#34c759}
.red{color:#ff3b30}
.yellow{color:#ffcc00}
h2{color:#aa0721;font-size:11px;text-transform:uppercase;letter-spacing:3px;margin:24px 0 12px;border-bottom:1px solid #1e1e1e;padding-bottom:8px}
.log{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:4px;padding:14px;font-family:'SF Mono',Menlo,monospace;font-size:12px;line-height:1.7}
.log .ok{color:#34c759}
.log .fail{color:#ff3b30}
.footer{margin-top:40px;padding-top:16px;border-top:1px solid #1e1e1e;color:#666;font-size:11px;text-align:center}
</style></head><body><div class="container">
<div class="header"><h1>Signature SB — Dashboard Bot</h1><div class="sub">Temps réel · ${new Date().toLocaleString('fr-CA',{timeZone:'America/Toronto'})}</div></div>
<h2>🚀 Auto-envoi docs</h2>
<div class="grid">
  <div class="card"><div class="label">Total envoyés</div><div class="value green">${autoStats.total}</div><div class="sub">depuis démarrage</div></div>
  <div class="card"><div class="label">Échecs</div><div class="value ${autoStats.fails > 0 ? 'red' : ''}">${autoStats.fails}</div><div class="sub">après 3 retries</div></div>
  <div class="card"><div class="label">Taux succès</div><div class="value ${autoStats.rate >= 90 ? 'green' : autoStats.rate >= 70 ? 'yellow' : 'red'}">${autoStats.rate}%</div><div class="sub">global</div></div>
  <div class="card"><div class="label">Temps moyen</div><div class="value">${Math.round(avgMs/1000)}s</div><div class="sub">lead → docs envoyés</div></div>
</div>
<h2>📧 Gmail Poller</h2>
<div class="grid">
  <div class="card"><div class="label">Leads traités</div><div class="value">${gmailPollerState.totalLeads || 0}</div><div class="sub">total depuis boot</div></div>
  <div class="card"><div class="label">Dernier scan</div><div class="value" style="font-size:16px">${pollerHealth}</div><div class="sub">scan toutes les 5min</div></div>
  <div class="card"><div class="label">IDs mémorisés</div><div class="value" style="font-size:24px">${(gmailPollerState.processed||[]).length}</div><div class="sub">anti-doublon</div></div>
  <div class="card"><div class="label">Uptime bot</div><div class="value" style="font-size:18px">${Math.floor(uptimeS/3600)}h ${Math.floor((uptimeS%3600)/60)}m</div></div>
</div>
<h2>🏠 Pipeline</h2>
<div class="grid">
  <div class="card"><div class="label">Dropbox</div><div class="value" style="font-size:24px">${dropboxTerrains.length}</div><div class="sub">dossiers terrain en cache</div></div>
  <div class="card"><div class="label">Modèle IA</div><div class="value" style="font-size:16px">${currentModel.replace('claude-','')}</div><div class="sub">thinking: ${thinkingMode}</div></div>
  <div class="card"><div class="label">Tools actifs</div><div class="value">${TOOLS.length}</div><div class="sub">Pipedrive · Gmail · Dropbox</div></div>
  <div class="card"><div class="label">Mémos Kira</div><div class="value">${kiramem.facts.length}</div></div>
</div>
<h2>📋 10 derniers auto-envois</h2>
<div class="log">${recent.length === 0 ? '<span style="color:#666">Aucun auto-envoi encore</span>' : recent.map(l => {
  const when = new Date(l.timestamp).toLocaleString('fr-CA',{timeZone:'America/Toronto',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  return l.success
    ? `<span class="ok">✅</span> <span style="color:#888">${when}</span> · <strong>${l.email}</strong> · ${l.pdfsCount} PDFs · ${l.strategy}(${l.score}) · ${Math.round(l.deliveryMs/1000)}s`
    : `<span class="fail">❌</span> <span style="color:#888">${when}</span> · ${l.email} · ${String(l.error).substring(0, 80)}`;
}).join('<br>')}</div>
<div class="footer">Signature SB · Bot Kira · auto-refresh manuel · <a href="/health" style="color:#aa0721">/health JSON</a></div>
</div></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // Root '/' uniquement — PAS un catch-all (sinon ça mange les /admin/*)
  if (req.method === 'GET' && (url === '/' || url === '')) {
    const commit = (process.env.RENDER_GIT_COMMIT || 'unknown').substring(0, 7);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Assistant SignatureSB OK — ${new Date().toISOString()} — tools:${TOOLS.length} — mémos:${kiramem.facts.length} — commit:${commit}`);
    return;
  }
  // /version — commit SHA + uptime (public, pas de token requis)
  if (req.method === 'GET' && url === '/version') {
    const commit = (process.env.RENDER_GIT_COMMIT || 'unknown').substring(0, 7);
    const uptimeS = Math.floor((Date.now() - metrics.startedAt) / 1000);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ commit, branch: process.env.RENDER_GIT_BRANCH, uptime_sec: uptimeS, model: currentModel, tools: TOOLS.length }));
    return;
  }

  // ── Admin endpoints — protégés par WEBHOOK_SECRET (accès assistant) ──────
  // /admin/audit?token=X → dump complet pour diagnostic à distance (leads,
  // pending, poller stats, audit log, dernières erreurs). Utilisé par Claude
  // Code pour investiguer sans roundtrip Telegram.
  // EXACT match /admin/audit (legacy with token) — pas startsWith pour ne pas
  // capturer /admin/auditlog (nouveau, sans token).
  if (req.method === 'GET' && url === '/admin/audit') {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    const filter = ((req.url || '').split('q=')[1]?.split('&')[0] || '').toLowerCase();
    let events = auditLog.slice(-100).reverse();
    if (filter) {
      const f = decodeURIComponent(filter);
      events = events.filter(e => JSON.stringify(e).toLowerCase().includes(f));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      now: new Date().toISOString(),
      auditLog: events.slice(0, 50),
      auditTotal: auditLog.length,
      pendingLeads: pendingLeads.slice(-20),
      pendingDocSends: [...(pendingDocSends?.values() || [])].map(p => ({
        email: p.email, nom: p.nom, centris: p.centris,
        score: p.match?.score, folder: p.match?.folder?.name,
        pdfs: p.match?.pdfs?.length,
      })),
      pollerStats,
      gmailPollerState: {
        lastRun: gmailPollerState.lastRun,
        totalLeads: gmailPollerState.totalLeads,
        processedCount: gmailPollerState.processed?.length || 0,
        last10Processed: (gmailPollerState.processed || []).slice(-10),
      },
      autoSendPaused,
      autoEnvoiState: {
        totalAuto: autoEnvoiState?.totalAuto || 0,
        totalFails: autoEnvoiState?.totalFails || 0,
        last5: (autoEnvoiState?.log || []).slice(0, 5),
      },
      metrics: { ...metrics, tools: undefined },
      lastApiError: metrics.lastApiError,
    }, null, 2));
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONFIRM/CANCEL CAMPAIGN — migré du confirm_server Mac → Render direct
  // Élimine dépendance Cloudflare Worker + tunnel (cause des 3 alertes 530 du matin).
  // URL stable: https://signaturesb-bot-s272.onrender.com/confirm?id=X&tok=Y&segment=Z
  // HMAC SHA256 via CONFIRM_SECRET env var (même secret que confirm_server Mac).
  // ═══════════════════════════════════════════════════════════════════════════
  if ((req.method === 'GET') && (url.startsWith('/confirm') || url.startsWith('/cancel'))) {
    try {
      const u = new URL(req.url, 'http://x');
      const campaignId = parseInt(u.searchParams.get('id'));
      const tok = u.searchParams.get('tok') || '';
      const segment = u.searchParams.get('segment') || 'Campagne';
      const action = url.startsWith('/confirm') ? 'confirm' : 'cancel';
      const pageHTML = (emoji, titre, sousTitre, couleur = '#aa0721') => `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titre}</title></head><body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0a;font-family:-apple-system,BlinkMacSystemFont,sans-serif;"><div style="text-align:center;padding:40px 24px;max-width:340px;"><div style="font-size:64px;margin-bottom:20px;">${emoji}</div><div style="color:#f5f5f7;font-size:22px;font-weight:700;margin-bottom:12px;">${titre}</div><div style="color:#666;font-size:14px;line-height:1.6;">${sousTitre}</div><div style="margin-top:28px;color:${couleur};font-size:10px;font-weight:700;letter-spacing:2px;">SIGNATURE SB · RE/MAX PRESTIGE</div></div></body></html>`;
      if (!campaignId) { res.writeHead(400); res.end('ID manquant'); return; }
      // Validation HMAC token
      const secret = process.env.CONFIRM_SECRET || '';
      if (!secret) { res.writeHead(503); res.end('CONFIRM_SECRET non configuré'); return; }
      const expected = crypto.createHmac('sha256', secret).update(String(campaignId)).digest('hex').slice(0, 16);
      let valid = false;
      try {
        valid = tok.length === expected.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(expected));
      } catch {}
      if (!valid) {
        log('WARN', 'CONFIRM', `Token invalide ${action} #${campaignId} from ${req.socket.remoteAddress}`);
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageHTML('⛔', 'Lien expiré', 'Ce lien est périmé. Utilise le DERNIER email de veille reçu (le plus récent) — c\'est lui qui a le bon bouton.', '#aa0721'));
        return;
      }
      // Brevo API call
      const newStatus = action === 'confirm' ? 'queued' : 'suspended';
      const brevoRes = await fetch(`https://api.brevo.com/v3/emailCampaigns/${campaignId}/status`, {
        method: 'PUT',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      if (!brevoRes.ok && brevoRes.status !== 400) {
        const err = await brevoRes.text();
        log('ERR', 'CONFIRM', `Brevo ${action} #${campaignId} HTTP ${brevoRes.status}: ${err.substring(0, 200)}`);
        res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(pageHTML('❌', 'Erreur', `Brevo HTTP ${brevoRes.status}`));
        return;
      }
      log('OK', 'CONFIRM', `${action.toUpperCase()} #${campaignId} (${segment}) — status → ${newStatus}`);
      auditLogEvent('campaign', action, { id: campaignId, segment, ip: req.socket.remoteAddress });
      // Push to campaignApprovals registry (pour safetyCheck cron)
      try {
        if (action === 'confirm' && campaignApprovals?.approved) {
          campaignApprovals.approved[campaignId] = { at: new Date().toISOString(), via: 'email-confirm-link', segment };
          saveJSON(APPROVAL_FILE, campaignApprovals);
        }
      } catch {}
      const html = action === 'confirm'
        ? pageHTML('✅', 'Activée', `La campagne ${segment} est en file d'attente.`, '#aa0721')
        : pageHTML('🚫', 'Envoi annulé', `${segment} ne partira pas.`, '#555');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (e) {
      log('ERR', 'CONFIRM', `Exception: ${e.message}`);
      res.writeHead(500); res.end('Server error');
    }
    return;
  }

  // /admin/logs?token=X&tail=200&cat=POLLER&level=WARN — ring buffer logs
  if (req.method === 'GET' && url.startsWith('/admin/logs')) {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    const tail = Math.min(500, parseInt((req.url || '').split('tail=')[1]?.split('&')[0] || '200'));
    const catFilter = decodeURIComponent((req.url || '').split('cat=')[1]?.split('&')[0] || '');
    const levelFilter = decodeURIComponent((req.url || '').split('level=')[1]?.split('&')[0] || '');
    let entries = logRingBuffer.slice(-tail);
    if (catFilter) entries = entries.filter(e => String(e.cat).toUpperCase().includes(catFilter.toUpperCase()));
    if (levelFilter) entries = entries.filter(e => String(e.niveau).toUpperCase() === levelFilter.toUpperCase());
    // Text format par défaut (facile à lire), ?format=json pour JSON
    const format = (req.url || '').split('format=')[1]?.split('&')[0];
    if (format === 'json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: entries.length, bufferSize: logRingBuffer.length, entries }, null, 2));
    } else {
      const lines = entries.map(e => {
        const ts = new Date(e.ts).toISOString();
        return `${ts} ${e.niveau.padEnd(4)} [${e.cat.padEnd(10)}] ${e.msg}`;
      }).join('\n');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(`# logs (${entries.length}/${logRingBuffer.length})\n${lines}\n`);
    }
    return;
  }

  // /admin/diagnose?token=X — diag live via HTTP (sans Telegram)
  if (req.method === 'GET' && url.startsWith('/admin/diagnose')) {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    const checks = {};
    // Gmail
    try { const r = await gmailAPI('/messages?maxResults=1').catch(() => null); checks.gmailAPI = !!r?.messages; } catch { checks.gmailAPI = false; }
    try { const t = await getGmailToken(); checks.gmailToken = !!t; } catch { checks.gmailToken = false; }
    // Dropbox
    try { const r = await dropboxAPI('https://api.dropboxapi.com/2/users/get_current_account', {}); checks.dropboxAPI = !!r?.ok; } catch { checks.dropboxAPI = false; }
    checks.dropboxIndex = (dropboxIndex?.folders?.length || 0) > 10;
    // Pipedrive
    if (PD_KEY) { try { const r = await pdGet('/users/me').catch(() => null); checks.pipedrive = !!r?.data; } catch { checks.pipedrive = false; } }
    else checks.pipedrive = false;
    // Anthropic
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10000),
      });
      checks.anthropic = r.ok;
    } catch { checks.anthropic = false; }
    // Telegram
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      checks.telegramWebhook = !!j.result?.url;
      checks.telegramPendingUpdates = j.result?.pending_update_count || 0;
    } catch { checks.telegramWebhook = false; }
    // State
    checks.dataDir = DATA_DIR;
    checks.pendingDocs = pendingDocSends.size;
    checks.pendingNames = pendingLeads.filter(l => l.needsName).length;
    checks.processedMsgIds = gmailPollerState.processed.length;
    checks.dedupKeys = recentLeadsByKey.size;
    checks.lastPollerRun = gmailPollerState.lastRun;
    checks.autoSendPaused = autoSendPaused;
    checks.healthScore = computeHealthScore();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ at: new Date().toISOString(), checks }, null, 2));
    return;
  }

  // POST /admin/retry-centris?token=X&centris=123 — force-retry lead par Centris#
  if (req.method === 'POST' && url.startsWith('/admin/retry-centris')) {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    const centrisNum = ((req.url || '').split('centris=')[1]?.split('&')[0] || '').replace(/\D/g, '');
    if (!centrisNum || centrisNum.length < 7) {
      res.writeHead(400); res.end('centris# (7-9 digits) requis'); return;
    }
    // Purger clés dedup
    let purgedKeys = 0;
    for (const k of [...recentLeadsByKey.keys()]) {
      if (k === 'c:' + centrisNum) { recentLeadsByKey.delete(k); purgedKeys++; }
    }
    // Purger msgIds processed
    let purgedIds = 0, extractedCount = 0;
    try {
      const list = await gmailAPI(`/messages?maxResults=20&q=${encodeURIComponent(centrisNum)}`).catch(() => null);
      for (const m of list?.messages || []) {
        const idx = gmailPollerState.processed.indexOf(m.id);
        if (idx >= 0) { gmailPollerState.processed.splice(idx, 1); purgedIds++; }
        if (leadRetryState[m.id]) delete leadRetryState[m.id];
        try {
          const full = await gmailAPI(`/messages/${m.id}?format=full`).catch(() => null);
          if (full) {
            const hdrs = full.payload?.headers || [];
            const get = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
            const lead = parseLeadEmail(gmailExtractBody(full.payload), get('subject'), get('from'));
            const source = detectLeadSource(get('from'), get('subject'));
            if (source) {
              for (const k of buildLeadKeys({ ...lead, centris: lead.centris || centrisNum, source: source.source })) {
                if (recentLeadsByKey.has(k)) { recentLeadsByKey.delete(k); purgedKeys++; }
              }
              extractedCount++;
            }
          }
        } catch {}
      }
      saveLeadRetryState(); saveLeadsDedup(); saveJSON(POLLER_FILE, gmailPollerState);
    } catch (e) { /* log and continue */ }
    // Kick off async scan
    runGmailLeadPoller({ forceSince: '48h' }).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, centrisNum, purgedKeys, purgedIds, extractedCount, scanTriggered: true }));
    return;
  }

  // POST /admin/firecrawl/clear-cache?token=X — vide le cache scraping
  if (req.method === 'POST' && url.startsWith('/admin/firecrawl/clear-cache')) {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    try {
      const { clearCache } = require('./firecrawl_scraper');
      const r = clearCache();
      res.writeHead(r.ok ? 200 : 500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  // POST /admin/flush-pending?token=X — retry tous les pendingDocSends immédiatement
  if (req.method === 'POST' && url.startsWith('/admin/flush-pending')) {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    const results = [];
    for (const [email, pending] of [...pendingDocSends.entries()]) {
      try {
        // Admin token = Shawn's authorized tool → consent implicite
        const r = await envoyerDocsAuto({ ...pending, _shawnConsent: true });
        if (r.sent) { pendingDocSends.delete(email); results.push({ email, sent: true }); }
        else results.push({ email, sent: false, reason: r.reason || r.error });
      } catch (e) { results.push({ email, sent: false, error: e.message.substring(0, 150) }); }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, count: results.length, results }));
    return;
  }

  // POST /admin/test-email?token=X&centris=123&email=x@y.com — simule lead factice
  if (req.method === 'POST' && url.startsWith('/admin/test-email')) {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    const centrisNum = ((req.url || '').split('centris=')[1]?.split('&')[0] || '').replace(/\D/g, '');
    const email = decodeURIComponent((req.url || '').split('email=')[1]?.split('&')[0] || 'test-prospect@example.com');
    if (!centrisNum) { res.writeHead(400); res.end('centris# requis'); return; }
    const fakeLead = { nom: 'Test Prospect', telephone: '5145551234', email, centris: centrisNum, adresse: '', type: 'terrain' };
    const fakeMsgId = `admintest_${Date.now()}`;
    try {
      const result = await traiterNouveauLead(
        fakeLead, fakeMsgId, 'Admin Test <admin@bot>', `TEST — Demande Centris #${centrisNum}`,
        { source: 'centris', label: 'Centris.ca (ADMIN TEST)' }, { skipDedup: true }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result, msgId: fakeMsgId }, null, 2));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (req.method === 'GET' && url === '/admin/chat-history') {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    const history = getHistory(ALLOWED_ID).slice(-30).map(m => ({
      role: m.role,
      // Truncate pour éviter payloads énormes
      content: typeof m.content === 'string' ? m.content.substring(0, 2000) : JSON.stringify(m.content).substring(0, 2000),
      ts: m.ts,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ history, total: getHistory(ALLOWED_ID).length, audit: auditLog.slice(-20) }, null, 2));
    return;
  }

  // ── Webhook Telegram — PROTÉGÉ par X-Telegram-Bot-Api-Secret-Token ───────
  // Sans ce header, n'importe qui peut injecter des commandes dans le bot.
  // Le secret est configuré côté Telegram via setWebhook(secret_token).
  if (req.method === 'POST' && url === '/webhook/telegram') {
    // Rate limit: Telegram peut envoyer plusieurs updates/min en burst
    if (!webhookRateOK(req.socket.remoteAddress, url, 120)) {
      log('WARN', 'SECURITY', `Webhook Telegram rate-limited from ${req.socket.remoteAddress}`);
      res.writeHead(429); res.end('too many requests'); return;
    }
    const tgSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    if (tgSecret && provided !== tgSecret) {
      log('WARN', 'SECURITY', `Webhook Telegram — bad/missing secret-token from ${ip}`);
      res.writeHead(401); res.end('unauthorized'); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200); res.end('ok');
      try {
        const update = JSON.parse(body || '{}');
        bot.processUpdate(update);
      } catch (e) { log('WARN', 'TG', `processUpdate: ${e.message}`); }
    });
    return;
  }

  // ── Webhook GitHub — PROTÉGÉ par HMAC SHA-256 signature ──────────────────
  if (req.method === 'POST' && url === '/webhook/github') {
    const ghSecret = process.env.GITHUB_WEBHOOK_SECRET;
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on('end', async () => {
      if (ghSecret) {
        const crypto = require('crypto');
        const sig = req.headers['x-hub-signature-256'] || '';
        const expected = 'sha256=' + crypto.createHmac('sha256', ghSecret).update(body).digest('hex');
        if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          log('WARN', 'SECURITY', `Webhook GitHub — bad/missing HMAC from ${req.socket.remoteAddress}`);
          res.writeHead(401); res.end('unauthorized'); return;
        }
      }
      res.writeHead(200); res.end('ok');
      try {
        const event = req.headers['x-github-event'] || '';
        const data  = JSON.parse(body || '{}');
        if (event === 'push' && data.ref === 'refs/heads/main') {
          log('OK', 'WEBHOOK', `GitHub push → rechargement SESSION_LIVE.md (${data.commits?.length||0} commits)`);
          await loadSessionLiveContext();
          logActivity(`Sync GitHub: ${data.commits?.length||0} commits — SESSION_LIVE rechargé`);
        }
      } catch (e) { log('WARN', 'WEBHOOK', `GitHub: ${e.message}`); }
    });
    return;
  }

  // ─── GET /admin/env-check — diagnostic env vars (safe: pas de values) ──
  if (req.method === 'GET' && url.startsWith('/admin/env-check')) {
    const keys = ['CENTRIS_USER', 'CENTRIS_PASS', 'BREVO_API_KEY', 'PIPEDRIVE_API_KEY', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN', 'DROPBOX_REFRESH_TOKEN', 'TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'WEBHOOK_SECRET', 'RENDER_API_KEY', 'FIRECRAWL_API_KEY', 'PERPLEXITY_API_KEY'];
    const status = {};
    for (const k of keys) {
      const v = process.env[k] || '';
      status[k] = {
        set: v.length > 0,
        length: v.length,
        // Affiche juste les 4 premiers + 4 derniers pour identification
        preview: v.length > 12 ? `${v.substring(0, 4)}...${v.substring(v.length - 4)}` : (v ? '***' : ''),
      };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ checked: keys.length, status }, null, 2));
    return;
  }

  // ─── GET /admin/cleanup-activities-by-subject — supprime activités avec subject matching
  // Query: ?pattern=appeler contact|appeler prospect (regex, case insensitive)
  //        ?dry=1 (défaut DRY-RUN)
  if (req.method === 'GET' && url.startsWith('/admin/cleanup-activities-by-subject')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const pattern = u.searchParams.get('pattern') || 'appeler contact|appeler prospect';
    const dry = u.searchParams.get('dry') !== '0';
    const out = { dry, pattern, total_scanned: 0, matched: 0, deleted: 0, sample: [], errors: [] };
    let regex;
    try { regex = new RegExp(pattern, 'i'); }
    catch (e) { res.writeHead(400); res.end(JSON.stringify({error:`pattern invalide: ${e.message}`})); return; }
    try {
      // Paginer toutes les activités du compte
      let start = 0;
      const allActs = [];
      while (true) {
        const r = await pdGet(`/activities?start=${start}&limit=500`);
        const items = r?.data || [];
        allActs.push(...items);
        if (!r?.additional_data?.pagination?.more_items_in_collection) break;
        start = r.additional_data.pagination.next_start;
        if (start === undefined || start === null) break;
        if (allActs.length > 50000) break; // safety
      }
      out.total_scanned = allActs.length;
      const matched = allActs.filter(a => a.subject && regex.test(a.subject));
      out.matched = matched.length;
      out.sample = matched.slice(0, 10).map(a => ({ id: a.id, subject: a.subject, deal_id: a.deal_id, due_date: a.due_date, done: a.done, type: a.type }));
      if (!dry) {
        // BACKUP avant suppression
        const backup = await backupBeforeAction(`cleanup_activities_subject_${pattern.replace(/[^a-z0-9]/gi, '_')}`, matched);
        out.backup = backup;
        for (const a of matched) {
          try {
            const dr = await fetch(`https://api.pipedrive.com/v1/activities/${a.id}?api_token=${process.env.PIPEDRIVE_API_KEY}`, { method: 'DELETE' });
            if (dr.ok) out.deleted++;
            else out.errors.push(`${a.id}: HTTP ${dr.status}`);
          } catch (e) { out.errors.push(`${a.id}: ${e.message}`); }
        }
      }
      out.summary = dry
        ? `DRY-RUN: ${out.matched} activités matchent /${pattern}/ sur ${out.total_scanned} total`
        : `EXÉCUTÉ: ${out.deleted}/${out.matched} activités supprimées`;
    } catch (e) { out.errors.push(`Top: ${e.message}`); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── GET /admin/pipedrive-cleanup — DÉSACTIVÉ Shawn 2026-06-09
  // Règle absolue: bot n'a PAS le droit de supprimer dans Pipedrive.
  // Si Shawn veut nettoyer son Pipedrive, il le fait DIRECTEMENT dans Pipedrive UI.
  // Pour réactiver: retirer le bloc 403 ci-dessous.
  if (req.method === 'GET' && url.startsWith('/admin/pipedrive-cleanup')) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: 'BLOQUÉ',
      reason: 'Shawn 2026-06-09: aucune suppression/modification Pipedrive auto. Le bot a seulement le droit de CREATE deal + CREATE activité.',
      action: 'Faire le nettoyage directement dans Pipedrive UI (app.pipedrive.com)',
    }, null, 2));
    return;
    // Code original commenté:
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const dry = u.searchParams.get('dry') !== '0';
    const notify = u.searchParams.get('notify') !== '0';
    // Identifiants Shawn — toute person qui matche un de ces 3 = Shawn lui-même
    const SHAWN_EMAILS = ['shawn@signaturesb.com', 'shawnbarrette@icloud.com'];
    const SHAWN_PHONES_RAW = ['514-927-1340', '5149271340', '14149271340'];
    const normPhone = s => String(s || '').replace(/\D/g, '');
    const SHAWN_PHONES = SHAWN_PHONES_RAW.map(normPhone);
    const out = {
      dry, total_scanned: 0,
      generiques: { matched: 0, deleted: 0, sample: [], errors: [] },
      doublons:   { groupes: 0, a_fermer: 0, fermes: 0, sample: [], errors: [] },
      no_contact: { matched: 0, fermes: 0, sample: [], errors: [] },
      shawn:      { matched: 0, deleted: 0, sample: [], errors: [] },
      retards:    { count: 0, sample: [] }, // audit only
      backup: null,
      summary: '',
    };
    // Pattern générique = même règle que SUJET_SUIVI_GENERIQUE côté creerActivite
    // + variantes que Pipedrive crée par défaut quand subject manquant
    const RE_GENERIQUE = /^(?:📞|☎️)?\s*(?:appeler|suivi|contacter|rappel(?:er)?|relancer?)\s*(?:le|la|du|de|un|une|nouveau|nouvel)?\s*(?:contact|prospect|client|lead)s?\s*$/i;
    try {
      // 1. Pagination TOUTES activités (open + done) — on filtre done=0 après
      let start = 0;
      const allActs = [];
      while (true) {
        const r = await pdGet(`/activities?start=${start}&limit=500`);
        const items = r?.data || [];
        allActs.push(...items);
        if (!r?.additional_data?.pagination?.more_items_in_collection) break;
        start = r.additional_data.pagination.next_start;
        if (start === undefined || start === null) break;
        if (allActs.length > 50000) break;
      }
      out.total_scanned = allActs.length;
      const openActs = allActs.filter(a => !a.done);

      // 2. (A) Génériques — peu importe done ou open, on purge tout (bruit historique aussi)
      const generiques = allActs.filter(a => a.subject && RE_GENERIQUE.test(String(a.subject).trim()));
      out.generiques.matched = generiques.length;
      out.generiques.sample = generiques.slice(0, 10).map(a => ({
        id: a.id, subject: a.subject, deal_id: a.deal_id, due_date: a.due_date, done: a.done, type: a.type
      }));

      // 3. (B) Doublons — grouper open par deal_id, marquer "à fermer" tout sauf le plus récent
      const byDeal = new Map();
      for (const a of openActs) {
        if (!a.deal_id) continue;
        if (!byDeal.has(a.deal_id)) byDeal.set(a.deal_id, []);
        byDeal.get(a.deal_id).push(a);
      }
      const aFermer = [];
      const idsGeneriques = new Set(generiques.map(g => g.id));
      for (const [dealId, acts] of byDeal.entries()) {
        if (acts.length <= 1) continue;
        // Trier desc par add_time (le + récent = on garde)
        const sorted = acts.slice().sort((a, b) => new Date(b.add_time || b.due_date || 0) - new Date(a.add_time || a.due_date || 0));
        const garder = sorted[0];
        for (let i = 1; i < sorted.length; i++) {
          // Skip si déjà dans les génériques (sera supprimée, pas juste fermée)
          if (idsGeneriques.has(sorted[i].id)) continue;
          aFermer.push({ activity: sorted[i], deal_id: dealId, garder_id: garder.id });
        }
        out.doublons.groupes++;
      }
      out.doublons.a_fermer = aFermer.length;
      out.doublons.sample = aFermer.slice(0, 10).map(x => ({
        id: x.activity.id, subject: x.activity.subject, deal_id: x.deal_id, due_date: x.activity.due_date, type: x.activity.type, garder_id: x.garder_id,
      }));

      // 3.bis (C) — Activités OPEN dont le deal a une person SANS email ET SANS téléphone
      // Cache person par deal pour éviter re-fetch
      const personByDeal = new Map(); // dealId → { email, phone, person_name }
      const idsADejaFlag = new Set([
        ...generiques.map(g => g.id),
        ...aFermer.map(x => x.activity.id),
      ]);
      const noContact = [];
      for (const a of openActs) {
        if (!a.deal_id) continue;
        if (idsADejaFlag.has(a.id)) continue; // déjà couvert par (A) ou (B)
        let contact = personByDeal.get(a.deal_id);
        if (contact === undefined) {
          try {
            const dr = await pdGet(`/deals/${a.deal_id}`);
            const personField = dr?.data?.person_id;
            const personId = typeof personField === 'object' ? personField?.value : personField;
            if (!personId) {
              contact = { email: '', phone: '', person_name: null };
            } else {
              // Pipedrive embed déjà email/phone dans person_id quand objet
              if (typeof personField === 'object' && (personField.email || personField.phone)) {
                const emails = (personField.email || []).map(e => e?.value || '').filter(Boolean);
                const phones = (personField.phone || []).map(p => p?.value || '').filter(Boolean);
                contact = { email: emails.join(','), phone: phones.join(','), person_name: personField.name || '' };
              } else {
                const pr = await pdGet(`/persons/${personId}`);
                const p = pr?.data || {};
                const emails = (p.email || []).map(e => e?.value || '').filter(Boolean);
                const phones = (p.phone || []).map(ph => ph?.value || '').filter(Boolean);
                contact = { email: emails.join(','), phone: phones.join(','), person_name: p.name || '' };
              }
            }
          } catch (e) {
            contact = { email: '', phone: '', person_name: null, _err: e.message };
          }
          personByDeal.set(a.deal_id, contact);
        }
        if (!contact.email && !contact.phone) {
          noContact.push({ activity: a, deal_id: a.deal_id, person: contact });
        }
      }
      out.no_contact.matched = noContact.length;
      out.no_contact.sample = noContact.slice(0, 10).map(x => ({
        id: x.activity.id, subject: x.activity.subject, deal_id: x.deal_id, type: x.activity.type, due_date: x.activity.due_date,
        person_name: x.person.person_name || '(pas de person)',
      }));

      // 3.ter (D) — Activités où la person EST Shawn (emails + tel match)
      // Cache personFull (avec tous emails/phones bruts) — séparé de personByDeal
      // car ce dernier ne stocke que le concat. Ici on veut matcher item par item.
      const shawnByDeal = new Map(); // dealId → boolean
      const shawnAsContact = [];
      const isShawnPerson = (emails, phones) => {
        const emailsL = (emails || []).map(e => String(e || '').toLowerCase().trim()).filter(Boolean);
        const phonesN = (phones || []).map(normPhone).filter(Boolean);
        if (emailsL.some(e => SHAWN_EMAILS.includes(e))) return true;
        if (phonesN.some(p => SHAWN_PHONES.some(sp => p === sp || p.endsWith(sp) || sp.endsWith(p)))) return true;
        return false;
      };
      for (const a of openActs) {
        if (!a.deal_id) continue;
        if (idsADejaFlag.has(a.id)) continue;
        let isShawn = shawnByDeal.get(a.deal_id);
        if (isShawn === undefined) {
          try {
            const dr = await pdGet(`/deals/${a.deal_id}`);
            const personField = dr?.data?.person_id;
            const personId = typeof personField === 'object' ? personField?.value : personField;
            let emails = [], phones = [];
            if (typeof personField === 'object' && personField) {
              emails = (personField.email || []).map(e => e?.value || '');
              phones = (personField.phone || []).map(p => p?.value || '');
            }
            if ((!emails.length && !phones.length) && personId) {
              const pr = await pdGet(`/persons/${personId}`);
              const p = pr?.data || {};
              emails = (p.email || []).map(e => e?.value || '');
              phones = (p.phone || []).map(ph => ph?.value || '');
            }
            isShawn = isShawnPerson(emails, phones);
          } catch (e) {
            isShawn = false;
          }
          shawnByDeal.set(a.deal_id, isShawn);
        }
        if (isShawn) shawnAsContact.push(a);
      }
      out.shawn.matched = shawnAsContact.length;
      out.shawn.sample = shawnAsContact.slice(0, 10).map(a => ({
        id: a.id, subject: a.subject, deal_id: a.deal_id, type: a.type, due_date: a.due_date,
      }));

      // 3.quater (E) — AUDIT retards (overdue): open + due_date < aujourd'hui
      // Pas d'action, juste lister pour que Shawn voie ce qui traîne
      const todayISO = new Date().toISOString().substring(0, 10);
      const retards = openActs.filter(a => a.due_date && a.due_date < todayISO);
      out.retards.count = retards.length;
      out.retards.sample = retards
        .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))
        .slice(0, 15)
        .map(a => ({
          id: a.id, subject: (a.subject || '').substring(0, 50), deal_id: a.deal_id,
          due_date: a.due_date, type: a.type, jours_retard: Math.round((Date.now() - new Date(a.due_date).getTime()) / 86400000),
        }));

      // 4. EXÉCUTION (si !dry)
      if (!dry) {
        // Backup avant
        const backupItems = [
          ...generiques.map(g => ({ ...g, _action: 'delete' })),
          ...aFermer.map(x => ({ ...x.activity, _action: 'mark_done', _garder_id: x.garder_id })),
          ...noContact.map(x => ({ ...x.activity, _action: 'mark_done_no_contact', _deal: x.deal_id })),
          ...shawnAsContact.map(a => ({ ...a, _action: 'delete_shawn_contact' })),
        ];
        if (backupItems.length) {
          try { out.backup = await backupBeforeAction('pipedrive_cleanup_global', backupItems); }
          catch (e) { out.generiques.errors.push(`Backup: ${e.message}`); }
        }
        // (A) DELETE génériques
        for (const a of generiques) {
          try {
            const dr = await fetch(`https://api.pipedrive.com/v1/activities/${a.id}?api_token=${process.env.PIPEDRIVE_API_KEY}`, { method: 'DELETE' });
            if (dr.ok) out.generiques.deleted++;
            else out.generiques.errors.push(`${a.id}: HTTP ${dr.status}`);
          } catch (e) { out.generiques.errors.push(`${a.id}: ${e.message}`); }
        }
        // (B) Mark done sur doublons
        for (const x of aFermer) {
          try {
            const r = await fetch(`https://api.pipedrive.com/v1/activities/${x.activity.id}?api_token=${process.env.PIPEDRIVE_API_KEY}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ done: 1 }),
            });
            if (r.ok) out.doublons.fermes++;
            else out.doublons.errors.push(`${x.activity.id}: HTTP ${r.status}`);
          } catch (e) { out.doublons.errors.push(`${x.activity.id}: ${e.message}`); }
        }
        // (C) Mark done sur no_contact
        for (const x of noContact) {
          try {
            const r = await fetch(`https://api.pipedrive.com/v1/activities/${x.activity.id}?api_token=${process.env.PIPEDRIVE_API_KEY}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ done: 1 }),
            });
            if (r.ok) out.no_contact.fermes++;
            else out.no_contact.errors.push(`${x.activity.id}: HTTP ${r.status}`);
          } catch (e) { out.no_contact.errors.push(`${x.activity.id}: ${e.message}`); }
        }
        // (D) DELETE sur Shawn-as-contact
        for (const a of shawnAsContact) {
          try {
            const dr = await fetch(`https://api.pipedrive.com/v1/activities/${a.id}?api_token=${process.env.PIPEDRIVE_API_KEY}`, { method: 'DELETE' });
            if (dr.ok) out.shawn.deleted++;
            else out.shawn.errors.push(`${a.id}: HTTP ${dr.status}`);
          } catch (e) { out.shawn.errors.push(`${a.id}: ${e.message}`); }
        }
      }

      out.summary = dry
        ? `DRY-RUN sur ${out.total_scanned}: ${out.generiques.matched} génériques · ${out.doublons.a_fermer} doublons (${out.doublons.groupes} deals) · ${out.no_contact.matched} sans contact · ${out.shawn.matched} Shawn-as-contact · ${out.retards.count} retards (audit)`
        : `EXÉCUTÉ: ${out.generiques.deleted}/${out.generiques.matched} génériques · ${out.doublons.fermes}/${out.doublons.a_fermer} doublons · ${out.no_contact.fermes}/${out.no_contact.matched} sans-contact · ${out.shawn.deleted}/${out.shawn.matched} Shawn-contact · ${out.retards.count} retards (audit)`;

      // 5. Notif Telegram
      if (notify && ALLOWED_ID) {
        const tg = [
          dry ? '🧹 *Pipedrive cleanup — DRY-RUN*' : '🧹 *Pipedrive cleanup — EXÉCUTÉ*',
          '',
          `📊 Scanné: *${out.total_scanned}* activités totales`,
          '',
          `🗑 *Sujets génériques* (suivi/appeler contact/prospect):`,
          dry ? `   → ${out.generiques.matched} à supprimer` : `   → ${out.generiques.deleted}/${out.generiques.matched} supprimées`,
          ...out.generiques.sample.slice(0, 5).map(s => `      • #${s.id} "${(s.subject||'').substring(0,40)}" deal:${s.deal_id||'-'}`),
          out.generiques.matched > 5 ? `      … +${out.generiques.matched - 5} autres` : '',
          '',
          `🔄 *Doublons open par deal* (garde + récente):`,
          `   → ${out.doublons.groupes} deals concernés · ${out.doublons.a_fermer} à fermer` + (dry ? '' : ` · ${out.doublons.fermes} fermées`),
          ...out.doublons.sample.slice(0, 5).map(s => `      • deal:${s.deal_id} ferme #${s.id} "${(s.subject||'').substring(0,30)}" (garde #${s.garder_id})`),
          out.doublons.a_fermer > 5 ? `      … +${out.doublons.a_fermer - 5} autres` : '',
          '',
          `👻 *Sans contact* (ni email ni tél):`,
          dry ? `   → ${out.no_contact.matched} à fermer` : `   → ${out.no_contact.fermes}/${out.no_contact.matched} fermées`,
          ...out.no_contact.sample.slice(0, 5).map(s => `      • #${s.id} deal:${s.deal_id} "${(s.subject||'').substring(0,30)}" (${s.person_name})`),
          out.no_contact.matched > 5 ? `      … +${out.no_contact.matched - 5} autres` : '',
          '',
          `🙋 *Shawn-as-contact* (toi comme person):`,
          dry ? `   → ${out.shawn.matched} à supprimer` : `   → ${out.shawn.deleted}/${out.shawn.matched} supprimées`,
          ...out.shawn.sample.slice(0, 5).map(s => `      • #${s.id} deal:${s.deal_id} "${(s.subject||'').substring(0,30)}" ${s.due_date||''}`),
          out.shawn.matched > 5 ? `      … +${out.shawn.matched - 5} autres` : '',
          '',
          `⏰ *Retards* (audit, aucune action):`,
          `   → ${out.retards.count} activité(s) overdue`,
          ...out.retards.sample.slice(0, 10).map(s => `      • #${s.id} deal:${s.deal_id} "${s.subject}" — ${s.due_date} (${s.jours_retard}j retard)`),
          out.retards.count > 10 ? `      … +${out.retards.count - 10} autres` : '',
          '',
          dry ? `▶️ Pour exécuter: \`/admin/pipedrive-cleanup?dry=0\`` : `✅ Backup: ${out.backup?.path || 'n/a'}`,
        ].filter(Boolean).join('\n');
        try { await sendTelegramWithFallback(tg, { category: 'pipedrive-cleanup' }); } catch {}
      }
    } catch (e) {
      out.generiques.errors.push(`Top: ${e.message}`);
      if (notify && ALLOWED_ID) {
        try { await sendTelegramWithFallback(`❌ Pipedrive cleanup erreur: ${e.message}`, { category: 'pipedrive-cleanup-fail' }); } catch {}
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── GET /logo/sb et /logo/remax — sert les logos pour campagnes Brevo
  // Solution au problème "logos pas visibles chez destinataires" causé par
  // Gmail/Outlook qui bloquent les images base64 inline. URL stable = visible.
  // Source: data/logos_embedded.json (committé dans le repo).
  if (req.method === 'GET' && /^\/logo\/(sb|remax)(\.png)?$/.test(url)) {
    const isRemax = url.includes('remax');
    global._logoCache = global._logoCache || {};
    const cacheKey = isRemax ? 'remax' : 'sb';
    let buf = global._logoCache[cacheKey];
    if (!buf) {
      try {
        const embedded = loadJSON(path.join(__dirname, 'data', 'logos_embedded.json'), null);
        if (embedded) {
          const b64 = isRemax ? embedded.remax_b64 : embedded.sb_b64;
          buf = Buffer.from(b64, 'base64');
          global._logoCache[cacheKey] = buf;
        }
      } catch (e) { log('WARN', 'LOGO', `${cacheKey}: ${e.message}`); }
    }
    if (buf) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      res.end(buf); return;
    }
    res.writeHead(404); res.end('logo not found');
    return;
  }

  // ─── POST /webhook/appel — Zapier call recording → Whisper → Résumé Pipedrive
  // Body JSON attendu (Zapier configurable):
  //   { audio_url: "https://...", caller_name?: "Marie", caller_phone?: "5145551234",
  //     duration_sec?: 300, source?: "tapeacall|aircall|twilio|other" }
  // Auth: header X-Webhook-Secret: <WEBHOOK_SECRET>
  if (req.method === 'POST' && url === '/webhook/appel') {
    if (!webhookRateOK(req.socket.remoteAddress, url, 30)) { res.writeHead(429); res.end('rate limit'); return; }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 50000) req.destroy(); });
    req.on('end', async () => {
      try {
        const provided = req.headers['x-webhook-secret'];
        if (!process.env.WEBHOOK_SECRET || provided !== process.env.WEBHOOK_SECRET) {
          res.writeHead(401); res.end(JSON.stringify({error:'unauthorized'})); return;
        }
        const payload = JSON.parse(body || '{}');
        const { audio_url, caller_name, caller_phone, duration_sec, source } = payload;
        if (!audio_url || !/^https?:\/\//.test(audio_url)) {
          res.writeHead(400); res.end(JSON.stringify({error:'audio_url (https) requis'})); return;
        }
        // Audit avant traitement
        const audit_id = `appel_${Date.now()}`;
        auditLogEvent('appel_webhook', 'received', { source, caller_name, caller_phone, duration_sec, audio_url: audio_url.substring(0, 80) });
        // Download audio
        let buffer;
        try {
          const r = await fetch(audio_url, { signal: AbortSignal.timeout(60000) });
          if (!r.ok) throw new Error(`Download HTTP ${r.status}`);
          buffer = Buffer.from(await r.arrayBuffer());
          if (buffer.length > 25 * 1024 * 1024) throw new Error(`Audio trop gros: ${(buffer.length/1024/1024).toFixed(1)} MB (max 25)`);
        } catch (e) {
          res.writeHead(502); res.end(JSON.stringify({error:`Audio download: ${e.message}`})); return;
        }
        // Transcribe
        let transcription = null;
        try {
          const recentNames = (auditLog || []).filter(e => e.category === 'lead' && e.details?.extracted).slice(-10).flatMap(e => [e.details.extracted.nom]).filter(Boolean).join(', ');
          transcription = await transcrire(buffer, { recentContext: recentNames });
          if (duration_sec) trackWhisperCost(duration_sec);
        } catch (e) {
          // Sauve audio Dropbox pour ne pas perdre
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          const dbxPath = `/Audio/zapier_${ts}.ogg`;
          await fetch('https://content.dropboxapi.com/2/files/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${dropboxToken}`, 'Dropbox-API-Arg': JSON.stringify({ path: dbxPath, mode: 'add', autorename: true, mute: true }), 'Content-Type': 'application/octet-stream' },
            body: buffer,
          }).catch(() => {});
          if (ALLOWED_ID) sendTelegramWithFallback(`🎙 Appel Zapier reçu mais Whisper échoué: ${e.message}\nAudio sauvé: ${dbxPath}`, { category: 'appel-fail' }).catch(() => {});
          res.writeHead(500); res.end(JSON.stringify({error:`Transcription: ${e.message}`, audio_saved: dbxPath})); return;
        }
        // Pré-tag transcription avec metadata Zapier (aide Haiku à matcher prospect)
        const taggedTranscription = [
          caller_name ? `Appelant: ${caller_name}` : '',
          caller_phone ? `Numéro: ${caller_phone}` : '',
          duration_sec ? `Durée: ${duration_sec}s` : '',
          source ? `Source: ${source}` : '',
          '',
          transcription,
        ].filter(Boolean).join('\n');
        // Process via enregistrerResumeAppel (réutilise tout le pipeline)
        let resumeResult = null;
        try {
          resumeResult = await enregistrerResumeAppel({ transcription: taggedTranscription });
        } catch (e) { resumeResult = `Erreur résumé: ${e.message}\n\nTranscription brute:\n${transcription}`; }
        // Notif Telegram à Shawn (résumé court + lien)
        if (ALLOWED_ID) {
          const tgText = `📞 *Appel Zapier traité*${caller_name ? ` — ${caller_name}` : ''}${duration_sec ? ` (${Math.round(duration_sec/60)}min)` : ''}\n\n${resumeResult}`.substring(0, 3500);
          sendTelegramWithFallback(tgText, { category: 'appel-zapier' }).catch(() => {});
        }
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify({ ok: true, transcription_length: transcription.length, resume: resumeResult.substring(0, 500), audit_id }, null, 2));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
    });
    return;
  }

  // ─── POST /admin/setsecret-universal — set n'importe quelle clé via WEBHOOK_SECRET
  // Body: { key: 'OPENAI_API_KEY', value: 'sk-...', test_url?: 'https://api.openai.com/v1/models' }
  // Si test_url fourni, valide la clé contre le service avant d'enregistrer.
  if (req.method === 'POST' && url.startsWith('/admin/setsecret-universal')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        const { key, value, test_url, test_auth_header } = data;
        if (!key || !value) { res.writeHead(400); res.end(JSON.stringify({error:'key et value requis'})); return; }
        if (!/^[A-Z0-9_]+$/.test(key)) { res.writeHead(400); res.end(JSON.stringify({error:'key invalide (A-Z0-9_)'})); return; }
        if (value.length < 8) { res.writeHead(400); res.end(JSON.stringify({error:'value trop courte'})); return; }
        // Auth: soit WEBHOOK_SECRET header, SOIT test_url qui valide la clé contre service externe
        // (la clé valide est elle-même la preuve d'authorité pour cette opération)
        const provided = req.headers['x-webhook-secret'];
        const hasWebhookAuth = process.env.WEBHOOK_SECRET && provided === process.env.WEBHOOK_SECRET;
        if (!hasWebhookAuth && !test_url) {
          res.writeHead(401); res.end(JSON.stringify({ error: 'X-Webhook-Secret header OU test_url requis pour validation' })); return;
        }
        // Test optionnel
        let tested = null;
        if (test_url) {
          const headers = test_auth_header
            ? { [test_auth_header]: value }
            : { 'Authorization': `Bearer ${value}` };
          try {
            const tr = await fetch(test_url, { headers, signal: AbortSignal.timeout(10000) });
            tested = { status: tr.status, ok: tr.ok };
            if (!tr.ok) {
              res.writeHead(400); res.end(JSON.stringify({ error: `Test URL fail: HTTP ${tr.status}`, tested })); return;
            }
          } catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: `Test URL exception: ${e.message}` })); return; }
        }
        // Set process.env IMMÉDIATEMENT (même si Dropbox fail)
        process.env[key] = value;
        // Try Dropbox persist (best effort)
        let persisted = false;
        try { persisted = await uploadDropboxSecret(key, value); } catch {}
        auditLogEvent('secret', 'set', { key, via: 'admin-universal', tested: !!tested, persisted, dbxErr: _lastSecretError });
        res.writeHead(200, {'content-type':'application/json'});
        res.end(JSON.stringify({ ok: true, key, persisted, env_set: true, tested, dropbox_error: persisted ? null : _lastSecretError, warning: persisted ? null : 'Dropbox persist failed — clé active en mémoire seulement (perdue au prochain redeploy).' }, null, 2));
        // Notif Telegram
        if (ALLOWED_ID) sendTelegramWithFallback(`🔑 *${key}* configurée\n${persisted ? '✅ Persisté Dropbox + env' : '⚠️ Env seulement (Dropbox fail — perdu au redeploy)'}${tested ? `\nTest: HTTP ${tested.status} ✅` : ''}`, { category: 'secret-set' }).catch(()=>{});
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
    });
    return;
  }

  // ─── GET /admin/state — DUMP COMPLET pour Claude Code (sync temps réel)
  // Une seule requête → toute la state du bot. Curl this au début de chaque
  // session Claude Code pour avoir le contexte parfait sans questions.
  if (req.method === 'GET' && url.startsWith('/admin/state')) {
    const v = getMonthlyVariableCosts();
    const upcoming = (auditLog || []).slice(-30).reverse();
    const lastCampaignSent = (auditLog || []).filter(e => e.category === 'campaign' && e.event === 'sent-now').slice(-1)[0];
    const lastAppel = (auditLog || []).filter(e => e.category === 'appel').slice(-1)[0];
    const subFixed = (subscriptions.items || []).filter(s => !s.variable && !s.pending);
    const totalUsd = subFixed.reduce((sum, s) => {
      if (s.price_usd != null) return sum + s.price_usd;
      if (s.price_cad != null) return sum + s.price_cad / (subscriptions.usd_to_cad || 1.36);
      return sum;
    }, 0);
    const state = {
      now: new Date().toISOString(),
      commit: (process.env.RENDER_GIT_COMMIT || 'unknown').substring(0, 7),
      uptime_sec: Math.floor((Date.now() - metrics.startedAt) / 1000),
      bot: {
        model: currentModel,
        tools_count: TOOLS.length,
        thinking_mode: thinkingMode,
      },
      health: healthState.checks || {},
      health_last_run: healthState.lastRun,
      health_failures: healthState.lastFailures || [],
      keys_set: {
        anthropic: !!process.env.ANTHROPIC_API_KEY,
        openai: !!process.env.OPENAI_API_KEY,
        pipedrive: !!process.env.PIPEDRIVE_API_KEY,
        brevo: !!process.env.BREVO_API_KEY,
        telegram: !!process.env.TELEGRAM_BOT_TOKEN,
        gmail: !!(process.env.GMAIL_CLIENT_ID && process.env.GMAIL_REFRESH_TOKEN),
        dropbox: !!process.env.DROPBOX_REFRESH_TOKEN,
        centris: !!(process.env.CENTRIS_USER && process.env.CENTRIS_PASS),
        firecrawl: !!process.env.FIRECRAWL_API_KEY,
        perplexity: !!process.env.PERPLEXITY_API_KEY,
        browserless: !!process.env.BROWSERLESS_WS,
      },
      cua: (() => {
        try { const m = getCUA(); return m ? m.cuaStatus() : { available: false }; } catch { return { available: false }; }
      })(),
      costs: {
        anthropic_today: costTracker.daily?.[today()] || 0,
        anthropic_month: costTracker.monthly?.[thisMonth()] || 0,
        anthropic_projected: v.anthropic_projected,
        openai_month: openaiCost.monthly?.[thisMonth()] || 0,
        openai_minutes_total: openaiCost.totalMinutes || 0,
        subs_fixed_usd: totalUsd,
        cache_hits: costTracker.cacheStats?.hits || 0,
        cache_writes: costTracker.cacheStats?.writes || 0,
      },
      campaigns: {
        approved_registry: Object.keys(campaignApprovals.approved || {}),
        last_sent: lastCampaignSent ? { at: lastCampaignSent.at, ...lastCampaignSent.details } : null,
      },
      appels: {
        last: lastAppel ? { at: lastAppel.at, ...lastAppel.details } : null,
        total_audit: (auditLog || []).filter(e => e.category === 'appel').length,
      },
      pipedrive: {
        deals_cache: dropboxTerrains.length,
      },
      audit_log_count: (auditLog || []).length,
      audit_log_recent: upcoming.slice(0, 15).map(e => ({ at: e.at, cat: e.category, event: e.event })),
      memory_facts: (kiramem?.facts || []).length,
      preview_dedup: (() => { try { return loadJSON(path.join(DATA_DIR, 'preview_dedup.json'), {}); } catch { return {}; } })(),
      sent_registry: (() => { try { return loadJSON(path.join(DATA_DIR, 'brevo_sent_registry.json'), {}); } catch { return {}; } })(),
      pending_actions: {
        openai_key_missing: !process.env.OPENAI_API_KEY,
        firecrawl_key_missing: !process.env.FIRECRAWL_API_KEY,
        perplexity_key_missing: !process.env.PERPLEXITY_API_KEY,
      },
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(state, null, 2));
    return;
  }

  // ─── GET /admin/dashboard — page HTML agrégée (tous les indicateurs) ────
  if (req.method === 'GET' && url.startsWith('/admin/dashboard')) {
    const v = getMonthlyVariableCosts();
    const rate = subscriptions.usd_to_cad || 1.36;
    const allOk = (Object.values(healthState.checks || {})).every(c => c?.ok);
    const upcomingApprovals = Object.keys(campaignApprovals.approved || {}).length;
    const lastAuditEvents = (auditLog || []).slice(-15).reverse();
    const subTable = (subscriptions.items || []).filter(s => !s.variable && !s.pending).map(s => {
      const usd = s.price_usd != null ? s.price_usd : (s.price_cad != null ? s.price_cad / rate : null);
      const cad = s.price_usd != null ? s.price_usd * rate : (s.price_cad || null);
      return `<tr><td>${s.name}</td><td>${s.category}</td><td>${usd != null ? '$' + usd.toFixed(2) : '?'}</td><td>${cad != null ? '$' + cad.toFixed(2) : '?'}</td><td>${s.est ? '🔸' : '✅'}</td></tr>`;
    }).join('');
    const totalUsd = (subscriptions.items || []).filter(s => !s.variable && !s.pending).reduce((sum, s) => {
      if (s.price_usd != null) return sum + s.price_usd;
      if (s.price_cad != null) return sum + s.price_cad / rate;
      return sum;
    }, 0);
    const grandUsd = totalUsd + v.anthropic_projected + v.openai_projected;
    const grandCad = grandUsd * rate;
    const healthRows = Object.entries(healthState.checks || {}).map(([k, c]) => `<tr><td>${k}</td><td>${c.ok ? '✅ OK' : '❌ FAIL'}</td><td><code>${JSON.stringify(c).substring(0, 200)}</code></td></tr>`).join('');
    const auditRows = lastAuditEvents.map(e => `<tr><td>${new Date(e.at).toLocaleString('fr-CA',{timeZone:'America/Toronto'})}</td><td>${e.category}</td><td>${e.event}</td><td><code>${JSON.stringify(e.details).substring(0,150)}</code></td></tr>`).join('');
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Kira Admin Dashboard</title>
<style>
body{font-family:-apple-system,sans-serif;background:#060606;color:#eee;margin:0;padding:20px;max-width:1400px}
h1{color:#aa0721;border-bottom:2px solid #aa0721;padding-bottom:8px}
h2{margin-top:32px;color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin:16px 0}
.card{background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:16px}
.card .label{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:1px}
.card .value{font-size:32px;font-weight:bold;margin:4px 0}
.card .sub{color:#aaa;font-size:13px}
.green{color:#4ade80} .red{color:#ef4444} .yellow{color:#fbbf24}
table{width:100%;border-collapse:collapse;margin:8px 0;background:#1a1a1a;font-size:13px}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #2a2a2a}
th{background:#aa0721;color:#fff;font-weight:600;text-transform:uppercase;font-size:11px;letter-spacing:1px}
code{background:#0a0a0a;padding:2px 6px;border-radius:3px;color:#93c5fd;font-size:11px}
.btn{display:inline-block;background:#aa0721;color:#fff;padding:8px 16px;border-radius:4px;text-decoration:none;margin:4px;font-size:13px}
.btn:hover{background:#cc0a2c}
.muted{color:#666}
</style></head>
<body>
<h1>🤖 Kira — Admin Dashboard</h1>
<p class="muted">Auto-refresh suggéré F5 · Bot: ${currentModel} · Tools: ${TOOLS.length} · Lignes: ${require('fs').statSync('bot.js').size > 0 ? 'live' : '?'} · ${new Date().toLocaleString('fr-CA',{timeZone:'America/Toronto'})}</p>
${!process.env.OPENAI_API_KEY ? `<div style="background:#5c1a1a;border:1px solid #aa0721;padding:16px;border-radius:8px;margin:16px 0"><strong>⚠️ OPENAI_API_KEY manquante</strong> — Whisper désactivé, vocaux Telegram et résumés d'appels ne fonctionnent pas.<br>Fix immédiat: tape dans Telegram <code>/setsecret OPENAI_API_KEY sk-...</code> — persiste à travers les redeploys.</div>` : ''}

<div class="grid">
<div class="card"><div class="label">Health APIs</div><div class="value ${allOk ? 'green' : 'red'}">${allOk ? '✅' : '❌'}</div><div class="sub">${healthState.lastRun ? new Date(healthState.lastRun).toLocaleTimeString('fr-CA',{timeZone:'America/Toronto'}) : 'never'}</div></div>
<div class="card"><div class="label">Coût mensuel projeté</div><div class="value">$${grandUsd.toFixed(0)}</div><div class="sub">USD · $${grandCad.toFixed(0)} CAD</div></div>
<div class="card"><div class="label">Anthropic ce mois</div><div class="value">$${v.anthropic_actual.toFixed(2)}</div><div class="sub">proj. $${v.anthropic_projected.toFixed(2)}</div></div>
<div class="card"><div class="label">OpenAI Whisper</div><div class="value">$${v.openai_actual.toFixed(2)}</div><div class="sub">${v.openai_minutes.toFixed(0)} min audio</div></div>
<div class="card"><div class="label">Campagnes approuvées</div><div class="value">${upcomingApprovals}</div><div class="sub">registre actif</div></div>
<div class="card"><div class="label">Audit log</div><div class="value">${auditLog.length}</div><div class="sub">events trackés (cap 1000)</div></div>
</div>

<h2>🎬 Actions rapides</h2>
<a class="btn" href="/admin/health?refresh=1">🩺 Health check (refresh)</a>
<a class="btn" href="/admin/safety-check">🛡️ Safety check campagnes</a>
<a class="btn" href="/admin/check-plans">📊 Plans Brevo+Dropbox</a>
<a class="btn" href="/admin/auditlog?limit=100">📋 Audit log full</a>
<a class="btn" href="/admin/cleanup-activities-by-subject?dry=1">🧹 Cleanup activités (pattern)</a>
<a class="btn" href="/admin/pipedrive-cleanup?dry=1">🧼 Pipedrive cleanup global (DRY)</a>

<h2>🩺 Health Check Détails</h2>
<table><tr><th>Service</th><th>Status</th><th>Détails</th></tr>${healthRows || '<tr><td colspan=3 class=muted>Pas encore exécuté</td></tr>'}</table>

<h2>💰 Abonnements (fixe seulement)</h2>
<table><tr><th>Service</th><th>Catégorie</th><th>USD/mo</th><th>CAD/mo</th><th>Confirmé</th></tr>${subTable}</table>
<p class="muted">Total fixe: $${totalUsd.toFixed(2)} USD · $${(totalUsd * rate).toFixed(2)} CAD</p>

<h2>📋 Audit Log (15 derniers events)</h2>
<table><tr><th>Quand</th><th>Catégorie</th><th>Event</th><th>Détails</th></tr>${auditRows || '<tr><td colspan=4 class=muted>Aucun event</td></tr>'}</table>

</body></html>`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ─── GET /admin/health — état santé APIs (boot + cron horaire) ──────────
  if (req.method === 'GET' && url.startsWith('/admin/health')) {
    const u = new URL(req.url, 'http://x');
    const refresh = u.searchParams.get('refresh') === '1';
    if (refresh) await testApisHealth();
    res.writeHead(200, { 'content-type':'application/json' });
    res.end(JSON.stringify(healthState, null, 2));
    return;
  }

  // ─── GET /admin/auditlog — derniers events (filtrable, sans token requis)
  // Renommé /admin/audit-log → /admin/auditlog pour éviter conflit avec
  // /admin/audit (token-required) qui interceptait avant.
  if (req.method === 'GET' && url.startsWith('/admin/auditlog')) {
    const u = new URL(req.url, 'http://x');
    const cat = u.searchParams.get('category');
    const limit = Math.min(parseInt(u.searchParams.get('limit') || '50', 10), 500);
    const filtered = cat ? auditLog.filter(e => e.category === cat) : auditLog;
    res.writeHead(200, { 'content-type':'application/json' });
    res.end(JSON.stringify({ count: filtered.length, total: auditLog.length, items: filtered.slice(-limit).reverse() }, null, 2));
    return;
  }

  // ─── GET /admin/brevo-send-preview?id=N — force preview test à shawn@
  // DÉDUP 2026-05-05: 1 preview/jour/campagne max. ?force=1 override.
  if (req.method === 'GET' && url.startsWith('/admin/brevo-send-preview')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    const to = u.searchParams.get('to') || SHAWN_EMAIL;
    const force = u.searchParams.get('force') === '1';
    if (!id) { res.writeHead(400); res.end(JSON.stringify({error:'?id=N requis'})); return; }
    const out = { id, to, sent: false, status: null, campaign: null, dedup_skipped: false };
    try {
      // Dédup check
      const PREVIEW_DEDUP_FILE = path.join(DATA_DIR, 'preview_dedup.json');
      const dedup = loadJSON(PREVIEW_DEDUP_FILE, {});
      const todayKey = new Date().toISOString().slice(0, 10);
      const dedupKey = `${id}_${todayKey}`;
      if (!force && dedup[dedupKey]) {
        out.dedup_skipped = true;
        out.last_sent_at = dedup[dedupKey];
        out.note = `Preview déjà envoyé aujourd'hui à ${dedup[dedupKey]}. Utilise ?force=1 pour re-envoyer.`;
        res.writeHead(200, { 'content-type':'application/json' });
        res.end(JSON.stringify(out, null, 2));
        return;
      }
      // Get campaign details
      const det = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (det.ok) {
        const data = await det.json();
        out.campaign = { name: data.name, subject: data.subject, status: data.status, scheduledAt: data.scheduledAt, recipients: data.recipients };
      }
      // Send test
      const tr = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}/sendTest`, {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type':'application/json' },
        body: JSON.stringify({ emailTo: [to] }),
      });
      out.status = tr.status;
      out.sent = tr.ok || tr.status === 204;
      if (out.sent) {
        dedup[dedupKey] = new Date().toISOString();
        // Purge >7j
        Object.keys(dedup).forEach(k => {
          const d = k.split('_').slice(-1)[0];
          if (d < new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)) delete dedup[k];
        });
        saveJSON(PREVIEW_DEDUP_FILE, dedup);
        auditLogEvent('preview', 'sent', { campaignId: id, to, forced: force });
      }
      if (!out.sent) {
        const errBody = await tr.text().catch(() => '');
        out.error = errBody.substring(0, 300);
      }
    } catch (e) { out.error = e.message; }
    res.writeHead(200, { 'content-type':'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── GET /admin/safety-check — déclenche safety check campagnes immédiatement
  if (req.method === 'GET' && url.startsWith('/admin/safety-check')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    try {
      await safetyCheckCampagnes();
      res.writeHead(200, { 'content-type':'application/json' });
      res.end(JSON.stringify({ ok: true, approved_registry: campaignApprovals.approved, ranAt: new Date().toISOString() }, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ─── GET /admin/inspect-activity?id=N — info activité Pipedrive
  if (req.method === 'GET' && url.startsWith('/admin/inspect-activity')) {
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    if (!id) { res.writeHead(400); res.end(JSON.stringify({error:'?id=N requis'})); return; }
    try {
      const r = await pdGet(`/activities/${id}`);
      res.writeHead(200, { 'content-type':'application/json' });
      res.end(JSON.stringify(r, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ─── POST /admin/brevo-send-now?id=N — ENVOI IMMÉDIAT avec triple-safety
  // 1. Refuse si status === 'sent' OR sentDate set
  // 2. Refuse si registre dédup contient déjà id+date
  // 3. Pré-écrit registre AVANT envoi (anti-double-call)
  // 4. Vérifie status post-envoi
  if ((req.method === 'POST' || req.method === 'GET') && url.startsWith('/admin/brevo-send-now')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 3)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    if (!id) { res.writeHead(400); res.end(JSON.stringify({error:'?id=N requis'})); return; }
    const out = { id, sent: false, before: null, after: null, dedup_blocked: false, errors: [] };
    try {
      // 1. Get current state
      const det = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (!det.ok) {
        out.errors.push(`Brevo GET HTTP ${det.status}`);
        res.writeHead(200, { 'content-type':'application/json' }); res.end(JSON.stringify(out, null, 2)); return;
      }
      const beforeData = await det.json();
      out.before = { status: beforeData.status, sentDate: beforeData.sentDate, name: beforeData.name, scheduledAt: beforeData.scheduledAt };
      // 2. Refuse si déjà envoyée
      if (beforeData.status === 'sent' || beforeData.sentDate) {
        out.dedup_blocked = true;
        out.errors.push(`Déjà envoyée le ${beforeData.sentDate || '?'}`);
        res.writeHead(200, { 'content-type':'application/json' }); res.end(JSON.stringify(out, null, 2)); return;
      }
      if (beforeData.status === 'in_process' || beforeData.status === 'queued') {
        out.dedup_blocked = true;
        out.errors.push(`En cours d'envoi (status=${beforeData.status})`);
        res.writeHead(200, { 'content-type':'application/json' }); res.end(JSON.stringify(out, null, 2)); return;
      }
      // 3. Vérifier registre dédup local (data/brevo_sent_registry.json)
      const SEND_REGISTRY = path.join(DATA_DIR, 'brevo_sent_registry.json');
      const reg = loadJSON(SEND_REGISTRY, {});
      const today = new Date().toISOString().slice(0, 10);
      const dedupKey = `${id}_${today}`;
      if (reg[dedupKey]) {
        out.dedup_blocked = true;
        out.errors.push(`Registre local: déjà envoyé ${reg[dedupKey].sentAt}`);
        res.writeHead(200, { 'content-type':'application/json' }); res.end(JSON.stringify(out, null, 2)); return;
      }
      // 4. Pré-écrire registre AVANT envoi (anti-double-call atomic)
      reg[dedupKey] = { sentAt: new Date().toISOString(), name: beforeData.name, by: 'admin-endpoint' };
      saveJSON(SEND_REGISTRY, reg);
      // 5. Send NOW
      const sr = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}/sendNow`, {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY }
      });
      out.sendStatus = sr.status;
      out.sent = sr.ok || sr.status === 204;
      if (!out.sent) {
        // Annule le registre si l'envoi a échoué
        delete reg[dedupKey];
        saveJSON(SEND_REGISTRY, reg);
        const errBody = await sr.text().catch(() => '');
        out.errors.push(`sendNow HTTP ${sr.status}: ${errBody.substring(0, 200)}`);
      } else {
        // 🚀 Cc Shawn auto (règle 2026-05-13): sendTest parallèle pour copie identique
        const shawnCc = process.env.SHAWN_EMAIL || 'shawn@signaturesb.com';
        fetch(`https://api.brevo.com/v3/emailCampaigns/${id}/sendTest`, {
          method: 'POST',
          headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailTo: [shawnCc] }),
        }).catch(e => log('WARN', 'BREVO', `sendTest Cc fail #${id}: ${e.message}`));
        out.cc_shawn_fired = true;
        // Aussi marquer dans le registre d'approbation
        approveCampaign(id);
        auditLogEvent('campaign', 'sent-now', { id, name: beforeData.name, by: 'admin-endpoint', cc_shawn: true });
      }
      // 6. Vérifier état après
      const after = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (after.ok) {
        const afterData = await after.json();
        out.after = { status: afterData.status, sentDate: afterData.sentDate };
      }
    } catch (e) { out.errors.push(`Top: ${e.message}`); }
    res.writeHead(200, { 'content-type':'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── POST /admin/brevo-fix-logos — remplace base64 logos par URLs hostées
  // ?id=N (single) OR ?all=1 (toutes les suspended/queued)
  // ?dry=1 pour preview, ?dry=0 pour exécuter
  if ((req.method === 'POST' || req.method === 'GET') && url.startsWith('/admin/brevo-fix-logos')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    const all = u.searchParams.get('all') === '1';
    const dry = u.searchParams.get('dry') !== '0';
    const out = { dry, mode: id ? `single id=${id}` : (all ? 'all suspended+queued' : 'none'), processed: [], errors: [] };
    const SB_URL = 'https://signaturesb-bot-s272.onrender.com/logo/sb';
    const REMAX_URL = 'https://signaturesb-bot-s272.onrender.com/logo/remax';
    try {
      let campaignIds = [];
      if (id) campaignIds = [id];
      else if (all) {
        for (const st of ['suspended', 'queued']) {
          const r = await fetch(`https://api.brevo.com/v3/emailCampaigns?status=${st}&limit=100`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
          if (r.ok) {
            const d = await r.json();
            campaignIds.push(...(d.campaigns || []).map(c => c.id));
          }
        }
      } else {
        res.writeHead(400); res.end(JSON.stringify({error:'?id=N ou ?all=1 requis'})); return;
      }
      for (const cid of campaignIds) {
        try {
          const det = await fetch(`https://api.brevo.com/v3/emailCampaigns/${cid}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
          if (!det.ok) { out.errors.push(`#${cid}: GET HTTP ${det.status}`); continue; }
          const data = await det.json();
          const html = data.htmlContent || '';
          // Replace base64 logos with URLs (alt-based detection)
          let newHtml = html;
          let replaced = 0;
          // Logo Signature SB (alt="Signature SB")
          newHtml = newHtml.replace(/<img([^>]*alt=["'][^"']*[Ss]ignature[^"']*["'][^>]*?)src=["']data:image\/png;base64,[A-Za-z0-9+/=]+["']/g, (m, before) => {
            replaced++;
            return `<img${before}src="${SB_URL}"`;
          });
          newHtml = newHtml.replace(/<img([^>]*?)src=["']data:image\/png;base64,[A-Za-z0-9+/=]+["']([^>]*alt=["'][^"']*[Ss]ignature[^"']*["'])/g, (m, before, after) => {
            replaced++;
            return `<img${before}src="${SB_URL}"${after}`;
          });
          // Logo RE/MAX (alt="RE/MAX")
          newHtml = newHtml.replace(/<img([^>]*alt=["'][^"']*[Rr][Ee].?[Mm][Aa][Xx][^"']*["'][^>]*?)src=["']data:image\/png;base64,[A-Za-z0-9+/=]+["']/g, (m, before) => {
            replaced++;
            return `<img${before}src="${REMAX_URL}"`;
          });
          newHtml = newHtml.replace(/<img([^>]*?)src=["']data:image\/png;base64,[A-Za-z0-9+/=]+["']([^>]*alt=["'][^"']*[Rr][Ee].?[Mm][Aa][Xx][^"']*["'])/g, (m, before, after) => {
            replaced++;
            return `<img${before}src="${REMAX_URL}"${after}`;
          });
          const item = { id: cid, name: data.name, status: data.status, replaced, html_before_kb: Math.round(html.length/1024), html_after_kb: Math.round(newHtml.length/1024) };
          if (replaced === 0) { item.skipped = 'no base64 logos found'; out.processed.push(item); continue; }
          if (!dry) {
            // PUT update HTML (Brevo API)
            const pr = await fetch(`https://api.brevo.com/v3/emailCampaigns/${cid}`, {
              method: 'PUT',
              headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
              body: JSON.stringify({ htmlContent: newHtml }),
            });
            item.put_status = pr.status;
            item.put_ok = pr.ok || pr.status === 204;
            if (!item.put_ok) {
              const errBody = await pr.text().catch(() => '');
              item.put_error = errBody.substring(0, 200);
            }
          }
          out.processed.push(item);
        } catch (e) { out.errors.push(`#${cid}: ${e.message}`); }
      }
      out.summary = dry
        ? `DRY: ${out.processed.filter(p => p.replaced > 0).length}/${out.processed.length} campagnes auraient des replacements`
        : `EXÉCUTÉ: ${out.processed.filter(p => p.put_ok).length}/${out.processed.filter(p => p.replaced > 0).length} campagnes mises à jour`;
    } catch (e) { out.errors.push(`Top: ${e.message}`); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── GET /admin/taux-actuels — scrape live + LLM extract des taux du jour
  // Sources: MultiPrêt + PlaniPrêt + Banque Canada → retourne best rates
  if (req.method === 'GET' && url.startsWith('/admin/taux-actuels')) {
    if (!requireAdmin(req, res)) return;
    try {
      const fc = require('./firecrawl_scraper');
      const Anthropic = require('@anthropic-ai/sdk');
      const a = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      // Scrape sources avec contenus statiques + Ratehub aggregator
      const [rh, mp, pp, bc, nbc] = await Promise.all([
        fc.scrapUrl('https://www.ratehub.ca/best-mortgage-rates', []).catch(() => null),
        fc.scrapUrl('https://multi-prets.com/taux-hypothecaires/', []).catch(() => null),
        fc.scrapUrl('https://planipret.com/taux-hypothecaires/', []).catch(() => null),
        fc.scrapUrl('https://www.bankofcanada.ca/wp-content/themes/boc/widgets/policy-rate.html', []).catch(() => null),
        fc.scrapUrl('https://www.nbc.ca/personal/mortgages/posted-rates.html', []).catch(() => null),
      ]);
      const combined = `=== RATEHUB ===\n${rh?.contenu?.substring(0, 5000) || ''}\n\n=== MULTIPRET ===\n${mp?.contenu?.substring(0, 4000) || ''}\n\n=== PLANIPRET ===\n${pp?.contenu?.substring(0, 3000) || ''}\n\n=== BANQUE CANADA ===\n${bc?.contenu?.substring(0, 2000) || ''}\n\n=== BNC ===\n${nbc?.contenu?.substring(0, 3000) || ''}`;
      const prompt = `Tu reçois 3 sources de taux d'intérêt québécois mai 2026. Extrait UNIQUEMENT les taux ACTUELS (pas historiques).

Réponds avec ce JSON exactement:
{
  "taux_directeur_bdc": <%>,
  "taux_qualification_bdc": <% — stress test B-20, généralement le plus haut de "taux contractuel + 2%" ou 5.25%>,
  "fixe_5ans_meilleur": <% — le MEILLEUR taux fixe 5 ans entre MultiPret et PlaniPret>,
  "variable_5ans_meilleur": <%>,
  "fixe_3ans_meilleur": <% si dispo>,
  "source_meilleur_5fix": "MultiPret ou PlaniPret",
  "as_of": "mai 2026"
}

Met null pour les taux non trouvés. Pas de texte autour du JSON.`;
      const llmRes = await a.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt + '\n\n' + combined.substring(0, 12000) }],
      });
      const llmTxt = llmRes.content.find(b => b.type === 'text')?.text || '';
      const jsonM = llmTxt.match(/\{[\s\S]*\}/);
      const parsed = jsonM ? JSON.parse(jsonM[0]) : null;
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({
        ok: !!parsed, taux: parsed,
        sources_scraped: { multipret: !!mp, planipret: !!pp, banque_canada: !!bc },
        scraped_at: new Date().toISOString(),
        llm_raw: llmTxt.substring(0, 500),
      }, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── POST /admin/report-bug?token=X — trigger manuel bug tracker (test)
  if (req.method === 'POST' && url.startsWith('/admin/report-bug')) {
    if (!requireAdmin(req, res)) return;
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const r = await reportBug(body.title || 'Manual test', body.description || 'no description', { labels: body.labels });
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify(r || { skipped: true }, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/reload-session — force reload immédiat de SESSION_LIVE.md
  // À appeler après git push pour que le bot ait l'info instantanément
  if (req.method === 'GET' && url.startsWith('/admin/reload-session')) {
    if (!requireAdmin(req, res)) return;
    try {
      await loadSessionLiveContext();
      const len = sessionLiveContext?.length || 0;
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ ok: true, sessionLive_kb: Math.round(len/1024), reloaded_at: new Date().toISOString() }, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── POST /admin/parse-pdf-centris — upload PDF buffer, retourne data structurée
  // Body: binary PDF. Header: X-Token: WEBHOOK_SECRET
  if (req.method === 'POST' && url.startsWith('/admin/parse-pdf-centris')) {
    const tok = req.headers['x-token'] || (new URL(req.url, 'http://x')).searchParams.get('token') || '';
    if (tok !== process.env.WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const buf = Buffer.concat(chunks);
      if (buf.length < 1000 || buf.slice(0, 4).toString() !== '%PDF') {
        res.writeHead(400); res.end(JSON.stringify({error: 'not a PDF or too small'})); return;
      }
      const cua = getCUA();
      const data = await cua.extractCentrisPDFData(buf);
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify(data, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/campaign-regenerate?id=N — génère nouveau angle/intro
  // Évite que la même audience reçoive 2× la même version. Audience auto-détectée.
  if (req.method === 'GET' && url.startsWith('/admin/campaign-regenerate')) {
    if (!requireAdmin(req, res)) return;
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    const dry = u.searchParams.get('dry') === '1';
    if (!id) { res.writeHead(400); res.end(JSON.stringify({error:'?id=N requis'})); return; }
    try {
      const variation = require('./campaign_variation');
      const mi = require('./market_intelligence');
      // 1. Fetch campagne actuelle
      const r1 = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (!r1.ok) { res.writeHead(r1.status); res.end(await r1.text()); return; }
      const camp = await r1.json();
      const audience = variation.detectAudience(camp.name);
      if (!audience) { res.writeHead(400); res.end(JSON.stringify({error: `audience non détectée dans nom: ${camp.name}`})); return; }
      // 2. Génère variation avec données marché actuelles + HTML existant pour rewrite ciblé
      const marketDigest = mi.buildMarketDigest() || {};
      const variant = await variation.generateVariation(audience, marketDigest, {
        customNote: u.searchParams.get('note') || null,
        existingHtml: camp.htmlContent || '',
      });
      // 3. Injection HTML — préserve TOUT (logos, tables, images, footer)
      // Stratégie: LLM réécrit UNIQUEMENT le contenu des <p>...</p> contenant du
      // texte narratif (>40 chars, pas juste un chiffre/lien). Tout le reste
      // (img, table, css, structure) reste 100% intact.
      const oldHtml = camp.htmlContent || '';
      let newHtml = oldHtml;
      let replacements = [];
      if (variant.paragraphs_replacement && Array.isArray(variant.paragraphs_replacement)) {
        // LLM a retourné liste {old_inner, new_inner} — on cherche dans <p>...</p>
        // et on remplace UNIQUEMENT le inner (pas le wrapper)
        for (const r of variant.paragraphs_replacement) {
          const oldInner = r.old_inner || r.old_text; // backward compat
          const newInner = r.new_inner || r.new_text;
          if (!oldInner || !newInner) continue;
          // Strip <p> wrapper du new_inner si LLM en a mis un quand même
          let cleanNew = String(newInner).trim();
          if (/^<p[^>]*>[\s\S]*<\/p>$/i.test(cleanNew)) {
            cleanNew = cleanNew.replace(/^<p[^>]*>/i, '').replace(/<\/p>$/i, '');
          }
          // Escape regex pour old_inner (tolère whitespace variants)
          const escaped = String(oldInner).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
          const re = new RegExp(escaped, 'g');
          const count = (newHtml.match(re) || []).length;
          if (count > 0) {
            newHtml = newHtml.replace(re, cleanNew);
            replacements.push({ from: oldInner.substring(0, 60), to: cleanNew.substring(0, 60), count });
          }
        }
      } else if (variant.intro_html && /<!--\s*INTRO_TEXTE\s*-->[\s\S]*?<!--\s*\/INTRO_TEXTE\s*-->/.test(oldHtml)) {
        // Fallback: si marqueurs présents, replace block
        newHtml = oldHtml.replace(/<!--\s*INTRO_TEXTE\s*-->[\s\S]*?<!--\s*\/INTRO_TEXTE\s*-->/, `<!-- INTRO_TEXTE -->${variant.intro_html}<!-- /INTRO_TEXTE -->`);
        replacements.push({ via: 'marker' });
      }
      const subject_changed = variant.subject && variant.subject !== camp.subject;
      const html_changed = newHtml !== oldHtml;
      const out = {
        id, audience, angle: variant.angle, focus: variant.focus,
        new_subject: variant.subject,
        subject_changed, html_changed,
        replacements_applied: replacements.length,
        replacements_summary: replacements.slice(0, 5),
        intro_preview: variant.intro_html?.substring(0, 400),
        key_points: variant.key_points,
        dry,
      };
      if (dry) { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(out, null, 2)); return; }
      // 4. PUT update si changement
      if (subject_changed || html_changed) {
        const r2 = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, {
          method: 'PUT',
          headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({
            ...(subject_changed ? { subject: variant.subject } : {}),
            ...(html_changed ? { htmlContent: newHtml } : {}),
          }),
        });
        out.put_ok = r2.ok || r2.status === 204;
        if (!out.put_ok) out.put_error = (await r2.text()).substring(0, 300);
        else {
          variation.recordSent(audience, id, variant.angle, variation.hashContent(newHtml), variant.subject);
          auditLogEvent('campaign', 'regenerated', { id, audience, angle: variant.angle });
        }
      }
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify(out, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message?.substring(0, 300)})); }
    return;
  }

  // ─── GET /admin/variation-status — voir historique angles par audience
  if (req.method === 'GET' && url.startsWith('/admin/variation-status')) {
    try {
      const v = require('./campaign_variation');
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify(v.variationStatus(), null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/brevo-html?id=N — return HTML raw pour debug/audit
  if (req.method === 'GET' && url.startsWith('/admin/brevo-html')) {
    if (!requireAdmin(req, res)) return;
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    if (!id) { res.writeHead(400); res.end(JSON.stringify({error:'?id=N requis'})); return; }
    try {
      const r1 = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (!r1.ok) { res.writeHead(r1.status); res.end(await r1.text()); return; }
      const camp = await r1.json();
      // Extract taux patterns (X.X% ou X,X%)
      const html = camp.htmlContent || '';
      const rateMatches = [...html.matchAll(/(\d+[\.,]\d{1,3})\s*%/g)].map(m => m[1]);
      // Extract montants $ — patterns multiples (avant et après $)
      const amountMatches = [
        ...[...html.matchAll(/\$\s*(\d{1,3}(?:[\s, ]\d{3})+)/g)].map(m => m[1]),
        ...[...html.matchAll(/(\d{1,3}(?:[\s, ]\d{3})+)\s*\$/g)].map(m => m[1]),
      ];
      // Cherche AUSSI "4.44", "4,44", "4&#46;44" même sans % (au cas où entity ou texte alt)
      const hardSearch = ['4.44', '4,44', '4&#46;44', '4&#x2E;44', '4.04', '4,04', '6.09', '6,09'];
      const hardSearchResults = {};
      for (const term of hardSearch) {
        const cnt = (html.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
        if (cnt > 0) hardSearchResults[term] = cnt;
      }
      // Cherche contexte autour de chaque taux (50 chars avant/après)
      const rateContexts = [];
      let m;
      const re = /(\d+[\.,]\d{1,3})\s*%/g;
      while ((m = re.exec(html)) !== null) {
        const start = Math.max(0, m.index - 80);
        const end = Math.min(html.length, m.index + 80);
        const ctx = html.substring(start, end).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        rateContexts.push({ rate: m[1], context: ctx });
      }
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({
        id, name: camp.name, subject: camp.subject,
        html_length: html.length,
        rates_found: [...new Set(rateMatches)],
        amounts_found: [...new Set(amountMatches)],
        rate_contexts: rateContexts.slice(0, 20),
        hard_search: hardSearchResults,
        html_first_3000: html.substring(0, 3000),
      }, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/preview-via-gmail?id=N&to=X — envoie campagne via Gmail OAuth
  // Bypass Brevo SMTP qui hold les emails (status=requests sans delivered).
  // Défaut: shawn@signaturesb.com (Inbox + Sent puisque Gmail OAuth = shawn@).
  if (req.method === 'GET' && url.startsWith('/admin/preview-via-gmail')) {
    if (!requireAdmin(req, res)) return;
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    const to = u.searchParams.get('to') || SHAWN_EMAIL;
    if (!id) { res.writeHead(400); res.end(JSON.stringify({error:'?id=N requis'})); return; }
    try {
      // 1. Fetch campagne Brevo (subject + htmlContent)
      const r1 = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (!r1.ok) { res.writeHead(r1.status); res.end(await r1.text()); return; }
      const camp = await r1.json();
      // Subject avec timestamp + version pour distinguer plusieurs previews
      const u2 = new URL(req.url, 'http://x');
      const tag = u2.searchParams.get('tag') || new Date().toLocaleTimeString('fr-CA', { timeZone: 'America/Toronto', hour: '2-digit', minute: '2-digit' });
      const subject = `[PREVIEW ${tag}] ${camp.subject}`;
      const htmlContent = camp.htmlContent || '<p>(no html)</p>';
      // 2. Send via Gmail API directement (PAS sendEmailLogged car self-send vers shawn@)
      // sendEmailLogged check Cc Shawn → si To=shawn@, skip Cc auto + skip Telegram trace
      // (sinon notif de notif). On garde l'audit log manuellement.
      const token = await getGmailToken();
      if (!token) { res.writeHead(500); res.end(JSON.stringify({error:'gmail token absent'})); return; }
      const enc = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
      const lines = [
        `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
        `To: ${to}`,
        `Reply-To: ${AGENT.email}`,
        `Subject: ${enc(subject)}`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(htmlContent, 'utf-8').toString('base64'),
      ];
      const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      const gmailRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      const gmailBody = await gmailRes.json().catch(() => ({}));
      const ok = gmailRes.ok;
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({
        ok, status: gmailRes.status,
        to, subject,
        campaign_name: camp.name,
        html_length: htmlContent.length,
        via: 'gmail-direct',
        gmail_message_id: gmailBody.id,
        gmail_thread_id: gmailBody.threadId,
        error: ok ? null : gmailBody.error?.message,
      }, null, 2));
      if (ok) auditLogEvent('preview', 'sent-via-gmail', { id, to, gmail_id: gmailBody.id });
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/brevo-events?email=X — vérifier statut delivery
  if (req.method === 'GET' && url.startsWith('/admin/brevo-events')) {
    if (!requireAdmin(req, res)) return;
    const u = new URL(req.url, 'http://x');
    const email = u.searchParams.get('email') || SHAWN_EMAIL;
    const limit = u.searchParams.get('limit') || '20';
    try {
      const r = await fetch(`https://api.brevo.com/v3/smtp/statistics/events?email=${encodeURIComponent(email)}&limit=${limit}`, {
        headers: { 'api-key': process.env.BREVO_API_KEY },
      });
      const data = await r.json();
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify(data, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/brevo-send-raw?id=N&to=email — bypass sendTest, envoie via SMTP API
  // Permet de garantir delivery quand sendTest Brevo échoue (sender unauthorized etc)
  if (req.method === 'GET' && url.startsWith('/admin/brevo-send-raw')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 10)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const tok = u.searchParams.get('token') || '';
    if (tok !== process.env.WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }
    const id = u.searchParams.get('id');
    const to = u.searchParams.get('to') || SHAWN_EMAIL;
    if (!id) { res.writeHead(400); res.end(JSON.stringify({error:'?id=N requis'})); return; }
    try {
      // 1. Fetch full campagne pour récupérer subject + htmlContent + sender
      const r1 = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (!r1.ok) { res.writeHead(r1.status); res.end(await r1.text()); return; }
      const camp = await r1.json();
      // Brevo refuse sender avec BOTH id AND email → garder seulement email + name
      const rawSender = camp.sender || { name: AGENT.nom, email: AGENT.email };
      const senderObj = { email: rawSender.email, name: rawSender.name };
      // Self-send trap: Gmail filtre les emails de shawn@ → shawn@. On force destinataire
      // alternatif si match. Override via ?to=...
      const isSameAsSender = senderObj.email?.toLowerCase() === to.toLowerCase();
      const finalTo = isSameAsSender && u.searchParams.get('force') !== '1'
        ? (u.searchParams.get('alt') || 'shawnbarrette@icloud.com')
        : to;
      const subject = `[PREVIEW${isSameAsSender ? ' — destinataire ajusté' : ''}] ${camp.subject}`;
      const htmlContent = camp.htmlContent || '<p>(no html)</p>';
      // 2. Envoyer via Brevo SMTP API (sendinblue transactional)
      const r2 = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: senderObj,
          to: [{ email: finalTo, name: 'Shawn' }],
          replyTo: { email: AGENT.email, name: AGENT.nom },
          subject,
          htmlContent,
          tags: ['preview', `campaign-${id}`],
        }),
      });
      const body = await r2.text();
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({
        ok: r2.ok, status: r2.status,
        sender_used: senderObj,
        to_requested: to,
        to_actual: finalTo,
        self_send_detected: isSameAsSender,
        subject,
        html_length: htmlContent.length,
        brevo_response: body.substring(0, 500),
      }, null, 2));
      if (r2.ok) auditLogEvent('preview', 'sent-raw', { id, to: finalTo, sender: senderObj.email });
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/market-debug?source=banque_canada — raw markdown pour fix regex
  if (req.method === 'GET' && url.startsWith('/admin/market-debug')) {
    const u = new URL(req.url, 'http://x');
    const tok = u.searchParams.get('token') || '';
    if (tok !== process.env.WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }
    const sourceKey = u.searchParams.get('source') || 'banque_canada';
    try {
      const mi = require('./market_intelligence');
      const firecrawl = require('./firecrawl_scraper');
      const src = mi.SOURCES[sourceKey];
      if (!src) { res.writeHead(404); res.end(JSON.stringify({error: 'source unknown', avail: Object.keys(mi.SOURCES)})); return; }
      const r = await firecrawl.scrapUrl(src.url, src.keywords || []);
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({
        source: sourceKey, url: src.url,
        len: r?.contenu?.length || 0,
        markdown_first_3000: (r?.contenu || '').substring(0, 3000),
        extracted: src.extract ? src.extract(r?.contenu || '') : null,
      }, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/market-refresh — force refresh market_intelligence
  if (req.method === 'GET' && url.startsWith('/admin/market-refresh')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const tok = u.searchParams.get('token') || '';
    if (tok !== process.env.WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }
    const sources = u.searchParams.get('sources')?.split(',').filter(Boolean) || null;
    try {
      const mi = require('./market_intelligence');
      const r = await mi.refreshMarketSnapshot({ sources });
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({
        ok: true,
        sources_ok: Object.keys(r.data || {}),
        sources_err: r.errors || {},
        digest: mi.buildMarketDigest(),
      }, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/market-status — snapshot actuel sans refresh
  if (req.method === 'GET' && url.startsWith('/admin/market-status')) {
    try {
      const mi = require('./market_intelligence');
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({ status: mi.marketStatus(), digest: mi.buildMarketDigest() }, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); }
    return;
  }

  // ─── GET /admin/brevo-replace?id=N&from=X&to=Y[&dry=1] — find/replace HTML+subject
  // Cas typique: fix "avril" → "mai" dans campagne. dry=1 = preview seulement.
  if (req.method === 'GET' && url.startsWith('/admin/brevo-replace')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 10)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const tok = u.searchParams.get('token') || '';
    if (tok !== process.env.WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }
    const id = u.searchParams.get('id');
    const fromText = u.searchParams.get('from');
    const toText = u.searchParams.get('to');
    const dry = u.searchParams.get('dry') === '1';
    if (!id || !fromText || !toText) { res.writeHead(400); res.end(JSON.stringify({error: 'id+from+to requis'})); return; }
    try {
      // 1. Fetch campagne
      const r1 = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (!r1.ok) { res.writeHead(r1.status); res.end(await r1.text()); return; }
      const camp = await r1.json();
      const oldSubject = camp.subject || '';
      const oldHtml = camp.htmlContent || '';
      // Case-insensitive replace mais préserve la casse simple (mai/Mai/MAI)
      const reFrom = new RegExp(fromText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      const newSubject = oldSubject.replace(reFrom, (m) => {
        if (m === m.toUpperCase()) return toText.toUpperCase();
        if (m[0] === m[0].toUpperCase()) return toText.charAt(0).toUpperCase() + toText.slice(1);
        return toText;
      });
      const newHtml = oldHtml.replace(reFrom, (m) => {
        if (m === m.toUpperCase()) return toText.toUpperCase();
        if (m[0] === m[0].toUpperCase()) return toText.charAt(0).toUpperCase() + toText.slice(1);
        return toText;
      });
      const subjectChanged = oldSubject !== newSubject;
      const htmlChanged = oldHtml !== newHtml;
      const occurrencesSubject = (oldSubject.match(reFrom) || []).length;
      const occurrencesHtml = (oldHtml.match(reFrom) || []).length;
      const out = {
        id, from: fromText, to: toText, dry,
        campaign_name: camp.name,
        subject_changed: subjectChanged,
        html_changed: htmlChanged,
        occurrences_subject: occurrencesSubject,
        occurrences_html: occurrencesHtml,
        old_subject: oldSubject,
        new_subject: newSubject,
      };
      if (dry) { res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(out, null, 2)); return; }
      // 2. PUT update si changement
      if (!subjectChanged && !htmlChanged) { out.note = 'Aucun changement nécessaire'; res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(out, null, 2)); return; }
      const r2 = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, {
        method: 'PUT',
        headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ subject: newSubject, htmlContent: newHtml }),
      });
      out.put_status = r2.status;
      out.put_ok = r2.ok || r2.status === 204;
      if (!out.put_ok) out.put_error = (await r2.text()).substring(0, 300);
      else auditLogEvent('brevo', 'replace-applied', { id, from: fromText, to: toText, subject: subjectChanged, html: htmlChanged });
      res.writeHead(200, {'content-type':'application/json'}); res.end(JSON.stringify(out, null, 2)); return;
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error: e.message})); return; }
  }

  // ─── GET /admin/brevo-list?status=X — liste campagnes Brevo
  if (req.method === 'GET' && url.startsWith('/admin/brevo-list')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 10)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const status = u.searchParams.get('status') || '';
    const limit = u.searchParams.get('limit') || '50';
    try {
      const qs = new URLSearchParams({ limit });
      if (status) qs.set('status', status);
      const r = await fetch(`https://api.brevo.com/v3/emailCampaigns?${qs}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      const data = await r.json();
      const summary = (data.campaigns || []).map(c => ({
        id: c.id, name: c.name, subject: c.subject, status: c.status,
        scheduledAt: c.scheduledAt, sentDate: c.sentDate, modifiedAt: c.modifiedAt,
      }));
      res.writeHead(200, { 'content-type':'application/json' });
      res.end(JSON.stringify({ count: summary.length, campaigns: summary }, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ─── GET /admin/brevo-campaign?id=N — info campagne Brevo
  if (req.method === 'GET' && url.startsWith('/admin/brevo-campaign')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 10)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    if (!id) { res.writeHead(400); res.end(JSON.stringify({error:'?id=N requis'})); return; }
    try {
      const r = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY, 'accept':'application/json' } });
      const data = await r.json();
      res.writeHead(r.status, { 'content-type':'application/json' });
      res.end(JSON.stringify(data, null, 2));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({error:e.message})); }
    return;
  }

  // ─── POST /admin/brevo-cancel?id=N — ANNULE une campagne Brevo schedulée
  // Brevo: PUT /v3/emailCampaigns/{id}/status body {status:"suspended"} pour pause
  // OU DELETE /v3/emailCampaigns/{id} pour suppression définitive
  if ((req.method === 'POST' || req.method === 'GET') && url.startsWith('/admin/brevo-cancel')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const id = u.searchParams.get('id');
    const action = u.searchParams.get('action') || 'suspend'; // suspend | delete
    if (!id) { res.writeHead(400); res.end(JSON.stringify({error:'?id=N requis'})); return; }
    const out = { id, action, before: null, after: null, errors: [] };
    try {
      // Get current state
      const before = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      const beforeData = await before.json();
      out.before = { status: beforeData.status, scheduledAt: beforeData.scheduledAt, name: beforeData.name, subject: beforeData.subject };
      // Cancel
      if (action === 'delete') {
        const dr = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { method: 'DELETE', headers: { 'api-key': process.env.BREVO_API_KEY } });
        out.deletedHttp = dr.status;
      } else {
        // Suspend = set status to "draft" via Brevo API (annule schedule)
        const sr = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}/status`, {
          method: 'PUT',
          headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type':'application/json' },
          body: JSON.stringify({ status: 'suspended' })
        });
        if (!sr.ok) {
          // Fallback: try setting back to draft
          const dr = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}/status`, {
            method: 'PUT',
            headers: { 'api-key': process.env.BREVO_API_KEY, 'content-type':'application/json' },
            body: JSON.stringify({ status: 'draft' })
          });
          out.fallbackDraftHttp = dr.status;
          if (!dr.ok) out.errors.push(`suspend HTTP ${sr.status}, draft HTTP ${dr.status}`);
        } else { out.suspendedHttp = sr.status; }
      }
      // Verify after
      const after = await fetch(`https://api.brevo.com/v3/emailCampaigns/${id}`, { headers: { 'api-key': process.env.BREVO_API_KEY } });
      if (after.ok) {
        const afterData = await after.json();
        out.after = { status: afterData.status, scheduledAt: afterData.scheduledAt };
      }
    } catch (e) { out.errors.push(e.message); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── GET /admin/delete-deals-stage — supprime tous les deals d'une étape ─
  // Query params: ?stage=48 (multi via virgules) ?dry=1 (preview)
  // ATTENTION DESTRUCTIF: par défaut DRY-RUN, faut explicitement ?dry=0 pour exécuter
  if (req.method === 'GET' && url.startsWith('/admin/delete-deals-stage')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 3)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const stages = (u.searchParams.get('stage') || '').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    const dry = u.searchParams.get('dry') !== '0';
    const out = { dry, stages, deals_found: 0, deals_deleted: 0, sample: [], errors: [] };
    if (!stages.length) {
      out.errors.push('?stage=N requis (ex: ?stage=48 ou ?stage=48,49)');
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out, null, 2)); return;
    }
    try {
      const allDeals = [];
      for (const stage of stages) {
        let start = 0;
        while (true) {
          const r = await pdGet(`/deals?stage_id=${stage}&status=all_not_deleted&start=${start}&limit=500`);
          const items = r?.data || [];
          allDeals.push(...items);
          if (!r?.additional_data?.pagination?.more_items_in_collection) break;
          start = r.additional_data.pagination.next_start;
          if (start === undefined || start === null) break;
        }
      }
      out.deals_found = allDeals.length;
      // Sample preview
      out.sample = allDeals.slice(0, 10).map(d => ({ id: d.id, title: d.title, stage_id: d.stage_id, person: d.person_name, value: d.value, add_time: d.add_time }));
      if (!dry) {
        // BACKUP avant suppression — recovery garantie
        const backup = await backupBeforeAction(`delete_deals_stage_${stages.join('_')}`, allDeals);
        out.backup = backup;
        for (const d of allDeals) {
          try {
            // ALSO delete all open activities first to avoid orphans (proper API)
            const acts = await pdGet(`/deals/${d.id}/activities?done=0&limit=200`);
            for (const a of (acts?.data || []).filter(a => a.deal_id === d.id || a.deal_id == null)) {
              await fetch(`https://api.pipedrive.com/v1/activities/${a.id}?api_token=${process.env.PIPEDRIVE_API_KEY}`, { method: 'DELETE' }).catch(() => {});
            }
            // Delete deal
            const dr = await fetch(`https://api.pipedrive.com/v1/deals/${d.id}?api_token=${process.env.PIPEDRIVE_API_KEY}`, { method: 'DELETE' });
            if (dr.ok) out.deals_deleted++;
            else out.errors.push(`Deal ${d.id}: HTTP ${dr.status}`);
          } catch (e) { out.errors.push(`Deal ${d.id}: ${e.message}`); }
        }
      }
      out.summary = dry
        ? `DRY-RUN: ${out.deals_found} deals à supprimer (étapes ${stages.join(',')})`
        : `EXÉCUTÉ: ${out.deals_deleted}/${out.deals_found} deals supprimés (+ leurs activités open)`;
    } catch (e) { out.errors.push(`Top: ${e.message}`); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── GET /admin/cleanup-activity-dups — nettoie doublons activités ───────
  // Query params: ?stage=48 (filtre étape, multi via virgules) ?dry=1 (preview)
  // Pour chaque deal de l'étape: garde la +récente activité open, delete reste.
  if (req.method === 'GET' && url.startsWith('/admin/cleanup-activity-dups')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const stages = (u.searchParams.get('stage') || '48').split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
    const dry = u.searchParams.get('dry') !== '0'; // défaut DRY-RUN
    const out = { dry, stages, deals_scanned: 0, deals_with_dups: 0, total_activities_found: 0, total_to_delete: 0, total_deleted: 0, sample: [], errors: [] };
    try {
      // 1. Fetch deals des étapes ciblées (paginé)
      const allDeals = [];
      for (const stage of stages) {
        let start = 0;
        while (true) {
          const r = await pdGet(`/deals?stage_id=${stage}&status=all_not_deleted&start=${start}&limit=500`);
          const items = r?.data || [];
          allDeals.push(...items);
          if (!r?.additional_data?.pagination?.more_items_in_collection) break;
          start = r.additional_data.pagination.next_start;
          if (start === undefined || start === null) break;
        }
      }
      out.deals_scanned = allDeals.length;
      // 2. Pour chaque deal: lister activités open via endpoint /deals/{id}/flow ou /deals/{id}/activities
      // BUG FIX 2026-05-05: l'endpoint /activities?deal_id=X ne filtrait PAS correctement —
      // il retournait toutes les activités du compte (30k+), pas celles du deal seul.
      // L'endpoint /deals/{id}/activities est l'API correcte pour filtrer.
      for (const deal of allDeals) {
        try {
          const acts = await pdGet(`/deals/${deal.id}/activities?done=0&limit=200`);
          const list = (acts?.data || []).filter(a => a && a.id && (a.deal_id === deal.id || a.deal_id == null));
          if (list.length <= 1) continue; // 0 ou 1 activité = OK
          out.deals_with_dups++;
          out.total_activities_found += list.length;
          // Garder la +récente — sort par add_time desc (fallback id desc)
          list.sort((a, b) => {
            const ta = a.add_time ? new Date(a.add_time).getTime() : 0;
            const tb = b.add_time ? new Date(b.add_time).getTime() : 0;
            if (ta !== tb) return tb - ta;
            return b.id - a.id;
          });
          const keep = list[0];
          const toDelete = list.slice(1);
          out.total_to_delete += toDelete.length;
          if (out.sample.length < 5) {
            out.sample.push({
              deal_id: deal.id,
              deal_title: deal.title,
              total_open: list.length,
              keep_id: keep.id,
              keep_subject: keep.subject,
              delete_count: toDelete.length,
            });
          }
          // 3. Delete (sauf si dry)
          if (!dry) {
            for (const a of toDelete) {
              try {
                const dr = await fetch(`https://api.pipedrive.com/v1/activities/${a.id}?api_token=${process.env.PIPEDRIVE_API_KEY}`, { method: 'DELETE' });
                if (dr.ok) out.total_deleted++;
                else out.errors.push(`Delete activity ${a.id}: HTTP ${dr.status}`);
              } catch (e) { out.errors.push(`Delete activity ${a.id}: ${e.message}`); }
            }
          }
        } catch (e) { out.errors.push(`Deal ${deal.id}: ${e.message}`); }
      }
      out.summary = dry
        ? `DRY-RUN: ${out.total_to_delete} activités à supprimer sur ${out.deals_with_dups} deals (${out.deals_scanned} deals scannés, étapes ${stages.join(',')})`
        : `EXÉCUTÉ: ${out.total_deleted}/${out.total_to_delete} activités supprimées sur ${out.deals_with_dups} deals`;
    } catch (e) { out.errors.push(`Top: ${e.message}`); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── GET /admin/check-plans — fetch real plan info Brevo + Dropbox ───────
  if (req.method === 'GET' && url.startsWith('/admin/check-plans')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 10)) { res.writeHead(429); res.end('rate limit'); return; }
    const out = { brevo: null, dropbox: null, errors: [] };
    // Brevo /v3/account
    try {
      if (process.env.BREVO_API_KEY) {
        const r = await fetch('https://api.brevo.com/v3/account', { headers: { 'api-key': process.env.BREVO_API_KEY, 'accept': 'application/json' } });
        if (r.ok) {
          const data = await r.json();
          out.brevo = {
            email: data.email,
            companyName: data.companyName,
            plan: data.plan,  // array de plans actifs
            firstName: data.firstName,
            lastName: data.lastName,
          };
        } else { out.errors.push(`Brevo HTTP ${r.status}`); }
      } else { out.errors.push('BREVO_API_KEY absent'); }
    } catch (e) { out.errors.push(`Brevo: ${e.message}`); }
    // Dropbox /2/users/get_current_account
    try {
      if (process.env.DROPBOX_REFRESH_TOKEN) {
        // Refresh token first
        const refreshRes = await fetch('https://api.dropboxapi.com/oauth2/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: process.env.DROPBOX_REFRESH_TOKEN,
            client_id: process.env.DROPBOX_APP_KEY,
            client_secret: process.env.DROPBOX_APP_SECRET,
          }),
        });
        const tokenData = await refreshRes.json();
        if (tokenData.access_token) {
          const r = await fetch('https://api.dropboxapi.com/2/users/get_current_account', {
            method: 'POST', headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
          });
          if (r.ok) {
            const data = await r.json();
            out.dropbox = {
              email: data.email,
              account_type: data.account_type,  // {".tag": "basic"|"pro"|"business"}
              name: data.name?.display_name,
              country: data.country,
            };
            // Aussi space usage
            const sr = await fetch('https://api.dropboxapi.com/2/users/get_space_usage', {
              method: 'POST', headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            if (sr.ok) {
              const su = await sr.json();
              out.dropbox.space = {
                used_gb: (su.used / 1e9).toFixed(2),
                allocated_gb: (su.allocation?.allocated / 1e9 || 0).toFixed(2),
                type: su.allocation?.['.tag'],
              };
            }
          } else { out.errors.push(`Dropbox HTTP ${r.status}`); }
        } else { out.errors.push('Dropbox token refresh failed'); }
      } else { out.errors.push('DROPBOX_REFRESH_TOKEN absent'); }
    } catch (e) { out.errors.push(`Dropbox: ${e.message}`); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── POST /admin/setenv-firecrawl — push Firecrawl key + test live ───────
  // Sécurité: teste la clé contre Firecrawl API avant save. Si invalide → reject.
  if (req.method === 'POST' && url === '/admin/setenv-firecrawl') {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) {
      res.writeHead(429); res.end('rate limit'); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 1000) req.destroy(); });
    req.on('end', async () => {
      try {
        const key = body.trim();
        if (!/^fc-[a-f0-9]{20,}$/i.test(key)) {
          res.writeHead(400); res.end('format clé invalide (attendu fc-xxxxxx)'); return;
        }
        // Test contre Firecrawl
        const test = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }),
          signal: AbortSignal.timeout(15000),
        });
        if (test.status === 401 || test.status === 403) {
          res.writeHead(401); res.end('clé refusée par Firecrawl'); return;
        }
        // OK — save dans process.env + Dropbox
        process.env.FIRECRAWL_API_KEY = key;
        try {
          if (typeof uploadDropboxSecret === 'function') {
            await uploadDropboxSecret('FIRECRAWL_API_KEY', key);
          }
        } catch {}
        if (ALLOWED_ID) {
          sendTelegramWithFallback(
            `🔥 *FIRECRAWL_API_KEY activée*\n\n${key.length} chars · testée live ✅\nSauvegardée Dropbox /bot-secrets/ + process.env\n\n_Scraping web actif maintenant._`,
            { category: 'firecrawl-set' }
          ).catch(() => {});
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, length: key.length, tested: 'firecrawl ok' }));
      } catch (e) {
        res.writeHead(500); res.end(`error: ${e.message?.substring(0, 200)}`);
      }
    });
    return;
  }

  // ─── GET /admin/cua-test?num=N — test CUA end-to-end sur un listing
  // Retourne taille PDF + source + message. Auth WEBHOOK_SECRET requise.
  if (req.method === 'GET' && url.startsWith('/admin/cua-test')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const tok = u.searchParams.get('token') || '';
    if (tok !== process.env.WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }
    const num = u.searchParams.get('num') || '';
    if (!/^\d{7,9}$/.test(num)) { res.writeHead(400); res.end(JSON.stringify({error: '?num=N (7-9 chiffres) requis'})); return; }
    const out = { num, started: new Date().toISOString() };
    try {
      const cua = getCUA();
      if (!cua || !cua.CUA_AVAILABLE()) {
        out.error = 'CUA non disponible (playwright-core ou @anthropic-ai/sdk manquant)';
        res.writeHead(503); res.end(JSON.stringify(out, null, 2)); return;
      }
      out.status_before = cua.cuaStatus();
      const r = await cua.cuaGetCentrisPDF(num);
      out.success = r.success;
      out.message = r.message;
      out.filename = r.filename;
      out.bytes = r.buffer ? r.buffer.length : 0;
      out.fromCache = r.fromCache || false;
      out.status_after = cua.cuaStatus();
    } catch (e) { out.exception = e.message; }
    out.finished = new Date().toISOString();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── GET /admin/zone-test?num=N — test Zone Centris dry-run (preview docs + courtier)
  // Reproduce le tool envoyer_tous_documents_zone sans envoyer, capture erreur exacte
  if (req.method === 'GET' && url.startsWith('/admin/zone-test')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const tok = u.searchParams.get('token') || '';
    if (tok !== process.env.WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }
    const num = u.searchParams.get('num') || '';
    if (!/^\d{7,9}$/.test(num)) { res.writeHead(400); res.end(JSON.stringify({error: '?num=N (7-9 chiffres) requis'})); return; }
    const out = { num, started: new Date().toISOString() };
    try {
      const cua = getCUA();
      if (!cua || !cua.CUA_AVAILABLE()) {
        out.error = 'CUA non disponible';
        res.writeHead(503); res.end(JSON.stringify(out, null, 2)); return;
      }
      if (!cua.shareCentrisZoneDocuments) {
        out.error = 'shareCentrisZoneDocuments absent (deploy needed)';
        res.writeHead(503); res.end(JSON.stringify(out, null, 2)); return;
      }
      out.status_before = cua.cuaStatus();
      const r = await cua.shareCentrisZoneDocuments({ centris_num: num, dry_run: true });
      out.success = r.success;
      out.dry_run = r.dry_run;
      out.broker_info = r.broker_info;
      out.docs_count = r.docs_count;
      out.docs_list = r.docs_list;
      out.message = r.message;
      out.listing_url = r.listing_url;
      out.status_after = cua.cuaStatus();
    } catch (e) {
      out.exception = e.message;
      out.stack = (e.stack || '').split('\n').slice(0, 5);
    }
    out.finished = new Date().toISOString();
    out.elapsed_ms = Date.now() - new Date(out.started).getTime();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out, null, 2));
    return;
  }

  // ─── GET /admin/test-white-label?to=email&num=N — envoi listing white-label réel
  // Si num= fourni: scrape photos publiques + télécharge fiche PDF Centris + envoie HTML v11
  // Si num= absent: data Saint-Esprit hardcoded + PDF placeholder (test design only)
  if (req.method === 'GET' && url.startsWith('/admin/test-white-label')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const tok = u.searchParams.get('token') || '';
    if (tok !== process.env.WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }
    const toEmail = u.searchParams.get('to') || AGENT.email;
    const num = (u.searchParams.get('num') || '').replace(/\D/g, '').trim();
    // PRE-FLIGHT 1: validate email format
    if (!/@/.test(toEmail) || !/^[^@]+@[^@]+\.[^@]+$/.test(toEmail)) {
      res.writeHead(400); res.end(JSON.stringify({error: 'to=email valide requis'})); return;
    }
    // PRE-FLIGHT 2: validate centris num format si fourni
    if (num && !/^\d{7,9}$/.test(num)) {
      res.writeHead(400); res.end(JSON.stringify({error: 'num=N invalide (7-9 chiffres)'})); return;
    }
    const out = { to: toEmail, num: num || null, started: new Date().toISOString(), steps: [] };
    try {
      // 1. Si num: scrape photos + télécharge fiche PDF
      let listingData = {
        adresse: '280 Rang Montcalm, Saint-Esprit',
        prix: '799 000$',
        centrisNum: '18366287',
        type: 'Fermette',
        statut: 'En vigueur',
        chambres: '4', sdb: '2', annee: '1985',
        superficie: '2 240 pc', terrain: '5 384 545 pc',
        description: 'Magnifique fermette sur 124 acres avec maison ancestrale entièrement rénovée, grande grange double, étang naturel, terre cultivable et boisé mature. Vue imprenable sur les Laurentides. Idéale pour fermette d\'agrément, équestre ou projet de développement.',
        nbPhotos: 12,
        photos: [],
        photoMainUrl: null,
      };
      let pdfBuf = null;
      let pdfFilename = 'Fiche_descriptive_Centris.pdf';

      if (num) {
        // Scrape photos publiques (rapide, no login)
        out.steps.push(`scrape photos publiques #${num}`);
        const cuaMod = getCUA();
        if (cuaMod?.getCentrisListingPhotos) {
          const photoResult = await cuaMod.getCentrisListingPhotos(num);
          if (photoResult.success) {
            listingData.photos = photoResult.photos;
            listingData.photoMainUrl = photoResult.main;
            listingData.nbPhotos = photoResult.count;
            listingData.centrisNum = num;
            if (photoResult.adresse) listingData.adresse = photoResult.adresse;
            if (photoResult.prix) listingData.prix = photoResult.prix;
            out.steps.push(`✅ ${photoResult.count} photos extraites + adresse "${photoResult.adresse || '?'}"`);
          } else {
            out.steps.push(`⚠️ photos publiques fail: ${photoResult.message}`);
          }
        }

        // Télécharge fiche descriptive PDF via Matrix UI direct (PAS CUA agent — économique + plus fiable)
        out.steps.push(`télécharge fiche PDF Matrix direct (timeout MFA 180s)...`);
        if (cuaMod?.downloadCentrisFichePDF) {
          const pdfResult = await cuaMod.downloadCentrisFichePDF(num);
          if (pdfResult.success && pdfResult.buffer && pdfResult.buffer.length > 5000) {
            pdfBuf = pdfResult.buffer;
            pdfFilename = pdfResult.filename || `Fiche_Centris_${num}.pdf`;
            out.steps.push(`✅ fiche PDF ${Math.round(pdfBuf.length/1024)}KB${pdfResult.fromCache ? ' (cache)' : ''} via ${pdfResult.via || 'direct'}`);
          } else {
            out.steps.push(`⚠️ fiche PDF fail: ${pdfResult.message}. Email sans PJ.`);
          }
        } else if (cuaMod?.cuaGetCentrisPDF) {
          // Fallback ancien CUA si nouvelle fonction pas dispo
          const pdfResult = await cuaMod.cuaGetCentrisPDF(num);
          if (pdfResult.success && pdfResult.buffer) {
            pdfBuf = pdfResult.buffer;
            pdfFilename = pdfResult.filename || `Fiche_Centris_${num}.pdf`;
            out.steps.push(`✅ fiche PDF via CUA fallback ${Math.round(pdfBuf.length/1024)}KB`);
          }
        }
      }

      // 2. Build HTML v11 avec data (réelle ou test)
      out.steps.push('build HTML v11');
      const htmlV11 = buildWhiteLabelHTMLv11(listingData);
      out.steps.push(`HTML built (${htmlV11.length} chars)`);

      // 2. Get Gmail token
      const token = await getGmailToken();
      if (!token) {
        out.error = 'Gmail token absent';
        res.writeHead(503); res.end(JSON.stringify(out, null, 2)); return;
      }
      out.steps.push('Gmail token OK');

      // 3. Build MIME multipart avec HTML + PJ (vraie fiche PDF si scraping OK, sinon sans PJ)
      const outer = `wlOut${Date.now()}`;
      const inner = `wlAlt${Date.now()}`;
      const enc = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
      const subject = `Voici la propriété! — ${listingData.adresse}`;

      // PRE-FLIGHT: vérifier que MIME total < 24MB (Gmail limit 25MB)
      const pdfSize = pdfBuf ? pdfBuf.length : 0;
      if (pdfSize > 24 * 1024 * 1024) {
        out.error = `PDF trop gros (${Math.round(pdfSize/1024/1024)}MB > 24MB Gmail limit)`;
        res.writeHead(413); res.end(JSON.stringify(out, null, 2)); return;
      }

      const textBody = `Voici la propriété!\n\n${listingData.adresse}\n${listingData.prix}\nN° Centris ${listingData.centrisNum} · ${listingData.type} · ${listingData.statut}\n\nAppelez-moi: 514-927-1340\n${AGENT.email}\nhttps://www.signaturesb.com`;
      const lines = [
        `From: ${AGENT.nom} · Signature SB <${AGENT.email}>`,
        `To: ${toEmail}`,
        `Reply-To: ${AGENT.email}`,
        `Subject: ${enc(subject)}`,
        'MIME-Version: 1.0',
        `Content-Type: multipart/mixed; boundary="${outer}"`,
        '',
        `--${outer}`,
        `Content-Type: multipart/alternative; boundary="${inner}"`,
        '',
        `--${inner}`,
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        textBody,
        '',
        `--${inner}`,
        'Content-Type: text/html; charset=UTF-8',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from(htmlV11, 'utf-8').toString('base64'),
        `--${inner}--`,
        '',
      ];
      // Attach PDF si scraping a réussi
      if (pdfBuf && pdfBuf.length > 5000) {
        lines.push(
          `--${outer}`,
          'Content-Type: application/pdf',
          `Content-Disposition: attachment; filename="${enc(pdfFilename)}"`,
          'Content-Transfer-Encoding: base64',
          '',
          pdfBuf.toString('base64'),
          '',
        );
      }
      lines.push(`--${outer}--`);
      const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
      out.steps.push(`MIME built (raw ${Math.round(raw.length/1024)}KB)`);

      // 4. Send via sendEmailLogged
      const logged = await sendEmailLogged({
        via: 'gmail',
        to: toEmail,
        cc: [],
        subject,
        category: 'test-white-label',
        shawnConsent: true,
        sendFn: async () => {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 30000);
          try {
            return await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
              method: 'POST', signal: ctrl.signal,
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ raw }),
            });
          } finally { clearTimeout(t); }
        },
      });
      if (!logged.ok) {
        out.error = `Gmail send fail ${logged.status}: ${(logged.error||'').substring(0,200)}`;
        res.writeHead(500); res.end(JSON.stringify(out, null, 2)); return;
      }
      out.steps.push('✅ Gmail envoyé');
      out.success = true;
      out.finished = new Date().toISOString();
      out.elapsed_ms = Date.now() - new Date(out.started).getTime();

      // 🔔 NOTIF TELEGRAM auto à chaque envoi white-label (intelligence proactive)
      try {
        const tgMsg = [
          `📧 *Listing envoyé — ${listingData.adresse}*`,
          ``,
          `📬 À: ${toEmail}`,
          `🏠 #${listingData.centrisNum} · ${listingData.type} · ${listingData.prix}`,
          `📸 ${listingData.photos?.length || 0} photos extraites`,
          pdfBuf ? `📄 Fiche PDF jointe (${Math.round(pdfBuf.length/1024)}KB)` : `⚠️ Fiche PDF non jointe (scraping Matrix échoué)`,
          ``,
          `⏱️ ${Math.round(out.elapsed_ms/1000)}s · Template SB v11`,
        ].join('\n');
        await sendTelegramWithFallback(tgMsg, { category: 'white-label-sent' }).catch(() => {});
      } catch {}

      // Audit log persistant
      auditLogEvent('white-label', 'sent', {
        to: toEmail, num: listingData.centrisNum, adresse: listingData.adresse,
        photos: listingData.photos?.length || 0, pdf_attached: !!pdfBuf,
        elapsed_ms: out.elapsed_ms,
      });

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out, null, 2));
    } catch (e) {
      out.exception = e.message;
      out.stack = (e.stack || '').split('\n').slice(0, 5);
      res.writeHead(500); res.end(JSON.stringify(out, null, 2));
    }
    return;
  }

  // ─── GET /admin/centris-fetch?url=URL — fetch n'importe quelle URL Centris avec session
  // Pour debug: tester quelles URLs Matrix retournent PDF avec les cookies fresh du bot
  if (req.method === 'GET' && url.startsWith('/admin/centris-fetch')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 20)) { res.writeHead(429); res.end('rate limit'); return; }
    const u = new URL(req.url, 'http://x');
    const token = u.searchParams.get('token') || '';
    if (token !== process.env.WEBHOOK_SECRET) { res.writeHead(401); res.end('unauthorized'); return; }
    const targetUrl = u.searchParams.get('url') || '';
    if (!targetUrl || !targetUrl.startsWith('http')) { res.writeHead(400); res.end('url required'); return; }
    if (!centrisSession?.cookies) { res.writeHead(503); res.end(JSON.stringify({error:'no centris session'})); return; }
    try {
      const r = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
          'Cookie': centrisSession.cookies,
          'Referer': 'https://matrix.centris.ca/Matrix/Home',
        },
        signal: AbortSignal.timeout(30000),
        redirect: 'follow',
      });
      const buf = Buffer.from(await r.arrayBuffer());
      const ct = r.headers.get('content-type') || '';
      const isPdf = buf.length > 100 && buf.slice(0, 4).toString() === '%PDF';
      const preview = isPdf ? '(PDF binary)' : buf.toString('utf8', 0, 500);
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({
        url: targetUrl,
        finalUrl: r.url,
        status: r.status,
        contentType: ct,
        size: buf.length,
        isPdf,
        preview: preview.substring(0, 500),
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({error: e.message?.substring(0, 200)}));
    }
    return;
  }

  // ─── GET /admin/centris-mfa-code — lit Gmail pour code MFA email Centris/Auth0
  // Pour autonomie complète: Auth0 envoie email à shawn@signaturesb.com, bot lit
  // via OAuth Gmail (déjà setup), extract code 6 chiffres, return.
  // Permet à un script externe de récupérer le code MFA sans intervention manuelle.
  if (req.method === 'GET' && url.startsWith('/admin/centris-mfa-code')) {
    if (!webhookRateOK(req.socket.remoteAddress, url, 30)) {
      res.writeHead(429); res.end('rate limit'); return;
    }
    const u = new URL(req.url, 'http://x');
    const token = u.searchParams.get('token') || '';
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    try {
      const gmailTok = await getGmailToken();
      if (!gmailTok) { res.writeHead(500); res.end(JSON.stringify({error:'no gmail token'})); return; }
      // Cherche emails récents Centris/Auth0/MFA dans la dernière heure — query large
      const query = encodeURIComponent('(from:centris.ca OR from:auth0 OR from:noreply OR from:no-reply OR subject:Centris OR subject:Matrix OR subject:vérification OR subject:verification OR subject:code OR subject:authentif) newer_than:1h');
      const listRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${query}&maxResults=5`, {
        headers: { 'Authorization': `Bearer ${gmailTok}` },
        signal: AbortSignal.timeout(10000),
      });
      const list = await listRes.json();
      const messages = list.messages || [];
      let foundCode = null;
      let foundSubject = null;
      for (const m of messages.slice(0, 5)) {
        const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`, {
          headers: { 'Authorization': `Bearer ${gmailTok}` },
          signal: AbortSignal.timeout(10000),
        });
        const msg = await msgRes.json();
        const headers = msg.payload?.headers || [];
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const snippet = msg.snippet || '';
        // Parse body parts for full text
        let bodyText = snippet;
        const parts = msg.payload?.parts || [msg.payload];
        for (const p of parts) {
          if (p?.body?.data) {
            try {
              bodyText += ' ' + Buffer.from(p.body.data, 'base64').toString('utf8');
            } catch {}
          }
        }
        // Match 6-digit code
        const codeMatch = bodyText.match(/\b(\d{6})\b/);
        if (codeMatch) {
          foundCode = codeMatch[1];
          foundSubject = subject;
          break;
        }
      }
      res.writeHead(200, {'content-type':'application/json'});
      res.end(JSON.stringify({
        ok: !!foundCode,
        code: foundCode,
        subject: foundSubject,
        emails_checked: messages.length,
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({error: e.message?.substring(0, 200)}));
    }
    return;
  }

  // ─── POST /admin/centris-storage-state — push storageState Playwright complet
  // depuis Mac (cookies + localStorage + sessionStorage + UA). Plus fiable que
  // juste cookies car Centris bind session à fingerprint complet.
  if (req.method === 'POST' && url === '/admin/centris-storage-state') {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) {
      res.writeHead(429); res.end('rate limit'); return;
    }
    if (req.headers['x-webhook-secret'] !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 200000) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const { storageState, userAgent } = payload;
        if (!storageState || !storageState.cookies) {
          res.writeHead(400); res.end('storageState manquant'); return;
        }
        const STATE_FILE = path.join(DATA_DIR, 'centris_storage_state.json');
        const data = { storageState, userAgent, capturedAt: Date.now(), expiry: Date.now() + 25 * 24 * 3600 * 1000 };
        safeWriteJSON(STATE_FILE, data);
        auditLogEvent('centris', 'storage-state-captured', { cookies: storageState.cookies.length, origins: storageState.origins?.length || 0, ua: userAgent?.substring(0, 80) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cookies: storageState.cookies.length, origins: storageState.origins?.length || 0, expiresInDays: 25 }));
      } catch (e) {
        res.writeHead(500); res.end(`error: ${e.message?.substring(0, 200)}`);
      }
    });
    return;
  }

  // ─── POST /admin/centris-cookies — push cookies depuis Mac (>4KB) ───────
  // Bypass Telegram 4096 char limit. Sécurité: bot teste les cookies contre
  // Centris AVANT de save — si ça marche pas, on save pas. Donc inutile pour
  // un attaquant d'envoyer du junk. Plus rate limit 5 req/h par IP.
  if (req.method === 'POST' && url === '/admin/centris-cookies') {
    if (!webhookRateOK(req.socket.remoteAddress, url, 5)) {
      res.writeHead(429); res.end('rate limit'); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50000) req.destroy(); });
    req.on('end', async () => {
      try {
        const cookieStr = body.trim();
        if (!cookieStr || cookieStr.length < 100) {
          res.writeHead(400); res.end('cookie string trop court'); return;
        }
        // Test cookies contre matrix.centris.ca
        const testRes = await fetch('https://matrix.centris.ca/Matrix/Default.aspx', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
            'Cookie': cookieStr,
          },
          redirect: 'manual',
        });
        const isAuth = testRes.status === 200 || (testRes.status >= 300 && testRes.status < 400 && !(testRes.headers.get('location') || '').includes('Login'));
        if (!isAuth) {
          res.writeHead(401); res.end(`cookies refusés Centris HTTP ${testRes.status}`); return;
        }
        // Save 25j
        centrisSession = {
          cookies: cookieStr,
          expiry: Date.now() + 25 * 24 * 3600 * 1000,
          authenticated: true,
          lastLoginAt: Date.now(),
          via: 'http-push',
        };
        saveCentrisSessionToDisk();
        auditLogEvent('centris', 'cookies-captured-http', { length: cookieStr.length });
        if (ALLOWED_ID) {
          sendTelegramWithFallback(
            `✅ *Cookies Centris reçus via HTTP*\n\n📦 ${cookieStr.length} chars · session valide ~25 jours\n_Source: POST /admin/centris-cookies_`,
            { category: 'centris-cookies' }
          ).catch(() => {});
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, length: cookieStr.length, expiresInDays: 25 }));
      } catch (e) {
        res.writeHead(500); res.end(`error: ${e.message?.substring(0, 200)}`);
      }
    });
    return;
  }

  // ─── /webhook/sms-bridge — pont iMessage Mac → bot pour codes MFA Centris ──
  // Daemon Mac envoie ici les codes 6-digits captés depuis chat.db (Messages app).
  // Auth: HMAC SHA-256 du body avec SMS_BRIDGE_SECRET partagé.
  // Le code est stocké dans pendingMFA pour être consommé par le flow OAuth Centris.
  if (req.method === 'POST' && url === '/webhook/sms-bridge') {
    if (!webhookRateOK(req.socket.remoteAddress, url, 30)) {
      res.writeHead(429); res.end('too many requests'); return;
    }
    const expectedSecret = process.env.SMS_BRIDGE_SECRET || process.env.WEBHOOK_SECRET;
    if (!expectedSecret) { res.writeHead(503); res.end('SMS_BRIDGE_SECRET not configured'); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        // HMAC validation
        const sigProvided = req.headers['x-bridge-signature'] || '';
        const cryptoMod = require('crypto');
        const expected = cryptoMod.createHmac('sha256', expectedSecret).update(body).digest('hex');
        if (!sigProvided || !cryptoMod.timingSafeEqual(Buffer.from(sigProvided), Buffer.from(expected))) {
          log('WARN', 'SECURITY', `SMS bridge bad HMAC from ${req.socket.remoteAddress}`);
          res.writeHead(401); res.end('unauthorized'); return;
        }
        const data = JSON.parse(body);
        // Heartbeat (daemon vivant)
        if (data.heartbeat) {
          smsBridgeHealth.lastHeartbeat = Date.now();
          smsBridgeHealth.alive = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, type: 'heartbeat-ack' }));
          return;
        }
        // Code MFA reçu
        if (data.code && /^\d{4,8}$/.test(String(data.code))) {
          pendingMFACode = { code: String(data.code), receivedAt: Date.now(), sender: data.sender, text: data.text?.substring(0, 200) };
          // Notifie tous les waiters MFA (résolveurs en attente)
          for (const resolver of mfaWaiters) {
            try { resolver(pendingMFACode.code); } catch {}
          }
          mfaWaiters = [];
          smsBridgeHealth.lastCodeAt = Date.now();
          smsBridgeHealth.totalCodes = (smsBridgeHealth.totalCodes || 0) + 1;
          log('OK', 'SMS-BRIDGE', `Code MFA reçu (${data.sender || '?'})`);
          auditLogEvent('sms-bridge', 'code_received', { sender: data.sender, masked: data.code.substring(0,2)+'****' });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, type: 'code-ingested' }));
          return;
        }
        res.writeHead(400); res.end('invalid payload');
      } catch (e) {
        log('WARN', 'SMS-BRIDGE', `Parse: ${e.message}`);
        res.writeHead(400); res.end('bad json');
      }
    });
    return;
  }

  if (req.method === 'POST' && ['/webhook/centris', '/webhook/sms', '/webhook/reply'].includes(url)) {
    // Rate limiting par IP — anti-abuse (20 req/min max)
    if (!webhookRateOK(req.socket.remoteAddress, url)) {
      log('WARN', 'SECURITY', `Rate limit hit: ${req.socket.remoteAddress} → ${url}`);
      res.writeHead(429); res.end('too many requests'); return;
    }
    const wSecret = process.env.WEBHOOK_SECRET;
    // OBLIGATOIRE — pas d'auth optionnelle sur webhooks publics
    if (!wSecret) {
      log('ERR', 'SECURITY', 'WEBHOOK_SECRET manquant — webhooks rejetés par sécurité');
      res.writeHead(503); res.end('webhook secret not configured'); return;
    }
    const provided = req.headers['x-webhook-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (provided !== wSecret) {
      log('WARN', 'SECURITY', `Webhook ${url} — bad secret from ${req.socket.remoteAddress}`);
      res.writeHead(401); res.end('unauthorized'); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50000) req.destroy(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        res.writeHead(200); res.end('ok');
        if (url === '/webhook/centris') mTick('leads');
        await handleWebhook(url, data);
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

// ─── Gmail Lead Poller — surveille les emails entrants toutes les 5min ────────
let gmailPollerState = loadJSON(POLLER_FILE, { processed: [], lastRun: null, totalLeads: 0 });

// Sources d'emails → leads immobiliers
// Lead parsing — extrait dans lead_parser.js pour testabilité
const { detectLeadSource, isJunkLeadEmail, parseLeadEmail, parseLeadEmailWithAI, isValidProspectName } = leadParser;

// ── Dédoublonnage multi-clé, persisté disque (survit aux redeploys) ─────────
// Indexe par: email (exact, lower-case), téléphone (10 derniers chiffres),
// centris# (normalisé), signature nom+source. TTL 7 jours.
const LEADS_DEDUP_FILE = path.join(DATA_DIR, 'leads_dedup.json');
const recentLeadsByKey = new Map(Object.entries(loadJSON(LEADS_DEDUP_FILE, {})));
function saveLeadsDedup() { saveJSON(LEADS_DEDUP_FILE, Object.fromEntries(recentLeadsByKey)); if (typeof schedulePollerSave === 'function') schedulePollerSave(); }

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10); // 10 derniers chiffres
}
function normalizeName(n) {
  return String(n || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-zà-ü\s]/gi, '');
}
function buildLeadKeys({ email, telephone, centris, nom, source }) {
  const keys = [];
  if (email)             keys.push('e:' + email.toLowerCase().trim());
  const p = normalizePhone(telephone);
  if (p && p.length >= 10) keys.push('t:' + p);
  if (centris)           keys.push('c:' + String(centris).replace(/\D/g, ''));
  const n = normalizeName(nom);
  if (n && source)       keys.push('ns:' + n + ':' + source);
  return keys;
}

function leadAlreadyNotifiedRecently(emailOrLead, telephone, centris, nom, source) {
  // LEGACY: check-only (plus de mark écrit). Support 2 signatures.
  // Nouveau flow: les callers doivent appeler markLeadProcessed() APRÈS
  // traitement réussi — pas au premier coup d'œil. Ça permet le retry
  // automatique au prochain poll si quelque chose plante en cours de route.
  const lead = typeof emailOrLead === 'object' ? emailOrLead : { email: emailOrLead, telephone, centris, nom, source };
  const now = Date.now();
  const TTL = 7 * 24 * 60 * 60 * 1000;
  // Purge expired
  for (const [k, t] of recentLeadsByKey) {
    if (now - t > TTL) recentLeadsByKey.delete(k);
  }
  const keys = buildLeadKeys(lead);
  if (keys.length === 0) return false; // aucune clé utile → ne bloque pas
  for (const k of keys) {
    if (recentLeadsByKey.has(k)) {
      log('INFO', 'DEDUP', `Lead match: ${k} (vu ${Math.round((now-recentLeadsByKey.get(k))/60000)}min ago)`);
      return true;
    }
  }
  return false;
}

// Marquer un lead comme traité avec succès — à appeler UNIQUEMENT quand
// traiterNouveauLead arrive à une décision finale (notif envoyée, auto-sent,
// pending validé, etc.). Si on crash avant cet appel, prochain poll retry.
function markLeadProcessed(leadOrKeys) {
  const keys = Array.isArray(leadOrKeys) ? leadOrKeys : buildLeadKeys(leadOrKeys);
  if (!keys.length) return;
  const now = Date.now();
  for (const k of keys) recentLeadsByKey.set(k, now);
  // CAP: limiter à 5000 entries (FIFO) — prévient memory leak long-terme.
  // TTL 7j purge normalement, mais si purge loupée et trafic élevé, on cap.
  const MAX_DEDUP_ENTRIES = 5000;
  if (recentLeadsByKey.size > MAX_DEDUP_ENTRIES) {
    const overflow = recentLeadsByKey.size - MAX_DEDUP_ENTRIES;
    const oldest = [...recentLeadsByKey.entries()]
      .sort((a, b) => a[1] - b[1])
      .slice(0, overflow);
    for (const [k] of oldest) recentLeadsByKey.delete(k);
  }
  saveLeadsDedup();
}

// Tracker retry par Gmail msgId — max 5 tentatives avant giving up.
// Persisté sur disque pour survivre redeploys.
const LEAD_RETRY_FILE = path.join(DATA_DIR, 'lead_retry.json');
let leadRetryState = {};
try {
  if (fs.existsSync(LEAD_RETRY_FILE)) leadRetryState = JSON.parse(fs.readFileSync(LEAD_RETRY_FILE, 'utf8')) || {};
} catch { leadRetryState = {}; }
function saveLeadRetryState() {
  safeWriteJSON(LEAD_RETRY_FILE, leadRetryState);
}
function getRetryCount(msgId) { return leadRetryState[msgId]?.count || 0; }
function incRetryCount(msgId, err) {
  if (!leadRetryState[msgId]) leadRetryState[msgId] = { count: 0, firstSeen: Date.now() };
  leadRetryState[msgId].count++;
  leadRetryState[msgId].lastTry = Date.now();
  leadRetryState[msgId].lastErr = String(err || '').substring(0, 200);
  saveLeadRetryState();
  // Purge entrées >7j
  const TTL = 7 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  for (const [k, v] of Object.entries(leadRetryState)) {
    if (v.firstSeen && now - v.firstSeen > TTL) delete leadRetryState[k];
  }
}
function resetRetryCount(msgId) {
  if (leadRetryState[msgId]) { delete leadRetryState[msgId]; saveLeadRetryState(); }
}

async function traiterNouveauLead(lead, msgId, from, subject, source, opts = {}) {
  // 🛡️ SHAWN_GERE_SES_SUIVIS=true — cette fonction crée seulement deal+note, JAMAIS d'activité.
  const leadStart = Date.now();
  const { nom, telephone, email, centris, adresse, type } = lead;

  // DÉDUP multi-clé 7j — email OU tel OU centris# OU (nom+source) = skip
  // (opts.skipDedup: utilisé par le replay "nom X" sur un pending — même lead, on reprend)
  if (!opts.skipDedup && leadAlreadyNotifiedRecently({ email, telephone, centris, nom, source: source.source })) {
    log('INFO', 'POLLER', `Dédup 7j: lead ${nom || email || telephone || centris} déjà notifié — skip`);
    // Audit: tracer le dédup pour /lead-audit (sinon silencieux)
    auditLogEvent('lead', 'dedup_skipped', {
      msgId, at: new Date().toISOString(),
      source: source?.label, subject: subject?.substring(0, 100),
      extracted: { nom, telephone, email, centris, adresse, type },
      reason: 'déjà notifié dans les 7 derniers jours (multi-clé)',
      decision: 'dedup_skipped',
    });
    return { decision: 'dedup_skipped' };
  }

  log('OK', 'POLLER', `Lead ${source.label}: ${nom || email || telephone} | Centris: ${centris || '?'}`);

  // ─── CROSS-RÉFÉRENCE — détecter prospect récurrent ─────────────────────
  // Cherche dans Pipedrive si email/tel/nom existe déjà = lead récurrent.
  // Si oui → flag dans audit + suggestion approche basée sur historique
  // (genre "ce prospect a déjà eu visite il y a 3 mois sur autre terrain").
  let _recurrentInfo = null;
  if (PD_KEY && (email || telephone)) {
    try {
      const searchTerms = [email, telephone].filter(Boolean);
      for (const term of searchTerms) {
        const sr = await pdGet(`/persons/search?term=${encodeURIComponent(term)}&limit=2`).catch(() => null);
        const persons = sr?.data?.items || [];
        if (persons.length > 0) {
          const p = persons[0].item;
          // Cherche les deals associés à cette personne
          const dealsRes = await pdGet(`/persons/${p.id}/deals?limit=10`).catch(() => null);
          const oldDeals = dealsRes?.data || [];
          if (oldDeals.length > 0) {
            _recurrentInfo = {
              personId: p.id,
              personName: p.name,
              dealCount: oldDeals.length,
              lastDealTitle: oldDeals[0]?.title,
              lastDealStage: oldDeals[0]?.stage_id,
              lastDealStatus: oldDeals[0]?.status,
            };
            log('INFO', 'POLLER', `🔗 RÉCURRENT détecté: ${p.name} (${oldDeals.length} deal(s) passés)`);
            break;
          }
        }
      }
    } catch (e) { log('WARN', 'POLLER', `Cross-réf: ${e.message?.substring(0, 100)}`); }
  }

  // ─── P1 — Validation nom prospect AVANT création deal ──────────────────────
  // Si le parser n'a pas extrait un nom valide (vide, blacklisté, générique):
  // on met le lead en pending, on alerte Shawn, on attend "nom Prénom Nom"
  // pour reprendre. Évite les deals pourris "Prospect Centris" ou "Shawn Barrette".
  if (!isValidProspectName(nom)) {
    const pendingId = `lead_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const pending = {
      id: pendingId, ts: Date.now(), needsName: true,
      msgId, from, subject, source,
      extracted: { nom: nom || '', telephone: telephone || '', email: email || '', centris: centris || '', adresse: adresse || '', type: type || '' },
    };
    pendingLeads.push(pending);
    // Cap: garder les 50 derniers pending
    if (pendingLeads.length > 50) pendingLeads = pendingLeads.slice(-50);
    savePendingLeads();
    log('WARN', 'POLLER', `Nom invalide "${nom || '(vide)'}" — lead mis en pending (${pendingId})`);
    auditLogEvent('lead', 'pending_invalid_name', {
      msgId, at: new Date().toISOString(), source: source?.label,
      subject: subject?.substring(0, 100), from: from?.substring(0, 120),
      extracted: pending.extracted, pendingId, decision: 'pending_invalid_name',
    });
    if (ALLOWED_ID) {
      const alertMsg = [
        `⚠️ *Lead reçu — nom non identifié*`,
        ``,
        `📧 Email: ${email || '(vide)'}`,
        `📞 Tél: ${telephone || '(vide)'}`,
        `🏡 Centris: ${centris ? `#${centris}` : '(vide)'}`,
        `📍 Adresse: ${adresse || '(vide)'}`,
        `📨 Source: ${source?.label || '?'}`,
        `📝 Sujet: ${(subject || '').substring(0, 80)}`,
        ``,
        `❓ *Nom du prospect?*`,
        `Réponds: \`nom Prénom Nom\` pour créer le deal.`,
        ``,
        `ID: \`${pendingId}\``,
      ].join('\n');
      await sendTelegramWithFallback(alertMsg, { category: 'P1-pending-invalid-name', pendingId });
    }
    return { decision: 'pending_invalid_name', pendingId }; // STOP — pas de deal incomplet, on reprend quand Shawn répond "nom X"
  }
  // ─── FIN P1 ────────────────────────────────────────────────────────────────

  // 1. Créer deal Pipedrive
  let dealTxt = '';
  let dealId  = null;
  if (PD_KEY) {
    try {
      const noteBase = [
        `Lead ${source.label} reçu le ${new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}`,
        adresse ? `Propriété: ${adresse}` : '',
        centris ? `Centris: #${centris}` : '',
        `Email source: ${from}`,
        `Sujet: ${subject}`,
      ].filter(Boolean).join('\n');

      // Fallback nom: si nom extrait est vide ou suspect, utilise "Madame/Monsieur"
      // ou l'email local-part. Le deal Pipedrive sera créé avec un label utilisable.
      const nomFinal = nom || (email ? email.split('@')[0].replace(/[._-]/g, ' ') : 'Prospect Centris');
      // Retry 3× Pipedrive (backoff 0/2s/5s) — si API down, on essaie plusieurs fois
      const maxDealRetries = 3;
      const dealDelays = [0, 2000, 5000];
      for (let attempt = 0; attempt < maxDealRetries && !dealId; attempt++) {
        if (dealDelays[attempt]) await new Promise(r => setTimeout(r, dealDelays[attempt]));
        try {
          dealTxt = await creerDeal({
            prenom: nomFinal.split(' ')[0] || nomFinal,
            nom:    nomFinal.split(' ').slice(1).join(' ') || '',
            telephone, email, type, source: source.source, centris,
            note: noteBase,
          });
          const sr = await pdGet(`/deals/search?term=${encodeURIComponent(nomFinal || email || telephone)}&limit=1`);
          dealId = sr?.data?.items?.[0]?.item?.id;
          if (dealId) break;
        } catch (e) {
          dealTxt = `⚠️ Deal attempt ${attempt + 1}/${maxDealRetries}: ${e.message.substring(0, 80)}`;
          if (attempt === maxDealRetries - 1) log('WARN', 'POLLER', `Deal Pipedrive échoué après ${maxDealRetries} tentatives: ${e.message}`);
        }
      }
    } catch (e) { dealTxt = `⚠️ Deal: ${e.message.substring(0, 80)}`; }
  }

  // 1.5. ANTI-DOUBLONS — Cleanup + auto-complete ancien AVANT toute création
  // Règle Shawn: 1 deal + 1 activité active. Ancien complété au nouveau suivi.
  if (dealId) {
    try {
      const cleanup = await nettoyerDoublonsActivites(dealId);
      if (cleanup.supprimees > 0) {
        log('OK', 'POLLER', `🧹 Anti-doublons deal ${dealId}: ${cleanup.supprimees} doublon(s) supprimé(s)`);
      }
      const completed = await completerAnciennesActivites(dealId);
      if (completed > 0) {
        log('OK', 'POLLER', `✅ ${completed} ancienne(s) activité(s) complétée(s) sur deal ${dealId}`);
      }
    } catch (e) { log('WARN', 'POLLER', `Cleanup deal ${dealId}: ${e.message}`); }
  }

  // 2. Matching Dropbox AVANCÉ (4 stratégies) + auto-envoi si score ≥90
  let docsTxt = '';
  let j0Brouillon = null;
  let autoEnvoiMsg = '';

  let dbxMatch = null;
  if (centris || adresse) {
    try { dbxMatch = await matchDropboxAvance(centris, adresse); } catch (e) { log('WARN', 'POLLER', `Match: ${e.message}`); }
  }

  if (dbxMatch?.folder) {
    docsTxt = `📁 Match Dropbox: *${dbxMatch.folder.adresse || dbxMatch.folder.name}* (${dbxMatch.strategy}, score ${dbxMatch.score}, ${dbxMatch.pdfs.length} doc${dbxMatch.pdfs.length > 1 ? 's' : ''})`;
  } else if (dbxMatch?.candidates?.length) {
    docsTxt = `📁 Candidats Dropbox: ${dbxMatch.candidates.map(c => `${c.folder.adresse || c.folder.name} (${c.score})`).join(', ')}`;
  }

  // AUTO-ENVOI — flow 3 seuils (validé par Shawn 2026-04-22):
  //   Score ≥90  → envoi automatique direct (très confiant du match)
  //   Score 80-89→ notif AVANT, attend confirmation "envoie" (zone d'incertitude)
  //   Score <80  → brouillon seulement
  // Conditions pré-requises: email + nom + (téléphone OU centris#) = 3 infos min
  // Dédup 7j garantit zéro doublon de tout ce flow.
  let dealFullObj = null;
  if (dealId) {
    try { dealFullObj = (await pdGet(`/deals/${dealId}`))?.data; } catch {}
  }
  // Seuil d'envoi auto DYNAMIQUE selon qualité d'extraction du lead.
  // Logique: un lead bien formé (nom + email + tel + centris + adresse = quality 100)
  // mérite un seuil plus permissif. Un lead pauvre (peu d'info) → seuil strict.
  //   quality ≥80  → threshold 60   (très permissif, on connaît bien le client)
  //   quality 60-79 → threshold 70  (modéré)
  //   quality <60   → threshold 80  (strict, peu d'info = risque)
  // Override possible via env var AUTO_SEND_THRESHOLD (force value statique).
  const _envThreshold = parseInt(process.env.AUTO_SEND_THRESHOLD || '0');
  const _quality = leadParser.leadQualityScore({ nom, telephone, email, centris, adresse });
  const AUTO_THRESHOLD = _envThreshold > 0 ? _envThreshold
    : _quality >= 80 ? 60
    : _quality >= 60 ? 70
    : 80;

  // hasMinInfo RELAXÉ: email + (Centris# OU tel) suffit — nom pas obligatoire.
  // Si pas de nom, on utilise "Madame/Monsieur" dans le template (vouvoiement pro).
  // Avant: exigeait email + nom + (tel || Centris) — bloquait trop de vrais leads
  // qui remplissent le formulaire Centris sans rentrer leur nom.
  const hasMinInfo = !!(email && (telephone || centris));
  const hasMatch   = dbxMatch?.folder && dbxMatch.pdfs.length > 0;

  // BOOST SCORE: si Centris# exact match (stratégie index ou live search par #),
  // on FORCE le score à 100 — c'est le signal le plus fiable possible.
  if (dbxMatch && centris && dbxMatch.folder?.centris === String(centris).trim()) {
    dbxMatch.score = Math.max(dbxMatch.score || 0, 100);
  }
  if (dbxMatch && /centris_index|live_search_folder_name|filename_centris/i.test(dbxMatch.strategy || '')) {
    dbxMatch.score = Math.max(dbxMatch.score || 0, 95);
  }

  // AUDIT TRAIL complet — un event par lead avec tout son parcours pour /lead-audit
  const leadAudit = {
    msgId, at: new Date().toISOString(),
    source: source?.label, subject: subject?.substring(0, 100), from: from?.substring(0, 120),
    extracted: { nom, telephone, email, centris, adresse, type },
    dealId, dealCreated: !!dealId,
    match: {
      found: !!hasMatch,
      score: dbxMatch?.score || 0,
      strategy: dbxMatch?.strategy || 'none',
      folder: dbxMatch?.folder?.name || null,
      sources: dbxMatch?.folder?.sources || (dbxMatch?.folder?.source ? [dbxMatch.folder.source] : []),
      pdfCount: dbxMatch?.pdfs?.length || 0,
    },
    hasMinInfo,
    threshold: AUTO_THRESHOLD,
    decision: 'pending', // mis à jour plus bas
  };

  // GARDE-FOU: détecte nom suspect (= courtier/agent capturé par erreur)
  // Utilise la détection whole-word de lead_parser (évite false positive sur
  // "Jean Barrette-Tremblay" qui contiendrait "barrette" comme nom légitime).
  const { BLACKLIST_NAMES } = leadParser;
  const nomLower = String(nom || '').toLowerCase().trim();
  const nomTokens = nomLower.split(/\s+/).filter(Boolean);
  let nomSuspect = false;
  if (nomLower) {
    if (BLACKLIST_NAMES.includes(nomLower)) nomSuspect = true;
    else {
      for (const bl of BLACKLIST_NAMES) {
        const blTokens = bl.split(/\s+/).filter(Boolean);
        if (blTokens.length === 1 && nomTokens.includes(blTokens[0])) { nomSuspect = true; break; }
        if (blTokens.length > 1 && (' ' + nomLower + ' ').includes(' ' + bl + ' ')) { nomSuspect = true; break; }
      }
    }
  }
  if (nomSuspect) {
    log('WARN', 'POLLER', `Nom SUSPECT détecté "${nom}" — bloque envoi auto, pending validation`);
    if (ALLOWED_ID) {
      bot.sendMessage(ALLOWED_ID,
        `⚠️ *Lead suspect — validation requise*\n\n` +
        `Le parser a extrait *"${nom}"* comme nom du prospect, mais c'est un nom blacklisté (courtier/agent/system).\n\n` +
        `Source email: ${source?.label || '?'}\n` +
        `Sujet: ${subject?.substring(0, 80) || '?'}\n` +
        `Email extrait: ${email || '(vide)'}\n` +
        `Tél: ${telephone || '(vide)'}\n` +
        `Centris: ${centris || '(vide)'}\n` +
        `Adresse: ${adresse || '(vide)'}\n\n` +
        `Vérifie l'email original avec \`/parselead ${msgId || '?'}\` et corrige manuellement.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
    leadAudit.decision = 'blocked_suspect_name';
    leadAudit.suspectName = nom;
    if (email) {
      pendingDocSends.set(email, { email, nom: '', centris, dealId, deal: dealFullObj, match: dbxMatch });
      firePreviewDocs({ email, nom: '', centris, deal: dealFullObj, match: dbxMatch });
    }
    autoEnvoiMsg = `\n⚠️ Nom suspect "${nom}" — pending manuel, pas d'envoi auto. Preview envoyé sur ${AGENT.email} pour validation visuelle.`;
    return { decision: 'blocked_suspect_name', dealId };
  }

  // ─── HYBRIDE B (Shawn 2026-04-25): auto-send si TOUS critères stricts ────
  // CRITÈRES AUTO-SAFE — TOUS doivent être OK (sinon fallback preview):
  //   1. Match Dropbox PARFAIT (score 100 = Centris# exact) → exclut fuzzy
  //   2. Nom valide isValidProspectName (pas Shawn capté par erreur)
  //   3. AI a validé l'extraction (deep scrape réussi OU regex 5/5 complet)
  //   4. Email + (téléphone OU centris) extraits du body
  //   5. Source connue (centris/remax/realtor/duproprio) — pas 'direct' inconnu
  //   6. Pipedrive deal créé sans erreur
  //   7. autoSendPaused = false
  //
  // Si TOUS OK → auto-envoi + notif "🚀 envoyé auto" + audit complet.
  //   → consent attesté par les critères stricts (équivalent click manuel
  //     pour leads ultra-clean). Tu sais TOUJOURS via Telegram immédiatement.
  // Si moindre doute → preview + click ✅ comme avant (mode A).
  const aiValidated = (lead && lead._aiValidated) || (typeof lead._infoCount === 'number' && lead._infoCount >= 4);
  const sourceTrusted = /^(centris|remax|realtor|duproprio)$/i.test(source?.source || '');
  const exactMatch = dbxMatch?.score === 100;
  const completeContact = !!(email && (telephone || centris));
  const AUTO_SAFE = exactMatch && aiValidated && completeContact && sourceTrusted && hasMatch && !!dealId && !autoSendPaused && isValidProspectName(nom);

  if (AUTO_SAFE) {
    // Auto-envoi avec consent attesté par critères stricts
    try {
      const dealForSend = dealFullObj || { id: dealId, title: nom || email, [PD_FIELD_CENTRIS]: centris || '' };
      const autoRes = await envoyerDocsAuto({
        email, nom, centris, dealId, deal: dealForSend, match: dbxMatch,
        _shawnConsent: true, // attesté par AUTO_SAFE = tous critères stricts validés
      });
      if (autoRes.sent) {
        leadAudit.decision = 'auto_sent';
        leadAudit.deliveryMs = autoRes.deliveryMs;
        autoEnvoiMsg = `\n🚀 *Docs envoyés auto* à ${email}\n` +
                       `   ${dbxMatch.pdfs.length} docs · Centris# ${centris} match exact · ${Math.round(autoRes.deliveryMs/1000)}s\n` +
                       `   ✅ Toi en Cc · Note Pipedrive ajoutée · audit tracé`;
        auditLogEvent('auto-send', 'docs-sent-auto-safe', { email, centris, score: dbxMatch.score, ms: autoRes.deliveryMs });
      } else {
        // Auto échoué → fallback preview/pending
        leadAudit.decision = 'auto_failed_fallback_pending';
        pendingDocSends.set(email, { email, nom, centris, dealId, deal: dealFullObj, match: dbxMatch });
        firePreviewDocs({ email, nom, centris, deal: dealFullObj, match: dbxMatch });
        autoEnvoiMsg = `\n⚠️ Auto-send a échoué (${autoRes.error || autoRes.reason}) — fallback preview + click manuel\n   ✅ Click bouton ci-dessous OU dis \`envoie les docs à ${email}\``;
      }
    } catch (e) {
      leadAudit.decision = 'auto_exception';
      leadAudit.error = e.message?.substring(0, 200);
      pendingDocSends.set(email, { email, nom, centris, dealId, deal: dealFullObj, match: dbxMatch });
      firePreviewDocs({ email, nom, centris, deal: dealFullObj, match: dbxMatch });
      autoEnvoiMsg = `\n⚠️ Exception auto-send: ${e.message?.substring(0, 100)} — fallback preview`;
    }
  } else if (email && hasMatch) {
    // Mode preview + pending (consent click obligatoire)
    leadAudit.decision = 'pending_preview_sent';
    pendingDocSends.set(email, { email, nom, centris, dealId, deal: dealFullObj, match: dbxMatch });
    firePreviewDocs({ email, nom, centris, deal: dealFullObj, match: dbxMatch });
    // Explique POURQUOI ce n'est pas auto-safe (transparence pour Shawn)
    const reasons = [];
    if (!exactMatch) reasons.push(`match ${dbxMatch.score}/100 (pas exact)`);
    if (!aiValidated) reasons.push('extraction non validée par AI');
    if (!completeContact) reasons.push('contact incomplet');
    if (!sourceTrusted) reasons.push(`source "${source?.source}" non reconnue`);
    if (!isValidProspectName(nom)) reasons.push('nom invalide');
    if (!dealId) reasons.push('deal Pipedrive non créé');
    const why = reasons.length ? reasons.join(', ') : `match score ${dbxMatch.score}`;
    const docsList = dbxMatch.pdfs.slice(0, 10).map(p => `     • ${p.name}`).join('\n');
    autoEnvoiMsg = `\n📦 *Docs prêts — attend ton OK* (${why})\n` +
                   `   Dossier: *${dbxMatch.folder.adresse || dbxMatch.folder.name}*\n` +
                   `   ${dbxMatch.pdfs.length} docs:\n${docsList}\n` +
                   `   📧 Preview envoyé sur ${AGENT.email}\n` +
                   `   ✅ Click le bouton ci-dessous OU dis \`envoie les docs à ${email}\``;
  } else if (email && dbxMatch?.candidates?.length) {
    leadAudit.decision = 'multiple_candidates';
    autoEnvoiMsg = `\n🔍 Plusieurs candidats Dropbox — check lequel est le bon avant d'envoyer`;
  } else if (dealId && email) {
    // Aucun match Dropbox du tout mais deal créé — alerte pour visibilité
    leadAudit.decision = 'no_dropbox_match';
    autoEnvoiMsg = `\n⚠️ Deal créé mais aucun dossier Dropbox trouvé pour ce terrain. Vérifie avec \`/dropbox-find ${centris || adresse || email}\``;
  } else {
    leadAudit.decision = 'skipped_no_email_or_deal';
  }

  // PERSIST audit trail — indexé par msgId + email + centris pour /lead-audit
  auditLogEvent('lead', leadAudit.decision, leadAudit);

  // LEADS_LOG.jsonl — format structuré demandé Shawn 2026-05-13 (PROMPT_CLAUDE_CODE_SESSION)
  // Append-only JSON Lines pour analyse offline + audit historique persistant
  try {
    const leadsLogPath = path.join(DATA_DIR, 'LEADS_LOG.jsonl');
    const entry = {
      ts: new Date().toISOString(),
      centris: centris || null,
      nom: nom || null,
      email: email || null,
      tel: telephone || null,
      parse_method: (lead._aiValidated || lead._haikuUsed) ? 'haiku' : 'regex',
      pipedrive_deal: dealId || null,
      dropbox_match: dbxMatch?.score || 0,
      dropbox_dossier: dbxMatch?.folder?.name || null,
      envoi: leadAudit.decision === 'auto_sent' ? 'auto'
           : leadAudit.decision === 'pending_preview_sent' ? 'pending'
           : leadAudit.decision === 'blocked_suspect_name' ? 'skip_name'
           : leadAudit.decision === 'no_dropbox_match' ? 'brouillon'
           : leadAudit.decision,
      docs_count: dbxMatch?.pdfs?.length || 0,
      duree_ms: typeof leadStart === 'number' ? Date.now() - leadStart : null,
      source: source?.source || null,
      msgId: msgId || null,
    };
    require('fs').appendFileSync(leadsLogPath, JSON.stringify(entry) + '\n');
  } catch (e) { log('WARN', 'LEADS_LOG', e.message?.substring(0, 100)); }

  // Préparer brouillon J+0
  const prospectNom   = nom || (email?.split('@')[0]) || 'Madame/Monsieur';
  const typeLabel     = { terrain:'terrain', maison_usagee:'propriété', plex:'plex', construction_neuve:'construction neuve' }[type] || 'propriété';
  const j0Texte = `Bonjour,\n\nMerci de votre intérêt${centris ? ` pour la propriété Centris #${centris}` : adresse ? ` pour la propriété au ${adresse}` : ''}.\n\nJ'aimerais vous contacter pour vous donner plus d'informations et répondre à vos questions. Quand seriez-vous disponible pour qu'on se parle?\n\nAu plaisir,\n${AGENT.nom}\n${AGENT.titre} | ${AGENT.compagnie}\n📞 ${AGENT.telephone}\n${AGENT.email}`;

  // Si email dispo → stocker brouillon (Shawn dit "envoie")
  if (email) {
    const sujetJ0 = centris
      ? `Centris #${centris} — ${AGENT.compagnie}`
      : `Votre demande — ${AGENT.compagnie}`;
    j0Brouillon = { to: email, toName: prospectNom, sujet: sujetJ0, texte: j0Texte };
    pendingEmails.set(ALLOWED_ID, j0Brouillon);
  }

  // 3. Notifier Shawn immédiatement
  if (!ALLOWED_ID) return;
  let msg = `🔔 *Nouveau lead ${source.label}!*\n\n`;
  // Flag récurrent en HAUT du message — info stratégique
  if (_recurrentInfo) {
    msg += `🔗 *PROSPECT RÉCURRENT* — ${_recurrentInfo.dealCount} deal(s) passés\n`;
    msg += `   Dernier: ${_recurrentInfo.lastDealTitle?.substring(0, 60) || '?'}\n\n`;
    leadAudit.recurrent = _recurrentInfo;
  }
  if (nom)       msg += `👤 *${nom}*\n`;
  if (telephone) msg += `📞 ${telephone}\n`;
  if (email)     msg += `✉️ ${email}\n`;
  if (adresse)   msg += `📍 ${adresse}\n`;
  if (centris)   msg += `🏡 Centris #${centris}\n`;
  msg += `\n${dealTxt || '⚠️ Pipedrive non configuré'}\n`;
  if (docsTxt) msg += `\n${docsTxt}\n`;
  if (autoEnvoiMsg) msg += autoEnvoiMsg;
  if (j0Brouillon) {
    msg += `\n📧 *Brouillon J+0 prêt* — dis *"envoie"* pour l'envoyer à ${email}`;
  } else if (!email) {
    msg += `\n⚠️ Pas d'email — appelle directement: ${telephone || '(non fourni)'}`;
  }

  // INLINE BUTTONS — si le lead a un pending docs, attacher boutons 1-click
  // ✅ Envoie · ❌ Annule · 📋 Audit. Plus rapide que de retaper la commande,
  // élimine les fautes de frappe (mauvais email), trace explicite du consent.
  let replyMarkup;
  const hasPendingDocs = email && pendingDocSends?.has?.(email);
  if (hasPendingDocs) {
    replyMarkup = {
      inline_keyboard: [[
        { text: '✅ Envoie',  callback_data: `send:${email}` },
        { text: '❌ Annule',  callback_data: `cancel:${email}` },
        { text: '📋 Audit',   callback_data: `audit:${msgId || email}` },
      ]],
    };
  }

  const sent = await sendTelegramWithFallback(msg, {
    category: 'lead-notif', leadId: msgId, email, centris, replyMarkup,
  });
  return { decision: leadAudit.decision, dealId, notifySent: sent };
}

// Envoi Telegram avec fallback: essaie markdown → plain → email Gmail à shawn@
// Utilisé pour TOUTES les notifs critiques (leads, alertes échec, validations P1).
// Garantit que Shawn est averti même si Telegram API est down ou le bot expulsé du chat.
async function sendTelegramWithFallback(msg, ctx = {}) {
  if (!ALLOWED_ID) return false;
  const replyMarkup = ctx.replyMarkup; // optionnel: inline buttons
  const sendOpts = { parse_mode: 'Markdown' };
  if (replyMarkup) sendOpts.reply_markup = replyMarkup;
  // 1. Markdown
  try {
    await bot.sendMessage(ALLOWED_ID, msg, sendOpts);
    return true;
  } catch (e1) {
    log('WARN', 'NOTIFY', `Telegram markdown failed (${ctx.category || '?'}): ${e1.message.substring(0, 140)}`);
    // 2. Plain text (avec replyMarkup si fourni)
    try {
      const plain = msg.replace(/\*/g, '').replace(/_/g, '').replace(/`/g, '');
      const plainOpts = replyMarkup ? { reply_markup: replyMarkup } : {};
      await bot.sendMessage(ALLOWED_ID, plain, plainOpts);
      return true;
    } catch (e2) {
      log('ERR', 'NOTIFY', `Telegram plain failed (${ctx.category || '?'}): ${e2.message.substring(0, 140)}`);
      auditLogEvent('notify', 'telegram_double_fail', {
        category: ctx.category, context: ctx,
        markdownErr: e1.message.substring(0, 200),
        plainErr: e2.message.substring(0, 200),
      });
      // 3. Fallback email Gmail sur shawn@ — dernière chance
      try {
        const token = await getGmailToken();
        if (token && AGENT.email) {
          const subj = `🚨 Bot notif fallback — ${ctx.category || 'notification'}`;
          const body = `Telegram a échoué 2x. Notification originale:\n\n${msg}\n\nContexte: ${JSON.stringify(ctx, null, 2)}\n\n— Bot kira (auto-fallback)`;
          const enc = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
          const mime = [
            `From: Bot kira <${AGENT.email}>`,
            `To: ${AGENT.email}`,
            `Subject: ${enc(subj)}`,
            'MIME-Version: 1.0',
            'Content-Type: text/plain; charset=UTF-8',
            'Content-Transfer-Encoding: 8bit',
            '',
            body,
          ].join('\r\n');
          const raw = Buffer.from(mime).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
          // Sent via wrapper — outbox traçable. Destinataire shawn@ = consent implicite.
          await sendEmailLogged({
            via: 'gmail', to: AGENT.email, subject: subj,
            category: 'sendTelegramFallback-' + (ctx.category || 'unknown'),
            shawnConsent: true,
            sendFn: () => fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ raw }),
            }),
          });
          log('OK', 'NOTIFY', `Fallback email → ${AGENT.email} (${ctx.category})`);
          auditLogEvent('notify', 'email_fallback_sent', { category: ctx.category });
          return true;
        }
      } catch (e3) {
        log('ERR', 'NOTIFY', `Email fallback failed: ${e3.message.substring(0, 140)}`);
      }
      // 4. SMS Brevo — dernière chance (niveau "le téléphone vibre c'est urgent")
      // N'activé que pour catégories critiques pour éviter spam SMS (coût + nuisance)
      const smsCategories = /lead-notif|lead-abandoned|P1-pending|P2-docs-failed|preflight|cost-monthly/i;
      if (BREVO_KEY && AGENT?.telephone && smsCategories.test(ctx.category || '')) {
        try {
          const phone = AGENT.telephone.replace(/\D/g, '');
          const e164 = phone.length === 10 ? '+1' + phone : '+' + phone;
          const shortMsg = msg.replace(/[*_`]/g, '').substring(0, 150);
          const smsRes = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
            method: 'POST',
            headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sender: 'KiraBot',
              recipient: e164,
              content: `Bot SignatureSB (${ctx.category || 'alert'}): ${shortMsg}`,
              type: 'transactional',
            }),
          });
          if (smsRes.ok) {
            log('OK', 'NOTIFY', `Fallback SMS → ${e164} (${ctx.category})`);
            auditLogEvent('notify', 'sms_fallback_sent', { category: ctx.category });
            return true;
          }
          log('WARN', 'NOTIFY', `SMS fallback failed: ${smsRes.status}`);
        } catch (e4) {
          log('ERR', 'NOTIFY', `SMS exception: ${e4.message.substring(0, 140)}`);
        }
      }
      auditLogEvent('notify', 'all_notify_channels_failed', {
        category: ctx.category, context: ctx,
      });
      return false;
    }
  }
}

// Stats poller (pour /health + debug P0)
// ── Health check proactif Anthropic — ping Haiku léger toutes les 6h pour
// détecter crédit bas / clé révoquée AVANT qu'un vrai appel échoue.
// Si fail → alerte Telegram proactive avec action (déjà codée dans formatAPIError)
async function anthropicHealthCheck() {
  if (!API_KEY) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] }),
    });
    clearTimeout(t);
    if (!res.ok) {
      const body = await res.text();
      const err = { status: res.status, message: `${res.status} ${body.substring(0, 200)}` };
      log('WARN', 'HEALTH', `Anthropic ping: ${err.message.substring(0, 120)}`);
      // formatAPIError détecte credit/auth et alerte Telegram avec cooldown 30min
      formatAPIError(err);
      metrics.lastApiError = { at: new Date().toISOString(), status: res.status, message: err.message.substring(0, 300) };
    } else {
      log('OK', 'HEALTH', 'Anthropic OK (healthcheck Haiku)');
      // Succès → effacer lastApiError si était credit/auth (problème résolu)
      if (metrics.lastApiError && /credit|billing|authentication|invalid.*key/i.test(metrics.lastApiError.message || '')) {
        log('OK', 'HEALTH', '🎉 Anthropic retour à la normale — clear lastApiError');
        metrics.lastApiError = null;
        if (ALLOWED_ID) {
          bot.sendMessage(ALLOWED_ID, '✅ *Anthropic est de retour*\nLe bot a récupéré l\'accès Claude. Tout reprend normalement.', { parse_mode: 'Markdown' }).catch(() => {});
        }
      }
    }
  } catch (e) {
    log('WARN', 'HEALTH', `Anthropic ping exception: ${e.message}`);
  }
}

const pollerStats = {
  runs: 0,
  lastRun: null,
  lastDuration: 0,
  lastError: null,
  lastScan: { found: 0, junk: 0, noSource: 0, lowInfo: 0, dealCreated: 0, autoSent: 0, pending: 0, dedup: 0, processed: 0, errors: 0 },
  totalsFound: 0, totalsJunk: 0, totalsNoSource: 0, totalsLowInfo: 0, totalsDealCreated: 0, totalsErrors: 0,
};

// ── baselineSilentAtBoot — marque tous les leads 7 derniers jours comme
// déjà vus SANS notifier. Appelé au boot si processed[] vide.
async function baselineSilentAtBoot() {
  const token = await getGmailToken();
  if (!token) return;
  const shawnEmail = AGENT.email.toLowerCase();
  const queries = [
    `newer_than:7d from:centris NOT from:${shawnEmail}`,
    `newer_than:7d from:remax NOT from:${shawnEmail}`,
    `newer_than:7d from:realtor NOT from:${shawnEmail}`,
    `newer_than:7d from:duproprio NOT from:${shawnEmail}`,
    `newer_than:7d subject:(demande OR "intéress" OR inquiry) NOT from:${shawnEmail}`,
  ];
  let marked = 0;
  const seen = new Set();
  for (const q of queries) {
    const list = await gmailAPI(`/messages?maxResults=50&q=${encodeURIComponent(q)}`).catch(() => null);
    if (!list?.messages?.length) continue;
    for (const m of list.messages) {
      if (seen.has(m.id) || gmailPollerState.processed.includes(m.id)) continue;
      seen.add(m.id);
      gmailPollerState.processed.push(m.id);
      marked++;
      try {
        const full = await gmailAPI(`/messages/${m.id}?format=full`).catch(() => null);
        if (full) {
          const hdrs = full.payload?.headers || [];
          const get = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
          const from    = get('from');
          const subject = get('subject');
          const body    = gmailExtractBody(full.payload);
          if (!isJunkLeadEmail(subject, from, body)) {
            const source = detectLeadSource(from, subject);
            if (source) {
              const lead = parseLeadEmail(body, subject, from);
              // Boot silent baseline: marque dans dedup sans notifier
              markLeadProcessed({
                email: lead.email, telephone: lead.telephone, centris: lead.centris,
                nom: lead.nom, source: source.source,
              });
            }
          }
        }
      } catch {}
    }
  }
  gmailPollerState.lastRun = new Date().toISOString();
  if (gmailPollerState.processed.length > 500) gmailPollerState.processed = gmailPollerState.processed.slice(-500);
  saveJSON(POLLER_FILE, gmailPollerState);
  schedulePollerSave(); // → Gist
  log('OK', 'BOOT', `Baseline silencieux: ${marked} leads marqués, ${recentLeadsByKey.size} dédup entries`);
}

// ── autoTrashGitHubNoise — supprime auto les emails notifications GitHub/Render/CI
// Shawn ne veut plus être notifié par courriel — le bot nettoie tout seul.
// Run: 30s après boot + cron quotidien 6h (+ manuel via /cleanemail)
// Couvre: GitHub, Dependabot, CI, Render deploys (succeeded/failed), Vercel, Netlify.
async function autoTrashGitHubNoise(opts = {}) {
  try {
    const token = await getGmailToken();
    if (!token) return { trashed: 0, skipped: 'no_gmail' };

    const maxAge = opts.maxAge || '30d';
    // Sources de bruit auto-nettoyées: GitHub, Render, PaaS communs
    const query = [
      '(',
      'from:notifications@github.com',
      'OR from:noreply@github.com',
      'OR cc:ci_activity@noreply.github.com',
      'OR cc:push@noreply.github.com',
      'OR cc:state_change@noreply.github.com',
      'OR cc:comment@noreply.github.com',
      // Render: deploys, alerts, service updates
      'OR from:no-reply@render.com',
      'OR from:noreply@render.com',
      'OR from:notify@render.com',
      'OR from:@render.com',
      'OR subject:"Deploy failed"',
      'OR subject:"Deploy succeeded"',
      'OR subject:"Deploy live"',
      'OR subject:"Your service"',
      // Autres PaaS courants
      'OR from:@vercel.com',
      'OR from:@netlify.com',
      'OR from:@fly.io',
      ')',
      `newer_than:${maxAge}`,
      '-in:trash',
    ].join(' ');

    const list = await gmailAPI(`/messages?maxResults=100&q=${encodeURIComponent(query)}`);
    if (!list?.messages?.length) return { trashed: 0 };

    let trashed = 0;
    for (const m of list.messages) {
      try {
        await gmailAPI(`/messages/${m.id}/trash`, { method: 'POST' });
        trashed++;
        await new Promise(r => setTimeout(r, 200)); // éviter rate limit
      } catch (e) {
        log('WARN', 'CLEANUP', `trash ${m.id}: ${e.message.substring(0, 80)}`);
      }
    }
    log('OK', 'CLEANUP', `Auto-trashed ${trashed} emails (GitHub + Render + PaaS)`);
    return { trashed };
  } catch (e) {
    log('WARN', 'CLEANUP', `autoTrashGitHubNoise: ${e.message}`);
    return { trashed: 0, error: e.message };
  }
}

// ── runGmailLeadPoller — BULLETPROOF (2026-04-22)
// Principe: AUCUN lead client ne doit passer inaperçu.
// - Scan SANS is:unread (dédup via processed[] state)
// - 24h fenêtre au boot (pas 6h)
// - Alert Telegram P0 si email match source mais deal non créé (bug detection)
// - Logging structuré par étape
// MUTEX: empêche overlap des runs (poll 30s mais run peut prendre 60s+)
// Sans ça → double-traitement leads (cf audit P0 #2)
let _pollerInFlight = false;
async function runGmailLeadPoller(opts = {}) {
  if (_pollerInFlight) {
    log('INFO', 'POLLER', 'Skip — run précédent toujours en cours (mutex)');
    return;
  }
  _pollerInFlight = true;
  try {
    return await _runGmailLeadPollerInner(opts);
  } finally {
    _pollerInFlight = false;
  }
}

async function _runGmailLeadPollerInner(opts = {}) {
  const t0 = Date.now();

  // CIRCUIT BREAKER CRÉDIT: si Anthropic a retourné credit/auth error dans les
  // dernières 30min, SKIP le poller. Évite le spam de leads + save argent
  // pendant que Shawn règle son crédit. Auto-resume dès que crédit OK.
  if (metrics.lastApiError && !opts.force) {
    const age = Date.now() - new Date(metrics.lastApiError.at).getTime();
    const msg = metrics.lastApiError.message || '';
    if (age < 30 * 60 * 1000 && /credit|billing|insufficient|authentication|invalid.*key/i.test(msg)) {
      log('INFO', 'POLLER', `Skip — Anthropic down (${Math.round(age/60000)}min ago): ${msg.substring(0, 80)}`);
      return;
    }
  }

  pollerStats.runs++;
  const scan = { found: 0, junk: 0, noSource: 0, lowInfo: 0, dealCreated: 0, autoSent: 0, pending: 0, dedup: 0, processed: 0, errors: 0 };
  const problems = []; // emails qui matchent mais n'ont pas abouti — pour alerte P0
  try {
    const token = await getGmailToken();
    if (!token) { pollerStats.lastError = 'gmail_token_unavailable'; return; }

    // Force scan 48h si demandé explicitement (/checkemail ou /forcelead)
    const since = opts.forceSince
      ? opts.forceSince
      : (gmailPollerState.lastRun
          ? Math.max(1, Math.ceil((Date.now() - new Date(gmailPollerState.lastRun).getTime()) / 60000) + 2) + 'm'
          : '24h'); // Au boot: 24h (pas 6h — laisser de la marge pour emails manqués)

    // Queries SANS is:unread — emails lus scannés aussi (dédup via processed[])
    // Plusieurs queries ciblées + un catch-all pour robustesse
    const shawnEmail = AGENT.email.toLowerCase();
    const queries = [
      `newer_than:${since} from:centris NOT from:${shawnEmail}`,
      `newer_than:${since} from:remax NOT from:${shawnEmail}`,
      `newer_than:${since} from:realtor NOT from:${shawnEmail}`,
      `newer_than:${since} from:duproprio NOT from:${shawnEmail}`,
      // Catch-all: demande dans subject, pas d'une source auto
      `newer_than:${since} subject:(demande OR "intéress" OR inquiry OR "prospect") NOT from:${shawnEmail} NOT from:noreply@signaturesb NOT from:notifications@github`,
    ];

    let newLeads = 0;
    const processedThisRun = new Set();
    const singleId = opts.singleMsgId || null;

    // Mode forcelead: traiter 1 msgId spécifique, bypass queries
    const msgIds = singleId ? [{ id: singleId }] : null;

    for (const q of (msgIds ? [null] : queries)) {
      let list;
      if (msgIds) {
        list = { messages: msgIds };
      } else {
        try {
          list = await gmailAPI(`/messages?maxResults=25&q=${encodeURIComponent(q)}`);
        } catch (e) {
          scan.errors++;
          log('WARN', 'POLLER', `Query fail [${q.substring(0,40)}]: ${e.message}`);
          continue;
        }
      }
      if (!list?.messages?.length) continue;
      scan.found += list.messages.length;

      for (const msgRef of list.messages) {
        const id = msgRef.id;
        // En mode forcelead, on bypass le dédup pour forcer le retraitement
        if (!singleId && (gmailPollerState.processed.includes(id) || processedThisRun.has(id))) continue;
        processedThisRun.add(id);

        try {
          const full = await gmailAPI(`/messages/${id}?format=full`);
          const hdrs = full.payload?.headers || [];
          const get  = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
          const from    = get('from');
          const subject = get('subject');
          const body    = gmailExtractBody(full.payload);
          const bodies  = gmailExtractAllBodies(full.payload); // pour AI fallback avec plus de contexte

          // Ignorer les emails de Shawn lui-même
          if (from.toLowerCase().includes(shawnEmail)) {
            gmailPollerState.processed.push(id); continue;
          }

          // FILTRE JUNK — rejette newsletters, alertes saved-search, notifications
          if (isJunkLeadEmail(subject, from, body)) {
            scan.junk++;
            log('INFO', 'POLLER', `Junk: ${subject.substring(0, 60)} (${from.substring(0, 40)})`);
            gmailPollerState.processed.push(id); continue;
          }

          const source = detectLeadSource(from, subject);
          if (!source) {
            scan.noSource++;
            // Si le sujet ressemble à un lead (demande/visite/intéressé/centris#) MAIS
            // la source n'est pas reconnue → on alerte Shawn avec le sujet+from brut.
            // Un courriel légitime avec source inconnue ne doit JAMAIS être silencieusement filtré.
            const suspectLead = /demande|visite|intéress|interet|centris|propriété|propri[ée]t[ée]|maison|terrain|acheteur|vendeur|informations?|question/i.test(subject)
              || /\b\d{7,9}\b/.test(subject);
            if (suspectLead && ALLOWED_ID) {
              // Dédup 6h par msgId pour éviter spam si même email apparaît X fois au polling
              const key = `nosource:${id}`;
              if (!recentLeadsByKey.has(key)) {
                recentLeadsByKey.set(key, Date.now());
                saveLeadsDedup();
                const alertMsg = [
                  `🔍 *Email filtré (source inconnue) — vérif requise*`,
                  ``,
                  `Un email qui RESSEMBLE à un lead mais dont la source ne matche`,
                  `aucun pattern connu (Centris/RE-MAX/Realtor/DuProprio/social).`,
                  ``,
                  `📝 Sujet: ${subject?.substring(0, 120)}`,
                  `📨 De: ${from?.substring(0, 150)}`,
                  `🆔 \`${id}\``,
                  ``,
                  `Si c'est un vrai lead, \`/forcelead ${id}\` pour forcer.`,
                ].join('\n');
                sendTelegramWithFallback(alertMsg, { category: 'noSource-suspect', msgId: id }).catch(() => {});
                auditLogEvent('lead', 'noSource_suspect', { msgId: id, subject: subject?.substring(0, 200), from: from?.substring(0, 200) });
              }
            }
            gmailPollerState.processed.push(id); continue;
          }

          let lead = parseLeadEmail(body, subject, from);
          let infoCount = [lead.nom, lead.email, lead.telephone, lead.centris, lead.adresse].filter(Boolean).length;
          let aiValidated = false;

          // AI DEEP SCRAPE (renforcé Shawn 2026-04-25): toujours appeler l'AI quand
          // l'info n'est pas COMPLÈTE (5/5), pour valider/enrichir l'extraction et
          // donner un signal de confiance pour l'auto-send. Avant: AI seulement si <3.
          // Maintenant: AI dès que <5 ET au moins 2 (sinon junk évident, on skip AI).
          if (infoCount < 5 && infoCount >= 2 && API_KEY) {
            log('INFO', 'POLLER', `Regex ${infoCount}/5 infos — AI deep scrape (sonnet tool-use) pour "${subject.substring(0,50)}"`);
            try {
              const enriched = await parseLeadEmailWithAI(body, subject, from, lead, {
                apiKey: API_KEY, logger: log, htmlBody: bodies.html,
              });
              if (enriched && (enriched.nom || enriched.email || enriched.centris)) {
                lead = enriched;
                aiValidated = true;
                infoCount = [lead.nom, lead.email, lead.telephone, lead.centris, lead.adresse].filter(Boolean).length;
              }
            } catch (e) { log('WARN', 'POLLER', `AI deep scrape: ${e.message}`); }
          } else if (infoCount === 5) {
            // Regex a tout extrait — confiance haute déjà
            aiValidated = true;
          } else if (infoCount < 2 && API_KEY) {
            // Cas limite: presque rien extrait, AI fallback dernière chance
            try {
              lead = await parseLeadEmailWithAI(body, subject, from, lead, { apiKey: API_KEY, logger: log, htmlBody: bodies.html }) || lead;
              infoCount = [lead.nom, lead.email, lead.telephone, lead.centris, lead.adresse].filter(Boolean).length;
              aiValidated = infoCount >= 3;
            } catch {}
          }
          // Marqueur de confiance utilisé par traiterNouveauLead pour décider auto-send
          lead._aiValidated = aiValidated;
          lead._infoCount = infoCount;

          // VALIDATION lead viable — minimum 2 infos OU Centris# seul suffit
          if (infoCount < 2 && !lead.centris) {
            scan.lowInfo++;
            // ⚠ ALERTE P0: email match source (Centris/RE/MAX) mais extraction insuffisante = BUG probable
            problems.push({ id, subject, from, source: source.label, reason: `${infoCount} info extraites après AI fallback` });
            log('WARN', 'POLLER', `Lead non viable: "${subject.substring(0, 50)}" (${source.label}) — PROBLÈME P0`);
            gmailPollerState.processed.push(id); continue;
          }

          // Retry guard: max 5 tentatives par Gmail msgId avant giving up
          const retryCount = getRetryCount(id);
          const MAX_RETRIES = 5;
          if (retryCount >= MAX_RETRIES) {
            log('WARN', 'POLLER', `msg ${id}: ${retryCount} tentatives — SKIP définitif (giving up)`);
            gmailPollerState.processed.push(id); // OK: on accepte l'échec définitif
            auditLogEvent('lead', 'max_retries_exhausted', {
              msgId: id, attempts: retryCount, lastErr: leadRetryState[id]?.lastErr,
              subject: subject?.substring(0, 100), from: from?.substring(0, 120),
            });
            continue;
          }

          let result = {};
          try {
            result = await traiterNouveauLead(lead, id, from, subject, source) || {};
          } catch (eLead) {
            // Échec — NE PAS marquer processed, laisser retry au prochain poll
            incRetryCount(id, eLead.message);
            log('WARN', 'POLLER', `Lead ${id} tentative ${retryCount + 1}/${MAX_RETRIES} ÉCHOUÉE: ${eLead.message.substring(0, 150)}`);
            scan.errors++;
            if (retryCount + 1 >= MAX_RETRIES) {
              // Escalation finale
              await sendTelegramWithFallback(
                `🚨 *LEAD ABANDONNÉ après ${MAX_RETRIES} tentatives*\n` +
                `MsgId: \`${id}\`\nSujet: ${subject?.substring(0, 100)}\nFrom: ${from?.substring(0, 120)}\n` +
                `Dernière erreur: ${eLead.message.substring(0, 200)}\n\n` +
                `Le bot arrête de réessayer. Inspecte manuellement via /lead-audit ${id}.`,
                { category: 'lead-abandoned', msgId: id }
              );
              gmailPollerState.processed.push(id); // abandon: marque pour ne plus revenir
            }
            continue;
          }

          // Succès: mark processed + reset retry + dedup + compteurs
          gmailPollerState.processed.push(id);
          gmailPollerState.totalLeads = (gmailPollerState.totalLeads || 0) + 1;
          resetRetryCount(id);
          // Mark dedup UNIQUEMENT ici (après succès end-to-end) — pas au premier coup d'œil
          if (result.decision !== 'dedup_skipped') {
            markLeadProcessed({ email: lead.email, telephone: lead.telephone, centris: lead.centris, nom: lead.nom, source: source.source });
          }
          scan.processed++;
          if (result.dealId) scan.dealCreated++;
          // Compteurs exhaustifs par décision (chaque lead doit incrémenter UN bucket)
          const dec = String(result.decision || 'unknown');
          if (dec === 'auto_sent')              scan.autoSent++;
          else if (dec === 'dedup_skipped')     scan.dedup++;
          else if (dec.startsWith('pending'))   scan.pending++;
          else if (dec === 'auto_skipped')      scan.autoSkipped = (scan.autoSkipped || 0) + 1;
          else if (dec === 'auto_failed' || dec === 'auto_exception') scan.autoFailed = (scan.autoFailed || 0) + 1;
          else if (dec === 'no_dropbox_match')  scan.noMatch = (scan.noMatch || 0) + 1;
          else if (dec === 'multiple_candidates') scan.multiCandidate = (scan.multiCandidate || 0) + 1;
          else if (dec === 'blocked_suspect_name') scan.blocked = (scan.blocked || 0) + 1;
          else if (dec === 'skipped_no_email_or_deal') scan.skippedNoEmail = (scan.skippedNoEmail || 0) + 1;
          else                                  scan.otherDecision = (scan.otherDecision || 0) + 1;
          newLeads++;
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
          scan.errors++;
          problems.push({ id, subject: 'N/A', from: 'N/A', source: 'N/A', reason: `Exception: ${e.message.substring(0, 100)}` });
          log('WARN', 'POLLER', `msg ${id}: ${e.message}`);
          gmailPollerState.processed.push(id);
        }
      }
    }

    // FIFO max 500 IDs
    if (gmailPollerState.processed.length > 500) {
      gmailPollerState.processed = gmailPollerState.processed.slice(-500);
    }
    gmailPollerState.lastRun = new Date().toISOString();
    saveJSON(POLLER_FILE, gmailPollerState); schedulePollerSave();

    // Update stats globales
    pollerStats.lastScan = scan;
    pollerStats.totalsFound      += scan.found;
    pollerStats.totalsJunk       += scan.junk;
    pollerStats.totalsNoSource   += scan.noSource;
    pollerStats.totalsLowInfo    += scan.lowInfo;
    pollerStats.totalsDealCreated+= scan.dealCreated;
    pollerStats.totalsAutoSent   = (pollerStats.totalsAutoSent || 0) + scan.autoSent;
    pollerStats.totalsPending    = (pollerStats.totalsPending || 0) + scan.pending;
    pollerStats.totalsDedup      = (pollerStats.totalsDedup || 0) + scan.dedup;
    pollerStats.totalsProcessed  = (pollerStats.totalsProcessed || 0) + scan.processed;
    pollerStats.totalsAutoSkipped= (pollerStats.totalsAutoSkipped || 0) + (scan.autoSkipped || 0);
    pollerStats.totalsAutoFailed = (pollerStats.totalsAutoFailed || 0) + (scan.autoFailed || 0);
    pollerStats.totalsNoMatch    = (pollerStats.totalsNoMatch || 0) + (scan.noMatch || 0);
    pollerStats.totalsBlocked    = (pollerStats.totalsBlocked || 0) + (scan.blocked || 0);
    pollerStats.totalsSkippedNoEmail = (pollerStats.totalsSkippedNoEmail || 0) + (scan.skippedNoEmail || 0);
    pollerStats.totalsErrors     += scan.errors;
    pollerStats.lastRun = new Date().toISOString();
    pollerStats.lastDuration = Date.now() - t0;
    pollerStats.lastError = null;

    // ALERTE P0 Telegram: leads potentiels manqués
    // Skip si Anthropic est down (crédit/auth) — ce n'est pas une vraie anomalie parser
    const anthropicDown = metrics.lastApiError &&
      Date.now() - new Date(metrics.lastApiError.at).getTime() < 30 * 60 * 1000 &&
      /credit|billing|authentication|invalid.*key/i.test(metrics.lastApiError.message || '');
    if (problems.length && ALLOWED_ID && !anthropicDown) {
      const lines = problems.slice(0, 5).map(p =>
        `• [${p.source}] ${p.subject.substring(0, 60)} — ${p.reason}`
      );
      const alertMsg = [
        `🚨 *P0 — ${problems.length} lead(s) potentiellement manqué(s)*`,
        ``,
        ...lines,
        ``,
        `Dis \`/forcelead ${problems[0].id}\` pour forcer le retraitement du premier.`,
        `Ou vérifie Gmail directement.`,
      ].join('\n');
      bot.sendMessage(ALLOWED_ID, alertMsg, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(ALLOWED_ID, alertMsg.replace(/[*_`]/g, '')).catch(() => {});
      });
    }

    if (newLeads > 0) {
      log('OK', 'POLLER',
        `Scan: ${scan.found} found | ${scan.processed} traités | ${scan.autoSent} auto-sent | ` +
        `${scan.pending} pending | ${scan.dealCreated} deals | ${scan.dedup} dedup | ${scan.errors} err`
      );
    }
  } catch (e) {
    pollerStats.lastError = e.message;
    log('ERR', 'POLLER', `Erreur fatale: ${e.message}`);
  }
}

// ─── Démarrage séquentiel ─────────────────────────────────────────────────────
async function main() {
  // ── CRITIQUE: Démarrer le server HTTP EN PREMIER pour passer health check Render ──
  log('INFO', 'BOOT', `Step 0: server.listen(${PORT}) [CRITICAL]`);
  server.on('error', err => {
    log('ERR', 'BOOT', `server error: ${err.code || err.message}`);
    // Si EADDRINUSE, retry après 2s (l'ancienne instance libère le port)
    if (err.code === 'EADDRINUSE') setTimeout(() => server.listen(PORT).on('error', () => {}), 2000);
  });
  server.listen(PORT, () => log('OK', 'BOOT', `HTTP server listening on port ${PORT}`));

  log('INFO', 'BOOT', 'Step 1: refresh Dropbox token');
  if (process.env.DROPBOX_REFRESH_TOKEN) {
    try {
      const ok = await refreshDropboxToken();
      if (!ok) log('WARN', 'BOOT', 'Dropbox refresh échoué au démarrage');
    } catch (e) { log('WARN', 'BOOT', `Dropbox refresh exception: ${e.message}`); }
  }

  log('INFO', 'BOOT', 'Step 1b: load secrets (local persistent disk + Dropbox)');
  try {
    const local = loadLocalSecrets();
    if (local > 0) log('OK', 'BOOT', `${local} secret(s) chargé(s) depuis ${LOCAL_SECRETS_FILE}`);
  } catch (e) { log('WARN', 'BOOT', `Local secrets: ${e.message}`); }
  try {
    const n = await loadDropboxSecrets();
    if (n > 0) log('OK', 'BOOT', `${n} secret(s) chargé(s) depuis Dropbox /bot-secrets/`);
  } catch (e) { log('WARN', 'BOOT', `Dropbox secrets: ${e.message}`); }

  log('INFO', 'BOOT', 'Step 2: load Dropbox structure + index');
  try { await loadDropboxStructure(); } catch (e) { log('WARN', 'BOOT', `Dropbox struct: ${e.message}`); }
  // Build index complet en background (non bloquant — lookup rapide dès que prêt)
  buildDropboxIndex().catch(e => log('WARN', 'BOOT', `Dropbox index build: ${e.message}`));

  log('INFO', 'BOOT', 'Step 2b: refresh mailing plan (Brevo)');
  refreshMailingPlan().catch(e => log('WARN', 'BOOT', `Mailing plan: ${e.message}`));
  // Refresh toutes les heures pour rester à jour
  setInterval(() => refreshMailingPlan().catch(() => {}), 60 * 60 * 1000);

  // Step 2c — CATCH-UP veille J-1 (Shawn 2026-05-13):
  // Si redeploy/boot pendant la fenêtre 19-23h Eastern et veille pour aujourd'hui
  // pas encore faite, fire immédiatement. La fonction interne dédup par campagne
  // dans /data/veille_state.json — donc safe même si recall.
  try {
    const bootHourET = parseInt(new Date().toLocaleString('fr-CA', { hour: 'numeric', hour12: false, timeZone: 'America/Toronto' }), 10);
    if (bootHourET >= 19 && bootHourET <= 23) {
      log('INFO', 'BOOT', `Step 2c: catch-up veille J-1 (boot dans fenêtre ${bootHourET}h Eastern)`);
      checkVeilleCampagnesBackup().catch(e => log('WARN', 'BOOT', `Veille catch-up: ${e.message}`));
    }
  } catch (e) { log('WARN', 'BOOT', `Veille catch-up check: ${e.message}`); }

  log('INFO', 'BOOT', 'Step 3: init Gist');
  try { await initGistId(); } catch (e) { log('WARN', 'BOOT', `Gist init: ${e.message}`); }

  log('INFO', 'BOOT', 'Step 4: load memory + history');
  try { await loadMemoryFromGist(); } catch (e) { log('WARN', 'BOOT', `Memory: ${e.message}`); }
  // Restaurer l'historique depuis Gist si le disque /data est vide (post redeploy Render)
  try { await loadHistoryFromGist(); } catch (e) { log('WARN', 'BOOT', `History Gist: ${e.message}`); }

  log('INFO', 'BOOT', 'Step 5: load session live context');
  try { await loadSessionLiveContext(); } catch (e) { log('WARN', 'BOOT', `Session live: ${e.message}`); }

  log('INFO', 'BOOT', 'Step 5b: pre-warm master email template');
  try {
    const tpl = await loadMasterTemplate(true);
    if (tpl) log('OK', 'BOOT', `Master template chargé (${(tpl.length/1024).toFixed(1)} KB) — logos Signature SB + RE/MAX prêts`);
    else log('WARN', 'BOOT', `Master template Dropbox indispo au boot — fallback inline activé`);
  } catch (e) { log('WARN', 'BOOT', `Pre-warm template: ${e.message}`); }

  // Refresh token Dropbox toutes les 3h (tokens expirent ~4h)
  setInterval(async () => {
    if (process.env.DROPBOX_REFRESH_TOKEN) await refreshDropboxToken().catch(() => {});
  }, 3 * 60 * 60 * 1000);

  // Refresh structure Dropbox toutes les 15min (était 30min) — index plus frais
  setInterval(async () => {
    await loadDropboxStructure().catch(e => log('WARN', 'DROPBOX', `Refresh structure: ${e.message}`));
    buildDropboxIndex().catch(e => log('WARN', 'DROPBOX', `Rebuild index: ${e.message}`));
  }, 15 * 60 * 1000);

  // Preemptive Gmail token refresh toutes les 45min (token expire à 60min)
  // Évite les 401 au moment d'envoyer un doc au client
  setInterval(async () => {
    try {
      if (typeof getGmailToken === 'function') {
        await getGmailToken().catch(() => {});
      }
    } catch {}
  }, 45 * 60 * 1000);

  // ── Anthropic Health Check — ping Haiku pour détecter credit/auth problems
  // avant qu'un vrai appel Claude échoue. Adaptive: 6h normal, 5min si down.
  setTimeout(() => anthropicHealthCheck(), 30000); // 1er check 30s après boot
  setInterval(() => {
    const isDown = metrics.lastApiError &&
      Date.now() - new Date(metrics.lastApiError.at).getTime() < 60 * 60 * 1000 &&
      /credit|billing|authentication|invalid.*key/i.test(metrics.lastApiError.message || '');
    // Si down → check toutes les 5min (détecte reprise rapide après recharge)
    // Sinon → check toutes les 6h (pas de spam)
    if (isDown) anthropicHealthCheck();
  }, 5 * 60 * 1000); // tick 5min (fait le call seulement si down)
  setInterval(() => anthropicHealthCheck(), 6 * 60 * 60 * 1000); // check propre 6h

  // ── Gmail Lead Poller — surveille les leads entrants ──────────────────────
  if (process.env.GMAIL_CLIENT_ID && POLLER_ENABLED) {
    // Boot: restaurer state depuis Gist (cross-redeploy persistence).
    // Puis, si processed[] est vide (premier boot OU Gist vide) → baseline AUTO
    // silencieux: marque tous les leads récents comme déjà vus SANS notifier.
    // Évite le spam "re-notif de tout l'historique" à chaque redeploy.
    setTimeout(async () => {
      await loadPollerStateFromGist().catch(()=>{});
      if (gmailPollerState.processed.length < 5) {
        log('INFO', 'BOOT', 'State vide — baseline silencieux 7j au boot (zéro notif rétro)');
        await baselineSilentAtBoot().catch(e => log('WARN', 'BOOT', `Baseline: ${e.message}`));
      }
      // Scan normal + catch-up 4h pour attraper les leads arrivés pendant le redeploy.
      // Les leads récents non-processed seront traités. Ceux déjà dedup sont skip.
      log('INFO', 'BOOT', 'Boot catch-up scan 4h — récupération leads pendant redeploy');
      runGmailLeadPoller({ forceSince: '4h' }).catch(e => log('WARN', 'POLLER', `Boot catch-up: ${e.message}`));
    }, 8000);
    // POLLING HAUTE FRÉQUENCE: 30s par défaut (configurable) — quasi-instantané.
    // Gmail API quota: 250 unités/user/sec. list_messages = 5 unités. 30s = 0.17 req/sec
    // = 0.83 unités/sec → on est à 0.3% du quota. Safe.
    // Override via env var GMAIL_POLL_INTERVAL_MS. Default 30000 = 30s.
    const POLL_INTERVAL = parseInt(process.env.GMAIL_POLL_INTERVAL_MS || '30000');
    setInterval(() => runGmailLeadPoller().catch(() => {}), POLL_INTERVAL);
    log('OK', 'POLLER', `Intervalle polling: ${POLL_INTERVAL/1000}s (quasi-instantané)`);
    // Boot: nettoyer emails GitHub/CI 30s après démarrage (Shawn veut zéro spam)
    setTimeout(() => autoTrashGitHubNoise().catch(() => {}), 30000);
    // Cron 2h — purge en temps quasi-réel pour ne pas laisser dormir CI fails 24h
    setInterval(() => autoTrashGitHubNoise().catch(() => {}), 2 * 60 * 60 * 1000);
    log('OK', 'BOOT', 'Gmail Lead Poller + auto-trash CI noise (boot+2h cycle) activés');
  } else if (!POLLER_ENABLED) {
    log('WARN', 'BOOT', '🛑 Gmail Lead Poller DÉSACTIVÉ (POLLER_ENABLED=false) — /checkemail pour scan manuel');
  } else {
    log('WARN', 'BOOT', 'Gmail Lead Poller désactivé — GMAIL_CLIENT_ID manquant');
  }

  // Pre-login Centris au démarrage si credentials disponibles
  if (process.env.CENTRIS_USER && process.env.CENTRIS_PASS) {
    centrisLogin()
      .then(ok => log(ok ? 'OK' : 'WARN', 'CENTRIS', ok ? `Pré-login réussi (agent ${process.env.CENTRIS_USER})` : 'Pré-login échoué — retry automatique à la première requête'))
      .catch(() => {});
  }

  log('INFO', 'BOOT', 'Step 6: registerHandlers');
  try { registerHandlers(); } catch (e) { log('ERR', 'BOOT', `registerHandlers FATAL: ${e.message}\n${e.stack}`); throw e; }

  log('INFO', 'BOOT', 'Step 7: startDailyTasks');
  try { startDailyTasks(); } catch (e) { log('ERR', 'BOOT', `startDailyTasks FATAL: ${e.message}`); throw e; }

  log('INFO', 'BOOT', 'Step 8: configuration WEBHOOK Telegram (auto-healing bulletproof)');
  const webhookUrl = `https://signaturesb-bot-s272.onrender.com/webhook/telegram`;

  // ── AUTO-HEAL WEBHOOK BULLETPROOF ─────────────────────────────────────────
  // Garantit que le webhook Telegram est TOUJOURS fonctionnel. Si fail:
  // 1. Detect via getWebhookInfo
  // 2. Resync avec exponential backoff
  // 3. Après 3 fails consécutifs → escalade GitHub Issue + fallback Brevo email
  // 4. Auto-recover dès que ça remarche
  const webhookHealth = {
    lastSync: null,
    lastCheck: null,
    consecutiveFails: 0,
    lastError: null,
    status: 'unknown',
  };
  // Expose dans /health
  global.__webhookHealth = webhookHealth;

  async function syncWebhookWithSecret(reason = 'routine') {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    try {
      const setParams = {
        url: webhookUrl,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
        max_connections: 40,
      };
      if (secret) setParams.secret_token = secret;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setParams),
      });
      clearTimeout(t);
      const data = await res.json();
      if (data.ok) {
        webhookHealth.lastSync = new Date().toISOString();
        webhookHealth.consecutiveFails = 0;
        webhookHealth.lastError = null;
        webhookHealth.status = 'healthy';
        log('OK', 'WEBHOOK', `Sync OK (${reason}) — secret=${secret ? 'set' : 'none'}`);
        auditLogEvent('webhook', 'synced', { reason, hasSecret: !!secret });
        return true;
      } else {
        webhookHealth.lastError = data.description || 'unknown';
        log('WARN', 'WEBHOOK', `setWebhook fail: ${data.description}`);
        return false;
      }
    } catch (e) {
      webhookHealth.lastError = e.message;
      log('WARN', 'WEBHOOK', `sync exception: ${e.message}`);
      return false;
    }
  }

  // Fallback: envoyer alerte via Brevo email si Telegram bot down
  async function alertShawnViaFallback(subject, body) {
    if (!BREVO_KEY || !SHAWN_EMAIL) return;
    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: { email: AGENT.email, name: 'Kira Bot' },
          to: [{ email: SHAWN_EMAIL }],
          subject, htmlContent: `<pre>${body}</pre>`,
        })
      });
      log('OK', 'FALLBACK', `Email alerte envoyé à ${SHAWN_EMAIL}`);
    } catch (e) { log('WARN', 'FALLBACK', `Brevo fallback fail: ${e.message}`); }
  }

  async function checkWebhookHealth() {
    webhookHealth.lastCheck = new Date().toISOString();
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`, { signal: ctrl.signal });
      clearTimeout(t);
      const data = await res.json();
      const w = data.result || {};
      const now = Math.floor(Date.now() / 1000);
      const errorRecent = w.last_error_date && (now - w.last_error_date) < 300;
      const tooPending  = (w.pending_update_count || 0) > 20;
      const anomaly = errorRecent || tooPending;

      if (!anomaly) {
        if (webhookHealth.status !== 'healthy') {
          log('OK', 'WEBHOOK', '🎉 Webhook sain à nouveau');
          webhookHealth.status = 'healthy';
          webhookHealth.consecutiveFails = 0;
          if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, '✅ Webhook Telegram retour à la normale.').catch(()=>{});
        }
        return;
      }

      // Anomalie détectée
      webhookHealth.status = 'degraded';
      webhookHealth.consecutiveFails++;
      log('WARN', 'WEBHOOK', `Anomaly #${webhookHealth.consecutiveFails}: pending=${w.pending_update_count} lastErr=${w.last_error_message}`);
      auditLogEvent('webhook', 'anomaly', { pending: w.pending_update_count, error: w.last_error_message, consecutive: webhookHealth.consecutiveFails });

      const synced = await syncWebhookWithSecret(`auto-heal #${webhookHealth.consecutiveFails}`);
      if (synced && ALLOWED_ID) {
        bot.sendMessage(ALLOWED_ID, `🔧 *Webhook auto-heal*\n${w.last_error_message}\nResync OK. Renvoie messages perdus si besoin.`, { parse_mode: 'Markdown' }).catch(()=>{});
      }

      // Escalade: 3+ fails consécutifs → GitHub Issue + Brevo email
      if (webhookHealth.consecutiveFails >= 3) {
        log('ERR', 'WEBHOOK', `🚨 ESCALADE — ${webhookHealth.consecutiveFails} fails consécutifs`);
        auditLogEvent('webhook', 'escalated', { fails: webhookHealth.consecutiveFails });
        const msg = `Webhook Telegram cassé après ${webhookHealth.consecutiveFails} tentatives.\n` +
                    `Pending: ${w.pending_update_count}\n` +
                    `Error: ${w.last_error_message}\n` +
                    `Bot URL: ${webhookUrl}\n` +
                    `Action: vérifier TELEGRAM_WEBHOOK_SECRET + TELEGRAM_BOT_TOKEN sur Render.`;
        alertShawnViaFallback('🚨 Kira Bot — webhook Telegram cassé', msg).catch(()=>{});
      }
    } catch (e) {
      webhookHealth.consecutiveFails++;
      webhookHealth.lastError = e.message;
      log('WARN', 'WEBHOOK', `check exception: ${e.message}`);
    }
  }

  // 1er sync au boot (+5s), puis check santé toutes les 2 min (plus agressif)
  setTimeout(() => syncWebhookWithSecret('boot'), 5000);
  setInterval(checkWebhookHealth, 2 * 60 * 1000);

  // ── Anomaly detection + backup state réguliers ───────────────────────────
  // Anomaly check toutes les 30min (équilibre réactivité vs spam)
  setInterval(() => detectAnomalies().catch(e => log('WARN', 'ANOMALY', e.message)), 30 * 60 * 1000);
  // 1er check 2min après boot (laisse le temps au poller de tourner)
  setTimeout(() => detectAnomalies().catch(()=>{}), 2 * 60 * 1000);
  // Backup Gist toutes les 6h (survit aux redeploys + disaster recovery)
  setInterval(() => savePollerStateToGist().catch(()=>{}), 6 * 60 * 60 * 1000);
  // Health check APIs: 30s après boot puis toutes les heures
  setTimeout(() => testApisHealth().catch(e => log('WARN','HEALTH',e.message)), 30 * 1000);
  setInterval(() => testApisHealth().catch(e => log('WARN','HEALTH',e.message)), 60 * 60 * 1000);
  // KEEP-WARM Render free tier (anti-cold-start) — self-ping toutes les 14min
  // Render dort après 15min d'idle. Le ping suffit à le garder éveillé.
  setInterval(() => {
    fetch(`https://signaturesb-bot-s272.onrender.com/`, { signal: AbortSignal.timeout(8000) })
      .catch(() => {});
  }, 14 * 60 * 1000);
  // Reload Dropbox secrets toutes les 6h — capture nouveaux secrets ajoutés
  // sans redeploy + récupère OPENAI_API_KEY si Shawn fait /setsecret
  setInterval(() => loadDropboxSecrets().catch(e => log('WARN','SECRETS',e.message)), 6 * 60 * 60 * 1000);

  log('OK', 'BOOT', `✅ Kira démarrée [${currentModel}] — ${DATA_DIR} — mémos:${kiramem.facts.length} — tools:${TOOLS.length} — port:${PORT}`);

  // ── PRE-FLIGHT CHECK COMPLET au boot ────────────────────────────────────
  // Vérifie env vars critiques + ping chaque API + check disk space.
  // Si misconfig détectée → alerte Telegram immédiate avec diagnostic exact.
  // 10s après boot pour laisser le webhook se sync d'abord.
  setTimeout(async () => {
    const checks = [];
    const t0 = Date.now();

    // Env vars critiques
    const envRequired = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USER_ID', 'ANTHROPIC_API_KEY'];
    const envMissing = envRequired.filter(v => !process.env[v]);
    if (envMissing.length) checks.push({ ok: false, label: 'Env vars critiques', detail: `MANQUANT: ${envMissing.join(', ')}` });
    else checks.push({ ok: true, label: 'Env vars critiques', detail: 'OK' });

    // Env vars optionnels (warn si manquant mais pas bloquant)
    const envOptional = { GMAIL_CLIENT_ID: 'Gmail désactivé', PIPEDRIVE_API_KEY: 'Pipedrive désactivé', BREVO_API_KEY: 'Brevo désactivé', DROPBOX_REFRESH_TOKEN: 'Dropbox désactivé' };
    const optMissing = Object.entries(envOptional).filter(([k]) => !process.env[k]).map(([,v]) => v);
    checks.push({ ok: optMissing.length === 0, label: 'Env vars optionnels', detail: optMissing.length ? optMissing.join(', ') : 'tous présents' });

    // Disk space
    try {
      const stat = fs.statSync(DATA_DIR);
      const testFile = path.join(DATA_DIR, '.preflight_write');
      fs.writeFileSync(testFile, 'ok'); fs.unlinkSync(testFile);
      checks.push({ ok: true, label: 'Disque writable', detail: DATA_DIR });
    } catch (e) {
      checks.push({ ok: false, label: 'Disque writable', detail: e.message.substring(0, 80) });
    }

    // Ping Telegram (self-test connectivité)
    let tgOK = false;
    try {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getMe`, { signal: AbortSignal.timeout(8000) });
      tgOK = r.ok;
      checks.push({ ok: tgOK, label: 'Telegram API', detail: tgOK ? 'getMe OK' : `HTTP ${r.status}` });
    } catch (e) { checks.push({ ok: false, label: 'Telegram API', detail: e.message.substring(0, 80) }); }

    // Ping Anthropic
    if (process.env.ANTHROPIC_API_KEY) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] }),
          signal: AbortSignal.timeout(10000),
        });
        checks.push({ ok: r.ok, label: 'Anthropic API', detail: r.ok ? 'haiku ping OK' : `HTTP ${r.status}` });
      } catch (e) { checks.push({ ok: false, label: 'Anthropic API', detail: e.message.substring(0, 80) }); }
    }

    // Ping Pipedrive si configuré
    if (PD_KEY) {
      try {
        const r = await pdGet('/users/me').catch(() => null);
        checks.push({ ok: !!r?.data, label: 'Pipedrive API', detail: r?.data ? `user ${r.data.email || 'OK'}` : 'échec' });
      } catch (e) { checks.push({ ok: false, label: 'Pipedrive API', detail: e.message.substring(0, 80) }); }
    }

    // Ping Dropbox si configuré
    if (process.env.DROPBOX_REFRESH_TOKEN) {
      try {
        const r = await dropboxAPI('https://api.dropboxapi.com/2/users/get_current_account', {});
        checks.push({ ok: !!r?.ok, label: 'Dropbox API', detail: r?.ok ? 'auth OK' : `HTTP ${r?.status || '?'}` });
      } catch (e) { checks.push({ ok: false, label: 'Dropbox API', detail: e.message.substring(0, 80) }); }
    }

    // Ping Gmail si configuré
    if (process.env.GMAIL_CLIENT_ID) {
      try {
        const tok = await getGmailToken();
        checks.push({ ok: !!tok, label: 'Gmail token', detail: tok ? 'refresh OK' : 'NULL' });
      } catch (e) { checks.push({ ok: false, label: 'Gmail token', detail: e.message.substring(0, 80) }); }
    }

    // Ping Firecrawl si configuré
    if (process.env.FIRECRAWL_API_KEY) {
      try {
        const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${process.env.FIRECRAWL_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: 'https://example.com', formats: ['markdown'] }),
          signal: AbortSignal.timeout(15000),
        });
        checks.push({ ok: r.ok, label: 'Firecrawl API', detail: r.ok ? 'scrape OK' : `HTTP ${r.status}` });
      } catch (e) { checks.push({ ok: false, label: 'Firecrawl API', detail: e.message.substring(0, 80) }); }
    }

    const dur = Date.now() - t0;
    const failed = checks.filter(c => !c.ok);
    const lines = [
      failed.length === 0 ? `✅ *Bot démarré — tous systèmes OK* (${dur}ms)` : `🚨 *Bot démarré — ${failed.length} problème(s) détecté(s)*`,
      ``,
      `🤖 Modèle: \`${currentModel}\``,
      `🛠 Outils: ${TOOLS.length}`,
      `📊 Leads en attente: ${pendingLeads.filter(l=>l.needsName).length}`,
      `📦 Docs en attente: ${(typeof pendingDocSends !== 'undefined' ? pendingDocSends.size : 0)}`,
      ``,
      ...checks.map(c => `${c.ok ? '✅' : '🔴'} ${c.label}: ${c.detail}`),
    ].join('\n');

    const sent = await sendTelegramWithFallback(lines, { category: failed.length ? 'boot-preflight-issues' : 'boot-preflight-ok' });
    if (sent) log('OK', 'BOOT', `✅ Pre-flight: ${checks.length - failed.length}/${checks.length} OK`);
    else log('WARN', 'BOOT', '⚠️ Pre-flight envoyé localement seulement — Telegram non joignable');
    if (failed.length) auditLogEvent('boot', 'preflight_issues', { failed: failed.map(f => ({ label: f.label, detail: f.detail })) });
  }, 10000);

  setTimeout(() => syncStatusGitHub().catch(() => {}), 30000);

  // ── PRE-FLIGHT Claude API — détecte tool invalide dès le boot ─────────────
  setTimeout(async () => {
    try {
      await claude.messages.create({
        model: currentModel, max_tokens: 10,
        tools: TOOLS_WITH_CACHE,
        messages: [{ role: 'user', content: 'ping' }]
      });
      log('OK', 'PREFLIGHT', `✅ Claude API accepte les ${TOOLS.length} tools`);
    } catch (e) {
      const msg = e.message || '';
      const badIdx = msg.match(/tools\.(\d+)\.custom\.name/);
      if (badIdx) {
        const badTool = TOOLS[parseInt(badIdx[1])]?.name || '?';
        log('ERR', 'PREFLIGHT', `🚨 TOOL REJETÉ: "${badTool}" — regex [a-zA-Z0-9_-] violée`);
        sendTelegramWithFallback(
          `🚨 *BOT EN PANNE*\nTool "${badTool}" invalide pour ${currentModel}.\nFix immédiat requis — accent ou caractère spécial dans le nom.`,
          { category: 'preflight-tool-rejected', badTool }
        ).catch(() => {});
      } else if (e.status === 400) {
        log('ERR', 'PREFLIGHT', `🚨 API 400: ${msg.substring(0, 200)}`);
        sendTelegramWithFallback(
          `🚨 *Claude API 400*\n${msg.substring(0, 200)}`,
          { category: 'preflight-api-400' }
        ).catch(() => {});
      } else {
        log('WARN', 'PREFLIGHT', `API test: ${msg.substring(0, 150)}`);
      }
    }
  }, 3000);

  // Rapport de boot réussi — Claude Code peut voir que le bot a bien démarré
  setTimeout(async () => {
    try {
      if (process.env.GITHUB_TOKEN) {
        const content = `# ✅ Boot réussi\n_${new Date().toLocaleString('fr-CA',{timeZone:'America/Toronto'})}_\n\n- Modèle: ${currentModel}\n- Outils: ${TOOLS.length}\n- Uptime: ${Math.floor(process.uptime())}s\n- Centris: ${centrisSession.authenticated?'✅':'⏳'}\n- Dropbox: ${dropboxToken?'✅':'❌'}\n\n## Logs boot (150 dernières lignes)\n\`\`\`\n${(bootLogsCapture||[]).slice(-150).join('\n')}\n\`\`\`\n`;
        const url = `https://api.github.com/repos/signaturesb/kira-bot/contents/BOOT_REPORT.md`;
        const getRes = await fetch(url, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
        const sha = getRes.ok ? (await getRes.json()).sha : undefined;
        await fetch(url, {
          method: 'PUT',
          headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `Boot OK ${new Date().toISOString()}`, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) })
        });
        log('OK', 'BOOT', 'BOOT_REPORT.md écrit dans GitHub');
      }
    } catch (e) { log('WARN', 'BOOT', `Report: ${e.message}`); }
  }, 15000);
}

main().catch(err => {
  log('ERR', 'BOOT', `❌ ERREUR DÉMARRAGE: ${err.message}\n${err.stack?.substring(0, 500) || ''}`);
  // Ne PAS exit(1) — laisser Render faire le health check
  // Si health fail, Render restart. Si on exit, on crash loop.
  setTimeout(() => process.exit(1), 5000); // Délai pour que les logs soient envoyés
});
