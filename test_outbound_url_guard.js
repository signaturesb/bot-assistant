'use strict';
const assert = require('assert');
const { parseStrictHttpsUrl, isPrivateAddress, assertPublicHttpsUrl, validateCentrisSessionUrl, secretTestTarget, fetchWithValidatedRedirects } = require('./lib/outbound_url_guard');
async function run() {
  assert.strictEqual(validateCentrisSessionUrl('https://matrix.centris.ca/Matrix/Home').hostname, 'matrix.centris.ca');
  assert.strictEqual(validateCentrisSessionUrl('https://zone.centris.ca/doc').hostname, 'zone.centris.ca');
  for (const bad of ['http://matrix.centris.ca/', 'https://matrix.centris.ca.evil.test/', 'https://user:pass@matrix.centris.ca/', 'https://127.0.0.1/', 'https://matrix.centris.ca:8443/', 'https://accounts.centris.ca/']) assert.throws(() => validateCentrisSessionUrl(bad));
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.2', '::1']) assert.strictEqual(isPrivateAddress(address), true);
  assert.strictEqual(isPrivateAddress('8.8.8.8'), false);
  assert.strictEqual(isPrivateAddress('2606:4700:4700::1111'), false);
  const publicUrl = await assertPublicHttpsUrl('https://audio.example.test/file.mp3', async () => [{ address: '203.0.113.10' }]);
  assert.strictEqual(publicUrl.hostname, 'audio.example.test');
  await assert.rejects(() => assertPublicHttpsUrl('https://metadata.example.test/', async () => [{ address: '169.254.169.254' }]), /ADRESSE_PRIVEE_INTERDITE/);
  assert.throws(() => parseStrictHttpsUrl('http://example.com'), /HTTPS_REQUIS/);
  assert.strictEqual(secretTestTarget('OPENAI_API_KEY', 'https://api.openai.com/v1/models').url, 'https://api.openai.com/v1/models');
  assert.throws(() => secretTestTarget('OPENAI_API_KEY', 'https://evil.test/collect'), /TEST_URL_NON_AUTORISEE/);
  assert.throws(() => secretTestTarget('OTHER_KEY', 'https://api.openai.com/v1/models'), /TEST_NON_SUPPORTE/);
  let calls = 0;
  const fakeFetch = async () => { calls++; return { status: 302, headers: { get: () => 'https://evil.test/steal' } }; };
  await assert.rejects(() => fetchWithValidatedRedirects('https://matrix.centris.ca/start', fakeFetch, {}, validateCentrisSessionUrl), /HOTE_NON_AUTORISE/);
  assert.strictEqual(calls, 1);
  console.log('✅ outbound URL guard: Centris, secrets, DNS privé et redirects bloqués');
}
run().catch(error => { console.error(error); process.exit(1); });
