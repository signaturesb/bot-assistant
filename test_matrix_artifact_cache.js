'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  cacheRoot,
  safeRemoveRequest,
  writeMatrixArtifactCache,
  loadMatrixArtifactCache,
  purgeExpiredMatrixArtifactCaches,
} = require('./lib/matrix_artifact_cache');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-artifact-cache-test-'));
const recipient = 'client@example.com';
const num = '28936167';
const fingerprint = crypto.createHash('sha256').update('payload-v1').digest('hex');
const pdf = (name) => ({
  filename: `${name}.pdf`,
  label: name,
  buffer: Buffer.from(`%PDF-1.4\n${name}\n%%EOF`, 'utf8'),
  page_count: 1,
  source: 'matrix-global',
});

function write(requestId, expiresAt = Date.now() + 60_000) {
  return writeMatrixArtifactCache({
    dataDir: testRoot,
    requestId,
    num,
    filtre: '',
    fingerprint,
    recipient,
    expiresAt,
    documents: [pdf('fiche'), pdf('declaration')],
    listing: {
      centris_num: num,
      address: '440, Rue du Bord-de-l’Eau, Saint-Alphonse-Rodriguez',
      address_complete: true,
      address_source: 'matrix-listing-report-pdf',
    },
  });
}

try {
  // Redémarrage simulé: aucune Map mémoire; la recharge vient uniquement du disque.
  const restartId = 'mx1111111111111111';
  const written = write(restartId);
  assert.strictEqual(fs.statSync(cacheRoot(testRoot)).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(written.directory).mode & 0o777, 0o700);
  assert.strictEqual(fs.statSync(path.join(written.directory, 'manifest.json')).mode & 0o777, 0o600);
  assert.strictEqual(fs.statSync(path.join(written.directory, 'document-001.pdf')).mode & 0o777, 0o600);
  const rawManifest = fs.readFileSync(path.join(written.directory, 'manifest.json'), 'utf8');
  assert.ok(!rawManifest.includes(recipient), 'le manifeste ne doit pas stocker le courriel en clair');
  const afterRestart = loadMatrixArtifactCache({ dataDir: testRoot, requestId: restartId, num, fingerprint, recipient });
  assert.strictEqual(afterRestart.ok, true);
  assert.strictEqual(afterRestart.artifact.documents.length, 2);
  assert.strictEqual(afterRestart.artifact.listing.address_complete, true);

  // Une corruption de n’importe quel octet invalide et nettoie toute la demande.
  const corruptId = 'mx2222222222222222';
  const corrupt = write(corruptId);
  fs.appendFileSync(path.join(corrupt.directory, 'document-001.pdf'), 'corruption');
  const corruptLoad = loadMatrixArtifactCache({ dataDir: testRoot, requestId: corruptId, num, fingerprint, recipient });
  assert.strictEqual(corruptLoad.ok, false);
  assert.strictEqual(corruptLoad.code, 'MATRIX_CACHE_DOCUMENT_CORRUPT');
  assert.strictEqual(fs.existsSync(corrupt.directory), false);

  // Numéro, empreinte ou destinataire différents ne réutilisent jamais le cache.
  for (const [requestId, mismatch] of [
    ['mx3333333333333333', { num: '27550924', fingerprint, recipient }],
    ['mx4444444444444444', { num, fingerprint: 'f'.repeat(64), recipient }],
    ['mx5555555555555555', { num, fingerprint, recipient: 'autre@example.com' }],
  ]) {
    const entry = write(requestId);
    const loaded = loadMatrixArtifactCache({ dataDir: testRoot, requestId, ...mismatch });
    assert.strictEqual(loaded.ok, false);
    assert.strictEqual(fs.existsSync(entry.directory), false);
  }

  // TTL expiré: refus et suppression; purge globale nettoie aussi les restes.
  const expiredId = 'mx6666666666666666';
  const expired = write(expiredId, Date.now() + 1000);
  const expiredLoad = loadMatrixArtifactCache({
    dataDir: testRoot, requestId: expiredId, num, fingerprint, recipient, now: Date.now() + 2000,
  });
  assert.strictEqual(expiredLoad.ok, false);
  assert.strictEqual(expiredLoad.code, 'MATRIX_CACHE_EXPIRED');
  assert.strictEqual(fs.existsSync(expired.directory), false);

  const purgeId = 'mx7777777777777777';
  const purge = write(purgeId, Date.now() + 1000);
  const stalePartial = path.join(cacheRoot(testRoot), '.partial-mx8888888888888888-deadbeef');
  fs.mkdirSync(stalePartial, { mode: 0o700 });
  fs.writeFileSync(path.join(stalePartial, 'orphan.pdf'), '%PDF-1.4\npartial\n%%EOF');
  assert.strictEqual(purgeExpiredMatrixArtifactCaches(testRoot, Date.now() + 2000), 2);
  assert.strictEqual(fs.existsSync(purge.directory), false);
  assert.strictEqual(fs.existsSync(stalePartial), false, 'un cache partiel abandonné doit être purgé au redémarrage');

  assert.strictEqual(safeRemoveRequest(testRoot, restartId), true);
  assert.strictEqual(fs.existsSync(written.directory), false);
  assert.strictEqual(safeRemoveRequest(testRoot, '../../escape'), false);

  console.log('✅ Cache Matrix privé: restart, permissions, mismatch, corruption, TTL et cleanup OK');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
