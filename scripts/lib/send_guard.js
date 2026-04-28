// send_guard.js — Système anti-envoi-sans-consent à 4 couches
//
// USAGE OBLIGATOIRE pour TOUT envoi email vers un destinataire non-Shawn.
// Aucun bypass possible sans token de consentement valide.
//
// Layers:
//   1. Whitelist hardcoded (Shawn emails = test, pas de friction)
//   2. Token random 6-chars + Telegram poll (production)
//   3. Dédup 24h par (email+context)
//   4. Audit log persistant + alerte si comportement suspect

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── CONSTANTS — HARDCODED, ne pas modifier sauf accord Shawn ───────────
const SHAWN_EMAILS = [
  'shawn@signaturesb.com',
  'shawnbarrette@icloud.com',
  'shawnbarrette@gmail.com',
  'shawnbarrette@hotmail.com',
];

const APPROVED_DIR = '/tmp/centris_approved_sends';
const AUDIT_LOG = '/tmp/centris_sends_audit.jsonl';
const DEDUP_WINDOW_MS = 24 * 3600 * 1000;
const SUSPICIOUS_THRESHOLD = 3; // 3 envois même email en 1h = alerte
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 min pour confirmer
const TG_POLL_INTERVAL_MS = 3000;

fs.mkdirSync(APPROVED_DIR, { recursive: true });

// ─── Layer 0 — Whitelist check ──────────────────────────────────────────
function isShawnEmail(email) {
  return SHAWN_EMAILS.includes(String(email).toLowerCase().trim());
}

// ─── Layer 4 — Audit log ────────────────────────────────────────────────
function appendAudit(entry) {
  try {
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

function readAudit() {
  try {
    return fs.readFileSync(AUDIT_LOG, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

// ─── Layer 3 — Dédup 24h ────────────────────────────────────────────────
function isDuplicate(email, mls) {
  const log = readAudit();
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  return log.some(e =>
    e.email === email.toLowerCase() &&
    e.mls === String(mls) &&
    e.success === true &&
    new Date(e.ts).getTime() > cutoff
  );
}

// ─── Layer 4b — Détection comportement suspect ──────────────────────────
function checkSuspicious(email) {
  const oneHourAgo = Date.now() - 3600000;
  const log = readAudit();
  const recentSendsToEmail = log.filter(e =>
    e.email === email.toLowerCase() && new Date(e.ts).getTime() > oneHourAgo
  ).length;
  return recentSendsToEmail >= SUSPICIOUS_THRESHOLD;
}

// ─── Token de consentement ──────────────────────────────────────────────
function generateConsentCode() {
  // 6 chars alphanumériques majuscules — random crypto-grade
  return crypto.randomBytes(4).toString('base64').replace(/[+/=]/g, '').substring(0, 6).toUpperCase();
}

function tokenPath(code) {
  return path.join(APPROVED_DIR, `${code}.token`);
}

function createToken(code, payload) {
  const tokenData = {
    code,
    createdAt: Date.now(),
    expiresAt: Date.now() + TOKEN_TTL_MS,
    used: false,
    ...payload,
  };
  fs.writeFileSync(tokenPath(code), JSON.stringify(tokenData, null, 2));
  return tokenData;
}

function consumeToken(code) {
  const p = tokenPath(code);
  if (!fs.existsSync(p)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (data.used) return null;
    if (Date.now() > data.expiresAt) {
      fs.unlinkSync(p);
      return null;
    }
    // Mark used + delete file (one-time use)
    fs.unlinkSync(p);
    return data;
  } catch { return null; }
}

// ─── Telegram helpers ───────────────────────────────────────────────────
async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' })
    });
    if (!r.ok) {
      // Fallback sans Markdown
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.replace(/[*_`]/g, '') })
      });
    }
    return true;
  } catch { return false; }
}

async function pollForCode(token, chatId, expectedCode, timeoutMs) {
  if (!token || !chatId) return false;
  // Get latest update id baseline
  let lastUpdateId = 0;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=1&offset=-1`);
    const d = await r.json();
    lastUpdateId = d.result?.[0]?.update_id || 0;
  } catch {}

  const start = Date.now();
  const expected = expectedCode.toUpperCase().trim();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=3`);
      const d = await r.json();
      for (const upd of (d.result || [])) {
        lastUpdateId = upd.update_id;
        const text = (upd.message?.text || '').trim().toUpperCase();
        // Match exact code OU "annule" / "non" / "cancel" pour annuler
        if (text === expected) return 'confirmed';
        if (/^(ANNULE|ANNULER|NON|CANCEL|🚫|❌)/i.test(text)) return 'cancelled';
      }
    } catch {}
    await new Promise(r => setTimeout(r, TG_POLL_INTERVAL_MS));
  }
  return 'timeout';
}

// ─── API publique — fonction principale ─────────────────────────────────
/**
 * Demande consentement Shawn pour un envoi.
 *
 * @param {Object} opts
 * @param {string} opts.email - email destinataire
 * @param {string} opts.mls - identifiant unique (ex: numéro Centris)
 * @param {string} opts.subject - subject de l'email
 * @param {Array<{name, content}>} opts.attachments - PDFs (pour preview)
 * @param {string} opts.htmlBody - HTML du body (pour preview)
 * @param {string} opts.brevoKey - Brevo API key (pour envoi preview)
 * @param {string} opts.tgToken - Telegram bot token
 * @param {string} opts.tgChat - Telegram chat ID (Shawn)
 * @param {Object} [opts.flags] - { forceResend: bool }
 * @returns {Promise<{approved: boolean, mode: string, code?: string, reason?: string}>}
 */
async function requestConsent(opts) {
  const { email, mls, subject, attachments, htmlBody, brevoKey, tgToken, tgChat, flags = {} } = opts;
  const emailLower = String(email).toLowerCase().trim();

  // ─── Layer 1 — Whitelist ──────────────────────────────────────────────
  if (isShawnEmail(emailLower)) {
    return { approved: true, mode: 'whitelist_test', email: emailLower };
  }

  // ─── Layer 3 — Dédup ──────────────────────────────────────────────────
  if (!flags.forceResend && isDuplicate(emailLower, mls)) {
    appendAudit({ email: emailLower, mls, action: 'blocked_duplicate', success: false });
    return { approved: false, mode: 'blocked', reason: 'duplicate_24h' };
  }

  // ─── Layer 4b — Comportement suspect ──────────────────────────────────
  if (checkSuspicious(emailLower)) {
    await sendTelegram(tgToken, tgChat,
      `🚨 *COMPORTEMENT SUSPECT BLOQUÉ*\n\n3+ envois à \`${emailLower}\` dans la dernière heure.\nEnvoi BLOQUÉ par sécurité.\nPour override: rerun avec --force-resend après vérification manuelle.`);
    appendAudit({ email: emailLower, mls, action: 'blocked_suspicious', success: false });
    return { approved: false, mode: 'blocked', reason: 'suspicious_activity' };
  }

  // ─── Layer 2 — Generate code + envoi preview + poll ───────────────────
  const code = generateConsentCode();
  const totalKB = (attachments || []).reduce((s, a) => s + Buffer.byteLength(a.content, 'base64'), 0) / 1024;

  // 2a. Envoi PREVIEW à Shawn avec le code dans le subject
  console.log(`\n🔐 *Système de confirmation activé*`);
  console.log(`   Code: ${code}`);
  console.log(`   Destinataire: ${emailLower}`);
  console.log();

  if (brevoKey) {
    try {
      // Inject warning + code dans htmlBody
      const previewHtml = `
        <div style="background:#aa0721;color:#fff;padding:20px;font-family:sans-serif;text-align:center;font-size:16px;">
          ⚠️ APERÇU — destinataire FINAL: <strong>${emailLower}</strong><br/>
          Code de confirmation: <strong style="font-size:24px;letter-spacing:4px;">${code}</strong><br/>
          Réponds ce code dans Telegram pour autoriser l'envoi.
        </div>
        ${htmlBody}`;
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Bot Preview', email: 'shawn@signaturesb.com' },
          to: [{ email: 'shawn@signaturesb.com' }],
          subject: `[APERÇU ${code}] ${subject} → ${emailLower}`,
          htmlContent: previewHtml,
          attachment: attachments,
        })
      });
      console.log('  📬 Preview envoyé à shawn@signaturesb.com');
    } catch (e) { console.log('  ⚠️ Preview email err: ' + e.message); }
  }

  // 2b. Telegram avec le code
  const tgMsg =
    `🔐 *Demande d'autorisation envoi*\n\n` +
    `📨 Destinataire: \`${emailLower}\`\n` +
    `📋 ${subject}\n` +
    `📎 ${(attachments || []).length} fichier(s) · ${totalKB.toFixed(0)} KB\n` +
    `🆔 MLS/ID: ${mls}\n\n` +
    `📬 *Aperçu envoyé à ton inbox shawn@signaturesb.com*\n\n` +
    `*Pour AUTORISER:* réponds le code\n\n` +
    `\`${code}\`\n\n` +
    `*Pour annuler:* réponds "annule"\n\n` +
    `_Timeout 10 min sans réponse = annulé par défaut_`;
  await sendTelegram(tgToken, tgChat, tgMsg);

  // 2c. Crée token (sera consommé après confirmation)
  createToken(code, { email: emailLower, mls, subject });

  // 2d. Poll Telegram for code reply
  console.log(`⏳ Attente confirmation Telegram (10 min)...`);
  console.log(`   Code attendu: ${code}`);
  const result = await pollForCode(tgToken, tgChat, code, TOKEN_TTL_MS);

  if (result === 'confirmed') {
    const token = consumeToken(code);
    if (!token) {
      // Token consommé déjà ou expiré — sécurité
      appendAudit({ email: emailLower, mls, action: 'token_invalid', success: false });
      return { approved: false, mode: 'blocked', reason: 'token_invalid_or_consumed' };
    }
    appendAudit({ email: emailLower, mls, action: 'consent_granted', code, success: true });
    return { approved: true, mode: 'consent', code, email: emailLower };
  }

  if (result === 'cancelled') {
    fs.unlinkSync(tokenPath(code));
    appendAudit({ email: emailLower, mls, action: 'cancelled_by_shawn', success: false });
    await sendTelegram(tgToken, tgChat, `🚫 Envoi à \`${emailLower}\` ANNULÉ`);
    return { approved: false, mode: 'cancelled', reason: 'cancelled_by_shawn' };
  }

  // Timeout
  if (fs.existsSync(tokenPath(code))) fs.unlinkSync(tokenPath(code));
  appendAudit({ email: emailLower, mls, action: 'timeout', success: false });
  await sendTelegram(tgToken, tgChat, `⏰ Pas de confirmation reçue → envoi à \`${emailLower}\` annulé par sécurité`);
  return { approved: false, mode: 'timeout', reason: 'no_confirmation_in_10min' };
}

/**
 * Marque l'envoi comme effectué dans l'audit log.
 */
function recordSend({ email, mls, subject, success, code }) {
  appendAudit({
    email: String(email).toLowerCase(),
    mls: String(mls),
    subject,
    success: !!success,
    code,
    action: success ? 'sent' : 'send_failed',
  });
}

module.exports = {
  isShawnEmail,
  isDuplicate,
  requestConsent,
  recordSend,
  SHAWN_EMAILS,
  AUDIT_LOG,
};
