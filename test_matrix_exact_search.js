'use strict';

const assert = require('assert');
const {
  _matrixTextContainsExactNumber: containsExact,
  _scoreMatrixSearchCandidate: scoreSearch,
  _classifyMatrixPageSnapshot: classify,
} = require('./cua_driver');

assert(containsExact('No Centris 28936167', '28936167'));
assert(!containsExact('No Centris 1289361670', '28936167'));
assert(!containsExact('Résultats 289361670 et 28936168', '28936167'));

assert(scoreSearch('QueryText global search', { width: 700, y: 100 }) >= 100);
assert(scoreSearch('omnisearch MLS Centris', { width: 500, y: 80 }) >= 100);
assert(scoreSearch('clientSearch email', { width: 800, y: 100 }) < 100);
assert(scoreSearch('municipalite critère', { width: 700, y: 120 }) < 100);
assert(scoreSearch('adresse', { width: 900, y: 100 }) < 100);

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
  mediaLinkCount: 0,
}, '28936167').code, 'MATRIX_LISTING_READY_NO_DOCUMENTS');

console.log('✅ Matrix exact search: semantic selector and exact-listing guards passed');
