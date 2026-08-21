'use strict';

const fs = require('fs');

const code = fs.readFileSync('bot.js', 'utf8');
const errors = [];
const warnings = [];

function count(re) {
  return (code.match(re) || []).length;
}

// EMAIL CONSENT — vague confirmations must never authorize sends.
const confirmLine = code.match(/const\s+CONFIRM_REGEX\s*=.*$/m)?.[0] || '';
if (/(?:parfait|oui|\bok\b|\bgo\b|ça marche)/i.test(confirmLine)) {
  errors.push('CONFIRM_REGEX contient encore des confirmations vagues pour email.');
}

// Hard-coded consent is forbidden for client-facing sends. A caller cannot self-attest consent.
const hardcodedConsent = count(/shawnConsent\s*:\s*true/g);
if (hardcodedConsent > 0) {
  errors.push(`${hardcodedConsent} occurrence(s) de shawnConsent:true détectée(s). Remplacer par une autorisation one-shot vérifiable.`);
}

const hardcodedPrivateConsent = count(/_shawnConsent\s*:\s*true/g);
if (hardcodedPrivateConsent > 0) {
  errors.push(`${hardcodedPrivateConsent} occurrence(s) de _shawnConsent:true détectée(s). Un caller ne doit pas pouvoir attester le consentement lui-même.`);
}

// Central email guard must be wired into the real bot.
if (!code.includes("require('./lib/email_send_guard')")) {
  errors.push('bot.js n’importe pas lib/email_send_guard.');
}

// Pipedrive guard must be wired into the real bot.
if (!code.includes("require('./lib/pipedrive_write_guard')")) {
  errors.push('bot.js n’importe pas lib/pipedrive_write_guard.');
}

// Inventory direct provider send surfaces. These are not automatically unsafe,
// but every occurrence must be consciously wrapped by the centralized send guard.
const gmailDirect = count(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/g);
const brevoDirect = count(/api\.brevo\.com\/v3\/(?:smtp\/email|emailCampaigns)/g);
if (gmailDirect > 0) warnings.push(`${gmailDirect} surface(s) Gmail messages/send directe(s) détectée(s) — vérifier wrapper central.`);
if (brevoDirect > 0) warnings.push(`${brevoDirect} surface(s) Brevo potentiellement mutative(s) détectée(s) — vérifier wrapper central.`);

// Inventory Pipedrive mutating helpers/endpoints for manual review until guard is fully centralized.
const pdMutations = count(/(?:pdPost|pdPut|pdDelete)\s*\(/g);
if (pdMutations > 0) warnings.push(`${pdMutations} appel(s) helper Pipedrive mutatif(s) détecté(s) — tous doivent passer par le write guard.`);

console.log('=== KIRA DANGEROUS SURFACE AUDIT ===');
for (const w of warnings) console.log(`WARN: ${w}`);
for (const e of errors) console.error(`ERROR: ${e}`);

if (errors.length) process.exit(1);
console.log('OK: aucune violation critique détectée');
