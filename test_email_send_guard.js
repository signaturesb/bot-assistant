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
  renderedHtmlSha256: 'html-v1',
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
  { ...base, renderedHtmlSha256: 'html-v2' },
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
const cuaCode = fs.readFileSync('cua_driver.js', 'utf8');
assert.ok(botCode.includes("require('./lib/email_send_guard')"), 'bot.js must import lib/email_send_guard before merge');
assert.ok(
  !/const\s+CONFIRM_REGEX\s*=.*(?:parfait|oui|\bok\b|\bgo\b|ça marche|d'accord|c'est bon)/i.test(botCode),
  'bot.js still treats vague words as email-send confirmation'
);
assert.ok(!botCode.includes('shawnConsent'), 'legacy caller-asserted consent flag must be completely absent');
assert.match(botCode, /const\s+maxRetries\s*=\s*1\s*;/, 'one confirmation must authorize one provider attempt only');
assert.match(
  botCode,
  /async function sendEmailLogged[\s\S]*?consumeOneShotAuthorization\(opts\.authorization, emailPayload\)[\s\S]*?entry\.outcome = 'blocked'/,
  'central email wrapper must consume content-bound authorization and fail closed'
);
assert.match(
  botCode,
  /async function envoyerDocsProspect[\s\S]*?createOneShotAuthorization[\s\S]*?authorization: emailAuthorization/,
  'document send path must create and pass a content-bound authorization'
);
assert.ok(botCode.includes('pendingExternalEmailActions'), 'external provider actions need a two-step pending confirmation');
assert.ok(botCode.includes('if (external.inFlight)'), 'external email confirmation must suppress concurrent duplicate attempts');
assert.ok(botCode.includes('PENDING_EMAILS_FILE'), 'pending drafts must survive a Render restart');
assert.ok(botCode.includes('queuePendingEmailDraft'), 'automatic drafts must use a non-overwriting queue');
assert.ok(botCode.includes('deliveryUncertain'), 'provider uncertainty must block duplicate retries');
assert.ok(!/pendingEmails\.set\(ALLOWED_ID/.test(botCode), 'automatic lead drafts must never overwrite the active draft');
assert.ok(botCode.includes("name === 'telecharger_docs_centris_complet'"), 'multi-email action must be blocked under one-shot policy');
assert.match(
  cuaCode,
  /async function sendCentrisListingByEmail\(opts\)[\s\S]*?hasExplicitCentrisSendConfirmation\(opts\?\.confirmationMessage\)/,
  'Matrix native send must fail closed without its own explicit confirmation'
);
assert.match(
  cuaCode,
  /async function shareCentrisZoneDocuments\(opts = \{\}\)[\s\S]*?!opts\.dry_run && !hasExplicitCentrisSendConfirmation\(opts\.confirmationMessage\)/,
  'Zone share must fail closed without its own explicit confirmation'
);
assert.ok(
  (botCode.match(/confirmationMessage: userMessage/g) || []).length >= 2,
  'Both Centris provider send paths must receive the current confirmation message'
);

const telegramFlush = botCode.match(/\/\/ \/flush-pending[\s\S]*?bot\.onText\(\/\\\/backup\//)?.[0] || '';
assert.ok(telegramFlush, 'Telegram /flush-pending handler must remain auditable');
assert.ok(!telegramFlush.includes('envoyerDocsAuto('), '/flush-pending must never bulk-send client emails');

const adminFlush = botCode.match(/\/\/ POST \/admin\/flush-pending[\s\S]*?\/\/ POST \/admin\/test-email/)?.[0] || '';
assert.ok(adminFlush, 'admin flush compatibility route must remain auditable');
assert.ok(!adminFlush.includes('envoyerDocsAuto('), 'admin token must never bulk-authorize client emails');
assert.ok(adminFlush.includes('BULK_EMAIL_CONFIRMATION_FORBIDDEN'), 'admin bulk-send route must fail closed explicitly');

const pendingReminder = botCode.match(/\/\/ RAPPEL pendingDocSends[\s\S]*?\/\/ \(pendingDocSends\.set wrappé/)?.[0] || '';
assert.ok(pendingReminder, 'pending reminder block must remain auditable');
assert.ok(!pendingReminder.includes('envoyerDocsAuto('), 'background reminders must never retry a client email');

console.log('✅ Email one-shot guard tests OK');
