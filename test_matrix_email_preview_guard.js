'use strict';

const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync('./bot.js', 'utf8');
const handler = code.match(/async function executeMatrixAnnexesTool[\s\S]*?\n}\n\nasync function executeTool/)?.[0] || '';
assert.ok(handler, 'executeMatrixAnnexesTool absent');
assert.match(handler, /pendingExternalEmailActions\.set/);
assert.match(handler, /matrixPreviewExpiresAt: Date\.now\(\) \+ 15 \* 60 \* 1000/);
assert.match(handler, /approvedPreview\.matrixFingerprint !== payloadFingerprint/);
assert.match(handler, /APERÇU COURRIEL — aucun envoi/);
assert.match(handler, /if \(!isSendConfirmation && ALLOWED_ID && chatId\)/);
assert.match(handler, /Confirmation refusée:.*PDF ont changé/s);
assert.ok(code.includes('Ne jamais conclure « courtier concurrent / accès restreint » sans un code HTTP 401/403 observé'));
assert.ok(code.includes("name !== 'telecharger_annexes_centris'"), 'le preview Matrix doit passer avant le garde générique');

console.log('✅ Aperçu Matrix lié au destinataire, modèle et PDF avant confirmation');
