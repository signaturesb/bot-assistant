#!/usr/bin/env node
// test_parser.js — Tests automatisés du parser de leads email
// Utilisé par: `node test_parser.js` (manuel) + validate.js (pre-commit hook)
// Exit 1 si un test échoue — bloque les commits qui cassent l'extraction

'use strict';

const { parseLeadEmail, isJunkLeadEmail, detectLeadSource } = require('./lead_parser');

const samples = [
  {
    name: 'Centris contact form — format officiel',
    subject: `Centris.ca - Demande d'information pour le Rue de Rawdon Park, Rawdon (# 28939185)`,
    from: 'nepasrepondre@centris.ca',
    body: `<style>body { margin: 0; } @media (max-width: 520px) { .col { width: 100% !important; } }</style>
      <p>Bonjour Shawn Barrette,</p>
      <p>Vous avez reçu une nouvelle demande de Centris.ca</p>
      <p>Type Demande d'information</p>
      <p>Nom Marie Tremblay</p>
      <p>Courriel marie.tremblay@gmail.com</p>
      <p>Téléphone 450-555-1234</p>
      <p>Message Bonjour, je désire plus d'information concernant l'inscription (#28939185).</p>`,
    expect: {
      nom: 'Marie Tremblay',
      telephone: '4505551234',
      email: 'marie.tremblay@gmail.com',
      centris: '28939185',
      type: 'terrain',
    },
    junk: false,
    source: 'centris',
  },
  {
    name: 'Centris notification (saved search alert — JUNK)',
    subject: `Shawn, vous avez 1 nouvelle notification`,
    from: 'no-reply@centris.ca',
    body: `Des inscriptions répondent à vos critères. Découvrez-les!`,
    junk: true,
  },
  {
    name: 'Centris saved search — "s répondent à vos critères" (JUNK)',
    subject: `Les Inscriptions Shawn Barrette`,
    from: 'no-reply@centris.ca',
    body: `Des inscriptions répondent à vos critères. Découvrez-les!`,
    junk: true,
  },
  {
    name: 'RE/MAX Québec — lead direct avec info complète',
    subject: `Demande d'information pour la propriété MLS #12345678`,
    from: 'alerts@remax-quebec.com',
    body: `<html><body>
      Nom complet: Jean Gagnon
      Téléphone: (514) 987-6543
      Courriel: jean.gagnon@hotmail.com
      Propriété: 123 Rue des Érables, Rawdon
      MLS: 12345678
      Type: maison unifamiliale
      </body></html>`,
    expect: {
      nom: 'Jean Gagnon',
      telephone: '5149876543',
      email: 'jean.gagnon@hotmail.com',
      centris: '12345678',
      type: 'maison_usagee',
    },
    junk: false,
    source: 'remax',
  },
  {
    name: 'Newsletter promotion (JUNK)',
    subject: `⏳ Last Call: The Spring Sale ends at midnight!`,
    from: 'newsletters@mail.healthyplanet.com',
    body: `Last chance for spring promotion...`,
    junk: true,
  },
  {
    name: 'Watchdog system alert (JUNK)',
    subject: `🚨 WATCHDOG — 1 alerte(s) système (HMAC)`,
    from: 'shawn@signaturesb.com',
    body: `HMAC validation failed on webhook.`,
    junk: true,
  },
  {
    name: 'Realtor.ca lead — format anglais',
    subject: `Property inquiry — 456 Main St`,
    from: 'info@realtor.ca',
    body: `Hello, my name is Sarah Johnson and I would like information.
      Phone: 438-555-7890
      Email: sarah.j@yahoo.com
      Property: 456 Main Street, Saint-Jérôme
      Listing #: 98765432`,
    expect: {
      nom: 'Sarah Johnson',
      telephone: '4385557890',
      email: 'sarah.j@yahoo.com',
      centris: '98765432',
    },
    junk: false,
    source: 'realtor',
  },
  {
    name: 'Lead direct avec Centris# dans body seulement',
    subject: `Demande d'information`,
    from: 'pierre.leblanc@videotron.ca',
    body: `Bonjour, je suis intéressé par votre propriété (# 11676716).
      Mon nom est Pierre LeBlanc.
      Vous pouvez me rejoindre au 514-111-2222.`,
    expect: {
      nom: 'Pierre LeBlanc',
      telephone: '5141112222',
      email: 'pierre.leblanc@videotron.ca',
      centris: '11676716',
    },
    junk: false,
    source: 'direct',
  },
];

function runTests() {
  let passed = 0;
  let failed = 0;
  const fails = [];

  console.log(`\n🧪 Test suite parser — ${samples.length} cas\n`);

  for (const s of samples) {
    const errors = [];

    // Test junk detection
    const junk = isJunkLeadEmail(s.subject, s.from, s.body);
    if (junk !== s.junk) {
      errors.push(`junk=${junk}, attendu ${s.junk}`);
    }

    // Si junk: on ne teste pas l'extraction (normal qu'elle échoue ou retourne vide)
    if (s.junk) {
      if (errors.length) { failed++; fails.push({ name: s.name, errors }); }
      else passed++;
      console.log(`${errors.length ? '❌' : '✅'} ${s.name}`);
      continue;
    }

    // Test source detection
    if (s.source) {
      const src = detectLeadSource(s.from, s.subject);
      if (!src || src.source !== s.source) {
        errors.push(`source=${src?.source || 'null'}, attendu ${s.source}`);
      }
    }

    // Test extraction
    if (s.expect) {
      const result = parseLeadEmail(s.body, s.subject, s.from);
      for (const [k, v] of Object.entries(s.expect)) {
        if (result[k] !== v) {
          errors.push(`${k}="${result[k]}", attendu "${v}"`);
        }
      }
    }

    if (errors.length) {
      failed++;
      fails.push({ name: s.name, errors });
      console.log(`❌ ${s.name}`);
      for (const e of errors) console.log(`    · ${e}`);
    } else {
      passed++;
      console.log(`✅ ${s.name}`);
    }
  }

  console.log(`\n${passed}/${samples.length} passés, ${failed} échoué(s)\n`);

  if (failed > 0) {
    console.error(`\n❌ ${failed} test(s) en échec:`);
    for (const f of fails) {
      console.error(`  • ${f.name}`);
      for (const e of f.errors) console.error(`    · ${e}`);
    }
    process.exit(1);
  }

  console.log('✅ Tous les tests parser passent — parser OK pour production');
  process.exit(0);
}

if (require.main === module) runTests();
module.exports = { runTests, samples };
