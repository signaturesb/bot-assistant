'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  openPayload,
  readSessionFile,
  sealPayload,
  writeSessionFile,
} = require('./lib/centris_session_store');

const payload = {
  cookies: 'matrix=secret-value; shared=another-secret',
  expiry: Date.now() + 60000,
  storageState: { cookies: [{ name: 'matrix', value: 'secret-value' }], origins: [] },
};
const secret = 'unit-test-session-key-with-enough-entropy';

const sealed = sealPayload(payload, secret);
assert.strictEqual(sealed.protected, true);
assert.throws(() => sealPayload(payload, ''), /CENTRIS_SESSION_KEY requis/, 'Une session sensible ne doit jamais être écrite en clair');
assert(!JSON.stringify(sealed).includes('secret-value'), 'Un état chiffré ne doit contenir aucun cookie en clair');
assert.deepStrictEqual(openPayload(sealed, secret), payload);
assert.throws(() => openPayload(sealed, 'wrong-key'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'centris-session-'));
const encryptedFile = path.join(tmpDir, 'encrypted.json');
writeSessionFile(encryptedFile, payload, { secret });
assert.deepStrictEqual(readSessionFile(encryptedFile, { secret }), payload);
assert.strictEqual(fs.statSync(encryptedFile).mode & 0o777, 0o600, 'Le fichier de session doit être privé (0600)');
assert(!fs.readFileSync(encryptedFile, 'utf8').includes('secret-value'));

const legacyFile = path.join(tmpDir, 'legacy.json');
fs.writeFileSync(legacyFile, JSON.stringify(payload));
assert.deepStrictEqual(readSessionFile(legacyFile, { secret }), payload, 'La migration doit lire un ancien fichier JSON en clair');
writeSessionFile(legacyFile, payload, { secret });
assert(!fs.readFileSync(legacyFile, 'utf8').includes('secret-value'), 'La prochaine sauvegarde doit migrer le fichier en clair vers chiffré');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log('✅ Centris session store: chiffrement, migration et permissions OK');
