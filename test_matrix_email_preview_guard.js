'use strict';

const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync('./bot.js', 'utf8');
const handler = code.match(/async function executeMatrixAnnexesTool[\s\S]*?\n}\n\nasync function executeTool/)?.[0] || '';
assert.ok(handler, 'executeMatrixAnnexesTool absent');
assert.match(handler, /pendingExternalEmailActions\.set/);
assert.match(handler, /matrixPreviewExpiresAt: Date\.now\(\) \+ MATRIX_PREVIEW_TTL_MS/);
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
assert.match(code, /const pendingMatrixArtifacts = new Map\(\)/);
assert.match(handler, /les PDF figés de l’aperçu Matrix/);
assert.match(handler, /pendingMatrixArtifacts\.set\(chatId/);
assert.match(handler, /listing: result\.listing \|\| null/,
  'l’adresse Matrix doit être figée avec les PDF du preview');
assert.match(handler, /listing: cachedArtifact\.listing \|\| null/,
  'la confirmation doit réutiliser la même adresse sans nouvelle recherche');
assert.match(handler, /pendingMatrixArtifacts\.delete\(chatId\)/);
assert.match(handler, /gmailProviderReceipt\?\.id/);
assert.match(handler, /Preuve Gmail:/);
assert.match(handler, /APERÇU HTML — aucun envoi/);
assert.match(handler, /const requestId = matrixRequestId\(\)/);
assert.match(handler, /const client = await resolveMatrixClientContext\(emailDestination, num\)/);
assert.match(handler, /returnedCentris !== String\(num\)/);
assert.match(handler, /l’adresse exacte n’a pas pu être validée/);
assert.match(handler, /matrixClientEligibility\(approvedPreview\.client \|\| \{\}\)/);
assert.match(handler, /État Gmail incertain/);
assert.match(handler, /Gmail bloqué avant livraison/);
assert.match(handler, /if \(!isSendConfirmation && ALLOWED_ID && chatId\)/);
assert.match(handler, /Confirmation refusée:.*PDF ont changé/s);
assert.ok(code.includes('Ne jamais conclure « courtier concurrent / accès restreint » sans un code HTTP 401/403 observé'));
assert.ok(code.includes('ne jamais créer/prétendre sauvegarder chatgpt_config.md'));
assert.ok(code.includes('ne jamais déclarer les documents inaccessibles à cause du courtier sans preuve 401/403'));
assert.ok(code.includes("name !== 'telecharger_annexes_centris'"), 'le preview Matrix doit passer avant le garde générique');
assert.match(code, /action\.name === 'telecharger_annexes_centris'[\s\S]*?\^🔒 Confirmation refusée:[\s\S]*?pendingExternalEmailActions\.delete\(chatId\)/);

// Le mot seul « envoie » ne reconstruit jamais le numéro ou le destinataire:
// il reprend l'action exacte figée dans pendingExternalEmailActions.
const confirmationHandler = code.match(/async function handleEmailConfirmation[\s\S]*?\n}\n\n\/\/ ─── Handlers Telegram/)?.[0] || '';
assert.ok(confirmationHandler, 'handleEmailConfirmation absent');
assert.match(confirmationHandler, /const firstConfirmation = CONFIRM_REGEX\.test\(text\)/);
assert.match(confirmationHandler, /const external = pendingExternalEmailActions\.get\(chatId\)/);
assert.match(confirmationHandler, /executeTool\(\s*action\.name,\s*action\.input,\s*chatId,\s*'envoie'/);
assert.doesNotMatch(confirmationHandler, /action\.input\s*=|email_destination\s*=|centris_num\s*=/,
  'la confirmation ne doit pas reconstruire ou modifier le destinataire/numéro du preview');
assert.match(confirmationHandler, /reply_to_message\?\.message_id/,
  'la confirmation doit être liée au message Telegram exact');
assert.match(confirmationHandler, /Pour Matrix, réponds « envoie » directement au résumé APERÇU MATRIX/,
  'Matrix doit refuser une première confirmation non liée au bon aperçu');
assert.match(confirmationHandler, /finalConfirmationMessageId/);
assert.match(confirmationHandler, /confirmationStage === 'awaiting-final'/);
assert.match(confirmationHandler, /Plusieurs actions courriel sont en attente[\s\S]*?Aucune priorité automatique/,
  'deux actions simultanées ne doivent jamais choisir un destinataire par ordre de Map');
const firstConfirmationBranch = confirmationHandler.split('// Première confirmation: elle ne peut JAMAIS appeler Gmail/Centris.')[1] || '';
assert.match(firstConfirmationBranch, /await requestFinalEmailConfirmation/);
assert.doesNotMatch(firstConfirmationBranch, /executeTool\(|envoyerEmailGmail\(|sendEmailLogged\(/,
  'la première confirmation doit seulement créer la deuxième étape avant tout provider');
assert.match(code, /telecharger_annexes_centris:\s*360000/,
  'le délai du tool doit couvrir l’attente du verrou et les sessions Matrix séquentielles');
assert.match(code, /function matrixPreviewButtons[\s\S]*?mxconfirm:[\s\S]*?mxcancel:[\s\S]*?mxrefresh:[\s\S]*?mxclient:[\s\S]*?mxemail:/,
  'les cinq actions Telegram doivent être liées à la demande Matrix unique');
assert.match(code, /function matrixPreviewSummary[\s\S]*?Client:[\s\S]*?Téléphone:[\s\S]*?CONTENU COMPLET DU COURRIEL/,
  'le résumé doit montrer identité, téléphone et contenu complet');
assert.match(code, /function purgeExpiredMatrixTransactions/);
assert.match(code, /safeCron\('matrix-preview-expiry-purge'/);
assert.match(confirmationHandler, /requestId: action\.requestId \|\| null/,
  'la deuxième confirmation doit transmettre le même identifiant unique au garde final');

console.log('✅ Aperçu Matrix lié au destinataire, modèle et PDF avant confirmation');
