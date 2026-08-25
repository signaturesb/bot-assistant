'use strict';

const fs = require('fs');
const assert = require('assert');
const vm = require('vm');
const { hasExplicitWriteIntent, requirePipedriveWriteIntent } = require('./lib/pipedrive_write_guard');

assert.strictEqual(hasExplicitWriteIntent('analyse mes leads aujourd hui', 'create'), false);
assert.strictEqual(hasExplicitWriteIntent('qu est-ce que je devrais faire avec Jean?', 'update'), false);
assert.strictEqual(hasExplicitWriteIntent('crée le lead Jean Tremblay', 'create'), true);
assert.strictEqual(hasExplicitWriteIntent('/lead Jean Tremblay 514-555-1212', 'create'), true);
assert.strictEqual(hasExplicitWriteIntent('ajoute une activité pour Jean demain', 'create'), true);
assert.strictEqual(hasExplicitWriteIntent('mets-moi un suivi demain pour Jean', 'create'), true);
assert.strictEqual(hasExplicitWriteIntent('supprime le deal Jean', 'delete'), true);
assert.strictEqual(hasExplicitWriteIntent('fusionne les deux deals Jean', 'merge'), true);
assert.strictEqual(hasExplicitWriteIntent('email entrant nouveau prospect Jean', 'create'), false);
assert.strictEqual(hasExplicitWriteIntent('enregistre ce résumé d appel dans Pipedrive', 'create'), true);
assert.strictEqual(hasExplicitWriteIntent('je viens de parler avec Jean', 'create'), false);

assert.throws(
  () => requirePipedriveWriteIntent({ message: 'email entrant nouveau prospect Jean', action: 'create', source: 'gmail' }),
  e => e && e.code === 'PIPEDRIVE_WRITE_BLOCKED'
);

assert.throws(
  () => requirePipedriveWriteIntent({ message: 'supprime le deal Jean', action: 'delete', source: 'telegram' }),
  e => e && e.code === 'PIPEDRIVE_CONFIRM_REQUIRED'
);

assert.doesNotThrow(() => requirePipedriveWriteIntent({
  message: 'supprime le deal Jean', action: 'delete', source: 'telegram', confirmed: true
}));

// Integration test: a standalone guard module is NOT enough. The production bot
// must import and invoke it before any Pipedrive write path can be considered safe.
const botCode = fs.readFileSync('bot.js', 'utf8');
assert.ok(
  botCode.includes("require('./lib/pipedrive_write_guard')") || botCode.includes('require("./lib/pipedrive_write_guard")'),
  'bot.js must import lib/pipedrive_write_guard'
);
assert.ok(
  botCode.includes('requirePipedriveWriteIntent('),
  'bot.js must invoke requirePipedriveWriteIntent before Pipedrive writes'
);
assert.ok(
  botCode.includes('const pipedriveWriteScope = new AsyncLocalStorage()'),
  'Pipedrive writes need a central async authorization scope'
);
assert.ok(
  botCode.includes("err.code = 'PIPEDRIVE_WRITE_SCOPE_REQUIRED'"),
  'pdRequest must fail closed outside the authorized scope'
);
assert.ok(botCode.includes('pendingPipedriveActivityActions'), 'scheduled CRM actions need a persisted confirmation transaction');
assert.ok(botCode.includes('pipedriveActionSnapshot'), 'scheduled CRM preview must be content-bound');
assert.ok(botCode.includes('normalizeScheduledAction'), 'scheduled CRM actions need deterministic calendar validation');
assert.ok(botCode.includes('PIPEDRIVE_ACTIVITY_CONFIRM_REGEX'), 'scheduled CRM actions need exact separate confirmation');
assert.ok(
  botCode.includes("const PD_V2_BASE = 'https://api.pipedrive.com/api/v2'"),
  'activity reads must use the current Pipedrive v2 API'
);
assert.ok(botCode.includes('async function pdGetActivities('), 'central filtered Pipedrive activity reader missing');
assert.ok(
  botCode.includes("if (raw === null || raw === undefined || raw === '') return null;"),
  'Pipedrive relation IDs must reject empty values instead of converting null to 0'
);
assert.ok(
  botCode.includes('Number.isSafeInteger(id) && id > 0 ? id : null'),
  'Pipedrive relation IDs must be positive safe integers'
);
const normalizeSource = botCode.match(/function normalizePipedriveRelationId\(value\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(normalizeSource, 'Pipedrive relation ID normalizer must be testable');
const normalizePipedriveRelationId = vm.runInNewContext(`(${normalizeSource})`);
for (const emptyValue of [null, undefined, '', 0, '0', -1, 'abc', 1.5]) {
  assert.strictEqual(normalizePipedriveRelationId(emptyValue), null, `invalid Pipedrive ID accepted: ${String(emptyValue)}`);
}
assert.strictEqual(normalizePipedriveRelationId(1358), 1358);
assert.strictEqual(normalizePipedriveRelationId('2506'), 2506);
assert.strictEqual(normalizePipedriveRelationId({ value: 5251 }), 5251);
assert.ok(
  !/pdGet\(`\/deals\/\$\{[^}]+\}\/activities/.test(botCode),
  'retired nested deal activities endpoint is still used'
);
assert.ok(
  !/pdGet\(`\/persons\/\$\{[^}]+\}\/activities/.test(botCode),
  'retired nested person activities endpoint is still used'
);
for (const tool of ['modifier_deal', 'deplacer_activite', 'enregistrer_resume_appel']) {
  assert.ok(new RegExp(`${tool}:\\s*['\"](?:create|update|move)['\"]`).test(botCode), `${tool} must be guarded`);
}

console.log('✅ Pipedrive write guard tests OK — module + bot.js integration');
