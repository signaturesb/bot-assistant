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
assert(cuaSource.includes('async function settleCentrisAfterMFA(page)'), 'La redirection OAuth post-MFA doit être stabilisée');
assert(cuaSource.includes("return 'intermediate'"), 'La page intermédiaire SSO doit être reconnue avant de chercher un formulaire');
assert.match(cuaSource, /settleCentrisAfterMFA\(page\)[\s\S]*?OAuth Centris encore affiché après MFA — vérification directe Matrix/,
  'un endpoint OAuth bloqué doit être vérifié directement dans Matrix avant de déclarer le login en échec');
assert.match(cuaSource, /let authorizeRecoveryUsed = false;[\s\S]*?OAuth Centris sans formulaire — reprise unique depuis Matrix Login/,
  'un endpoint authorize sans formulaire doit reprendre une seule fois depuis le login Matrix officiel');
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
assert(botSource.includes("safeCron('centris-session-maintenance'"), 'La session Centris doit être entretenue automatiquement');
assert(botSource.includes("maintainCentrisSession('boot-delayed')"), 'Le boot doit programmer un renouvellement différé');
assert(botSource.includes("if (process.env.CENTRIS_SMOKE_TEST_LISTING) await runCentrisReadOnlySmokeTest('boot-delayed')"), 'Le smoke boot doit remplacer le renouvellement préalable pour éviter MultipleLoginBreach');
assert(botSource.includes('deux connexions Browserless strictement séquentielles'), 'Le smoke peut fractionner Browserless sans ouvrir deux navigateurs Matrix à la fois');
assert(cuaSource.includes('await context.close();\n      context = null;\n      await browser.close();\n      browser = null;\n\n      browser = await launchBrowser();'), 'La phase A doit être fermée avant le lancement Browserless B');
assert(cuaSource.includes('resumeVerifiedCentrisSession(context)'), 'La phase B doit reprendre strictement la session, sans nouveau login/MFA');
assert(cuaSource.includes('MATRIX_RESUME_INVENTORY_CHANGED'), 'Un inventaire modifié entre les phases doit bloquer la fiche');
assert(cuaSource.includes('const authenticatedCheckpoint = {'), 'La connexion/MFA doit être figée avant la phase de recherche PDF');
assert(cuaSource.includes('const deadline = Date.now() + 5000'), 'La stabilisation post-MFA doit garder une marge Browserless pour vérifier Matrix');
assert(cuaSource.includes("Symbol('matrix-annexes')"), 'Un verrou global doit couvrir toute l’opération Matrix A+B');
assert(cuaSource.includes('MATRIX_EXPECTED_DOCUMENT_COUNT_MISMATCH'), 'Un inventaire connu incomplet ne doit jamais devenir un faux succès');
assert(cuaSource.includes("content_manifest_id: complete ? contentManifest.content_manifest_id : null"), 'Un lot partiel ne doit jamais exposer un manifeste de contenu complet');
assert(cuaSource.includes('async function navigateToMatrixLogin(page)'), 'La navigation OAuth Matrix doit avoir une reprise dédiée');
assert(cuaSource.includes("waitUntil: 'commit', timeout: 45000"), 'La redirection OAuth ne doit pas attendre indéfiniment domcontentloaded');
assert(cuaSource.includes('if (step.kind !== \'missing\') return'), 'Un formulaire reconnu après timeout doit être conservé');
assert(botSource.includes('consecutiveFailures >= 3'), 'Les alertes de renouvellement doivent avoir un seuil anti-bruit');
assert(botSource.includes('failure-cooldown'), 'Une panne ne doit jamais créer une boucle MFA rapide');
assert(botSource.includes('sessionKey.length >= 32'), 'La maintenance automatique doit exiger une clé de session robuste');
assert(cuaSource.includes('/Matrix/Recherche'), 'La réutilisation doit être vérifiée sur une vraie page Matrix');
assert(cuaSource.includes('25 * 24 * 60 * 60 * 1000'), 'Le plafond local de session doit être de 25 jours');
assert(botSource.includes('centrisResponseNeedsLogin'), 'Les redirections vers accounts.centris.ca doivent déclencher un seul renouvellement');

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
assert(autoLoginSource.includes('centris-mfa-code?after=${startWait}'), 'Le login autonome doit borner le courriel MFA à la tentative courante');
assert(!autoLoginSource.includes('chat.db'), 'Le login autonome ne doit pas accepter un code Messages sans validation d’expéditeur');

const {
  _browserlessEndpointWithTimeout,
  _cookieHeaderFromPlaywrightCookies,
  _isAuthenticatedCentrisUrl,
  _isAuthenticatedMatrixPage,
  _isMatrixMultipleLoginPage,
  _safeCentrisPageLocation,
  _classifyCentrisLoginSnapshot,
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

assert(
  _isAuthenticatedMatrixPage('https://matrix.centris.ca/Matrix/Recherche', 0, 'Matrix — Recherche Critères Résultats Déconnexion'),
  'Une vraie page de recherche Matrix doit valider la session'
);
assert(
  !_isAuthenticatedMatrixPage('https://matrix.centris.ca/Matrix/Recherche', 0, 'Votre session est expirée. Connexion'),
  'Une URL Matrix avec contenu de session expirée doit être refusée'
);
assert(
  !_isAuthenticatedMatrixPage('https://matrix.centris.ca/Matrix/Recherche', 1, 'Matrix Recherche'),
  'Un formulaire de mot de passe visible doit invalider la session'
);
assert(
  !_isAuthenticatedMatrixPage('https://matrix.centris.ca/Matrix/Recherche', 0, ''),
  'Un shell Matrix vide ne doit jamais prouver une authentification'
);
assert(
  !_isAuthenticatedMatrixPage('https://matrix.centris.ca/Matrix/Error/MultipleLoginBreach.aspx', 0, 'Matrix'),
  'La page de connexions multiples ne doit jamais prouver une authentification'
);
assert(
  _isMatrixMultipleLoginPage('https://matrix.centris.ca/Matrix/Error/MultipleLoginBreach.aspx'),
  'La collision de sessions Matrix doit avoir un diagnostic déterministe'
);
assert.match(cuaSource, /await submitMatrixGlobalSearch\(page, search, exactNum\);[\s\S]*?MATRIX_MULTIPLE_LOGIN_BREACH/,
  'une collision déclenchée après le clic de recherche doit être signalée explicitement');
assert.match(cuaSource, /Session persistante non vérifiée[\s\S]*?\/Matrix\/Logout\.aspx[\s\S]*?Login Centris matrix \(fresh\)/,
  'une session Matrix persistée non vérifiée doit être fermée avant le renouvellement frais');
assert.match(cuaSource, /Session Matrix persistée fermée[\s\S]*?context\.clearCookies\(\)[\s\S]*?Login Centris matrix \(fresh\)/,
  'un état Auth0 partiel doit être nettoyé dans le contexte temporaire avant le login frais');

assert.strictEqual(_safeCentrisPageLocation(
  'https://accounts.centris.ca/Account/Login?ReturnUrl=%2Fconnect%2Fauthorize%3Fstate%3Dsecret'
), 'accounts.centris.ca/Account/Login', 'les paramètres OIDC ne doivent jamais entrer dans les logs');
assert.strictEqual(_classifyCentrisLoginSnapshot({
  url: 'https://accounts.centris.ca/Account/Login?ReturnUrl=secret',
  userCodeVisible: 1, passwordVisible: 1, identifierVisible: 0, bodyText: 'Connect to Matrix',
}), 'credentials', 'le formulaire Centris UserCode + Password doit être reconnu strictement');
assert.strictEqual(_classifyCentrisLoginSnapshot({
  url: 'https://centris-prod.ca.auth0.com/u/login/identifier?state=secret',
  userCodeVisible: 0, passwordVisible: 0, identifierVisible: 1, bodyText: 'Continue',
}), 'identifier', 'l’étape Auth0 identifier doit rester supportée');
assert.strictEqual(_classifyCentrisLoginSnapshot({
  url: 'https://centris-prod.ca.auth0.com/u/login/password?state=secret',
  userCodeVisible: 0, passwordVisible: 1, identifierVisible: 0, bodyText: 'Password',
}), 'password', 'l’étape Auth0 password doit rester supportée');
assert.strictEqual(_classifyCentrisLoginSnapshot({
  url: 'https://centris-prod.ca.auth0.com/u/mfa-sms-challenge?state=secret',
  userCodeVisible: 0, passwordVisible: 0, identifierVisible: 0, mfaVisible: 1, bodyText: 'Verification code',
}), 'mfa', 'l’étape MFA doit être reconnue sans tenter de remplir de nouveau les identifiants');
assert.strictEqual(_classifyCentrisLoginSnapshot({
  url: 'https://matrix.centris.ca/Matrix/',
  userCodeVisible: 0, passwordVisible: 0, identifierVisible: 0,
  bodyText: 'Matrix Recherche Critères Résultats Déconnexion',
}), 'authenticated', 'un retour SSO direct dans Matrix doit être accepté sans chercher un formulaire');
assert.strictEqual(_classifyCentrisLoginSnapshot({
  url: 'https://matrix.centris.ca/Matrix/',
  userCodeVisible: 0, passwordVisible: 0, identifierVisible: 0, bodyText: '',
}), 'missing', 'un shell Matrix vide ne doit recevoir aucun identifiant');

assert(!cuaSource.includes('input:visible:not([type="password"])'), 'le repli vers un champ arbitraire doit être supprimé');
assert(cuaSource.includes('CENTRIS_LOGIN_FORM_MISSING:'), 'une interface inconnue doit échouer avec un code déterministe');
assert(cuaSource.includes('CENTRIS_LOGIN_REJECTED:'), 'un formulaire identique après soumission doit échouer sans répéter le mot de passe');
assert(cuaSource.includes('renouvellement sans suppression'), 'une sonde refusée ne doit pas supprimer la session persistée');
assert(!cuaSource.includes('clearSession({ includeStorageState: true })'), 'le login ne doit jamais effacer le storageState avant validation du remplacement');

assert(_hasExplicitCentrisSendConfirmation('envoie'), '« envoie » doit autoriser une seule tentative Centris');
assert(_hasExplicitCentrisSendConfirmation('send!'), '« send! » doit être accepté');
for (const vague of ['go', 'oui', 'ok', 'parfait', 'vas-y']) {
  assert(!_hasExplicitCentrisSendConfirmation(vague), `${vague} ne doit jamais autoriser un envoi Centris`);
}

console.log('✅ Centris Playwright auth bridge: tests passed');
