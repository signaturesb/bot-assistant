'use strict';

const assert = require('assert');
const {
  extractActiveDeploymentClaim,
  isProtectedStateFile,
  messageExplicitlyAuthorizesGitHubWrite,
  shasMatch,
  verifyProtectedStateWrite,
} = require('./lib/deployment_truth_guard');

assert.strictEqual(isProtectedStateFile('SESSION_LIVE.md'), true);
assert.strictEqual(isProtectedStateFile('/docs/CURRENT_STATE.md'), true);
assert.strictEqual(isProtectedStateFile('README.md'), false);
assert.strictEqual(extractActiveDeploymentClaim('Commit applicatif déployé: `abcdef1`').sha, 'abcdef1');
assert.strictEqual(extractActiveDeploymentClaim('Commits déployés: abcdef1, bcdefa2').ambiguous, true);
assert.strictEqual(shasMatch('abcdef1', 'abcdef1234567890'), true);
assert.strictEqual(shasMatch('abcdef1', '1234567'), false);
assert.strictEqual(messageExplicitlyAuthorizesGitHubWrite('Oui, mets à jour SESSIONLIVE sur GitHub', 'SESSION_LIVE.md'), true);
assert.strictEqual(messageExplicitlyAuthorizesGitHubWrite('Mets à jour SESSIONLIVE', 'SESSION_LIVE.md'), false);
assert.strictEqual(messageExplicitlyAuthorizesGitHubWrite('Regarde SESSIONLIVE sur GitHub', 'SESSION_LIVE.md'), false);

(async () => {
  const productionUrl = 'https://bot.example';
  const goodFetch = async url => ({
    ok: url === `${productionUrl}/version`,
    status: 200,
    json: async () => ({ commit: 'abcdef1' }),
  });
  const mismatchFetch = async () => ({ ok: true, status: 200, json: async () => ({ commit: '7654321' }) });

  assert.deepStrictEqual(
    await verifyProtectedStateWrite({ filePath: 'README.md', content: 'Commit actif: abcdef1' }),
    { ok: true, protected: false },
  );
  assert.strictEqual((await verifyProtectedStateWrite({
    filePath: 'SESSION_LIVE.md', content: 'Commit applicatif déployé: abcdef1', productionUrl, fetchImpl: goodFetch,
  })).ok, true);
  const mismatch = await verifyProtectedStateWrite({
    filePath: 'SESSION_LIVE.md', content: 'Commit applicatif déployé: abcdef1', productionUrl, fetchImpl: mismatchFetch,
  });
  assert.strictEqual(mismatch.ok, false);
  assert.strictEqual(mismatch.code, 'VERSION_MISMATCH');
  const ambiguous = await verifyProtectedStateWrite({
    filePath: 'ÉTAT_SYSTÈME.md', content: 'Commits déployés: abcdef1 et bcdefa2', productionUrl, fetchImpl: goodFetch,
  });
  assert.strictEqual(ambiguous.code, 'AMBIGUOUS_DEPLOYMENT_CLAIM');

  console.log('✅ Garde de vérité GitHub/Render/SESSION_LIVE OK');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
