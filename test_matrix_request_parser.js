'use strict';

const assert = require('assert');
const {
  parseDirectMatrixRequest,
  looksLikeMatrixSendWithoutEmail,
  looksLikeMatrixSendCommand,
} = require('./lib/matrix_request_parser');

const expected = { centrisNum: '19465925', email: 'client@example.com', message: '' };

assert.deepStrictEqual(parseDirectMatrixRequest('19465925 client@example.com'), expected);
assert.deepStrictEqual(parseDirectMatrixRequest('#19465925 CLIENT@EXAMPLE.COM'), expected);
assert.deepStrictEqual(
  parseDirectMatrixRequest('Envoie les documents du #19465925 à client@example.com'),
  expected,
);
assert.deepStrictEqual(
  parseDirectMatrixRequest('envoie la fiche descriptive détaillée avec album de photos Centris 19465925 a client@example.com'),
  expected,
);
assert.deepStrictEqual(
  parseDirectMatrixRequest('envoie-moi les docs pour le 19465925 vers client@example.com'),
  expected,
);
assert.deepStrictEqual(
  parseDirectMatrixRequest('envoie 19465925 client@example.com Bonjour, voici le dossier.'),
  { ...expected, message: 'Bonjour, voici le dossier.' },
);

assert.strictEqual(parseDirectMatrixRequest('envoie les documents du #19465925'), null);
assert.strictEqual(looksLikeMatrixSendWithoutEmail('envoie les documents du #19465925'), true);
assert.strictEqual(looksLikeMatrixSendWithoutEmail('envoie-moi la fiche 19465925'), true);
assert.strictEqual(looksLikeMatrixSendWithoutEmail('voici le listing 19465925'), false);
assert.strictEqual(looksLikeMatrixSendWithoutEmail('envoie 19465925 client@example.com'), false);
assert.strictEqual(looksLikeMatrixSendCommand('envoie 19465925 client@example.com'), true);
assert.strictEqual(looksLikeMatrixSendCommand('19465925 client@example.com autre@example.com'), true);
assert.strictEqual(looksLikeMatrixSendCommand('voici le listing 19465925'), false);
assert.strictEqual(parseDirectMatrixRequest('envoie 123 client@example.com'), null);
assert.strictEqual(parseDirectMatrixRequest('envoie client@example.com'), null);
assert.strictEqual(
  parseDirectMatrixRequest('envoie 19465925 client@example.com copie autre@example.com'),
  null,
  'deux destinataires dans une commande doivent rester ambigus et bloqués',
);
assert.strictEqual(
  parseDirectMatrixRequest('envoie 19465925 client@example.com et aussi 28936167'),
  null,
  'deux listings dans une commande doivent rester ambigus et bloqués',
);

console.log('✅ Commande Matrix naturelle et destinataire obligatoire validés');
