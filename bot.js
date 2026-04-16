'use strict';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic   = require('@anthropic-ai/sdk');
const http        = require('http');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID || '0');
const API_KEY    = process.env.ANTHROPIC_API_KEY;
const PORT       = process.env.PORT || 3000;
const MODEL      = process.env.MODEL || 'claude-haiku-4-5';

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }
if (!API_KEY)   { console.error('❌ ANTHROPIC_API_KEY manquant');  process.exit(1); }

// ─── Clients ──────────────────────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: API_KEY });
const bot    = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });
console.log(`✅ Kira démarrée [${MODEL}] — ${new Date().toLocaleString('fr-CA')}`);

// ─── Personnalité ─────────────────────────────────────────────────────────────
const SYSTEM = `Tu es Kira, l'assistante IA personnelle de Shawn Barrette.

Shawn est courtier immobilier RE/MAX Prestige à Rawdon, Québec.
Il parle québécois naturel — tu le comprends parfaitement.

Tu l'aides avec tout : rédaction, code, stratégie, immobilier, tech, questions générales.
Style : direct, concis, utile. Pas de flafla. Réponds comme un humain compétent.
Langue : français québécois naturel.

Infos Shawn : shawn@signaturesb.com | 514-927-1340 | Assistante : Julie
Spécialités : terrains Lanaudière, maisons, construction neuve
Partenaire ProFab : Jordan Brouillette 514-291-3018 (0$ comptant Desjardins)`;

// ─── Historique (max 40 messages) ────────────────────────────────────────────
const MAX_HIST = 40;
const chats    = new Map();

function getHistory(id)           { if (!chats.has(id)) chats.set(id, []); return chats.get(id); }
function addMsg(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);
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

// ─── Retry Anthropic (429/529 = surcharge temporaire) ────────────────────────
async function callClaude(chatId, userMsg, retries = 3) {
  addMsg(chatId, 'user', userMsg);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await claude.messages.create({
        model:      MODEL,
        max_tokens: 2048,
        system:     SYSTEM,
        messages:   getHistory(chatId),
      });
      const reply = res.content[0]?.text || '_(vide)_';
      addMsg(chatId, 'assistant', reply);
      return reply;
    } catch (err) {
      const retryable = err.status === 429 || err.status === 529 || err.status >= 500;
      if (retryable && attempt < retries) {
        const wait = attempt * 3000; // 3s, 6s
        console.warn(`⚠️ Anthropic ${err.status} — retry ${attempt}/${retries} dans ${wait/1000}s`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        // Retirer le message user si échec total (évite historique corrompu)
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
    `👋 Salut Shawn\\! Je suis *Kira*, ton assistante IA 24/7\\.\n\nParle\\-moi de n'importe quoi\\!\n\n/reset — Nouvelle conversation\n/status — État du bot\n/sonnet — Mode puissant \\(tâches complexes\\)\n/haiku — Mode rapide \\(défaut\\)`,
    { parse_mode: 'MarkdownV2' }
  )
);

bot.onText(/\/reset/, msg => {
  chats.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '🔄 Nouvelle conversation. Je t\'écoute!');
});

bot.onText(/\/status/, msg => {
  const h = getHistory(msg.chat.id);
  const uptime = Math.floor(process.uptime() / 60);
  bot.sendMessage(msg.chat.id,
    `✅ *Kira opérationnelle*\nModèle: \`${MODEL}\`\nMessages en mémoire: ${h.length}\nUptime: ${uptime} min`,
    { parse_mode: 'Markdown' }
  );
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
  if (isDuplicate(msg.message_id)) return; // Anti-doublon

  console.log(`[${new Date().toLocaleTimeString('fr-CA')}] ${text.substring(0, 80)}`);

  const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    const reply = await callClaude(chatId, text);
    clearInterval(typing);
    await send(chatId, reply);
  } catch (err) {
    clearInterval(typing);
    console.error('❌', err.status || '', err.message);
    if (err.status === 400) {
      chats.delete(chatId);
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
    process.exit(1); // Render redémarre automatiquement
  }
});
bot.on('message', () => { pollingErrors = 0; });

// ─── Health check Render ──────────────────────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200);
  res.end(`Kira OK — ${new Date().toISOString()}`);
}).listen(PORT);
