'use strict';

const assert = require('assert');
const fs = require('fs');
const cua = require('./cua_driver');

const docs = [
  { name: 'Fiche détaillée 28603836.pdf', size: '412 KB' },
  { name: 'Déclaration du vendeur DV.pdf', size: '1.2 MB' },
  { name: 'Compte de taxes municipales.pdf', size: '88 KB' },
  { name: 'Plan cadastral.pdf', size: '730 KB' },
];

const inventory = cua._buildCentrisDocumentInventory('28603836', docs);
assert.strictEqual(inventory.docs.length, 4);
assert.ok(inventory.present.some((d) => d.key === 'fiche_detaillee'));
assert.ok(inventory.present.some((d) => d.key === 'declaration_vendeur'));
assert.ok(inventory.present.some((d) => d.key === 'taxes_municipales'));
assert.ok(inventory.present.some((d) => d.key === 'plans'));
assert.ok(inventory.missing.some((d) => d.key === 'taxes_scolaires'));
assert.ok(inventory.missing.some((d) => d.key === 'certificat_localisation'));
assert.match(inventory.manifest_id, /^[a-f0-9]{64}$/);

const reordered = cua._buildCentrisDocumentInventory('28603836', [...docs].reverse());
assert.strictEqual(reordered.manifest_id, inventory.manifest_id, 'ordre DOM ne doit pas changer l’empreinte');

const changed = cua._buildCentrisDocumentInventory('28603836', [...docs, { name: 'Taxes scolaires.pdf', size: '45 KB' }]);
assert.notStrictEqual(changed.manifest_id, inventory.manifest_id, 'ajout/retrait doit changer l’empreinte');

const botCode = fs.readFileSync('bot.js', 'utf8');
const cuaCode = fs.readFileSync('cua_driver.js', 'utf8');
assert.ok(botCode.includes('expectedManifestId: preview.manifest_id'), 'l’envoi doit être lié au dry-run');
assert.ok(cuaCode.includes('expectedManifestId !== inventory.manifest_id'), 'un inventaire changé doit bloquer');
assert.ok(cuaCode.includes('if (!isDryRun && !cb.checked) cb.click()'), 'le dry-run doit être transmis explicitement au contexte navigateur');

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
assert.ok(botCode.includes('JAMAIS inventer, corriger ou suggérer un autre numéro Centris'), 'le bot ne doit jamais halluciner un numéro alternatif');

assert.deepStrictEqual(
  cua._extractTaxCandidatesFromText('Taxes municipales : 2 345 $\nTaxes scolaires : 412 $', 'taxes?\\s*municipal(?:e|es|aux)?'),
  [2345]
);
assert.deepStrictEqual(
  cua._extractTaxCandidatesFromText('Taxes municipales 2025 : 2 345 $\nTaxes municipales estimées : 2 510 $', 'taxes?\\s*municipal(?:e|es|aux)?'),
  [2345, 2510],
  'plusieurs montants doivent rester ambigus au lieu de choisir le premier'
);
assert.ok(cuaCode.includes("data.taxes_provenance = 'pdf-text-fallback'"), 'la provenance fiscale doit être explicite');
assert.ok(cuaCode.includes('data.taxes_ambiguous'), 'les taxes ambiguës doivent être signalées');

console.log('✅ Inventaire documents Centris + garde manifest OK');
