'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const vm = require('vm');
const {
  makeEmailConversationScope,
  emailMatchesConversationScope,
  shouldSupersedePendingEmail,
} = require('./lib/email_conversation_scope');
const { selectFirstEmailConfirmation } = require('./lib/email_send_guard');
const source = fs.readFileSync(require.resolve('./bot.js'), 'utf8');
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
assert.equal(shouldSupersedePendingEmail('Envoie'), false);
assert.equal(shouldSupersedePendingEmail('send!'), false);
assert.equal(shouldSupersedePendingEmail('confirme jackcanon@hotmail.com'), false);
assert.equal(shouldSupersedePendingEmail('Prépare quelque chose pour Marie'), true);
assert.equal(shouldSupersedePendingEmail('envoie lui les documents'), true);
assert.equal(shouldSupersedePendingEmail('merci'), true);
assert.equal(shouldSupersedePendingEmail(''), false);

assert.match(source, /const EMAIL_CONFIRMATION_VERSION = 5;/);
assert.match(source, /if \(!shouldSupersedePendingEmail\(text\)\) return;/);
assert.doesNotMatch(source, /if \(scope\.recipients\.length \|\| scope\.listings\.length\)/);
assert.match(source, /restored\.ambiguousAfterRestart = true;/);
assert.match(source, /ambiguousAfterRestart: true,/);
assert.match(source, /pendingEmailDraftQueue = \[\];\s+pendingMatrixRequestQueue = \[\];/);
assert.match(source, /async function callClaudeVision[\s\S]*?recordEmailConversationScope\(chatId, contextLabel/);
assert.match(source, /bot\.onText\(\/\^envoie[\s\S]*?recordEmailConversationScope\(msg\.chat\.id, msg\.text/);
assert.match(source, /bot\.onText\(\/\^\\\/fiche[\s\S]*?recordEmailConversationScope\(msg\.chat\.id, msg\.text/);
assert.match(source, /bot\.onText\(\/\^\\\/matrix[\s\S]*?recordEmailConversationScope\(chatId, msg\.text/);
assert(
  source.indexOf('savePendingEmailState();', source.indexOf('function recordEmailConversationScope')) <
  source.indexOf('emailConversationScopes.set(chatId, scope);', source.indexOf('function recordEmailConversationScope')),
  'les anciens envois doivent être révoqués avant la persistance du nouveau contexte',
);

// Execute the actual confirmation handler through selection and scope guard.
// A single stale pending draft must NOT reach the provider-authorizing branch.
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
