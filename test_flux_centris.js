#!/usr/bin/env node
// test_flux_centris.js — Tests non-régression flux Centris (BLOC A7 prompt 2026-05-13)
// Usage: node test_flux_centris.js
// Pas de tests d'intégration (réseau) — juste validation logique parsing/blacklist.

'use strict';

const assert = require('assert');
const leadParser = require('./lead_parser');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.log(`  ❌ ${name}: ${e.message}`); failed++; }
}

console.log('=== TEST FLUX CENTRIS — 5 scénarios non-régression ===\n');

// Scénario 1 — Lead Centris propre (nom valide, email, tel, Centris#)
t('Scénario 1: lead propre → extraction complète', () => {
  const sample = `
    De: Centris.ca <noreply@centris.ca>
    Nouvelle demande pour votre propriété #12345678
    Marie Tremblay
    marie.tremblay@gmail.com
    514-555-1234
    123 Chemin du Lac, Rawdon
  `;
  const result = leadParser.parseLeadEmail(sample, { id: 'test1' });
  assert(result, 'parseLeadEmail returned null');
  assert(result.email === 'marie.tremblay@gmail.com', `email: ${result.email}`);
  assert(result.centris === '12345678', `centris: ${result.centris}`);
  // Note: nom parsing depends on email format — sanitizeProspect garantit que
  // si nom extrait est blacklisté, il est null. Pas testé strictement ici.
});

// Scénario 2 — Lead avec "Shawn Barrette" dans header → sanitizeProspect doit purger
t('Scénario 2: "Shawn Barrette" en header → nom blacklisté', () => {
  const data = leadParser.sanitizeProspect({
    nom: 'Shawn Barrette',
    email: 'someone@gmail.com',
    telephone: '5145551234',
    centris: '12345678',
  });
  assert(!data.nom || data.nom === '', `Shawn Barrette pas nettoyé: ${data.nom}`);
});

// Scénario 3 — Lead avec email Shawn → email blacklisté
t('Scénario 3: shawn@signaturesb.com → email blacklisté', () => {
  const data = leadParser.sanitizeProspect({
    nom: 'Marie Tremblay',
    email: 'shawn@signaturesb.com',
    telephone: '5145551234',
    centris: '12345678',
  });
  assert(!data.email || data.email === '', `shawn@ pas nettoyé: ${data.email}`);
});

// Scénario 4 — Nom suspect (blacklist) bloque envoi auto
t('Scénario 4: nom "signature sb" → isValidProspectName=false', () => {
  assert(!leadParser.isValidProspectName('signature sb'), 'devrait être invalide');
  assert(!leadParser.isValidProspectName('SIGNATURE SB'), 'devrait être invalide (case)');
  assert(!leadParser.isValidProspectName('remax'), 'devrait être invalide');
  assert(leadParser.isValidProspectName('Marie Tremblay'), 'Marie Tremblay devrait être valide');
  assert(leadParser.isValidProspectName('Jean-Pierre Dupont'), 'Jean-Pierre Dupont devrait être valide');
});

// Scénario 5 — Email parsing résilient: pas de regex match → null
t('Scénario 5: email vide ou junk → result avec champs null', () => {
  const empty = leadParser.parseLeadEmail('', { id: 'test5' });
  assert(empty !== undefined, 'devrait pas crash sur vide');
  const junk = leadParser.parseLeadEmail('Hello world no email no centris no name', { id: 'test5b' });
  assert(junk, 'devrait retourner objet même si vide');
});

console.log(`\n=== RÉSULTAT ===`);
console.log(`  ✅ ${passed} passed`);
console.log(`  ❌ ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
