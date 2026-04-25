#!/usr/bin/env node
// sms-bridge.js — pont iMessage Mac → bot Render pour codes MFA Centris/Auth0
// Tourne en LaunchAgent 24/7. Polls chat.db chaque 5s, forward codes au bot.
//
// SETUP MAC (1 fois):
// 1. SMS Forwarding: iPhone → Settings → Messages → Text Message Forwarding → Mac ON
// 2. Full Disk Access: System Settings → Privacy → Full Disk Access → ajoute Terminal + Node
// 3. cp scripts/com.signaturesb.sms-bridge.plist ~/Library/LaunchAgents/
//    launchctl load ~/Library/LaunchAgents/com.signaturesb.sms-bridge.plist
//
// ENV VARS requis:
// - SMS_BRIDGE_WEBHOOK: URL bot (https://signaturesb-bot-s272.onrender.com/webhook/sms-bridge)
// - SMS_BRIDGE_SECRET: secret partagé pour HMAC auth (idem côté Render)
//
// Logs: ~/Documents/github/Claude, code Telegram/logs/sms-bridge.log
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const HOME = os.homedir();
const CHAT_DB = path.join(HOME, 'Library/Messages/chat.db');
const STATE_FILE = path.join(HOME, '.sms-bridge-state.json');
const LOG_FILE = path.join(HOME, 'Documents/github/Claude, code Telegram/logs/sms-bridge.log');

const WEBHOOK_URL = process.env.SMS_BRIDGE_WEBHOOK || 'https://signaturesb-bot-s272.onrender.com/webhook/sms-bridge';
const SECRET = process.env.SMS_BRIDGE_SECRET || '';
const POLL_INTERVAL_MS = parseInt(process.env.SMS_POLL_INTERVAL_MS || '5000');
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000; // 5 min

// Ensure logs dir exists
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); } catch {}

function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
  // Cap log file at 5MB (rotate)
  try {
    const stat = fs.statSync(LOG_FILE);
    if (stat.size > 5 * 1024 * 1024) {
      fs.renameSync(LOG_FILE, LOG_FILE + '.1');
    }
  } catch {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return { lastRowId: 0, processed: [], lastHeartbeat: 0 };
}

function saveState(state) {
  try {
    // Cap processed at 100 entries (FIFO)
    if (state.processed?.length > 100) state.processed = state.processed.slice(-100);
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  } catch (e) { log('WARN', `saveState: ${e.message}`); }
}

function queryDb(sql) {
  // Use macOS built-in sqlite3 CLI (no npm dep needed)
  // -separator '|' for parsing, -readonly for safety
  const out = execSync(`sqlite3 -separator '\\x1f' -readonly "${CHAT_DB}" "${sql.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8', timeout: 10000,
  });
  return out.trim().split('\n').filter(Boolean).map(line => line.split('\x1f'));
}

function isLikelyMFASms(text, sender) {
  if (!text) return false;
  // Doit contenir un code à 6 digits
  if (!/\b\d{6}\b/.test(text)) return false;
  // Patterns Centris/Auth0/MFA courants (cas-insensible)
  return /centris|matrix|auth0|verification|vérification|code|confirmation|connexion|sign[- ]?in|login|authent/i.test(text);
}

async function forwardCode(payload) {
  const body = JSON.stringify(payload);
  const sig = SECRET ? crypto.createHmac('sha256', SECRET).update(body).digest('hex') : '';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Signature': sig,
        'X-Bridge-Source': 'mac-imessage',
      },
      body,
    });
    clearTimeout(t);
    if (!res.ok) {
      log('WARN', `Bot responded ${res.status}: ${(await res.text()).substring(0, 100)}`);
      return false;
    }
    return true;
  } catch (e) {
    clearTimeout(t);
    log('ERR', `Forward failed: ${e.message}`);
    return false;
  }
}

let state = loadState();

async function poll() {
  try {
    if (!fs.existsSync(CHAT_DB)) {
      log('ERR', `chat.db not found at ${CHAT_DB} — Full Disk Access manquant?`);
      return;
    }
    const sql = `SELECT message.ROWID, COALESCE(message.text, ''), COALESCE(handle.id, ''),
                        datetime(message.date/1000000000 + 978307200, 'unixepoch', 'localtime')
                 FROM message
                 LEFT JOIN handle ON message.handle_id = handle.ROWID
                 WHERE message.ROWID > ${state.lastRowId} AND message.is_from_me = 0
                 ORDER BY message.ROWID LIMIT 50`;
    const rows = queryDb(sql);
    let maxRowId = state.lastRowId;
    let forwarded = 0;
    for (const row of rows) {
      const [rowId, text, sender, dateStr] = row;
      const id = parseInt(rowId);
      if (id > maxRowId) maxRowId = id;
      // Skip déjà traité (cas re-démarrage)
      if (state.processed?.includes(id)) continue;
      if (isLikelyMFASms(text, sender)) {
        const codeMatch = text.match(/\b(\d{6})\b/);
        const code = codeMatch[1];
        const masked = code.substring(0, 2) + '****';
        log('INFO', `MFA SMS détecté de ${sender || '?'}: code ${masked}`);
        const ok = await forwardCode({ code, sender, text: text.substring(0, 200), date: dateStr, rowId: id });
        if (ok) {
          forwarded++;
          state.processed = [...(state.processed || []), id];
        }
      }
    }
    if (maxRowId > state.lastRowId) {
      state.lastRowId = maxRowId;
      saveState(state);
    }
    if (forwarded > 0) log('OK', `${forwarded} code(s) forwardé(s) au bot`);
  } catch (e) {
    log('ERR', `poll: ${e.message}`);
  }
}

async function heartbeat() {
  try {
    const ok = await forwardCode({ heartbeat: true, ts: Date.now() });
    if (ok) {
      state.lastHeartbeat = Date.now();
      saveState(state);
    }
  } catch (e) { log('WARN', `heartbeat: ${e.message}`); }
}

// Main loop
log('OK', `🌉 SMS Bridge starting (poll every ${POLL_INTERVAL_MS/1000}s, webhook ${WEBHOOK_URL})`);
log('OK', `Last processed ROWID: ${state.lastRowId}`);

let lastHeartbeatAt = 0;
async function loop() {
  while (true) {
    await poll();
    if (Date.now() - lastHeartbeatAt > HEARTBEAT_INTERVAL_MS) {
      await heartbeat();
      lastHeartbeatAt = Date.now();
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Graceful shutdown
process.on('SIGTERM', () => { log('OK', 'SIGTERM — exit propre'); process.exit(0); });
process.on('SIGINT', () => { log('OK', 'SIGINT — exit propre'); process.exit(0); });
process.on('uncaughtException', (e) => { log('ERR', `uncaught: ${e.message}\n${e.stack}`); /* keep running */ });

loop().catch(e => { log('ERR', `loop crashed: ${e.message}`); process.exit(1); });
