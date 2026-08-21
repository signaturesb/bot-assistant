'use strict';

const EXPLICIT_SEND_RE = /^(envoie|envoie-le|send)[!.]?$/i;

function isExplicitEmailConfirmation(message) {
  return EXPLICIT_SEND_RE.test(String(message || '').trim());
}

function makeEmailFingerprint({ to, subject, body }) {
  const crypto = require('crypto');
  return crypto.createHash('sha256')
    .update(`${String(to || '').trim().toLowerCase()}\n${String(subject || '').trim()}\n${String(body || '')}`)
    .digest('hex');
}

function createOneShotAuthorization({ message, to, subject, body }) {
  if (!isExplicitEmailConfirmation(message)) {
    const err = new Error('Envoi email bloqué: confirmation explicite requise pour cet envoi précis');
    err.code = 'EMAIL_SEND_CONFIRM_REQUIRED';
    throw err;
  }
  return {
    fingerprint: makeEmailFingerprint({ to, subject, body }),
    used: false,
    createdAt: Date.now(),
  };
}

function consumeOneShotAuthorization(auth, email) {
  if (!auth || auth.used) {
    const err = new Error('Envoi email bloqué: autorisation absente ou déjà consommée');
    err.code = 'EMAIL_SEND_AUTH_INVALID';
    throw err;
  }
  const expected = makeEmailFingerprint(email);
  if (auth.fingerprint !== expected) {
    const err = new Error('Envoi email bloqué: le destinataire/sujet/contenu a changé depuis la confirmation');
    err.code = 'EMAIL_SEND_CONTENT_CHANGED';
    throw err;
  }
  auth.used = true;
  return true;
}

module.exports = {
  isExplicitEmailConfirmation,
  makeEmailFingerprint,
  createOneShotAuthorization,
  consumeOneShotAuthorization,
};
