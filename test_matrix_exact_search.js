'use strict';

const assert = require('assert');
const fs = require('fs');
const {
  _matrixTextContainsExactNumber: containsExact,
  _isExactMatrixListingLabel: isExactLabel,
  _scoreMatrixSearchCandidate: scoreSearch,
  _classifyMatrixPageSnapshot: classify,
} = require('./cua_driver');

assert(containsExact('No Centris 28936167', '28936167'));
assert(!containsExact('No Centris 1289361670', '28936167'));
assert(!containsExact('Résultats 289361670 et 28936168', '28936167'));
assert(isExactLabel('28936167', '28936167'));
assert(isExactLabel('  28936167\u00a0', '28936167'));
assert(!isExactLabel('No Centris 28936167', '28936167'));
assert(!isExactLabel('28936167 (En vigueur)', '28936167'));
assert(!isExactLabel('128936167', '28936167'));

assert(scoreSearch('QueryText global search', { width: 700, y: 100 }) >= 100);
assert(scoreSearch('omnisearch MLS Centris', { width: 500, y: 80 }) >= 100);
// Matrix 12.6 place parfois le mot « Search » sur le conteneur ou le bouton
// loupe adjacent plutôt que sur l'input lui-même.
assert(scoreSearch('text SearchContainer SearchButton', { width: 900, y: 220 }) >= 100);
assert(scoreSearch('clientSearch email', { width: 800, y: 100 }) < 100);
assert(scoreSearch('municipalite critère', { width: 700, y: 120 }) < 100);
assert(scoreSearch('adresse', { width: 900, y: 100 }) < 100);
assert(scoreSearch('', { width: 700, height: 42, y: 100 }) >= 100,
  'la barre Matrix v12.6 sans attribut sémantique doit être reconnue par sa géométrie d’en-tête');
assert(scoreSearch('form-control text', { width: 700, height: 42, y: 100 }) >= 100,
  'les attributs CSS/type génériques ne doivent pas masquer la barre Matrix d’en-tête');
assert(scoreSearch('', { width: 700, height: 42, y: 500 }) < 100,
  'un champ large hors en-tête ne doit pas être pris pour la recherche globale');
assert(scoreSearch('adresse', { width: 700, height: 42, y: 100 }) < 100,
  'un champ métier explicite reste exclu même s’il ressemble géométriquement à la barre globale');

assert.strictEqual(classify({
  url: 'https://matrix.centris.ca/Matrix/Results',
  text: 'Résultats comprenant 28936167',
  exactListingMentioned: true,
  mediaLinkCount: 0,
}, '28936167').code, 'MATRIX_NAVIGATION_UNVERIFIED');

assert.strictEqual(classify({
  url: 'https://matrix.centris.ca/Matrix/Detail',
  text: 'No Centris 28936167 Document(s) additionnel(s)',
  exactListingMentioned: true,
  detailEvidence: true,
  docs: [],
  mediaLinkCount: 0,
}, '28936167').code, 'MATRIX_LISTING_READY_NO_DOCUMENTS');

const driverCode = fs.readFileSync('./cua_driver.js', 'utf8');
assert.match(driverCode, /async function submitMatrixGlobalSearch/,
  'le parcours doit encapsuler la soumission de la recherche Matrix');
assert.match(driverCode, /search\.press\('Enter'\)[\s\S]*?best\.click/,
  'la loupe Matrix doit servir de repli quand Entrée ne navigue pas');
assert.match(driverCode, /button\[name="MagnifyingGlass"\]/,
  'le bouton réel observé dans Matrix v12.6 doit être ciblé explicitement');
assert.ok(!driverCode.includes("state.exactListingMentioned || /\\/Matrix\\/Results\\.aspx/i"),
  'une URL Results.aspx sans numéro exact ne doit jamais compter comme succès');
assert.match(driverCode, /clear\|effacer\|close\|fermer\|reset/,
  'le repli ne doit jamais cliquer le X d’effacement');

console.log('✅ Matrix exact search: semantic selector and exact-listing guards passed');
