'use strict';

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

console.log('✅ Email one-shot guard tests OK');
