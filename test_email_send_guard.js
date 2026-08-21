'use strict';

const fs = require('fs');
const assert = require('assert');
const {
  isExplicitEmailConfirmation,
  createOneShotAuthorization,
  consumeOneShotAuthorization,
} = require('./lib/email_send_guard');

assert.strictEqual(isExplicitEmailConfirmation('envoie'), true);
assert.strictEqual(isExplicitEmailConfirmation('envoie-le'), true);
assert.strictEqual(isExplicitEmailConfirmation('send'), true);
for (const vague of ['ok', 'oui', 'parfait', 'go', 'ça marche', "d'accord", "c'est bon"]) {
  assert.strictEqual(isExplicitEmailConfirmation(vague), false, `${vague} must never authorize an email`);
}

const base = {
  via: 'gmail',
  to: 'client@example.com',
  cc: ['shawn@example.com'],
  bcc: [],
  subject: 'Sujet',
  body: 'Bonjour',
  attachments: [{ name: 'fiche.pdf', size: 1234, sha256: 'abc123' }],
};

const auth = createOneShotAuthorization({ message: 'envoie', ...base, now: 1000, ttlMs: 300000 });
assert.doesNotThrow(() => consumeOneShotAuthorization(auth, base, 2000));
assert.throws(() => consumeOneShotAuthorization(auth, base, 2001), e => e && e.code === 'EMAIL_SEND_AUTH_INVALID');

for (const changed of [
  { ...base, to: 'autre@example.com' },
  { ...base, cc: ['autre@example.com'] },
  { ...base, bcc: ['audit@example.com'] },
  { ...base, subject: 'Autre sujet' },
  { ...base, body: 'Contenu changé' },
  { ...base, via: 'brevo' },
  { ...base, attachments: [{ name: 'fiche.pdf', size: 1234, sha256: 'different' }] },
]) {
  const a = createOneShotAuthorization({ message: 'send', ...base, now: 1000, ttlMs: 300000 });
  assert.throws(() => consumeOneShotAuthorization(a, changed, 2000), e => e && e.code === 'EMAIL_SEND_CONTENT_CHANGED');
}

const expired = createOneShotAuthorization({ message: 'envoie', ...base, now: 1000, ttlMs: 1000 });
assert.throws(() => consumeOneShotAuthorization(expired, base, 2001), e => e && e.code === 'EMAIL_SEND_AUTH_EXPIRED');
assert.throws(() => consumeOneShotAuthorization(expired, base, 2002), e => e && e.code === 'EMAIL_SEND_AUTH_INVALID');

assert.throws(
  () => createOneShotAuthorization({ message: 'ok', ...base }),
  e => e && e.code === 'EMAIL_SEND_CONFIRM_REQUIRED'
);
assert.throws(
  () => createOneShotAuthorization({ message: 'envoie', ...base, ttlMs: 60 * 60 * 1000 }),
  e => e && e.code === 'EMAIL_SEND_TTL_INVALID'
);

// Integration guards: the real bot must use the central module before this PR can pass.
const botCode = fs.readFileSync('bot.js', 'utf8');
assert.ok(botCode.includes("require('./lib/email_send_guard')"), 'bot.js must import lib/email_send_guard before merge');
assert.ok(
  !/const\s+CONFIRM_REGEX\s*=.*(?:parfait|oui|\bok\b|\bgo\b|ça marche|d'accord|c'est bon)/i.test(botCode),
  'bot.js still treats vague words as email-send confirmation'
);

console.log('✅ Email one-shot guard tests OK');
