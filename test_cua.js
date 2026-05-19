#!/usr/bin/env node
// test_cua.js — Test rapide du driver CUA
// Usage:
//   node test_cua.js              → status seulement (pas d'API call)
//   node test_cua.js 22264330     → test live PDF download
//   node test_cua.js annexes N    → test annexes pour listing N

'use strict';

require('dotenv').config({ path: '.env' });

(async () => {
  let cua;
  try { cua = require('./cua_driver'); }
  catch (e) {
    console.error('❌ Échec require cua_driver:', e.message);
    process.exit(1);
  }

  console.log('═══ CUA STATUS ═══');
  const status = cua.cuaStatus();
  console.log(JSON.stringify(status, null, 2));

  if (!status.available) {
    console.error('\n❌ CUA non disponible. npm install playwright-core requis.');
    process.exit(1);
  }
  if (!status.anthropic_key) {
    console.warn('\n⚠️  ANTHROPIC_API_KEY manquante — test live impossible.');
  }
  if (!status.centris_creds) {
    console.warn('⚠️  CENTRIS_USER / CENTRIS_PASS manquantes — login fail.');
  }

  const arg = process.argv[2];
  if (!arg) {
    console.log('\nPas de listing demandé. Pass un num pour test live: node test_cua.js 22264330');
    process.exit(0);
  }

  if (arg === 'annexes') {
    const num = process.argv[3];
    if (!/^\d{7,9}$/.test(num)) {
      console.error('❌ Num invalide:', num);
      process.exit(1);
    }
    console.log(`\n═══ TEST ANNEXES #${num} ═══`);
    const r = await cua.cuaGetCentrisAnnexes(num, process.argv[4] || null);
    console.log('Result:', JSON.stringify({ success: r.success, count: r.annexes?.length, message: r.message }, null, 2));
    if (r.annexes?.length) {
      r.annexes.forEach(a => console.log(`  📎 ${a.filename} (${Math.round(a.buffer.length/1024)}KB)`));
    }
    process.exit(r.success ? 0 : 1);
  }

  if (/^\d{7,9}$/.test(arg)) {
    console.log(`\n═══ TEST FICHE #${arg} ═══`);
    const t0 = Date.now();
    const r = await cua.cuaGetCentrisPDF(arg);
    const elapsed = Math.round((Date.now() - t0) / 1000);
    console.log(`Result (${elapsed}s):`, JSON.stringify({
      success: r.success,
      message: r.message,
      filename: r.filename,
      bytes: r.buffer?.length || 0,
      fromCache: r.fromCache,
    }, null, 2));
    process.exit(r.success ? 0 : 1);
  }

  console.error('Usage: node test_cua.js [num | annexes <num> [filtre]]');
  process.exit(1);
})();
