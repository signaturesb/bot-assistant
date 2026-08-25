'use strict';

const crypto = require('crypto');
const EXPLICIT_SEND_RE = /^(envoie|envoie-le|send)[!.]?$/i;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function normalizeList(value) {
  const arr = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(arr.map(x => String(x || '').trim().toLowerCase()).filter(Boolean))].sort();
}

function normalizeAttachments(value) {
  const arr = Array.isArray(value) ? value : [];
  return arr.map((a, index) => ({
    name: String(a?.name || a?.filename || `attachment-${index}`),
    size: Number(a?.size || a?.length || 0),
    sha256: String(a?.sha256 || a?.hash || ''),
  })).sort((a, b) => `${a.name}:${a.sha256}:${a.size}`.localeCompare(`${b.name}:${b.sha256}:${b.size}`));
}

function canonicalEmailPayload(email = {}) {
  return {
    via: String(email.via || 'gmail').trim().toLowerCase(),
    to: normalizeList(email.to),
    cc: normalizeList(email.cc),
    bcc: normalizeList(email.bcc),
    subject: String(email.subject || '').trim(),
    body: String(email.body || ''),
    renderedHtmlSha256: String(email.renderedHtmlSha256 || ''),
    attachments: normalizeAttachments(email.attachments),
  };
}

function isExplicitEmailConfirmation(message) {
  return EXPLICIT_SEND_RE.test(String(message || '').trim());
}

function makeEmailFingerprint(email) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalEmailPayload(email)))
    .digest('hex');
}

function createOneShotAuthorization({ message, ttlMs = DEFAULT_TTL_MS, now = Date.now(), ...email }) {
  if (!isExplicitEmailConfirmation(message)) {
    const err = new Error('Envoi email bloqué: confirmation explicite requise pour cet envoi précis');
    err.code = 'EMAIL_SEND_CONFIRM_REQUIRED';
    throw err;
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > 15 * 60 * 1000) {
    const err = new Error('Envoi email bloqué: durée d’autorisation invalide');
    err.code = 'EMAIL_SEND_TTL_INVALID';
    throw err;
  }
  return {
    fingerprint: makeEmailFingerprint(email),
    used: false,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
}

function consumeOneShotAuthorization(auth, email, now = Date.now()) {
  if (!auth || auth.used) {
    const err = new Error('Envoi email bloqué: autorisation absente ou déjà consommée');
    err.code = 'EMAIL_SEND_AUTH_INVALID';
    throw err;
  }
  if (!Number.isFinite(auth.expiresAt) || now > auth.expiresAt) {
    auth.used = true;
    const err = new Error('Envoi email bloqué: autorisation expirée, nouvelle confirmation requise');
    err.code = 'EMAIL_SEND_AUTH_EXPIRED';
    throw err;
  }
  const expected = makeEmailFingerprint(email);
  if (auth.fingerprint !== expected) {
    const err = new Error('Envoi email bloqué: destinataire, contenu, canal ou pièce jointe modifié depuis la confirmation');
    err.code = 'EMAIL_SEND_CONTENT_CHANGED';
    throw err;
  }
  auth.used = true;
  return true;
}

module.exports = {
  DEFAULT_TTL_MS,
  canonicalEmailPayload,
  isExplicitEmailConfirmation,
  makeEmailFingerprint,
  createOneShotAuthorization,
  consumeOneShotAuthorization,
};
