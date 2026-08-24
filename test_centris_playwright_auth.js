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
assert(cuaSource.includes('async function cuaLoginCentris()'), 'La connexion Playwright explicite doit être exposée');
assert(botSource.includes('cua?.isAwaitingCentrisMFA?.()'), 'Telegram doit détecter une attente MFA Playwright');
assert(botSource.includes('cua.ingestManualMFACode(code)'), 'Telegram doit transmettre le code à Playwright');
assert(botSource.includes('cua.ingestManualMFACode(data.code)'), 'Le pont Messages doit transmettre automatiquement le code à Playwright');
assert(botSource.includes('playwrightAccepted'), 'Le webhook SMS doit auditer si Playwright a consommé le code');
assert(cuaSource.includes('process.env.BROWSERLESS_WS ? 40000 : 180000'), 'L’attente MFA doit respecter la limite de session Browserless');
assert(botSource.includes('const result = await centrisLoginDetailed();'), 'La commande Telegram doit utiliser la connexion Playwright vérifiée');
assert(botSource.includes('await cua.cuaLoginCentris()'), 'Le runtime Centris doit utiliser Playwright comme source unique');
assert.strictEqual((botSource.match(/centrisOAuthLoginWithMFA\(/g) || []).length, 1, 'L’ancien parseur OAuth ne doit plus être appelé');
assert(!botSource.includes('bot.onText(/\\/centris/'), 'Un handler /centris trop large ne doit pas intercepter /centris-status');
assert(botSource.includes('bot.onText(/^\\/centris(?:@\\w+)?\\s*$/i'), 'La commande /centris doit être strictement délimitée');
assert(botSource.includes('Pré-login réseau désactivé au boot'), 'Un déploiement ne doit jamais déclencher un MFA Centris');

assert(cuaSource.includes('/admin/centris-mfa-code?after=${start}'), 'La récupération Gmail doit limiter les codes à la tentative courante');
assert(botSource.includes('internalDate < afterMs - 30000'), 'Les codes Gmail périmés doivent être ignorés');
assert(cuaSource.includes("'content-type': 'text/plain; charset=utf-8'"), 'Les cookies doivent être poussés au format texte attendu');
assert(cuaSource.includes('body: cookieStr'), 'Le body admin doit contenir le Cookie header brut');
assert(!cuaSource.includes('body: JSON.stringify({ cookies: cookieStr'), 'Le body cookies JSON incompatible ne doit pas revenir');

assert(autoLoginSource.includes('process.env.CENTRIS_USER'), 'Le script autonome doit lire CENTRIS_USER depuis l’environnement');
assert(autoLoginSource.includes('process.env.CENTRIS_PASS'), 'Le script autonome doit lire CENTRIS_PASS depuis l’environnement');
assert(autoLoginSource.includes('process.env.WEBHOOK_SECRET'), 'Le script autonome doit lire WEBHOOK_SECRET depuis l’environnement');
assert(!autoLoginSource.includes('.env.shared'), 'Le script autonome ne doit pas extraire un secret depuis un fichier local');
assert(!/const\s+(?:USER|PASS)\s*=\s*['"][^'"]+['"]/.test(autoLoginSource), 'Aucun identifiant Centris ne doit être codé en dur');

const {
  _browserlessEndpointWithTimeout,
  _cookieHeaderFromPlaywrightCookies,
  _isAuthenticatedCentrisUrl,
  _hasExplicitCentrisSendConfirmation,
} = require('./cua_driver');
const endpoint = _browserlessEndpointWithTimeout('wss://example.invalid/chromium?token=test-token&foo=bar', 175000);
const parsed = new URL(endpoint);
assert.strictEqual(parsed.searchParams.get('token'), 'test-token', 'Le paramètre Browserless existant doit être préservé');
assert.strictEqual(parsed.searchParams.get('foo'), 'bar', 'Les paramètres Browserless existants doivent être préservés');
assert.strictEqual(parsed.searchParams.get('timeout'), '60000', 'Le délai Browserless doit être plafonné à 60 000 ms');

const shortEndpoint = _browserlessEndpointWithTimeout('wss://example.invalid/chromium?token=test-token', 45000);
assert.strictEqual(new URL(shortEndpoint).searchParams.get('timeout'), '45000', 'Un délai Browserless valide doit être conservé');

const cookieHeader = _cookieHeaderFromPlaywrightCookies([
  { name: 'matrix', value: 'abc', domain: '.matrix.centris.ca' },
  { name: 'zone', value: 'def', domain: 'zone.centris.ca' },
  { name: 'shared', value: 'ghi', domain: '.centris.ca' },
  { name: 'auth0', value: 'exclude', domain: 'accounts.centris.ca' },
  { name: 'foreign', value: 'exclude', domain: 'example.com' },
]);
assert(cookieHeader.includes('matrix=abc'), 'Les cookies Matrix doivent être conservés');
assert(cookieHeader.includes('shared=ghi'), 'Les cookies Centris partagés doivent être conservés');
assert(!cookieHeader.includes('zone=def'), 'Les cookies propres à Zone ne doivent pas être envoyés à Matrix');
assert(!cookieHeader.includes('auth0=exclude'), 'Les cookies Auth0 ne doivent pas être envoyés à Matrix');
assert(!cookieHeader.includes('foreign=exclude'), 'Les cookies hors Centris doivent être exclus');

assert(_isAuthenticatedCentrisUrl('https://matrix.centris.ca/Matrix/'), 'Une page Matrix doit être reconnue');
assert(_isAuthenticatedCentrisUrl('https://zone.centris.ca/Dashboard'), 'Une page Zone connectée doit être reconnue');
assert(!_isAuthenticatedCentrisUrl('https://accounts.centris.ca/Account/Login'), 'La page comptes ne doit jamais être considérée connectée');
assert(!_isAuthenticatedCentrisUrl('chrome-error://chromewebdata/'), 'Une page d’erreur Chrome ne doit jamais être considérée connectée');

assert(_hasExplicitCentrisSendConfirmation('envoie'), '« envoie » doit autoriser une seule tentative Centris');
assert(_hasExplicitCentrisSendConfirmation('send!'), '« send! » doit être accepté');
for (const vague of ['go', 'oui', 'ok', 'parfait', 'vas-y']) {
  assert(!_hasExplicitCentrisSendConfirmation(vague), `${vague} ne doit jamais autoriser un envoi Centris`);
}

console.log('✅ Centris Playwright auth bridge: tests passed');
