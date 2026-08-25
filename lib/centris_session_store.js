'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENVELOPE_VERSION = 1;
const ALGORITHM = 'aes-256-gcm';

function deriveKey(secret) {
  const value = String(secret || '');
  return value ? crypto.createHash('sha256').update(value, 'utf8').digest() : null;
}

function sealPayload(payload, secret = process.env.CENTRIS_SESSION_KEY) {
  const key = deriveKey(secret);
  if (!key) throw new Error('CENTRIS_SESSION_KEY requis pour protéger la session Centris');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: ENVELOPE_VERSION,
    protected: true,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function openPayload(envelope, secret = process.env.CENTRIS_SESSION_KEY) {
  if (!envelope || envelope.protected !== true) return envelope;
  if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
    throw new Error('Format de session Centris protégé non supporté');
  }
  const key = deriveKey(secret);
  if (!key) throw new Error('CENTRIS_SESSION_KEY requis pour lire la session protégée');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

function writeSessionFile(file, payload, options = {}) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const envelope = sealPayload(payload, options.secret);
  fs.writeFileSync(tmp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
  return true;
}

function readSessionFile(file, options = {}) {
  if (!fs.existsSync(file)) return null;
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'));
  return openPayload(envelope, options.secret);
}

function removeSessionFile(file) {
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  readSessionFile,
  removeSessionFile,
  sealPayload,
  openPayload,
  writeSessionFile,
};
