'use strict';

const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync('./bot.js', 'utf8');
const handler = code.match(/async function executeMatrixAnnexesTool[\s\S]*?\n}\n\nasync function executeTool/)?.[0] || '';
assert.ok(handler, 'executeMatrixAnnexesTool absent');
assert.match(handler, /pendingExternalEmailActions\.set/);
assert.match(handler, /matrixPreviewExpiresAt: Date\.now\(\) \+ 15 \* 60 \* 1000/);
assert.match(handler, /approvedPreview\.matrixFingerprint !== payloadFingerprint/);
assert.match(handler, /telegramReceipt\?\.message_id/);
assert.match(handler, /previewReceipt\?\.message_id/);
assert.match(handler, /Aucun courriel n'est armé/);
assert.match(handler, /pendingExternalEmailActions\.set\(chatId, pendingMatrixPreview\)/);
assert.match(handler, /if \(!chatId\)[\s\S]*?Aucun courriel n'est armé/,
  'aucune confirmation Matrix ne doit être armée sans conversation Telegram vérifiable');
assert.ok(
  handler.indexOf('const token = await getGmailToken()') >
    handler.indexOf('approvedPreview.matrixFingerprint !== payloadFingerprint'),
  'OAuth Gmail doit être demandé après l’aperçu et sa validation, jamais avant le preview Telegram',
);
assert.ok(
  handler.indexOf('pendingExternalEmailActions.set(chatId, pendingMatrixPreview)') >
    handler.indexOf('if (!previewReceipt?.message_id)'),
  'la confirmation ne doit être armée qu’après un accusé Telegram vérifié',
);
assert.match(handler, /renderedHtmlSha256/);
assert.match(handler, /gmailProviderReceipt\?\.id/);
assert.match(handler, /Preuve Gmail:/);
assert.match(handler, /APERÇU COURRIEL — aucun envoi/);
assert.match(handler, /if \(!isSendConfirmation && ALLOWED_ID && chatId\)/);
assert.match(handler, /Confirmation refusée:.*PDF ont changé/s);
assert.ok(code.includes('Ne jamais conclure « courtier concurrent / accès restreint » sans un code HTTP 401/403 observé'));
assert.ok(code.includes('ne jamais créer/prétendre sauvegarder chatgpt_config.md'));
assert.ok(code.includes('ne jamais déclarer les documents inaccessibles à cause du courtier sans preuve 401/403'));
assert.ok(code.includes("name !== 'telecharger_annexes_centris'"), 'le preview Matrix doit passer avant le garde générique');
assert.match(code, /external\.name === 'telecharger_annexes_centris'[\s\S]*?\^🔒 Confirmation refusée:[\s\S]*?pendingExternalEmailActions\.delete\(chatId\)/);

console.log('✅ Aperçu Matrix lié au destinataire, modèle et PDF avant confirmation');
