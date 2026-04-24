// test_firecrawl.js — validation sans exec HTTP si API key absent
// Usage: FIRECRAWL_API_KEY=xxx node test_firecrawl.js
// Sans clé: teste la logique locale (cache, quota, extract, villes)
'use strict';

const { scrapMunicipalite, scrapUrl, getQuotaStatus, MUNICIPALITES } = require('./firecrawl_scraper');

let passed = 0, failed = 0;
function check(label, cond) {
  if (cond) { console.log('✅', label); passed++; }
  else { console.log('❌', label); failed++; }
}

async function runTests() {
  console.log('\n🧪 TEST 1: Quota status fonctionnel');
  const q = getQuotaStatus();
  check('quota a un statut', typeof q.statut === 'string');
  check('quota a utilise (number)', typeof q.utilise === 'number');
  check('quota a restant (number)', typeof q.restant === 'number');

  console.log('\n🧪 TEST 2: Villes pré-configurées (≥8)');
  const villes = Object.keys(MUNICIPALITES);
  check(`${villes.length} villes configurées`, villes.length >= 8);
  check('sainte-julienne dispo', villes.includes('sainte-julienne'));
  check('rawdon dispo', villes.includes('rawdon'));

  console.log('\n🧪 TEST 3: Ville non configurée → erreur claire');
  const r1 = await scrapMunicipalite('montreal-inexistant', 'zonage');
  check('success:false sur ville inconnue', r1.success === false);
  check('message mentionne "non configurée"', r1.error?.includes('non configurée'));

  console.log('\n🧪 TEST 4: URL invalide → message clair');
  const r2 = await scrapUrl('pas-une-url', []);
  check('success:false sur URL invalide', r2.success === false);
  check('erreur http:// mentionnée', r2.error?.includes('http'));

  if (process.env.FIRECRAWL_API_KEY) {
    console.log('\n🧪 TEST 5: Sainte-Julienne zonage (vrai scrape — API key détectée)');
    const r4 = await scrapMunicipalite('sainte-julienne', 'zonage');
    if (r4.success) {
      check('scrape réussi', r4.success);
      check('contenu non vide', r4.contenu && r4.contenu.length > 50);
    } else {
      // Fallback est acceptable (site down, etc.)
      check('fallback présent si échec', !!r4.fallback);
      check('téléphone fallback présent', !!r4.telephone);
    }
  } else {
    console.log('\n⏭ TEST 5 skipped — FIRECRAWL_API_KEY non définie (test local/CI)');
  }

  console.log(`\n=== ${passed} passed / ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('❌ TEST CRASH:', e.message);
  process.exit(1);
});
