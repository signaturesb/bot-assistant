'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const { makeEmailConversationScope, emailMatchesConversationScope } = require('./lib/email_conversation_scope');
const { selectFirstEmailConfirmation } = require('./lib/email_send_guard');
const scope = makeEmailConversationScope('Prépare les documents du 21461675 pour jackcanon@hotmail.com »', 100);
const jack = { to: 'jackcanon@hotmail.com', centris: '21461675' };
const patrick = { to: 'patrick.stjean1625@gmail.com', centris: '13097715' };
const action = { ...jack, createdAt: 101, telegramPreviewMessageId: 42 };
assert.equal(emailMatchesConversationScope(scope, jack, action), true);
assert.equal(emailMatchesConversationScope(scope, patrick, { ...action, ...patrick }), false);
assert.equal(emailMatchesConversationScope(scope, { ...jack, centris: '13097715' }, action), false);
assert.equal(emailMatchesConversationScope(scope, jack, { ...action, createdAt: 99 }), false);
assert.equal(emailMatchesConversationScope(scope, jack, action, 41), false);
assert.equal(emailMatchesConversationScope(scope, jack, action, 42), true);
assert.equal(emailMatchesConversationScope(JSON.parse(JSON.stringify(scope)), jack, action), true);
assert.equal(emailMatchesConversationScope(null, jack, action), false);
assert.equal(emailMatchesConversationScope(makeEmailConversationScope('autre dossier', 100), jack, action), false);

// Execute the actual confirmation handler through selection and scope guard.
// A single stale pending draft must NOT reach the provider-authorizing branch.
const source = fs.readFileSync(require.resolve('./bot.js'), 'utf8');
const start = source.indexOf('async function handleEmailConfirmation(msg)');
const end = source.indexOf('    if (directSelection?.ok) {', start);
assert(start > 0 && end > start);
const prefix = source.slice(start, end) + "return 'accepted'; } return 'not-selected'; }";
const ctx = vm.createContext({
  CONFIRM_REGEX: /^(envoie|send)$/i,
  pendingEmails: new Map([[1, { ...patrick, createdAt: 50 }]]),
  pendingExternalEmailActions: new Map(),
  emailConversationScopes: new Map([[1, scope]]),
  selectFirstEmailConfirmation, emailMatchesConversationScope,
  pendingEmailTransactionRecipient: (_, a) => a.to,
  pendingEmailTransactionSummary: (_, a) => a,
  send: async () => {},
});
vm.runInContext(prefix + '; this.confirm = handleEmailConfirmation;', ctx);
(async () => {
  assert.equal(await ctx.confirm({ chat: { id: 1 }, text: 'envoie' }), true, 'Patrick must be refused');
  ctx.pendingEmails.set(1, action);
  assert.equal(await ctx.confirm({ chat: { id: 1 }, text: 'envoie' }), 'accepted', 'fresh Jack preview stays usable');
  assert.equal(await ctx.confirm({ chat: { id: 1 }, text: 'envoie', reply_to_message: { message_id: 41 } }), true);
  console.log('✅ Confirmation bound to current recipient/listing; stale and mismatched drafts refused');
})().catch(e => { console.error(e); process.exitCode = 1; });
