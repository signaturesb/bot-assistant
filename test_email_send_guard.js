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
assert.strictEqual(isExplicitEmailConfirmation('ok'), false);
assert.strictEqual(isExplicitEmailConfirmation('oui'), false);
assert.strictEqual(isExplicitEmailConfirmation('parfait'), false);
assert.strictEqual(isExplicitEmailConfirmation('go'), false);
assert.strictEqual(isExplicitEmailConfirmation('ça marche'), false);

const email = { to: 'client@example.com', subject: 'Sujet', body: 'Bonjour' };
const auth = createOneShotAuthorization({ message: 'envoie', ...email });
assert.doesNotThrow(() => consumeOneShotAuthorization(auth, email));
assert.throws(() => consumeOneShotAuthorization(auth, email), e => e && e.code === 'EMAIL_SEND_AUTH_INVALID');

const auth2 = createOneShotAuthorization({ message: 'send', ...email });
assert.throws(
  () => consumeOneShotAuthorization(auth2, { ...email, to: 'autre@example.com' }),
  e => e && e.code === 'EMAIL_SEND_CONTENT_CHANGED'
);

assert.throws(
  () => createOneShotAuthorization({ message: 'ok', ...email }),
  e => e && e.code === 'EMAIL_SEND_CONFIRM_REQUIRED'
);

// Integration guard: the real bot must use the central module before this PR can pass.
const botCode = fs.readFileSync('bot.js', 'utf8');
assert.ok(
  botCode.includes("require('./lib/email_send_guard')"),
  'bot.js must import lib/email_send_guard before merge'
);
assert.ok(
  !/const\s+CONFIRM_REGEX\s*=.*(?:parfait|oui|\bok\b|\bgo\b|ça marche)/i.test(botCode),
  'bot.js still treats vague words as email-send confirmation'
);

console.log('✅ Email one-shot guard tests OK');
