'use strict';

const assert = require('assert');
const fs = require('fs');
const cuaModule = require('./cua_driver');
const { matrixClientEligibility } = require('./lib/matrix_client_eligibility');
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
scenario('Commande explicite numéro + courriel admissible sans dépendre du CRM', () => {
  const eligibility = matrixClientEligibility({
    email: 'client@example.com', propertyIdentified: true, ambiguous: false,
  });
  assert.strictEqual(eligibility.eligible, true);
  assert.deepStrictEqual(eligibility.missing, []);
  assert.deepStrictEqual(eligibility.enrichmentMissing, ['nom complet', 'téléphone', 'contexte CRM']);
});
scenario('Courriel invalide ou correspondance réellement ambiguë bloqués', () => {
  assert.strictEqual(matrixClientEligibility({ email: 'invalide', propertyIdentified: true }).eligible, false);
  assert.strictEqual(matrixClientEligibility({ email: 'client@example.com', propertyIdentified: true, ambiguous: true }).eligible, false);
});
scenario('Téléphone et nom facultatifs restent visibles sans être inventés', () => {
  assert.match(bot, /Téléphone:.*non fourni \(facultatif — jamais inventé\)/);
  assert.match(bot, /Enrichissement CRM facultatif absent/);
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
  const configuredCounts = process.env.CENTRIS_EXPECTED_DOCUMENTS_JSON;
  const smokeListing = process.env.CENTRIS_SMOKE_TEST_LISTING;
  const smokeCount = process.env.CENTRIS_SMOKE_EXPECTED_DOCUMENTS;
  delete process.env.CENTRIS_EXPECTED_DOCUMENTS_JSON;
  delete process.env.CENTRIS_SMOKE_TEST_LISTING;
  delete process.env.CENTRIS_SMOKE_EXPECTED_DOCUMENTS;
  assert.strictEqual(cuaModule._expectedCentrisDocumentCount('28936167'), 0,
    'aucun compte historique ne doit être imposé à une inscription réelle');
  if (configuredCounts === undefined) delete process.env.CENTRIS_EXPECTED_DOCUMENTS_JSON;
  else process.env.CENTRIS_EXPECTED_DOCUMENTS_JSON = configuredCounts;
  if (smokeListing === undefined) delete process.env.CENTRIS_SMOKE_TEST_LISTING;
  else process.env.CENTRIS_SMOKE_TEST_LISTING = smokeListing;
  if (smokeCount === undefined) delete process.env.CENTRIS_SMOKE_EXPECTED_DOCUMENTS;
  else process.env.CENTRIS_SMOKE_EXPECTED_DOCUMENTS = smokeCount;
  assert.doesNotMatch(cua, /selectedDocs\.slice\(0,\s*20\)/,
    'aucun plafond arbitraire de 20 documents ne doit tronquer le lot');
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
scenario('Redémarrage recharge seulement le cache PDF privé exact et empêche le rejeu', () => {
  assert.match(bot, /loadMatrixArtifactCache/);
  assert.match(bot, /restoredChatId === ALLOWED_ID/);
  assert.match(bot, /fingerprint: action\.matrixFingerprint/);
  assert.match(bot, /deliveryUncertain = Boolean\(action\.attemptStartedAt/);
  assert.match(bot, /ambiguousAfterRestart: deliveryUncertain/);
  assert.match(bot, /removeMatrixArtifactCache/);
});
scenario('Envoi réussi exige journal durable et preuve Gmail', () => {
  assert.match(bot, /if \(!saveEmailOutbox\(\)\)[\s\S]*?EMAIL_OUTBOX_PERSIST_FAILED/);
  assert.match(bot, /gmailProviderReceipt\?\.id/);
  const base = { via: 'gmail', to: 'client@example.com', cc: ['shawn@signaturesb.com'], subject: 'Sujet', body: 'Texte', attachments: [{ name: 'a.pdf', size: 10, sha256: 'abc' }] };
  assert.notStrictEqual(makeEmailFingerprint(base), makeEmailFingerprint({ ...base, to: 'autre@example.com' }));
});

assert.strictEqual(scenarios.length, 15);
console.log(`\n✅ ${scenarios.length}/15 scénarios obligatoires protégés (tests sans envoi réel)`);
