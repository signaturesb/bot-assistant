'use strict';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic   = require('@anthropic-ai/sdk');
const http        = require('http');
const fs          = require('fs');
const path        = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID || '0');
const API_KEY    = process.env.ANTHROPIC_API_KEY;
const PORT       = process.env.PORT || 3000;
const MODEL      = process.env.MODEL || 'claude-haiku-4-5';

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }
if (!API_KEY)   { console.error('❌ ANTHROPIC_API_KEY manquant');  process.exit(1); }

// ─── Persistance ──────────────────────────────────────────────────────────────
const DATA_DIR    = fs.existsSync('/data') ? '/data' : '/tmp';
const HIST_FILE   = path.join(DATA_DIR, 'history.json');
const MEM_FILE    = path.join(DATA_DIR, 'memory.json');

function loadJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { console.warn(`⚠️ Impossible de lire ${file} — réinitialisation`); }
  return fallback;
}

function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data), 'utf8'); }
  catch (e) { console.error(`❌ Sauvegarde ${file}:`, e.message); }
}

// ─── Clients ──────────────────────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: API_KEY });
const bot    = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });
console.log(`✅ Kira démarrée [${MODEL}] — ${new Date().toLocaleString('fr-CA')} — données: ${DATA_DIR}`);

// ─── Mémoire persistante (faits durables sur Shawn) ───────────────────────────
const kiramem = loadJSON(MEM_FILE, { facts: [], updatedAt: null });

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

Si Shawn te dit quelque chose d'important à retenir (préférence, projet, info), confirme que tu l'as mis en mémoire et utilise la commande: [MEMO: le fait à retenir]`;

function getSystem() {
  return SYSTEM_BASE + buildMemoryBlock();
}

// ─── Historique (max 40 messages, persistant) ─────────────────────────────────
const MAX_HIST = 40;
const rawChats = loadJSON(HIST_FILE, {});
const chats    = new Map(Object.entries(rawChats));

// Nettoyer les vieux historiques (> 7 jours sans activité) au démarrage
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;
for (const [id, hist] of chats.entries()) {
  if (!Array.isArray(hist) || hist.length === 0) { chats.delete(id); }
}

let saveTimer = null;
function scheduleHistSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveJSON(HIST_FILE, Object.fromEntries(chats));
  }, 1000);
}

function getHistory(id)           { if (!chats.has(id)) chats.set(id, []); return chats.get(id); }
function addMsg(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);
  scheduleHistSave();
}

// ─── Déduplication (évite double-réponse si Telegram renvoie le même message) ─
const processed = new Set();
function isDuplicate(msgId) {
  if (processed.has(msgId)) return true;
  processed.add(msgId);
  if (processed.size > 500) {
    const first = processed.values().next().value;
    processed.delete(first);
  }
  return false;
}

// ─── Extraction de mémos dans la réponse Claude ───────────────────────────────
function extractMemos(text) {
  const memoRegex = /\[MEMO:\s*([^\]]+)\]/gi;
  const found = [];
  let cleaned = text;
  let match;
  while ((match = memoRegex.exec(text)) !== null) {
    found.push(match[1].trim());
  }
  if (found.length) {
    cleaned = text.replace(/\[MEMO:[^\]]+\]/gi, '').trim();
    kiramem.facts.push(...found);
    if (kiramem.facts.length > 50) kiramem.facts.splice(0, kiramem.facts.length - 50);
    kiramem.updatedAt = new Date().toISOString();
    saveJSON(MEM_FILE, kiramem);
  }
  return { cleaned, memos: found };
}

// ─── Retry Anthropic (429/529 = surcharge temporaire) ────────────────────────
async function callClaude(chatId, userMsg, retries = 3) {
  addMsg(chatId, 'user', userMsg);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await claude.messages.create({
        model:      MODEL,
        max_tokens: 2048,
        system:     getSystem(),
        messages:   getHistory(chatId),
      });
      const raw   = res.content[0]?.text || '_(vide)_';
      const { cleaned, memos } = extractMemos(raw);
      addMsg(chatId, 'assistant', cleaned);
      return { reply: cleaned, memos };
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

// ─── Commandes ────────────────────────────────────────────────────────────────
bot.onText(/\/start/, msg =>
  bot.sendMessage(msg.chat.id,
    `👋 Salut Shawn\\! Je suis *Kira*, ton assistante IA 24/7\\.\n\nParle\\-moi de n'importe quoi\\!\n\n/reset — Nouvelle conversation\n/status — État du bot\n/memoire — Ma mémoire persistante\n/oublier — Effacer ma mémoire\n/sonnet — Mode puissant \\(tâches complexes\\)\n/haiku — Mode rapide \\(défaut\\)`,
    { parse_mode: 'MarkdownV2' }
  )
);

bot.onText(/\/reset/, msg => {
  chats.delete(msg.chat.id);
  scheduleHistSave();
  bot.sendMessage(msg.chat.id, '🔄 Nouvelle conversation. Je t\'écoute!');
});

bot.onText(/\/status/, msg => {
  const h = getHistory(msg.chat.id);
  const uptime = Math.floor(process.uptime() / 60);
  bot.sendMessage(msg.chat.id,
    `✅ *Kira opérationnelle*\nModèle: \`${MODEL}\`\nMessages en mémoire: ${h.length}\nFaits mémorisés: ${kiramem.facts.length}\nDonnées: \`${DATA_DIR}\`\nUptime: ${uptime} min`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/memoire/, msg => {
  if (!kiramem.facts.length) {
    return bot.sendMessage(msg.chat.id, '🧠 Aucun fait mémorisé pour l\'instant.');
  }
  const list = kiramem.facts.map((f, i) => `${i + 1}. ${f}`).join('\n');
  bot.sendMessage(msg.chat.id, `🧠 *Ma mémoire persistante:*\n\n${list}`, { parse_mode: 'Markdown' });
});

bot.onText(/\/oublier/, msg => {
  kiramem.facts = [];
  kiramem.updatedAt = new Date().toISOString();
  saveJSON(MEM_FILE, kiramem);
  bot.sendMessage(msg.chat.id, '🗑️ Mémoire effacée. Je repars à zéro!');
});

bot.onText(/\/sonnet/, msg => {
  process.env.MODEL = 'claude-sonnet-4-6';
  bot.sendMessage(msg.chat.id, '🧠 Mode Sonnet activé — plus puissant, légèrement plus lent.');
});

bot.onText(/\/haiku/, msg => {
  process.env.MODEL = 'claude-haiku-4-5';
  bot.sendMessage(msg.chat.id, '⚡ Mode Haiku activé — rapide et efficace.');
});

// ─── Messages texte ───────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text;

  if (ALLOWED_ID && msg.from.id !== ALLOWED_ID) return;
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

// ─── Reconnexion auto polling ──────────────────────────────────────────────────
let pollingErrors = 0;
bot.on('polling_error', err => {
  console.error(`Polling #${++pollingErrors}:`, err.message);
  if (pollingErrors >= 10) {
    console.log('🔄 Restart forcé...');
    process.exit(1);
  }
});
bot.on('message', () => { pollingErrors = 0; });

// ─── Sauvegarde propre à l'arrêt ──────────────────────────────────────────────
process.on('SIGTERM', () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveJSON(HIST_FILE, Object.fromEntries(chats));
  console.log('💾 Historique sauvegardé — arrêt propre');
  process.exit(0);
});

// ─── Health check Render ──────────────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`Kira OK — ${new Date().toISOString()}`);
}).listen(PORT);
