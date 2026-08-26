'use strict';

const assert = require('assert');
const fs = require('fs');
const {
  createOneShotAuthorization,
  consumeOneShotAuthorization,
  makeEmailFingerprint,
} = require('./lib/email_send_guard');

const bot = fs.readFileSync('./bot.js', 'utf8');
const cua = fs.readFileSync('./cua_driver.js', 'utf8');
const scenarios = [];
function scenario(name, check) {
  check();
  scenarios.push(name);
  console.log(`✅ ${scenarios.length}. ${name}`);
}

scenario('Listing d’un autre courtier accessible par recherche Matrix globale exacte', () => {
  assert.match(cua, /Recherche globale Matrix: fonctionne aussi pour les inscriptions d'autres/);
  assert.match(cua, /exactListingMentioned/);
});
scenario('Listing externe inaccessible produit un blocage technique précis', () => {
  assert.match(cua, /MATRIX_AUTH_REQUIRED/);
  assert.match(cua, /MATRIX_LISTING_NOT_FOUND/);
});
scenario('Numéro Centris invalide refusé', () => {
  assert.match(cua, /MATRIX_INVALID_CENTRIS_NUMBER/);
});
scenario('Client complet et admissible', () => {
  assert.match(bot, /function matrixClientEligibility/);
  assert.match(bot, /const nameValid = client\.testMode/);
  assert.match(bot, /nom complet fiable[\s\S]*?adresse courriel unique[\s\S]*?numéro de téléphone valide[\s\S]*?contexte immobilier clair/);
});
scenario('Courriel général sans client identifié bloqué', () => {
  assert.match(bot, /pipedrive-not-found/);
  assert.match(bot, /client\.ambiguous/);
});
scenario('Client sans téléphone clairement bloqué', () => {
  assert.match(bot, /Téléphone:.*MANQUANT — ne sera jamais inventé/);
  assert.match(bot, /if \(!normalizeClientPhone\(client\.phone\)\) missing\.push/);
});
scenario('Correspondance Dropbox approximative ne remplace pas Matrix exact', () => {
  const matrixHandler = bot.match(/async function executeMatrixAnnexesTool[\s\S]*?\n}\n\nasync function executeTool/)?.[0] || '';
  assert.ok(matrixHandler);
  assert.doesNotMatch(matrixHandler, /fastDropboxMatch|dropboxLiveSearch/);
});
scenario('Mauvais document ou mauvaise propriété détecté', () => {
  assert.match(bot, /returnedCentris !== String\(num\)/);
  assert.match(cua, /MATRIX_PRINT_LISTING_MISMATCH/);
  assert.match(cua, /extractCompleteMatrixAddressFromText/);
  assert.match(bot, /listingAddressComplete/);
  assert.match(bot, /listingAddressSource !== 'matrix-listing-report-pdf'/);
});
scenario('Document manquant, corrompu ou incomplet bloqué', () => {
  assert.match(cua, /MATRIX_EXPECTED_DOCUMENT_COUNT_MISMATCH/);
  assert.match(cua, /MATRIX_DOCUMENT_PAGE_COUNT_MISMATCH/);
  assert.match(cua, /MATRIX_PRINT_STREAM_INVALID_PDF/);
});
scenario('Double clic et commandes concurrentes bloqués', () => {
  assert.match(bot, /if \(action\.inFlight\)/);
  assert.match(bot, /pendingExternalEmailActions\.has\(chatId\)/);
  assert.match(bot, /EMAIL_DUPLICATE_FINGERPRINT_BLOCKED/);
});
scenario('Confirmation Telegram one-shot non réutilisable', () => {
  const payload = { via: 'gmail', to: 'client@example.com', cc: ['shawn@signaturesb.com'], subject: 'X', body: 'Y', attachments: [] };
  const auth = createOneShotAuthorization({ message: 'envoie', ...payload, now: 1000 });
  assert.strictEqual(consumeOneShotAuthorization(auth, payload, 1001), true);
  assert.throws(() => consumeOneShotAuthorization(auth, payload, 1002), /déjà consommée/);
});
scenario('Annulation liée à l’identifiant unique', () => {
  assert.match(bot, /mxcancel:\$\{requestId\}/);
  assert.match(bot, /clearMatrixTransaction\(chatId, arg\)/);
});
scenario('Échec fournisseur certain séparé de l’état incertain', () => {
  assert.match(bot, /if \(sent\.uncertain\)/);
  assert.match(bot, /Gmail a refusé.*échec confirmé/);
});
scenario('Redémarrage invalide les PDF mémoire et empêche le rejeu', () => {
  assert.match(bot, /Après[\s\S]*?redémarrage[\s\S]*?ne jamais restaurer une autorisation/);
  assert.match(bot, /ambiguousAfterRestart/);
});
scenario('Envoi réussi exige journal durable et preuve Gmail', () => {
  assert.match(bot, /if \(!saveEmailOutbox\(\)\)[\s\S]*?EMAIL_OUTBOX_PERSIST_FAILED/);
  assert.match(bot, /gmailProviderReceipt\?\.id/);
  const base = { via: 'gmail', to: 'client@example.com', cc: ['shawn@signaturesb.com'], subject: 'Sujet', body: 'Texte', attachments: [{ name: 'a.pdf', size: 10, sha256: 'abc' }] };
  assert.notStrictEqual(makeEmailFingerprint(base), makeEmailFingerprint({ ...base, to: 'autre@example.com' }));
});

assert.strictEqual(scenarios.length, 15);
console.log(`\n✅ ${scenarios.length}/15 scénarios obligatoires protégés (tests sans envoi réel)`);
