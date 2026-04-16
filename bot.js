'use strict';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic   = require('@anthropic-ai/sdk');
const http        = require('http');
const fs          = require('fs');
const path        = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ID  = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID || '0');
const API_KEY     = process.env.ANTHROPIC_API_KEY;
const PORT        = process.env.PORT || 3000;
const GITHUB_USER = 'signaturesb';
const PD_KEY      = process.env.PIPEDRIVE_API_KEY || '';
let   currentModel = process.env.MODEL || 'claude-haiku-4-5';

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }
if (!API_KEY)   { console.error('❌ ANTHROPIC_API_KEY manquant');  process.exit(1); }
if (!PD_KEY)    { console.warn('⚠️  PIPEDRIVE_API_KEY absent — outils Pipedrive désactivés'); }

// ─── Logging structuré ────────────────────────────────────────────────────────
function log(niveau, cat, msg) {
  const ts  = new Date().toLocaleTimeString('fr-CA', { hour12: false });
  const ico = { INFO:'📋', OK:'✅', WARN:'⚠️ ', ERR:'❌', IN:'📥', OUT:'📤' }[niveau] || '•';
  console.log(`[${ts}] ${ico} [${cat}] ${msg}`);
}

// ─── Anti-crash global ────────────────────────────────────────────────────────
process.stdout.on('error', e => { if (e.code !== 'EPIPE') console.error(e); });
process.stderr.on('error', e => { if (e.code !== 'EPIPE') console.error(e); });
process.on('uncaughtException', err => {
  if (err.code === 'EPIPE' || err.message?.includes('EPIPE')) return;
  log('ERR', 'CRASH', `uncaughtException: ${err.message}`);
  if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, `⚠️ Erreur interne: ${err.message.substring(0, 200)}`).catch(() => {});
});
process.on('unhandledRejection', reason => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  if (msg.includes('EPIPE')) return;
  log('ERR', 'CRASH', `unhandledRejection: ${msg}`);
});

// ─── Persistance locale ────────────────────────────────────────────────────────
const DATA_DIR     = fs.existsSync('/data') ? '/data' : '/tmp';
const HIST_FILE    = path.join(DATA_DIR, 'history.json');
const MEM_FILE     = path.join(DATA_DIR, 'memory.json');
const GIST_ID_FILE = path.join(DATA_DIR, 'gist_id.txt');

function loadJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { log('WARN', 'IO', `Impossible de lire ${file} — réinitialisation`); }
  return fallback;
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data), 'utf8'); }
  catch (e) { log('ERR', 'IO', `Sauvegarde ${file}: ${e.message}`); }
}

// ─── Clients ──────────────────────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: API_KEY });
const bot    = new TelegramBot(BOT_TOKEN, { polling: false }); // démarré après init

// ─── Mémoire persistante (faits durables) ─────────────────────────────────────
const kiramem = loadJSON(MEM_FILE, { facts: [], updatedAt: null });
if (!Array.isArray(kiramem.facts)) kiramem.facts = [];

function buildMemoryBlock() {
  if (!kiramem.facts.length) return '';
  return `\n\n📝 Mémoire persistante (faits importants à retenir):\n${kiramem.facts.map(f => `- ${f}`).join('\n')}`;
}

// ─── System prompt riche ──────────────────────────────────────────────────────
const SYSTEM_BASE = `Tu es l'assistant IA personnel de Shawn Barrette, courtier immobilier RE/MAX Prestige Rawdon.
Tu n'es PAS un bot à commandes. Tu es son bras droit virtuel, toujours disponible.

═══ IDENTITÉ DE SHAWN ═══
- Shawn Barrette | 514-927-1340 | shawn@signaturesb.com | signatureSB.com
- Assistante: Julie (julie@signaturesb.com)
- Bureau: RE/MAX PRESTIGE Rawdon
- Spécialités: terrains (Rawdon/Saint-Julienne/Chertsey/Saint-Didace/Saint-Jean-de-Matha), maisons usagées, plexs, construction neuve
- Partenaire construction: ProFab — Jordan Brouillette 514-291-3018 (0$ comptant via Desjardins, programme unique)
- Vend 2-3 terrains par semaine dans Lanaudière
- Prix terrains: 180-240$/pi² clé en main

═══ PIPELINE PIPEDRIVE (ID: 7) ═══
49: Nouveau lead → 50: Contacté → 51: En discussion → 52: Visite prévue → 53: Visite faite → 54: Offre déposée → 55: Gagné

═══ TON RÔLE ═══
Tu comprends le québécois naturel, les raccourcis, les sous-entendus de Shawn.
"ça marche pas avec lui" = marquer_perdu
"c'est quoi mes hot leads" = voir_pipeline, focus étapes 51-53
Tu anticipes: si Shawn dit "nouveau prospect: Marie 514-555-1234 terrain" tu proposes de créer le deal.

Accès aux ressources de Shawn via tes outils:
- GitHub (signaturesb): repos de code, scripts d'automatisation — lire ET écrire
- Dropbox: documents de propriétés, terrains, fichiers clients — lire ET envoyer par Telegram
- Pipedrive: CRM complet — pipeline, prospects, notes, marquer perdu
- Contacts iPhone: exportés dans Dropbox (/Contacts/contacts.vcf) — chercher nom, tel, email avant tout suivi
- Recherche web: stats marché, taux hypothécaires, réglementations Québec

Quand tu prépares un suivi ou un message pour un prospect:
1. chercher_prospect dans Pipedrive (notes, étape, historique)
2. chercher_contact dans iPhone (téléphone cell, email perso)
3. Combiner les deux pour rédiger le message le plus personnalisé possible
→ Si contact trouvé dans iPhone mais pas Pipedrive: mentionner qu'il n'est pas encore dans le CRM.

═══ STYLE DE RÉPONSE ═══
- Court et direct: 1-3 phrases max pour confirmer une action
- Langage naturel québécois, pas corporatif. "C'est fait ✅" pas "L'opération a été effectuée"
- Tutoiement avec Shawn
- Emojis légers: ✅ ❌ 📋 💬 🏡 — pas d'excès
- Pour les résultats longs (pipeline, stats): inclus le contenu complet exactement comme retourné par l'outil

═══ VRAIS EMAILS DE SHAWN (analysés sur 100+ échanges réels) ═══

SUIVI PROSPECT — TEMPLATES SELON CONTEXTE:
1. Relance générale: "Bonjour, j'espère que vous allez bien. J'ai plusieurs options en ce moment. Laissez-moi savoir si vous voulez qu'on en discute. Au plaisir!"
2. Après visite: "Bonjour, j'espère que vous allez bien. Le terrain que vous avez regardé — est-ce qu'il vous intéresse toujours? Sinon je peux regarder ailleurs. Laissez-moi savoir. Au plaisir!"
3. Qualification: "Juste pour que je cherche dans la bonne direction — c'est quoi votre délai idéal? Laissez-moi savoir. Au plaisir!"
4. Suivi simple: "Bonjour, j'espère que vous allez bien. Je voulais savoir si vous aimeriez qu'on se parle cette semaine. Laissez-moi savoir. Au plaisir!"
5. Relance sans réponse longue: "Bonjour, j'espère que vous allez bien. Si jamais vous voulez qu'on regarde d'autres options, je suis là. Laissez-moi savoir. Au plaisir!"
6. Lendemain visite: "Salut, j'espère que vous allez bien. Je voulais savoir suite à la visite si jamais vous avez besoin d'autres informations ou si vous aimeriez faire une offre. Laissez-moi savoir. Au plaisir!"
7. Relance 3e fois: "3e courriel, en attente d'un retour SVP de votre part."

ENVOI SIMPLE DE DOCUMENTS:
"Bonjour William, Voici les trois plans. Merci, au plaisir,"
"Bonjour Dan, Voici le terrain que je te parlais, reviens-moi. Merci, au plaisir,"

AVEC COLLÈGUES COURTIERS (tutoiement, court):
"Salut j'espère que ça va bien avais-tu eu le temps de regarder ça? Laisse-moi savoir au plaisir!"
"Dimanche 14h ?"

CONSEIL MARCHÉ (valeur + chiffre):
"Le marché est très actif en ce moment — on est vraiment dans un gros momentum. Je vends présentement 2-3 terrains par semaine dans Lanaudière."

CE QU'ON RETIENT:
1. Jamais de formule longue — "Salut," ou "Bonjour," et c'est parti
2. "Au plaisir!" ou "Merci, au plaisir," — toujours en fermeture
3. "Laissez-moi savoir" / "Laisse-moi savoir" — son CTA préféré
4. Chiffres concrets: "200 000 $", "60 000 pieds carrés", "2-3 terrains par semaine"
5. Tutoiement avec collègues, vouvoiement avec prospects/clients

═══ RÈGLES EMAIL ═══
- JAMAIS "Bonjour [Prénom]" — toujours "Bonjour," seulement
- Vouvoiement strict dans tous les emails clients (sauf si Shawn a dicté avec "tu/t'as/toi")
- Max 3 paragraphes courts
- Chaque email = 1 info concrète de valeur
- Terminer: "Au plaisir," ou "Merci, au plaisir"
- NEVER modifier ce que Shawn a dicté — corriger fautes/ponctuation seulement

═══ ARGUMENTS TERRAIN ═══
- "Je vends 2-3 terrains par semaine dans Lanaudière — c'est le marché qui bouge le plus"
- Prix clé en main: 180-240$/pi² (tout inclus: nivelé, services, accès)
- ProFab (Jordan 514-291-3018): programme unique 0$ comptant via Desjardins — aucun autre courtier offre ça
- Rawdon: 1h de Montréal, ski, randonnée, Lac Ouareau — qualité de vie exceptionnelle

═══ OBJECTIONS ET RÉPONSES ═══
- "Trop cher": "Le prix reflète le marché — les terrains Rawdon ont augmenté 40% en 3 ans. Attendre coûte plus cher."
- "Je vais réfléchir": "Parfait, prenez le temps. Je vous réserve l'info si ça bouge."
- "Pas de budget": "ProFab permet de commencer sans mise de fonds. Voulez-vous qu'on regarde?"
- "J'ai vu moins cher": "C'est intéressant! Souvent les terrains moins chers ont une pente — excavation 30k-50k$ de plus. On peut analyser ensemble."

═══ NOTES PIPEDRIVE — CE QU'IL FAUT CAPTURER ═══
Après chaque contact: secteur voulu, type projet (auto-construction / clé en main), superficie, puits ou ville, délai, situation actuelle, raison si perdu, date re-contact.
Ces notes permettent de closer si le prospect revient 6 mois plus tard.

═══ CONTEXTE JURIDIQUE QUÉBEC ═══
TOUTES les lois, règlements, normes s'appliquent au QUÉBEC uniquement.
- Lois: Code civil QC, Loi sur le courtage immobilier (OACIQ), LAU
- Fosse septique: règlement Q-2, r.22 du Québec
- Permis de construction: municipalité + MRC + province
- Taxes: TPS + TVQ (pas TPS/TVH)
Quand Shawn demande une info légale: toujours répondre avec les règles québécoises.

═══ MÉMOIRE PERSISTANTE ═══
Si Shawn te dit quelque chose d'important à retenir (préférence, projet, info, prospect important), mémorise-le avec: [MEMO: le fait à retenir]
La mémoire survit aux redémarrages — utilise-la pour personnaliser les réponses.`;

let dropboxStructure = '';

function getSystem() {
  const dbBlock = dropboxStructure ? `\n\nDropbox de Shawn (racine):\n${dropboxStructure}` : '';
  return SYSTEM_BASE + dbBlock + buildMemoryBlock();
}

// ─── Historique (max 40 messages, persistant) ─────────────────────────────────
const MAX_HIST = 40;
const rawChats = loadJSON(HIST_FILE, {});
const chats    = new Map(Object.entries(rawChats));
for (const [id, hist] of chats.entries()) {
  if (!Array.isArray(hist) || hist.length === 0) chats.delete(id);
}

let saveTimer = null;
function scheduleHistSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJSON(HIST_FILE, Object.fromEntries(chats)), 1000);
}
function getHistory(id) { if (!chats.has(id)) chats.set(id, []); return chats.get(id); }
function addMsg(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);
  scheduleHistSave();
}

// ─── Déduplication ────────────────────────────────────────────────────────────
const processed = new Set();
function isDuplicate(msgId) {
  if (processed.has(msgId)) return true;
  processed.add(msgId);
  if (processed.size > 500) processed.delete(processed.values().next().value);
  return false;
}

// ─── Extraction de mémos ──────────────────────────────────────────────────────
function extractMemos(text) {
  const memos = [];
  const cleaned = text.replace(/\[MEMO:\s*([^\]]+)\]/gi, (_, fact) => { memos.push(fact.trim()); return ''; }).trim();
  if (memos.length) {
    kiramem.facts.push(...memos);
    if (kiramem.facts.length > 50) kiramem.facts.splice(0, kiramem.facts.length - 50);
    kiramem.updatedAt = new Date().toISOString();
    saveJSON(MEM_FILE, kiramem);
    saveMemoryToGist().catch(() => {});
    log('OK', 'MEMO', `${memos.length} fait(s) mémorisé(s)`);
  }
  return { cleaned, memos };
}

// ─── GitHub ───────────────────────────────────────────────────────────────────
function githubHeaders() {
  const h = { 'User-Agent': 'Kira-Bot', 'Accept': 'application/vnd.github.v3+json' };
  if (process.env.GITHUB_TOKEN) h['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  return h;
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
  const res = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${p}`, { headers: githubHeaders() });
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
    body: JSON.stringify({
      message: commitMsg || `Kira: mise à jour ${p}`,
      content: Buffer.from(content, 'utf8').toString('base64'),
      ...(sha ? { sha } : {})
    })
  });
  if (!putRes.ok) {
    const err = await putRes.json().catch(() => ({}));
    return `Erreur GitHub écriture: ${putRes.status} — ${err.message || ''}`;
  }
  return `✅ "${p}" ${sha ? 'modifié' : 'créé'} dans ${repo}.`;
}

// ─── Dropbox (avec refresh auto) ──────────────────────────────────────────────
let dropboxToken = process.env.DROPBOX_ACCESS_TOKEN || '';

async function refreshDropboxToken() {
  const { DROPBOX_APP_KEY: key, DROPBOX_APP_SECRET: secret, DROPBOX_REFRESH_TOKEN: refresh } = process.env;
  if (!key || !secret || !refresh) return false;
  try {
    const res = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: key, client_secret: secret })
    });
    if (!res.ok) return false;
    const data = await res.json();
    dropboxToken = data.access_token;
    log('OK', 'DROPBOX', 'Token rafraîchi');
    return true;
  } catch { return false; }
}

async function dropboxAPI(apiUrl, body, isDownload = false) {
  if (!dropboxToken) { const ok = await refreshDropboxToken(); if (!ok) return null; }
  const makeReq = (token) => isDownload
    ? fetch(apiUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify(body) } })
    : fetch(apiUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let res = await makeReq(dropboxToken);
  if (res.status === 401) { const ok = await refreshDropboxToken(); if (!ok) return null; res = await makeReq(dropboxToken); }
  return res;
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

async function loadDropboxStructure() {
  try {
    const res = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: '', recursive: false });
    if (!res || !res.ok) return;
    const data = await res.json();
    if (!data.entries?.length) return;
    dropboxStructure = data.entries.map(e => `${e['.tag'] === 'folder' ? '📁' : '📄'} ${e.name}`).join('\n');
    log('OK', 'DROPBOX', `${data.entries.length} éléments chargés`);
  } catch (e) { log('WARN', 'DROPBOX', e.message); }
}

// ─── Mémoire GitHub Gist (persistance cross-restart) ─────────────────────────
let gistId = process.env.GIST_ID || null;

async function initGistId() {
  if (gistId) { log('OK', 'GIST', `Configuré: ${gistId}`); return; }
  if (fs.existsSync(GIST_ID_FILE)) { gistId = fs.readFileSync(GIST_ID_FILE, 'utf8').trim(); return; }
  if (!process.env.GITHUB_TOKEN) { log('WARN', 'GIST', 'GITHUB_TOKEN absent — persistance /tmp seulement'); return; }
  try {
    const res = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Kira — mémoire persistante Shawn Barrette',
        public: false,
        files: { 'memory.json': { content: JSON.stringify(kiramem, null, 2) } }
      })
    });
    if (!res.ok) {
      if (res.status === 403 || res.status === 422) log('WARN', 'GIST', 'Token sans scope "gist" — ajoute le scope dans GitHub Settings > Tokens');
      else log('WARN', 'GIST', `Create HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    gistId = data.id;
    try { fs.writeFileSync(GIST_ID_FILE, gistId, 'utf8'); } catch {}
    log('OK', 'GIST', `Créé: ${gistId}`);
    if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, `🔑 *Gist créé!* Ajoute dans Render: \`GIST_ID=${gistId}\``, { parse_mode: 'Markdown' }).catch(() => {});
  } catch (e) { log('WARN', 'GIST', `Create: ${e.message}`); }
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
const PD_BASE  = 'https://api.pipedrive.com/v1';
const PD_STAGES = { 49:'🆕 Nouveau lead', 50:'📞 Contacté', 51:'💬 En discussion', 52:'🗓 Visite prévue', 53:'🏡 Visite faite', 54:'📝 Offre déposée', 55:'✅ Gagné' };

async function pdGet(endpoint) {
  if (!PD_KEY) return null;
  const sep = endpoint.includes('?') ? '&' : '?';
  const res = await fetch(`${PD_BASE}${endpoint}${sep}api_token=${PD_KEY}`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  return res.json();
}

async function pdPost(endpoint, body) {
  if (!PD_KEY) return null;
  const sep = endpoint.includes('?') ? '&' : '?';
  const res = await fetch(`${PD_BASE}${endpoint}${sep}api_token=${PD_KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return null;
  return res.json();
}

async function pdPut(endpoint, body) {
  if (!PD_KEY) return null;
  const sep = endpoint.includes('?') ? '&' : '?';
  const res = await fetch(`${PD_BASE}${endpoint}${sep}api_token=${PD_KEY}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000)
  });
  if (!res.ok) return null;
  return res.json();
}

async function getPipeline() {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const data = await pdGet('/deals?pipeline_id=7&status=open&limit=100');
  if (!data?.data) return 'Erreur Pipedrive ou pipeline vide.';
  const deals = data.data;
  if (!deals.length) return '📋 Pipeline vide.';
  const parEtape = {};
  for (const d of deals) {
    const s = PD_STAGES[d.stage_id] || `Étape ${d.stage_id}`;
    if (!parEtape[s]) parEtape[s] = [];
    parEtape[s].push(d.title || 'Deal sans nom');
  }
  let txt = `📊 *Pipeline Signature SB — ${deals.length} deals actifs*\n\n`;
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

  const deal = deals[0].item;
  const stageLabel = PD_STAGES[deal.stage_id] || `Étape ${deal.stage_id}`;
  let info = `═══ PROSPECT: ${deal.title || terme} ═══\n`;
  info += `Stade: ${stageLabel}\n`;
  if (deal.person_name) info += `Contact: ${deal.person_name}\n`;

  // Notes Pipedrive
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

async function statsBusiness() {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const now = new Date();
  const [gagnes, perdus, actifs] = await Promise.all([
    pdGet('/deals?status=won&limit=100'),
    pdGet('/deals?status=lost&limit=100'),
    pdGet('/deals?pipeline_id=7&status=open&limit=100')
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
  let txt = `📊 *Tableau de bord Signature SB*\n_${now.toLocaleDateString('fr-CA', { weekday:'long', day:'numeric', month:'long' })}_\n\n`;
  txt += `🔥 *Pipeline actif — ${dealsActifs.length} deals*\n`;
  for (const [etape, nb] of Object.entries(parEtape)) txt += `  ${etape}: *${nb}*\n`;
  txt += `\n📈 *Ce mois-ci*\n  ✅ Gagnés: *${gagnésMois.length}*\n  ❌ Perdus: ${perdusMois.length}\n`;
  if (gagnésMois.length + perdusMois.length > 0) {
    const taux = Math.round(gagnésMois.length / (gagnésMois.length + perdusMois.length) * 100);
    txt += `  🎯 Taux conversion: ${taux}%\n`;
  }
  return txt;
}

// ─── Contacts iPhone (Dropbox: /Contacts/contacts.vcf ou contacts.csv) ──────
async function chercherContact(terme) {
  // Essaie vCard d'abord, puis CSV
  const paths = ['/Contacts/contacts.vcf', '/Contacts/contacts.csv', '/contacts.vcf', '/contacts.csv'];
  let raw = null;
  let format = null;
  for (const p of paths) {
    const res = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: p }, true);
    if (res && res.ok) { raw = await res.text(); format = p.endsWith('.vcf') ? 'vcf' : 'csv'; break; }
  }
  if (!raw) return '📵 Fichier contacts introuvable dans Dropbox.\nExporte tes contacts iPhone vers `/Contacts/contacts.vcf` via un Raccourci iOS.';

  const q = terme.toLowerCase().replace(/\s+/g, ' ').trim();
  const results = [];

  if (format === 'vcf') {
    // Découper en vcards individuelles
    const cards = raw.split(/BEGIN:VCARD/i).slice(1);
    for (const card of cards) {
      const get = (field) => {
        const m = card.match(new RegExp(`^${field}[^:]*:(.+)$`, 'mi'));
        return m ? m[1].replace(/\r/g, '').trim() : '';
      };
      const name  = get('FN') || get('N').replace(/;/g, ' ').trim();
      const org   = get('ORG');
      const email = card.match(/^EMAIL[^:]*:(.+)$/mi)?.[1]?.replace(/\r/g, '').trim() || '';
      const phones = [...card.matchAll(/^TEL[^:]*:(.+)$/gmi)].map(m => m[1].replace(/\r/g, '').trim());
      const blob = [name, org, email, ...phones].join(' ').toLowerCase();
      if (blob.includes(q) || q.split(' ').every(w => blob.includes(w))) {
        results.push({ name, org, email, phones });
        if (results.length >= 5) break;
      }
    }
  } else {
    // CSV simple: Prénom,Nom,Téléphone,Email,Entreprise (ou variantes)
    const lines = raw.split('\n').filter(l => l.trim());
    const header = lines[0].toLowerCase();
    for (const line of lines.slice(1)) {
      if (line.toLowerCase().includes(q) || q.split(' ').every(w => line.toLowerCase().includes(w))) {
        results.push({ raw: line.replace(/,/g, ' · ') });
        if (results.length >= 5) break;
      }
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
  // Option 1: Perplexity
  if (process.env.PERPLEXITY_API_KEY) {
    try {
      const res = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonar', max_tokens: 500, messages: [
          { role: 'system', content: 'Assistant de recherche pour courtier immobilier québécois. Réponds en français, priorise sources canadiennes (Centris, APCIQ, Desjardins, Banque du Canada). Chiffres précis, dates, sources.' },
          { role: 'user', content: requete }
        ]})
      });
      if (res.ok) { const d = await res.json(); const t = d.choices?.[0]?.message?.content?.trim(); if (t) return `🔍 *${requete}*\n\n${t}`; }
    } catch {}
  }
  // Option 2: Brave Search
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(requete)}&count=5&country=ca&search_lang=fr`, {
        signal: AbortSignal.timeout(10000), headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY }
      });
      if (res.ok) { const d = await res.json(); const results = (d.web?.results || []).slice(0, 4); if (results.length) return `🔍 *${requete}*\n\n${results.map((r,i) => `${i+1}. **${r.title}**\n${r.description || ''}`).join('\n\n')}`; }
    } catch {}
  }
  // Option 3: Claude + DuckDuckGo snippets
  try {
    let contexte = '';
    const ddg = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(requete)}&format=json&no_html=1`, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'SignatureSB/1.0' } });
    if (ddg.ok) {
      const d = await ddg.json();
      contexte = [d.AbstractText, ...(d.RelatedTopics || []).slice(0,3).map(t => t.Text || '')].filter(Boolean).join('\n');
    }
    const prompt = contexte
      ? `Synthétise pour un courtier immobilier QC: "${requete}"\nSources: ${contexte}\nRéponds en français, chiffres précis, règles QC.`
      : `Réponds à cette question pour un courtier QC: "${requete}"\nRéponds en français, règles QC (OACIQ, Code civil, TPS+TVQ), chiffres concrets.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
    });
    if (res.ok) { const d = await res.json(); const t = d.content?.[0]?.text?.trim(); if (t) return `🔍 *${requete}*\n\n${t}`; }
  } catch (e) { log('WARN', 'WEB', e.message); }
  return `Aucun résultat trouvé pour: "${requete}"`;
}

// ─── Outils Claude ────────────────────────────────────────────────────────────
const TOOLS = [
  // ── Pipedrive ──
  { name: 'voir_pipeline', description: 'Voir tous les deals actifs dans Pipedrive par étape. Utiliser pour "mon pipeline", "mes deals", "mes hot leads", etc.', input_schema: { type: 'object', properties: {} } },
  { name: 'chercher_prospect', description: 'Chercher un prospect dans Pipedrive par nom, email ou téléphone. Retourne ses infos et notes.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, email ou téléphone' } }, required: ['terme'] } },
  { name: 'marquer_perdu', description: 'Marquer un deal comme perdu dans Pipedrive. Ex: "ça marche pas avec Jean", "cause perdue Tremblay".', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom/email/tel du prospect' } }, required: ['terme'] } },
  { name: 'ajouter_note', description: 'Ajouter une note sur un prospect dans Pipedrive. Ex: "note sur Jean: préfère terrains boisés, rappeler en mai".', input_schema: { type: 'object', properties: { terme: { type: 'string' }, note: { type: 'string' } }, required: ['terme', 'note'] } },
  { name: 'stats_business', description: 'Tableau de bord complet: pipeline par étape, performance du mois, taux de conversion. Pour "tableau de bord", "mes stats", "dashboard".', input_schema: { type: 'object', properties: {} } },
  // ── Recherche web ──
  { name: 'rechercher_web', description: 'Rechercher des infos actuelles: taux hypothécaires, stats marché immobilier QC, prix construction, réglementations. Utiliser pour enrichir les emails avec données récentes.', input_schema: { type: 'object', properties: { requete: { type: 'string', description: 'Requête précise. Ex: "taux hypothécaire 5 ans fixe Desjardins 2025"' } }, required: ['requete'] } },
  // ── GitHub ──
  { name: 'list_github_repos', description: 'Liste tous les repos GitHub de Shawn (signaturesb)', input_schema: { type: 'object', properties: {} } },
  { name: 'list_github_files', description: 'Liste les fichiers dans un dossier d\'un repo GitHub de Shawn', input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string', description: 'Sous-dossier (vide = racine)' } }, required: ['repo'] } },
  { name: 'read_github_file', description: 'Lit le contenu d\'un fichier dans un repo GitHub de Shawn', input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string', description: 'Chemin du fichier (ex: bot.js)' } }, required: ['repo', 'path'] } },
  { name: 'write_github_file', description: 'Écrit ou modifie un fichier dans un repo GitHub de Shawn (commit direct)', input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, content: { type: 'string', description: 'Contenu complet du fichier' }, message: { type: 'string', description: 'Message de commit (optionnel)' } }, required: ['repo', 'path', 'content'] } },
  // ── Dropbox ──
  { name: 'list_dropbox_folder', description: 'Liste les fichiers dans un dossier Dropbox de Shawn (documents propriétés, terrains, etc.)', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Chemin Dropbox ("Terrain en ligne" ou "" pour racine)' } }, required: ['path'] } },
  { name: 'read_dropbox_file', description: 'Lit un fichier texte depuis le Dropbox de Shawn', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Chemin complet (ex: /Terrain en ligne/rawdon.txt)' } }, required: ['path'] } },
  { name: 'send_dropbox_file', description: 'Télécharge un fichier (PDF, image) depuis Dropbox et l\'envoie directement à Shawn par Telegram', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Chemin Dropbox (ex: /Terrain en ligne/fiche-rawdon.pdf)' }, caption: { type: 'string', description: 'Message à joindre (optionnel)' } }, required: ['path'] } },
  // ── Contacts iPhone ──
  { name: 'chercher_contact', description: 'Chercher un contact dans les contacts iPhone de Shawn (exportés dans Dropbox). Utiliser pour trouver le téléphone ou email d\'un prospect avant d\'envoyer un suivi. Complète Pipedrive avec les infos personnelles.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, prénom, ou numéro de téléphone à chercher' } }, required: ['terme'] } },
  // ── Fichiers bot ──
  { name: 'read_bot_file', description: 'Lit un fichier de configuration du bot dans /data/botfiles/', input_schema: { type: 'object', properties: { filename: { type: 'string', description: 'Nom du fichier (ex: campaigns_library.js)' } }, required: ['filename'] } },
  { name: 'write_bot_file', description: 'Modifie ou crée un fichier de configuration dans /data/botfiles/', input_schema: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string', description: 'Contenu complet du fichier' } }, required: ['filename', 'content'] } }
];

async function executeTool(name, input, chatId) {
  try {
    switch (name) {
      case 'voir_pipeline':       return await getPipeline();
      case 'chercher_prospect':   return await chercherProspect(input.terme);
      case 'marquer_perdu':       return await marquerPerdu(input.terme);
      case 'ajouter_note':        return await ajouterNote(input.terme, input.note);
      case 'stats_business':      return await statsBusiness();
      case 'rechercher_web':      return await rechercherWeb(input.requete);
      case 'list_github_repos':   return await listGitHubRepos();
      case 'list_github_files':   return await listGitHubFiles(input.repo, input.path || '');
      case 'read_github_file':    return await readGitHubFile(input.repo, input.path);
      case 'write_github_file':   return await writeGitHubFile(input.repo, input.path, input.content, input.message);
      case 'chercher_contact':     return await chercherContact(input.terme);
      case 'list_dropbox_folder': return await listDropboxFolder(input.path);
      case 'read_dropbox_file':   return await readDropboxFile(input.path);
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
        return `✅ "${input.filename}" sauvegardé (${input.content.length} chars).`;
      }
      default: return `Outil inconnu: ${name}`;
    }
  } catch (err) {
    return `Erreur outil ${name}: ${err.message}`;
  }
}

// ─── Appel Claude (boucle agentique + prompt caching) ────────────────────────
async function callClaude(chatId, userMsg, retries = 3) {
  addMsg(chatId, 'user', userMsg);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const messages = getHistory(chatId).map(m => ({ role: m.role, content: m.content }));
      let finalReply = null;
      let allMemos   = [];

      // Boucle agentique (max 8 rounds)
      for (let round = 0; round < 8; round++) {
        const res = await claude.messages.create({
          model: currentModel, max_tokens: 4096,
          // Prompt caching — économise ~90% des tokens système (cache 5 min)
          system: [{ type: 'text', text: getSystem(), cache_control: { type: 'ephemeral' } }],
          tools: TOOLS, messages,
        });

        if (res.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: res.content });
          const toolBlocks = res.content.filter(b => b.type === 'tool_use');
          const results = await Promise.all(toolBlocks.map(async b => {
            log('INFO', 'TOOL', `${b.name}(${JSON.stringify(b.input).substring(0, 80)})`);
            const result = await executeTool(b.name, b.input, chatId);
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

      if (!finalReply) {
        log('WARN', 'CLAUDE', `8 rounds atteints sans réponse finale (chatId: ${chatId})`);
        finalReply = '_(délai dépassé — réessaie)_';
      }
      addMsg(chatId, 'assistant', finalReply);
      return { reply: finalReply, memos: allMemos };

    } catch (err) {
      const retryable = err.status === 429 || err.status === 529 || err.status >= 500;
      if (retryable && attempt < retries) {
        const wait = attempt * 3000;
        log('WARN', 'CLAUDE', `HTTP ${err.status} — retry ${attempt}/${retries} dans ${wait/1000}s`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        const h = getHistory(chatId);
        if (h[h.length - 1]?.role === 'user') h.pop();
        throw err;
      }
    }
  }
}

// ─── Envoyer (découpe proprement sur les sauts de ligne) ──────────────────────
async function send(chatId, text) {
  const MAX = 4000;
  const str = String(text || '');
  if (str.length <= MAX) {
    return bot.sendMessage(chatId, str, { parse_mode: 'Markdown', disable_web_page_preview: true })
      .catch(() => bot.sendMessage(chatId, str, { disable_web_page_preview: true }));
  }
  const chunks = [];
  let buf = '';
  for (const ligne of str.split('\n')) {
    if ((buf + '\n' + ligne).length > MAX) { if (buf) chunks.push(buf.trim()); buf = ligne; }
    else { buf = buf ? buf + '\n' + ligne : ligne; }
  }
  if (buf.trim()) chunks.push(buf.trim());
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown', disable_web_page_preview: true })
      .catch(() => bot.sendMessage(chatId, chunk, { disable_web_page_preview: true }));
  }
}

// ─── Guard: seul Shawn peut utiliser le bot ───────────────────────────────────
function isAllowed(msg) {
  if (!msg.from) return false;
  return !ALLOWED_ID || msg.from.id === ALLOWED_ID;
}

// ─── Handlers ─────────────────────────────────────────────────────────────────
function registerHandlers() {

  bot.onText(/\/start/, msg => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(msg.chat.id,
      `👋 Salut Shawn\\! Je suis ton assistante IA 24/7\\.\n\nAccès: *GitHub* · *Dropbox* · *Pipedrive* · *Recherche web*\n\n/reset — Nouvelle conversation\n/status — État du bot\n/memoire — Ma mémoire persistante\n/oublier — Effacer ma mémoire\n/pipeline — Voir le pipeline Pipedrive\n/stats — Tableau de bord\n/sonnet — Mode puissant\n/haiku — Mode rapide \\(défaut\\)`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  bot.onText(/\/reset/, msg => {
    if (!isAllowed(msg)) return;
    chats.delete(msg.chat.id);
    scheduleHistSave();
    bot.sendMessage(msg.chat.id, '🔄 Nouvelle conversation. Je t\'écoute!');
  });

  bot.onText(/\/status/, msg => {
    if (!isAllowed(msg)) return;
    const h = getHistory(msg.chat.id);
    const uptime = Math.floor(process.uptime() / 60);
    const ghStatus = process.env.GITHUB_TOKEN ? '✅' : '⚠️';
    const dbStatus = dropboxToken ? '✅' : '❌';
    const pdStatus = PD_KEY ? '✅' : '❌';
    const memStatus = gistId ? `✅ Gist \`${gistId.substring(0, 8)}...\`` : '⚠️ /tmp';
    bot.sendMessage(msg.chat.id,
      `✅ *Kira opérationnelle*\nModèle: \`${currentModel}\`\nMessages: ${h.length} | Mémos: ${kiramem.facts.length}\nGitHub: ${ghStatus} | Dropbox: ${dbStatus} | Pipedrive: ${pdStatus}\nMémoire: ${memStatus} | Données: \`${DATA_DIR}\`\nUptime: ${uptime} min`,
      { parse_mode: 'Markdown' }
    );
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

  bot.onText(/\/memoire/, msg => {
    if (!isAllowed(msg)) return;
    if (!kiramem.facts.length) return bot.sendMessage(msg.chat.id, '🧠 Aucun fait mémorisé pour l\'instant.');
    const list = kiramem.facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
    bot.sendMessage(msg.chat.id, `🧠 *Ma mémoire persistante:*\n\n${list}`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/oublier/, msg => {
    if (!isAllowed(msg)) return;
    kiramem.facts = [];
    kiramem.updatedAt = new Date().toISOString();
    saveJSON(MEM_FILE, kiramem);
    saveMemoryToGist().catch(() => {});
    bot.sendMessage(msg.chat.id, '🗑️ Mémoire effacée (local + Gist).');
  });

  bot.onText(/\/sonnet/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-sonnet-4-6';
    bot.sendMessage(msg.chat.id, '🧠 Mode Sonnet activé — plus puissant, légèrement plus lent.');
  });

  bot.onText(/\/haiku/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-haiku-4-5';
    bot.sendMessage(msg.chat.id, '⚡ Mode Haiku activé — rapide et efficace.');
  });

  // ─── Messages texte ─────────────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    const text   = msg.text;
    if (!text || text.startsWith('/')) return;
    if (isDuplicate(msg.message_id)) return;

    log('IN', 'MSG', text.substring(0, 80));

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
      log('ERR', 'MSG', `${err.status || ''} ${err.message}`);
      if (err.status === 400) {
        chats.delete(chatId); scheduleHistSave();
        await bot.sendMessage(chatId, '⚠️ Conversation réinitialisée. Réessaie!');
      } else {
        await bot.sendMessage(chatId, '❌ Erreur temporaire. Réessaie dans quelques secondes.');
      }
    }
  });

  // ─── Reconnexion auto polling ────────────────────────────────────────────────
  let pollingErrors = 0;
  bot.on('polling_error', err => {
    log('ERR', 'POLL', `#${++pollingErrors}: ${err.message}`);
    if (pollingErrors >= 10) { log('WARN', 'POLL', 'Restart forcé...'); process.exit(1); }
  });
  bot.on('message', () => { pollingErrors = 0; });
}

// ─── Arrêt propre ─────────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveJSON(HIST_FILE, Object.fromEntries(chats));
  await saveMemoryToGist().catch(() => {});
  log('OK', 'BOOT', 'Arrêt propre');
  process.exit(0);
});

// ─── Health check Render ──────────────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`Kira OK — ${new Date().toISOString()}`);
}).listen(PORT);

// ─── Démarrage séquentiel — tout initialisé avant le 1er message ─────────────
async function main() {
  await loadDropboxStructure();
  await initGistId();
  await loadMemoryFromGist();

  registerHandlers();
  bot.startPolling({ interval: 1000, autoStart: true });

  log('OK', 'BOOT', `Kira démarrée [${currentModel}] — ${DATA_DIR} — mémos: ${kiramem.facts.length} — tools: ${TOOLS.length}`);
}

main().catch(err => {
  log('ERR', 'BOOT', `Erreur démarrage: ${err.message}`);
  process.exit(1);
});
