'use strict';

const assert = require('assert');
const { hasExplicitWriteIntent, requirePipedriveWriteIntent } = require('./lib/pipedrive_write_guard');

assert.strictEqual(hasExplicitWriteIntent('analyse mes leads aujourd hui', 'create'), false);
assert.strictEqual(hasExplicitWriteIntent('qu est-ce que je devrais faire avec Jean?', 'update'), false);
assert.strictEqual(hasExplicitWriteIntent('crée le lead Jean Tremblay', 'create'), true);
assert.strictEqual(hasExplicitWriteIntent('ajoute une activité pour Jean demain', 'create'), true);
assert.strictEqual(hasExplicitWriteIntent('mets-moi un suivi demain pour Jean', 'create'), true);
assert.strictEqual(hasExplicitWriteIntent('supprime le deal Jean', 'delete'), true);
assert.strictEqual(hasExplicitWriteIntent('fusionne les deux deals Jean', 'merge'), true);
assert.strictEqual(hasExplicitWriteIntent('email entrant nouveau prospect Jean', 'create'), false);

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

console.log('✅ Pipedrive write guard tests OK');
