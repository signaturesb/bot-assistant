#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const { evaluateSmsHmacSelfTest, evaluateActiveTemplate } = require('./lib/preflight_checks');

const botSource = fs.readFileSync('./bot.js', 'utf8');
assert.match(botSource, /pendingLeads\.filter\(l => l\.needsName && Number\(l\.ts \|\| 0\) >= bootStartTs\)/,
  'le détecteur ne doit pas confondre le backlog restauré avec une panne apparue au démarrage');
assert.doesNotMatch(botSource, /leads sans nom valide — parser AI peut-être cassé/,
  'le bot ne doit pas diagnostiquer un parseur cassé à partir du seul nombre historique de leads en attente');

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
