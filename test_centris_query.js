'use strict';

const assert = require('assert');
const fs = require('fs');
const { parseCentrisComparableQuery, publicComparableListing } = require('./lib/centris_query');

const valid = parseCentrisComparableQuery('/centris/comparables?ville=Rawdon&type=terrain&jours=14');
assert.deepStrictEqual(valid, {
  ok: true,
  value: { ville: 'Rawdon', type: 'terrain', statut: 'vendu', jours: 14 },
});

const accented = parseCentrisComparableQuery('/centris/comparables?ville=Sainte-Lucie-des-Laurentides&type=maison&jours=365&statut=actif');
assert.strictEqual(accented.ok, true);
assert.strictEqual(accented.value.statut, 'actif');

for (const url of [
  '/centris/comparables?type=terrain&jours=14',
  '/centris/comparables?ville=Rawdon&type=script&jours=14',
  '/centris/comparables?ville=Rawdon&type=terrain&jours=0',
  '/centris/comparables?ville=Rawdon&type=terrain&jours=366',
  '/centris/comparables?ville=Rawdon%26admin%3Dtrue&type=terrain&jours=14',
]) {
  assert.strictEqual(parseCentrisComparableQuery(url).ok, false, `doit rejeter ${url}`);
}

assert.deepStrictEqual(publicComparableListing({
  mls: 'QC-12345678-extra',
  adresse: '  123   rue Test  ',
  ville: 'Rawdon',
  prix: '225000',
  superficie: '50000',
  dateVente: '2026-08-20',
  dateISO: '2026-08-20T00:00:00Z',
  annee: '2024',
  cookies: 'NE_DOIT_PAS_SORTIR',
}), {
  mls: '12345678',
  adresse: '123 rue Test',
  ville: 'Rawdon',
  prix: 225000,
  superficie: 50000,
  dateVente: '2026-08-20',
  dateISO: '2026-08-20T00:00:00Z',
  annee: 2024,
});

const botSource = fs.readFileSync('bot.js', 'utf8');
const routeStart = botSource.indexOf("url === '/centris/comparables'");
const routeEnd = botSource.indexOf('// ── Admin endpoints', routeStart);
assert.ok(routeStart > 0 && routeEnd > routeStart, 'route /centris/comparables absente');
const routeSource = botSource.slice(routeStart, routeEnd);
assert.match(routeSource, /requireCentrisAction\(req, res\)/, 'clé Centris dédiée obligatoire');
assert.doesNotMatch(routeSource, /requireAdmin\(req, res\)/, 'ne jamais exposer le secret admin au Custom GPT');
assert.doesNotMatch(routeSource, /searchParams\.get\(['"](?:token|key|secret)/i, 'secret interdit dans URL');

assert.match(botSource, /\/mfa\(\?:@\\w\+\)\?/, 'commande MFA Telegram de secours absente');
assert.match(botSource, /if \(!centrisLoginInProgress\)/, 'MFA manuel doit être limité à une connexion active');
assert.match(botSource, /mfaWaiters = mfaWaiters\.filter\(r => r !== wrappedResolve\)/, 'écouteur MFA expiré doit être retiré');
assert.match(botSource, /if \(centrisLoginInProgress\)/, 'les connexions Centris simultanées doivent être bloquées');
assert.doesNotMatch(botSource, /Code MFA reçu \([^)]*\).*\$\{(?:code|data\.code)\}/, 'le code MFA ne doit jamais être journalisé');
assert.match(botSource, /successfulRequests === 0 && lastError/, 'une panne Centris ne doit pas devenir un faux résultat vide');
assert.match(botSource, /if \(\/cookies\|mfa\|re-login\|auth\/i\.test/, 'une session invalide doit arrêter les tentatives OAuth répétées');

const openapi = fs.readFileSync('docs/centris_action_openapi.yaml', 'utf8');
assert.match(openapi, /https:\/\/signaturesb-bot-s272\.onrender\.com/, 'URL Render de production incorrecte');
assert.match(openapi, /operationId: get_comparables/, 'operationId manquant');
assert.match(openapi, /bearerAuth:/, 'authentification Bearer manquante');

console.log('✅ Centris query validation: OK');
