'use strict';

const assert = require('assert');
const fs = require('fs');
const { evaluateConnectionResults } = require('./lib/connection_monitor');

const failed = {
  telegram: { ok: false, detail: 'HTTP 503', critical: true },
  sentry: { ok: false, detail: 'non configuré', critical: false },
};
let state = {};
for (let attempt = 1; attempt <= 2; attempt++) {
  const run = evaluateConnectionResults(state, failed, { now: attempt * 1000, threshold: 3 });
  assert.strictEqual(run.alerts.length, 0, 'un incident transitoire ne doit pas alerter');
  state = run.state;
}

let run = evaluateConnectionResults(state, failed, { now: 3000, threshold: 3 });
assert.deepStrictEqual(run.alerts.map(item => item.name), ['telegram']);
assert.strictEqual(run.state.checks.telegram.alertActive, true);
assert.strictEqual(run.state.checks.sentry.alertActive, false, 'une dépendance informative ne doit pas devenir critique');
state = run.state;

run = evaluateConnectionResults(state, failed, { now: 4000, threshold: 3, cooldownMs: 60_000 });
assert.strictEqual(run.alerts.length, 0, 'une panne persistante ne doit pas spammer');
state = run.state;

run = evaluateConnectionResults(state, {
  telegram: { ok: true, detail: 'getMe + webhook OK', critical: true },
  sentry: { ok: true, detail: 'actif', critical: false },
}, { now: 5000, threshold: 3 });
assert.strictEqual(run.recoveries.length, 0, 'une seule réussite ne doit pas annoncer trop vite un rétablissement');
state = run.state;
run = evaluateConnectionResults(state, {
  telegram: { ok: true, detail: 'getMe + webhook OK', critical: true },
  sentry: { ok: true, detail: 'actif', critical: false },
}, { now: 6000, threshold: 3 });
assert.deepStrictEqual(run.recoveries.map(item => item.name), ['telegram']);
assert.strictEqual(run.state.allCriticalOk, true);
assert.strictEqual(run.state.checks.telegram.consecutiveFailures, 0);

const bot = fs.readFileSync('./bot.js', 'utf8');
assert.match(bot, /safeCron\('structure-connections',[\s\S]*?10 \* 60 \* 1000/,
  'la surveillance structurelle doit tourner toutes les 10 minutes sans chevauchement');
assert.match(bot, /gmailAPI\('\/profile'\)/,
  'Gmail doit être vérifié en lecture seule sans messages\/send');
assert.match(bot, /scheduleCentrisMaintenanceRetry\(\)/,
  'une validation Centris échouée doit programmer un retry borné');
assert.match(bot, /connection_health: structureConnectionState/,
  'la preuve des connexions doit être exposée dans le health endpoint');
assert.match(bot, /structure-health-critical/,
  'une panne Telegram doit pouvoir basculer vers les canaux de secours');

console.log('✅ Surveillance connexions: 3 échecs, anti-spam et reprise vérifiés');
