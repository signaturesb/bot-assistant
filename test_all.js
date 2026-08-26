#!/usr/bin/env node
// test_all.js — runner unifié pour TOUS les tests du bot
// Usage: node test_all.js [--smoke]
// --smoke: test boot bot.js pour détecter erreurs runtime au load
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const runSmoke = args.includes('--smoke');

console.log('\n🧪 KIRA BOT — Test suite complète\n' + '═'.repeat(60));

let totalPassed = 0, totalFailed = 0;
const results = [];

function runScript(name, scriptPath, env = {}) {
  if (!fs.existsSync(scriptPath)) {
    results.push({ name, status: 'SKIP', detail: 'fichier absent' });
    return;
  }
  console.log(`\n▶ ${name}`);
  const r = spawnSync('node', [scriptPath], {
    env: { ...process.env, ...env },
    stdio: 'inherit',
    timeout: 30000,
  });
  const ok = r.status === 0;
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail: `exit ${r.status}` });
  if (ok) totalPassed++;
  else totalFailed++;
}

// 1. Parser tests
runScript('Parser tests', path.join(__dirname, 'test_parser.js'));

// Runtime safety: crons non chevauchants, Telegram, HMAC et persistance.
runScript('Runtime safety', path.join(__dirname, 'test_runtime_safety.js'));
runScript('Connection monitoring', path.join(__dirname, 'test_connection_monitor.js'));

// Preflight: ne pas confondre route campagne 410/HMAC SMS ni backup/template actif.
runScript('Preflight alerts', path.join(__dirname, 'test_preflight_alerts.js'));
runScript('Deployment truth guard', path.join(__dirname, 'test_deployment_truth_guard.js'));

// Dates/heures Toronto: calcul déterministe et contradictions bloquées.
runScript('Calendar guard', path.join(__dirname, 'test_calendar_guard.js'));

// Boucles, consentement CRM/campagnes et snapshots de persistance.
runScript('Workflow/backups audit', path.join(__dirname, 'scripts/audit-runtime-workflows.js'));

// 2. Firecrawl tests
runScript('Firecrawl tests', path.join(__dirname, 'test_firecrawl.js'));
runScript('Matrix exact search', path.join(__dirname, 'test_matrix_exact_search.js'));
runScript('Matrix natural request parser', path.join(__dirname, 'test_matrix_request_parser.js'));
runScript('Matrix authentication', path.join(__dirname, 'test_centris_playwright_auth.js'));
runScript('Matrix document inventory', path.join(__dirname, 'test_centris_document_inventory.js'));
runScript('Matrix authenticated browser download', path.join(__dirname, 'test_matrix_browser_download.js'));
runScript('Matrix PDF structural validation', path.join(__dirname, 'test_pdf_validation.js'));
runScript('Matrix email preview guard', path.join(__dirname, 'test_matrix_email_preview_guard.js'));
runScript('Matrix durable preview artifact cache', path.join(__dirname, 'test_matrix_artifact_cache.js'));
runScript('Matrix privacy-safe observability', path.join(__dirname, 'test_matrix_observability.js'));
runScript('Email provider delivery receipt', path.join(__dirname, 'test_email_delivery_receipt.js'));
runScript('Matrix email MIME', path.join(__dirname, 'test_matrix_email_mime.js'));
runScript('Matrix 15 required scenarios', path.join(__dirname, 'test_matrix_required_scenarios.js'));
runScript('Tool batch write serialization', path.join(__dirname, 'test_tool_batch.js'));

// 3. Plan quotas inline test
console.log('\n▶ Plan quotas');
try {
  const { checkQuota, recordUsage, getQuotaSnapshot, hasFeature, getPlanLimits } = require('./plan_quotas');
  let ok = 0, fail = 0;
  const tests = [
    () => getPlanLimits('solo').name === 'Solo',
    () => getPlanLimits('pro').limits.leadsPerDay === 100,
    () => getPlanLimits('enterprise').limits.leadsPerDay === Infinity,
    () => hasFeature('pro', 'registreFoncier') === true,
    () => hasFeature('solo', 'registreFoncier') === false,
    () => checkQuota('solo', 'leadsPerDay').status === 'ok',
    () => getQuotaSnapshot('trial').plan === 'Trial',
  ];
  for (const t of tests) { try { if (t()) ok++; else fail++; } catch { fail++; } }
  console.log(`  ${ok}/${tests.length} OK`);
  results.push({ name: 'Plan quotas', status: fail === 0 ? 'PASS' : 'FAIL', detail: `${ok}/${tests.length}` });
  if (fail === 0) totalPassed++; else totalFailed++;
} catch (e) {
  console.log(`  ❌ ${e.message}`);
  results.push({ name: 'Plan quotas', status: 'FAIL', detail: e.message.substring(0, 60) });
  totalFailed++;
}

// 4. Bot syntax check
console.log('\n▶ Bot syntax check');
const r = spawnSync('node', ['--check', path.join(__dirname, 'bot.js')], { stdio: 'pipe' });
if (r.status === 0) {
  console.log('  ✅ syntaxe OK');
  results.push({ name: 'Bot syntax', status: 'PASS', detail: 'node --check' });
  totalPassed++;
} else {
  console.log('  ❌ syntaxe FAIL');
  console.log(r.stderr.toString());
  results.push({ name: 'Bot syntax', status: 'FAIL', detail: 'syntax error' });
  totalFailed++;
}

// 5. Optional smoke boot
if (runSmoke) {
  console.log('\n▶ Bot smoke boot (3s)');
  let smokeDependenciesReady = true;
  try { require.resolve('dotenv'); }
  catch { smokeDependenciesReady = false; }
  if (!smokeDependenciesReady) {
    console.log('  ⏭ smoke SKIP — dépendances npm absentes dans cet environnement local');
    results.push({ name: 'Smoke boot', status: 'SKIP', detail: 'npm dependencies absent' });
  } else {
  const env = {
    TELEGRAM_BOT_TOKEN: 'TEST', TELEGRAM_ALLOWED_USER_ID: '1',
    ANTHROPIC_API_KEY: 'test',
  };
  // spawnSync capture stdout/stderr correctement. L'ancien busy-wait bloquait
  // l'event loop, donc les callbacks stdout ne roulaient jamais et le test
  // déclarait un faux échec avec une sortie vide.
  const smoke = spawnSync('node', [path.join(__dirname, 'bot.js')], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 3000,
    killSignal: 'SIGTERM',
  });
  const output = `${smoke.stdout || ''}${smoke.stderr || ''}`;
  const bootedOK = /Kira démarrée/.test(output);
  console.log(bootedOK ? '  ✅ boot OK' : '  ❌ boot FAIL');
  if (!bootedOK) console.log('  Output:', output.substring(0, 500));
  results.push({ name: 'Smoke boot', status: bootedOK ? 'PASS' : 'FAIL', detail: bootedOK ? '"Kira démarrée" trouvé' : 'pas trouvé' });
  if (bootedOK) totalPassed++; else totalFailed++;
  }
}

// Résumé
console.log('\n' + '═'.repeat(60));
console.log('📊 RÉSUMÉ');
for (const r of results) {
  const emoji = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : '⏭';
  console.log(`  ${emoji} ${r.name.padEnd(25)} ${r.status} (${r.detail})`);
}
console.log(`\n${totalPassed} passé(s), ${totalFailed} échec(s) — ${results.length} suites total`);
console.log('═'.repeat(60));

process.exit(totalFailed > 0 ? 1 : 0);
