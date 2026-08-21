'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const cuaSource = fs.readFileSync(path.join(root, 'cua_driver.js'), 'utf8');
const botSource = fs.readFileSync(path.join(root, 'bot.js'), 'utf8');
const autoLoginSource = fs.readFileSync(path.join(root, 'scripts', 'centris-auto-login.js'), 'utf8');

assert(!/\/admin\/[a-z0-9-]+\?token=/i.test(cuaSource), 'Les endpoints admin ne doivent jamais recevoir le secret dans la query string');
assert(!/encodeURIComponent\(token\)/.test(cuaSource), 'Le secret ne doit jamais être encodé dans une URL');
assert(cuaSource.includes('Authorization: `Bearer ${token}`'), 'Les appels internes CUA doivent utiliser Authorization Bearer');

assert(cuaSource.includes('function ingestManualMFACode'), 'Le pont MFA manuel doit exister');
assert(cuaSource.includes('function isAwaitingCentrisMFA'), 'L’état d’attente MFA doit être exposé');
assert(botSource.includes('cua?.isAwaitingCentrisMFA?.()'), 'Telegram doit détecter une attente MFA Playwright');
assert(botSource.includes('cua.ingestManualMFACode(code)'), 'Telegram doit transmettre le code à Playwright');

assert(autoLoginSource.includes('process.env.CENTRIS_USER'), 'Le script autonome doit lire CENTRIS_USER depuis l’environnement');
assert(autoLoginSource.includes('process.env.CENTRIS_PASS'), 'Le script autonome doit lire CENTRIS_PASS depuis l’environnement');
assert(autoLoginSource.includes('process.env.WEBHOOK_SECRET'), 'Le script autonome doit lire WEBHOOK_SECRET depuis l’environnement');
assert(!autoLoginSource.includes('.env.shared'), 'Le script autonome ne doit pas extraire un secret depuis un fichier local');
assert(!/const\s+(?:USER|PASS)\s*=\s*['"][^'"]+['"]/.test(autoLoginSource), 'Aucun identifiant Centris ne doit être codé en dur');

const { _browserlessEndpointWithTimeout } = require('./cua_driver');
const endpoint = _browserlessEndpointWithTimeout('wss://example.invalid/chromium?token=test-token&foo=bar', 175000);
const parsed = new URL(endpoint);
assert.strictEqual(parsed.searchParams.get('token'), 'test-token', 'Le paramètre Browserless existant doit être préservé');
assert.strictEqual(parsed.searchParams.get('foo'), 'bar', 'Les paramètres Browserless existants doivent être préservés');
assert.strictEqual(parsed.searchParams.get('timeout'), '175000', 'Le délai de session Browserless doit être explicite');

console.log('✅ Centris Playwright auth bridge: tests passed');
