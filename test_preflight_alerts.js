#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { evaluateSmsHmacSelfTest, evaluateActiveTemplate } = require('./lib/preflight_checks');

const hmac = evaluateSmsHmacSelfTest('test-secret');
assert.strictEqual(hmac.ok, true);
assert.match(hmac.detail, /route SMS \(401 attendu\)/);
assert.doesNotMatch(hmac.detail, /410|confirm/i,
  'le preflight ne doit jamais confondre le lien campagne 410 avec la route SMS');
assert.strictEqual(evaluateSmsHmacSelfTest('').ok, false);

const active = evaluateActiveTemplate({
  ok: true,
  sha256: 'abcdef1234567890',
  bytes: 62 * 1024,
});
assert.strictEqual(active.ok, true);
assert.match(active.detail, /structure active OK/);
assert.doesNotMatch(active.detail, /backup|diff|corruption/i,
  'une sauvegarde historique ne fait pas partie du verdict du template actif');

const invalid = evaluateActiveTemplate({ ok: false, errors: ['marqueur absent'] });
assert.strictEqual(invalid.ok, false);
assert.match(invalid.detail, /marqueur absent/);

console.log('✅ preflight alerts: HMAC SMS et template actif sans faux WARN');
