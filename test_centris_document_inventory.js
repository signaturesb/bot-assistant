'use strict';

const assert = require('assert');
const fs = require('fs');
const cua = require('./cua_driver');

const category = (inventory, key) => inventory.present.find((entry) => entry.key === key);

// Compatibilité avec l'ancien inventaire Zone: les alias name/size doivent
// rester disponibles tant que tous les consommateurs ne sont pas migrés.
const legacyDocs = [
  { name: 'Fiche détaillée 28603836.pdf', size: '412 KB', provenance: 'zone' },
  { name: 'Déclaration du vendeur DV.pdf', size: '1.2 MB', provenance: 'zone' },
  { name: 'Compte de taxes municipales.pdf', size: '88 KB', provenance: 'zone' },
  { name: 'Plan cadastral.pdf', size: '730 KB', provenance: 'zone' },
];
const legacy = cua._buildCentrisDocumentInventory('28603836', legacyDocs);
assert.strictEqual(legacy.docs.length, 4);
assert.ok(legacy.docs.every((doc) => doc.name && doc.label_original));
assert.ok(legacy.docs.every((doc) => doc.size === doc.size_display));
assert.ok(category(legacy, 'fiche_detaillee'));
assert.ok(category(legacy, 'declaration_vendeur_principale'));
assert.ok(category(legacy, 'taxes_municipales'));
assert.ok(category(legacy, 'plan_cadastral'));
assert.deepStrictEqual(legacy.missing, [], 'une catégorie possible absente ne doit pas être présentée comme document obligatoire manquant');
assert.match(legacy.inventory_manifest_id, /^[a-f0-9]{64}$/);
assert.strictEqual(legacy.manifest_id, legacy.inventory_manifest_id, 'alias manifest_id conservé pour le flux Zone existant');

// Fixture réelle confirmée par capture Matrix: 1 DV principale séparée et
// 8 documents additionnels. Ce total n'est jamais une règle globale.
const fixture28936167 = [
  { name: 'Oui DV-50037', size: null, source_section: 'principal_dv', provenance: 'matrix_principal_dv' },
  { name: 'Déclaration du vendeur / Modification DV (signé le 2026-03-25)', size: '584,48 k', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
  { name: 'Facture - Taxes scolaires', size: '92,66 k', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
  { name: 'Autre : Rôle évaluation', size: '8,26 k', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
  { name: 'Plan : Plan cadastral - LOT 6 184 490', size: '458,63 k', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
  { name: 'Plan : Plan cadastral - LOT 6 183 408', size: '466,52 k', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
  { name: 'Plan', size: '3687,56 k', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
  { name: 'Certificat de localisation : Ancien certificat de localisation 2004', size: '872,02 k', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
  { name: 'Autre : Obligation courtier envers son vendeur', size: '92,9 k', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
];
const matrix = cua._buildCentrisDocumentInventory('28936167', fixture28936167, {
  expectedCategories: ['declaration_vendeur_principale', 'certificat_localisation'],
});
assert.strictEqual(matrix.docs.length, 9);
assert.strictEqual(category(matrix, 'declaration_vendeur_principale').docs.length, 1);
assert.strictEqual(category(matrix, 'declaration_vendeur_principale').docs[0].source_section, 'principal_dv');
assert.strictEqual(category(matrix, 'modification_dv').docs.length, 1);
assert.strictEqual(category(matrix, 'plan_cadastral').docs.length, 2);
assert.deepStrictEqual(new Set(category(matrix, 'plan_cadastral').docs.map((doc) => doc.lot)), new Set(['6184490', '6183408']));
assert.strictEqual(category(matrix, 'plan_autre').docs.length, 1);
assert.ok(category(matrix, 'taxes_scolaires'));
assert.ok(category(matrix, 'role_evaluation'));
assert.ok(category(matrix, 'certificat_localisation'));
assert.ok(category(matrix, 'obligation_courtier'));
assert.deepStrictEqual(matrix.missing_expected_documents, []);

// La provenance structurelle empêche une annexe DV d'être promue en DV principale.
const additionalDv = cua._buildCentrisDocumentInventory('X', [
  { name: 'DV-99999', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
], { expectedCategories: ['declaration_vendeur_principale'] });
assert.ok(!category(additionalDv, 'declaration_vendeur_principale'));
assert.ok(category(additionalDv, 'document_autre'));
assert.ok(additionalDv.missing_expected_documents.some((entry) => entry.key === 'declaration_vendeur_principale'));

const modificationOnly = cua._buildCentrisDocumentInventory('X', [
  { name: 'Modification DV', source_section: 'additional_documents', provenance: 'matrix_additional_documents' },
], { expectedCategories: ['declaration_vendeur_principale'] });
assert.ok(category(modificationOnly, 'modification_dv'));
assert.ok(modificationOnly.missing_expected_documents.some((entry) => entry.key === 'declaration_vendeur_principale'));

const invalidExpectation = cua._buildCentrisDocumentInventory('X', [], {
  expectedCategories: ['declaration_vendeur_principale', 'categorie_inventee'],
});
assert.strictEqual(invalidExpectation.inventory_valid, false, 'une catégorie attendue inconnue ne doit pas être ignorée silencieusement');
assert.deepStrictEqual(invalidExpectation.invalid_expected_categories, ['categorie_inventee']);

// Un document inconnu reste visible et conserve sa provenance.
const unknown = cua._buildCentrisDocumentInventory('X', [
  { name: 'Rapport de conformité piscine', size: '50 KB', provenance: 'matrix_additional_documents' },
]);
assert.strictEqual(category(unknown, 'document_autre').docs.length, 1);
assert.strictEqual(unknown.docs[0].provenance, 'matrix_additional_documents');

// Normalisation typographique et formats de taille québécois.
const NBSP = '\u00A0';
assert.strictEqual(NBSP.codePointAt(0), 0x00A0);
assert.strictEqual(cua._parseCentrisDisplaySize('584,48 k'), Math.round(584.48 * 1024));
assert.strictEqual(cua._parseCentrisDisplaySize('92,9 k'), Math.round(92.9 * 1024));
assert.strictEqual(cua._parseCentrisDisplaySize('3687,56 k'), Math.round(3687.56 * 1024));
assert.strictEqual(cua._parseCentrisDisplaySize('1.2 MB'), Math.round(1.2 * 1024 * 1024));
assert.strictEqual(cua._parseCentrisDisplaySize('inconnue'), null);
assert.strictEqual(cua._normalizeCentrisLabel(`Plan${NBSP}: Plan cadastral — LOT 6 184 490`), 'Plan : Plan cadastral - LOT 6 184 490');

const typographyA = cua._buildCentrisDocumentInventory('X', [
  { name: `Facture${NBSP}-${NBSP}Taxes scolaires`, size: '92,66 k' },
  { name: 'Autre : Rôle évaluation', size: '8,26 k' },
]);
const typographyB = cua._buildCentrisDocumentInventory('X', [
  { name: 'Facture - Taxes scolaires', size: '92,66 k' },
  { name: 'Autre : Role evaluation', size: '8,26 k' },
]);
assert.strictEqual(typographyA.inventory_manifest_id, typographyB.inventory_manifest_id, 'variantes typographiques équivalentes → même inventaire');

// L'ordre DOM, même avec des libellés identiques et tailles différentes, ne
// doit jamais influencer l'empreinte.
const duplicatePlans = [
  { name: 'Plan', size: '100 KB' },
  { name: 'Plan', size: '200 KB' },
];
const duplicatesA = cua._buildCentrisDocumentInventory('X', duplicatePlans);
const duplicatesB = cua._buildCentrisDocumentInventory('X', [...duplicatePlans].reverse());
assert.strictEqual(category(duplicatesA, 'plan_autre').docs.length, 2);
assert.strictEqual(duplicatesA.inventory_manifest_id, duplicatesB.inventory_manifest_id);

const reordered = cua._buildCentrisDocumentInventory('28936167', [...fixture28936167].reverse(), {
  expectedCategories: ['declaration_vendeur_principale', 'certificat_localisation'],
});
assert.strictEqual(reordered.inventory_manifest_id, matrix.inventory_manifest_id);

const added = cua._buildCentrisDocumentInventory('28936167', [
  ...fixture28936167,
  { name: 'Rapport environnemental', size: '50 KB' },
]);
assert.notStrictEqual(added.inventory_manifest_id, matrix.inventory_manifest_id);

// Le manifeste de contenu est distinct de l'inventaire visuel. Deux PDF de
// même nom et même taille affichée, mais d'octets différents, doivent produire
// des empreintes finales différentes.
const pdfA = Buffer.from('%PDF-1.4\nA\n%%EOF');
const pdfB = Buffer.from('%PDF-1.4\nB\n%%EOF');
assert.strictEqual(pdfA.length, pdfB.length);
const baseDoc = cua._buildCentrisDocumentInventory('X', [{ name: 'Plan', size: '1 k' }]).docs[0];
const contentDocA = cua._addCentrisContentMetadata(baseDoc, pdfA, 1);
const contentDocB = cua._addCentrisContentMetadata(baseDoc, pdfB, 1);
const contentA = cua._buildCentrisContentManifest('X', [contentDocA]);
const contentB = cua._buildCentrisContentManifest('X', [contentDocB]);
assert.ok(contentA.complete && contentB.complete);
assert.notStrictEqual(contentA.content_manifest_id, contentB.content_manifest_id);
assert.strictEqual(cua._buildCentrisContentManifest('X', [baseDoc]).content_manifest_id, null, 'pas de manifeste final sans validation du contenu');
assert.strictEqual(cua._buildCentrisContentManifest('X', []).error_code, 'CENTRIS_DOCUMENT_LIST_EMPTY');
assert.throws(
  () => cua._addCentrisContentMetadata(baseDoc, Buffer.from('<html>login</html>'), 1),
  /CENTRIS_DOCUMENT_NOT_PDF/,
  'une page HTML de connexion ne doit jamais être acceptée comme PDF'
);

// Gardes et consommateurs existants.
const botCode = fs.readFileSync('bot.js', 'utf8');
const cuaCode = fs.readFileSync('cua_driver.js', 'utf8');
assert.ok(botCode.includes('d.label_original || d.name'), 'le preview doit supporter le modèle enrichi et les alias historiques');
assert.ok(botCode.includes('doc.label_original || doc.name'), 'l’autorisation doit recevoir un nom de document réel');
assert.ok(botCode.includes('missing_expected_documents'), 'le preview ne doit pas présenter toutes les catégories absentes comme obligatoires');
assert.ok(botCode.includes('expectedManifestId: preview.manifest_id'), 'le partage Zone actuel reste lié au dry-run');
assert.ok(cuaCode.includes('expectedManifestId !== inventory.manifest_id'), 'un inventaire Zone changé doit continuer à bloquer');
assert.ok(cuaCode.includes('if (!isDryRun && !cb.checked) cb.click()'), 'le dry-run ne doit cocher aucun document');

assert.strictEqual(cua._classifyZonePageSnapshot({
  url: 'https://accounts.centris.ca/Account/Login', text: 'Connexion', passwordInputs: 1,
}, '28936167').code, 'ZONE_AUTH_REQUIRED');
assert.strictEqual(cua._classifyZonePageSnapshot({
  url: 'https://zone.centris.ca/Listings/28936167/Documents', text: 'Inscription 28936167 Aucun document disponible', checkboxCount: 0,
}, '28936167').code, 'ZONE_NO_DOCUMENTS');
assert.strictEqual(cua._classifyZonePageSnapshot({
  url: 'https://zone.centris.ca/Listings/28936167/Documents', text: 'Inscription 28936167 Documents', checkboxCount: 3,
}, '28936167').code, 'ZONE_DOCUMENTS_READY');
assert.strictEqual(cua._classifyZonePageSnapshot({
  url: 'https://zone.centris.ca/Dashboard', text: 'Bienvenue', checkboxCount: 0,
}, '28936167').code, 'ZONE_NAVIGATION_UNVERIFIED');

// La recherche globale Matrix est le chemin obligatoire pour les listings
// d'autres courtiers. Le numéro exact doit être présent; aucune suggestion de
// numéro voisin ne peut transformer une page en résultat valide.
assert.strictEqual(cua._classifyMatrixPageSnapshot({
  url: 'https://matrix.centris.ca/Matrix/Results.aspx',
  text: 'No Centris 28936167 (En vigueur) Document(s) additionnel(s)',
  mediaLinkCount: 8,
  passwordInputs: 0,
}, '28936167').code, 'MATRIX_DOCUMENTS_READY');
assert.strictEqual(cua._classifyMatrixPageSnapshot({
  url: 'https://matrix.centris.ca/Matrix/Results.aspx',
  text: 'No Centris 28939185 (En vigueur) Document(s) additionnel(s)',
  mediaLinkCount: 8,
  passwordInputs: 0,
}, '28936167').code, 'MATRIX_NAVIGATION_UNVERIFIED');
assert.strictEqual(cua._classifyMatrixPageSnapshot({
  url: 'https://accounts.centris.ca/Account/Login',
  text: 'Connectez-vous', mediaLinkCount: 0, passwordInputs: 1,
}, '28936167').code, 'MATRIX_AUTH_REQUIRED');
assert.strictEqual(cua._classifyMatrixPageSnapshot({
  url: 'https://matrix.centris.ca/Matrix/Results.aspx',
  text: 'Aucun résultat', mediaLinkCount: 0, passwordInputs: 0,
}, '28936167').code, 'MATRIX_LISTING_NOT_FOUND');

assert.ok(botCode.includes('JAMAIS inventer, corriger ou suggérer un autre numéro Centris'));
assert.ok(botCode.includes('verifier_listing_centris: 120000'));
assert.ok(botCode.includes('if (timer) clearTimeout(timer)'));
assert.ok(cuaCode.includes('[ZONE-DIAG]'));
assert.ok(cuaCode.includes('waitForZoneAppReady'));
assert.ok(cuaCode.includes("code: 'ZONE_APP_BLANK'"));
assert.ok(!cuaCode.includes("'sec-fetch-dest': 'document'"));
assert.ok(botCode.includes('enforceCentrisNumberFidelity'));
assert.ok(botCode.includes('previewCentrisMatrixDocuments({ centris_num: num })'), 'le preview doit utiliser Matrix global, pas Zone Courtier');
assert.ok(botCode.includes('executeMatrixAnnexesTool({'), 'les annexes externes doivent suivre le chemin Matrix canonique');
assert.ok(botCode.includes("category: 'centris-matrix-annexes'"), 'l’envoi des annexes Matrix doit passer par sendEmailLogged');
assert.ok(botCode.includes('Aucun email envoyé pour éviter un dossier partiel'), 'un téléchargement partiel doit bloquer l’email');
assert.ok(botCode.includes("url.startsWith('/admin/matrix-test') || url.startsWith('/admin/zone-test')"), 'le diagnostic historique Zone doit être redirigé vers Matrix global');
assert.ok(!botCode.includes('Exception preview Zone:'), 'les erreurs de preview ne doivent plus attribuer Matrix à la Zone');
assert.ok(cuaCode.includes('Recherche globale exacte'), 'le chemin Matrix global doit journaliser la recherche exacte');
assert.ok(!cuaCode.includes('cb.checked = true; cb.click()'), 'sélectionner un format ne doit pas cocher puis décocher la case');
assert.ok(!cuaCode.includes('const navigatedOK = true'), 'le téléchargement de fiche ne doit pas cliquer deux fois le même résultat');
assert.ok(cuaCode.includes("normalize('NFD')"), 'le format Détaillé doit être reconnu avec ou sans accent');

assert.deepStrictEqual(
  cua._extractTaxCandidatesFromText('Taxes municipales : 2 345 $\nTaxes scolaires : 412 $', 'taxes?\\s*municipal(?:e|es|aux)?'),
  [2345]
);
assert.deepStrictEqual(
  cua._extractTaxCandidatesFromText('Taxes municipales 2025 : 2 345 $\nTaxes municipales estimées : 2 510 $', 'taxes?\\s*municipal(?:e|es|aux)?'),
  [2345, 2510]
);
assert.ok(cuaCode.includes("data.taxes_provenance = 'pdf-text-fallback'"));
assert.ok(cuaCode.includes('data.taxes_ambiguous'));

console.log('✅ Inventaire Centris sans perte + compatibilité + manifestes OK');
