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

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }
if (!API_KEY)   { console.error('❌ ANTHROPIC_API_KEY manquant');  process.exit(1); }

// ─── Clients ──────────────────────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: API_KEY });
const bot    = new TelegramBot(BOT_TOKEN, { polling: { interval: 1000, autoStart: true } });
console.log(`🤖 Kira démarrée — ${new Date().toLocaleString('fr-CA')}`);

// ─── Personnalité Kira ────────────────────────────────────────────────────────
const SYSTEM = `Tu es Kira, l'assistante IA personnelle de Shawn Barrette.

Shawn est courtier immobilier RE/MAX Prestige à Rawdon, Québec.
Il parle québécois naturel — tu le comprends parfaitement et tu réponds comme lui.

Tu peux l'aider avec tout :
- Rédaction d'emails, textes, scripts
- Code, automatisation, tech
- Stratégie business, immobilier
- Recherches, analyses, idées
- Questions générales

Style : direct, concis, utile. Pas de flafla. Réponds comme un vrai humain compétent.
Langue : français québécois naturel.

Infos clés sur Shawn :
- Email : shawn@signaturesb.com | Tel : 514-927-1340
- Assistante : Julie (julie@signaturesb.com)
- Spécialités : terrains Lanaudière, maisons, construction neuve
- Partenaire ProFab : Jordan Brouillette 514-291-3018 (0$ comptant Desjardins)
- CRM : Pipedrive | Email masse : Brevo | Automation : Make.com`;

// ─── Historique par chat (max 50 messages) ────────────────────────────────────
const MAX_HIST = 50;
const chats    = new Map(); // chatId → Message[]

function history(chatId) {
  if (!chats.has(chatId)) chats.set(chatId, []);
  return chats.get(chatId);
}

function push(chatId, role, content) {
  const h = history(chatId);
  h.push({ role, content });
  if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);
}

// ─── Claude Haiku ─────────────────────────────────────────────────────────────
async function kira(chatId, msg) {
  push(chatId, 'user', msg);
  const res = await claude.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 2048,
    system:     SYSTEM,
    messages:   history(chatId),
  });
  const reply = res.content[0]?.text || '_(vide)_';
  push(chatId, 'assistant', reply);
  return reply;
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
    '👋 Salut Shawn\\! Je suis *Kira*, ton assistante IA 24/7\\.\n\nParle\\-moi de n\'importe quoi\\.\n\n/reset — Nouvelle conversation',
    { parse_mode: 'MarkdownV2' }
  )
);

bot.onText(/\/reset/, msg => {
  chats.delete(msg.chat.id);
  bot.sendMessage(msg.chat.id, '🔄 Nouvelle conversation. Je t\'écoute!');
});

// ─── Messages ─────────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text   = msg.text;

  if (ALLOWED_ID && msg.from.id !== ALLOWED_ID) return;
  if (!text || text.startsWith('/')) return;

  console.log(`[${new Date().toLocaleTimeString('fr-CA')}] ${text.substring(0, 80)}`);

  const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    const reply = await kira(chatId, text);
    clearInterval(typing);
    await send(chatId, reply);
  } catch (err) {
    clearInterval(typing);
    console.error('❌', err.message);
    // Reset si context trop long
    if (err.status === 400) {
      chats.delete(chatId);
      await bot.sendMessage(chatId, '⚠️ Conversation réinitialisée. Réessaie.');
    } else {
      await bot.sendMessage(chatId, `❌ Erreur temporaire. Réessaie dans quelques secondes.`);
    }
  }
});

// ─── Reconnexion auto sur erreur polling ──────────────────────────────────────
let pollingErrors = 0;
bot.on('polling_error', err => {
  console.error(`Polling error #${++pollingErrors}:`, err.message);
  if (pollingErrors >= 5) {
    console.log('🔄 Trop d\'erreurs polling — redémarrage dans 10s...');
    setTimeout(() => process.exit(1), 10000); // Render redémarre automatiquement
  }
});

bot.on('message', () => { pollingErrors = 0; }); // Reset compteur sur succès

// ─── Serveur HTTP — health check Render ───────────────────────────────────────
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end(`Kira OK — ${new Date().toISOString()}`);
}).listen(PORT);

console.log(`✅ Health check sur port ${PORT}`);

process.on('SIGTERM', () => { bot.stopPolling(); process.exit(0); });
