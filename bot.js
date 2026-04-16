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
let   currentModel = process.env.MODEL || 'claude-haiku-4-5'; // FIX: let pas const — /sonnet /haiku fonctionnent

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }
if (!API_KEY)   { console.error('❌ ANTHROPIC_API_KEY manquant');  process.exit(1); }

// ─── Persistance locale ────────────────────────────────────────────────────────
const DATA_DIR     = fs.existsSync('/data') ? '/data' : '/tmp';
const HIST_FILE    = path.join(DATA_DIR, 'history.json');
const MEM_FILE     = path.join(DATA_DIR, 'memory.json');
const GIST_ID_FILE = path.join(DATA_DIR, 'gist_id.txt');

function loadJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { console.warn(`⚠️ Impossible de lire ${file} — réinitialisation`); }
  return fallback;
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data), 'utf8'); }
  catch (e) { console.error(`❌ Sauvegarde ${file}:`, e.message); }
}

// ─── Clients ──────────────────────────────────────────────────────────────────
// FIX: polling: false — démarré seulement après que tout est initialisé
const claude = new Anthropic({ apiKey: API_KEY });
const bot    = new TelegramBot(BOT_TOKEN, { polling: false });

// ─── Mémoire persistante (faits durables) ─────────────────────────────────────
const kiramem = loadJSON(MEM_FILE, { facts: [], updatedAt: null });
if (!Array.isArray(kiramem.facts)) kiramem.facts = []; // FIX: guard si JSON corrompu

function buildMemoryBlock() {
  if (!kiramem.facts.length) return '';
  return `\n\n📝 Mémoire persistante (rappels de conversations passées):\n${kiramem.facts.map(f => `- ${f}`).join('\n')}`;
}

// ─── Personnalité ─────────────────────────────────────────────────────────────
const SYSTEM_BASE = `Tu es Kira, l'assistante IA personnelle de Shawn Barrette.

Shawn est courtier immobilier RE/MAX Prestige à Rawdon, Québec.
Il parle québécois naturel — tu le comprends parfaitement.

Tu l'aides avec tout : rédaction, code, stratégie, immobilier, tech, questions générales.
Style : direct, concis, utile. Pas de flafla. Réponds comme un humain compétent.
Langue : français québécois naturel.

Infos Shawn : shawn@signaturesb.com | 514-927-1340 | Assistante : Julie
Spécialités : terrains Lanaudière, maisons, construction neuve
Partenaire ProFab : Jordan Brouillette 514-291-3018 (0$ comptant Desjardins)

Accès aux ressources de Shawn via tes outils:
- GitHub (signaturesb): repos de code, scripts d'automatisation
- Dropbox: documents de propriétés, terrains, fichiers clients

Si Shawn te dit quelque chose d'important à retenir (préférence, projet, info), confirme et utilise: [MEMO: le fait à retenir]`;

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
  if (!process.env.GITHUB_TOKEN) return 'Erreur: GITHUB_TOKEN manquant — accès écriture impossible';
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
    console.log('🔄 Dropbox token rafraîchi');
    return true;
  } catch { return false; }
}

async function dropboxAPI(apiUrl, body, isDownload = false) {
  // FIX: ne pas appeler avec token vide — rafraîchit d'abord
  if (!dropboxToken) {
    const ok = await refreshDropboxToken();
    if (!ok) return null;
  }

  const makeReq = (token) => {
    if (isDownload) {
      return fetch(apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify(body) }
      });
    }
    return fetch(apiUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  };

  let res = await makeReq(dropboxToken);
  if (res.status === 401) {
    const ok = await refreshDropboxToken();
    if (!ok) return null;
    res = await makeReq(dropboxToken);
  }
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
    console.log(`📦 Dropbox chargé: ${data.entries.length} éléments`);
  } catch (e) { console.warn('⚠️ Dropbox structure:', e.message); }
}

// ─── Mémoire GitHub Gist (persistance cross-restart) ─────────────────────────
let gistId = process.env.GIST_ID || null;

async function initGistId() {
  if (gistId) { console.log(`🧠 Gist configuré: ${gistId}`); return; }

  // GIST_ID_FILE est dans /tmp (éphémère) mais utile si pas encore redémarré
  if (fs.existsSync(GIST_ID_FILE)) {
    gistId = fs.readFileSync(GIST_ID_FILE, 'utf8').trim();
    console.log(`🧠 Gist chargé depuis fichier local: ${gistId}`);
    return;
  }

  if (!process.env.GITHUB_TOKEN) {
    console.warn('⚠️ Mémoire: GITHUB_TOKEN manquant — persistance locale /tmp seulement');
    return;
  }

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
      // FIX: messages d'erreur utiles selon le code HTTP
      if (res.status === 403 || res.status === 422) {
        console.warn('⚠️ Gist: token GitHub sans scope "gist" — va dans GitHub Settings > Tokens et ajoute le scope gist');
      } else {
        const body = await res.text();
        console.warn(`⚠️ Gist create: HTTP ${res.status} — ${body.substring(0, 200)}`);
      }
      return;
    }

    const data = await res.json();
    gistId = data.id;
    try { fs.writeFileSync(GIST_ID_FILE, gistId, 'utf8'); } catch {}
    console.log(`✅ Gist créé: ${gistId}`);

    // FIX: notifier via Telegram directement (pas juste les logs Render)
    if (ALLOWED_ID) {
      bot.sendMessage(ALLOWED_ID,
        `🔑 *Gist mémoire créé\\!*\n\nAjoute cette variable dans Render:\n\`GIST\\_ID=${gistId}\`\n\n_Sans ça, la mémoire repart à zéro à chaque redémarrage_`,
        { parse_mode: 'MarkdownV2' }
      ).catch(() => {});
    }
  } catch (e) { console.warn('⚠️ Gist create:', e.message); }
}

async function loadMemoryFromGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers: githubHeaders() });
    if (!res.ok) { console.warn(`⚠️ Gist load: HTTP ${res.status}`); return; }
    const data = await res.json();
    const content = data.files?.['memory.json']?.content;
    if (!content) return;
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.facts) && parsed.facts.length > 0) {
      kiramem.facts = parsed.facts;
      kiramem.updatedAt = parsed.updatedAt;
      saveJSON(MEM_FILE, kiramem);
      console.log(`🧠 Mémoire Gist: ${kiramem.facts.length} faits chargés`);
    }
  } catch (e) { console.warn('⚠️ Gist load:', e.message); }
}

async function saveMemoryToGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { 'memory.json': { content: JSON.stringify(kiramem, null, 2) } } })
    });
    if (!res.ok) console.warn(`⚠️ Gist save: HTTP ${res.status}`);
  } catch (e) { console.warn('⚠️ Gist save:', e.message); }
}

// ─── Outils Claude ────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'list_github_repos',
    description: 'Liste tous les repos GitHub de Shawn (signaturesb)',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'list_github_files',
    description: 'Liste les fichiers dans un dossier d\'un repo GitHub de Shawn',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Nom du repo (ex: kira-bot)' },
        path: { type: 'string', description: 'Sous-dossier à lister (vide = racine)' }
      },
      required: ['repo']
    }
  },
  {
    name: 'read_github_file',
    description: 'Lit le contenu d\'un fichier dans un repo GitHub de Shawn',
    input_schema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Nom du repo (ex: kira-bot)' },
        path: { type: 'string', description: 'Chemin du fichier (ex: bot.js, src/templates.js)' }
      },
      required: ['repo', 'path']
    }
  },
  {
    name: 'list_dropbox_folder',
    description: 'Liste les fichiers dans un dossier Dropbox de Shawn (documents propriétés, terrains, etc.)',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin Dropbox (ex: "Terrain en ligne" ou "" pour la racine)' }
      },
      required: ['path']
    }
  },
  {
    name: 'read_dropbox_file',
    description: 'Lit un fichier texte depuis le Dropbox de Shawn',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin complet du fichier (ex: /Terrain en ligne/rawdon.txt)' }
      },
      required: ['path']
    }
  },
  {
    name: 'send_dropbox_file',
    description: 'Télécharge un fichier (PDF, image, etc.) depuis Dropbox et l\'envoie directement à Shawn par Telegram',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Chemin complet du fichier Dropbox (ex: /Terrain en ligne/fiche-rawdon.pdf)' },
        caption: { type: 'string', description: 'Message à joindre au fichier (optionnel)' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_github_file',
    description: 'Modifie ou crée un fichier dans un repo GitHub de Shawn et fait un commit. Utilise ça pour corriger du code, ajuster des templates, modifier des campagnes dans mailing-masse, chatbot-immobilier, etc.',
    input_schema: {
      type: 'object',
      properties: {
        repo:       { type: 'string', description: 'Nom du repo (ex: mailing-masse, chatbot-immobilier)' },
        path:       { type: 'string', description: 'Chemin du fichier (ex: src/templates.js)' },
        content:    { type: 'string', description: 'Contenu complet du fichier après modification' },
        commit_msg: { type: 'string', description: 'Message de commit (ex: "Fix: corriger template J+1")' }
      },
      required: ['repo', 'path', 'content']
    }
  },
  {
    name: 'read_bot_file',
    description: 'Lit un fichier de configuration ou de code du bot assistant de Shawn stocké dans /data/botfiles/',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Nom du fichier dans /data/botfiles/ (ex: campaigns_library.js)' }
      },
      required: ['filename']
    }
  },
  {
    name: 'write_bot_file',
    description: 'Modifie ou crée un fichier de configuration du bot assistant dans /data/botfiles/',
    input_schema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Nom du fichier (ex: campaigns_library.js)' },
        content: { type: 'string', description: 'Contenu complet du fichier' }
      },
      required: ['filename', 'content']
    }
  }
];

async function executeTool(name, input, chatId) {
  try {
    switch (name) {
      case 'list_github_repos':   return await listGitHubRepos();
      case 'list_github_files':   return await listGitHubFiles(input.repo, input.path || '');
      case 'read_github_file':    return await readGitHubFile(input.repo, input.path);
      case 'list_dropbox_folder': return await listDropboxFolder(input.path);
      case 'read_dropbox_file':   return await readDropboxFile(input.path);
      case 'send_dropbox_file': {
        const file = await downloadDropboxFile(input.path);
        if (!file) return `Erreur: impossible de télécharger ${input.path}`;
        await bot.sendDocument(chatId, file.buffer, { caption: input.caption || '' }, { filename: file.filename });
        return `✅ Fichier "${file.filename}" envoyé à Shawn.`;
      }
      case 'write_github_file': return await writeGitHubFile(input.repo, input.path, input.content, input.commit_msg);
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
        const fp = path.join(dir, path.basename(input.filename));
        fs.writeFileSync(fp, input.content, 'utf8');
        return `✅ Fichier "${input.filename}" sauvegardé (${input.content.length} chars).`;
      }
      default: return `Outil inconnu: ${name}`;
    }
  } catch (err) {
    return `Erreur outil ${name}: ${err.message}`;
  }
}

// ─── Appel Claude (boucle agentique avec outils) ──────────────────────────────
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
          model: currentModel, max_tokens: 4096, // FIX: currentModel (let)
          system: getSystem(), tools: TOOLS, messages,
        });

        if (res.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: res.content });
          const toolBlocks = res.content.filter(b => b.type === 'tool_use');
          const results = await Promise.all(toolBlocks.map(async b => {
            console.log(`🔧 ${b.name}(${JSON.stringify(b.input).substring(0, 100)})`);
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
        console.warn(`⚠️ Boucle agentique: 8 rounds sans réponse finale (chatId: ${chatId})`);
        finalReply = '_(délai dépassé — réessaie)_';
      }
      addMsg(chatId, 'assistant', finalReply);
      return { reply: finalReply, memos: allMemos };

    } catch (err) {
      const retryable = err.status === 429 || err.status === 529 || err.status >= 500;
      if (retryable && attempt < retries) {
        const wait = attempt * 3000;
        console.warn(`⚠️ Anthropic ${err.status} — retry ${attempt}/${retries} dans ${wait/1000}s`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        const h = getHistory(chatId);
        if (h[h.length - 1]?.role === 'user') h.pop();
        throw err;
      }
    }
  }
}

// ─── Envoyer (découpe si > 4000 chars) ───────────────────────────────────────
async function send(chatId, text) {
  const MAX = 4000;
  for (let i = 0; i < text.length; i += MAX) {
    const chunk = text.slice(i, i + MAX);
    try { await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' }); }
    catch { await bot.sendMessage(chatId, chunk); }
  }
}

// ─── Guard: seul Shawn peut utiliser le bot ───────────────────────────────────
function isAllowed(msg) {
  if (!msg.from) return false; // FIX: guard msg.from undefined (messages de canaux, etc.)
  return !ALLOWED_ID || msg.from.id === ALLOWED_ID;
}

// ─── Enregistrement des handlers (appelé après init) ─────────────────────────
function registerHandlers() {

  // FIX: isAllowed() sur toutes les commandes, pas seulement les messages texte
  bot.onText(/\/start/, msg => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(msg.chat.id,
      `👋 Salut Shawn\\! Je suis *Kira*, ton assistante IA 24/7\\.\n\nJ'ai accès à ton *GitHub* et ton *Dropbox* — demande\\-moi n'importe quoi\\!\n\n/reset — Nouvelle conversation\n/status — État du bot\n/memoire — Ma mémoire persistante\n/oublier — Effacer ma mémoire\n/sonnet — Mode puissant\n/haiku — Mode rapide \\(défaut\\)`,
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
    const ghStatus = process.env.GITHUB_TOKEN ? '✅ Avec token' : '⚠️ Sans token';
    const dbStatus = dropboxToken ? '✅ Connecté' : '❌ Token manquant';
    const memStatus = gistId ? `✅ Gist \`${gistId.substring(0, 8)}...\`` : '⚠️ /tmp seulement';
    bot.sendMessage(msg.chat.id,
      `✅ *Kira opérationnelle*\nModèle: \`${currentModel}\`\nMessages: ${h.length} | Mémos: ${kiramem.facts.length}\nGitHub: ${ghStatus}\nDropbox: ${dbStatus}\nMémoire: ${memStatus}\nDonnées: \`${DATA_DIR}\`\nUptime: ${uptime} min`,
      { parse_mode: 'Markdown' }
    );
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
    bot.sendMessage(msg.chat.id, '🗑️ Mémoire effacée (local + Gist). Je repars à zéro!');
  });

  bot.onText(/\/sonnet/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-sonnet-4-6'; // FIX: modifie currentModel (let), pas process.env
    bot.sendMessage(msg.chat.id, '🧠 Mode Sonnet activé — plus puissant, légèrement plus lent.');
  });

  bot.onText(/\/haiku/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-haiku-4-5'; // FIX: modifie currentModel (let), pas process.env
    bot.sendMessage(msg.chat.id, '⚡ Mode Haiku activé — rapide et efficace.');
  });

  // ─── Messages texte ─────────────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    const text   = msg.text;
    if (!text || text.startsWith('/')) return;
    if (isDuplicate(msg.message_id)) return;

    console.log(`[${new Date().toLocaleTimeString('fr-CA')}] ${text.substring(0, 80)}`);

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
      console.error('❌', err.status || '', err.message);
      if (err.status === 400) {
        chats.delete(chatId);
        scheduleHistSave();
        await bot.sendMessage(chatId, '⚠️ Conversation réinitialisée. Réessaie!');
      } else {
        await bot.sendMessage(chatId, '❌ Erreur temporaire. Réessaie dans quelques secondes.');
      }
    }
  });

  // ─── Reconnexion auto polling ────────────────────────────────────────────────
  let pollingErrors = 0;
  bot.on('polling_error', err => {
    console.error(`Polling #${++pollingErrors}:`, err.message);
    if (pollingErrors >= 10) { console.log('🔄 Restart forcé...'); process.exit(1); }
  });
  bot.on('message', () => { pollingErrors = 0; });
}

// ─── Arrêt propre ─────────────────────────────────────────────────────────────
// FIX: sauvegarde vers Gist avant arrêt (était manquant)
process.on('SIGTERM', async () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveJSON(HIST_FILE, Object.fromEntries(chats));
  await saveMemoryToGist().catch(() => {});
  console.log('💾 Sauvegardé — arrêt propre');
  process.exit(0);
});

// ─── Health check Render ──────────────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`Kira OK — ${new Date().toISOString()}`);
}).listen(PORT);

// ─── Démarrage séquentiel ─────────────────────────────────────────────────────
// FIX: tout est initialisé (Dropbox + Gist + mémoire) AVANT le premier message
async function main() {
  await loadDropboxStructure();
  await initGistId();
  await loadMemoryFromGist();

  registerHandlers();
  bot.startPolling({ interval: 1000, autoStart: true });

  console.log(`✅ Kira démarrée [${currentModel}] — ${new Date().toLocaleString('fr-CA')} — données: ${DATA_DIR} — mémos: ${kiramem.facts.length}`);
}

main().catch(err => {
  console.error('❌ Erreur démarrage:', err);
  process.exit(1);
});
