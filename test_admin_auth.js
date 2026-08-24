'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getBearerToken, isAdminAuthorized } = require('./lib/admin_auth');

const secret = 'test-secret-123';
assert.strictEqual(getBearerToken({ authorization: `Bearer ${secret}` }), secret);
assert.strictEqual(getBearerToken({ authorization: `bearer ${secret}` }), secret);
assert.strictEqual(getBearerToken({ authorization: `Basic ${secret}` }), '');
assert.strictEqual(getBearerToken({ authorization: `Bearer ${secret} extra` }), '');
assert.strictEqual(isAdminAuthorized({}, secret), false);
assert.strictEqual(isAdminAuthorized({ authorization: `Bearer wrong-secret-12` }, secret), false);
assert.strictEqual(isAdminAuthorized({ authorization: `Bearer ${secret}` }, secret), true);
assert.strictEqual(isAdminAuthorized({ authorization: `Bearer ${secret}` }, ''), false);

const botSource = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');
const centrisSource = fs.readFileSync(path.join(__dirname, 'scripts', 'centris-auto-login.js'), 'utf8');
assert(!/searchParams\.get\(['"]token['"]\)/.test(botSource), 'admin secret found in URL parser');
assert(!/[?&]token=/.test(botSource), 'admin secret found in bot URL');
assert(!/[?&]token=/.test(centrisSource), 'admin secret found in Centris URL');
assert(botSource.includes("if (url.startsWith('/admin/') && !requireAdmin(req, res)) return;"), 'central admin gate missing');
assert(botSource.includes("AUCUNE_CONNEXION_MFA_ACTIVE"), 'MFA Gmail endpoint must be closed outside an active login');
assert(botSource.includes('validateCentrisSessionUrl(targetUrl)'), 'Centris cookie fetch must validate its destination');
assert(!botSource.includes('fetch(targetUrl, {'), 'Centris cookies must never be sent by a raw arbitrary fetch');
assert(botSource.includes('secretTestTarget(key, test_url, test_auth_header)'), 'secret tests must use canonical targets');
for (const route of ['/admin/brevo-send-now', '/admin/pipedrive-cleanup', '/admin/preview-via-gmail']) {
  assert(botSource.includes(`'${route}'`), `${route} must remain in the blocked legacy mutation list`);
}

console.log('✅ Admin Bearer auth: tests passed');
