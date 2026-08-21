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
if (/(?:parfait|oui|\bok\b|\bgo\b|ça marche|d'accord|c'est bon)/i.test(confirmLine)) {
  errors.push('CONFIRM_REGEX contient encore des confirmations vagues pour email.');
}

// Hard-coded consent is forbidden. A caller cannot self-attest consent.
const hardcodedConsent = count(/shawnConsent\s*:\s*true/g);
if (hardcodedConsent > 0) {
  errors.push(`${hardcodedConsent} occurrence(s) de shawnConsent:true détectée(s). Remplacer par une autorisation one-shot vérifiable.`);
}
const hardcodedPrivateConsent = count(/_shawnConsent\s*:\s*true/g);
if (hardcodedPrivateConsent > 0) {
  errors.push(`${hardcodedPrivateConsent} occurrence(s) de _shawnConsent:true détectée(s). Un caller ne doit pas pouvoir attester le consentement lui-même.`);
}

// Bulk/reusable consent is explicitly forbidden: one confirmation = one email.
const bulkConsentPatterns = [
  /flush[^\n]{0,140}consent/i,
  /consent\s+explicite?\s+pour\s+TOUS/i,
  /auto[-_ ]?retry[^\n]{0,220}_shawnConsent/i,
  /admin[^\n]{0,220}consent\s+implicite/i,
  /AUTO_SAFE[^\n]{0,260}_shawnConsent/i,
];
for (const re of bulkConsentPatterns) {
  if (re.test(code)) errors.push(`Consentement email réutilisable/bulk détecté: ${re}`);
}

// Prompt/model instructions must never instruct autonomous CRM writes.
// The model may propose a write, but only the current explicit user request can authorize it.
const autonomousCrmPatterns = [
  /nouveau prospect[^\n]{0,140}creer_deal\s+auto/i,
  /nouveau[^\n]{0,120}creer_deal\s+immédiatement/i,
  /visite faite[^\n]{0,180}changer_etape[^\n]{0,120}ajouter_note/i,
  /pas intéressé[^\n]{0,180}marquer_perdu/i,
  /cause perdue[^\n]{0,180}marquer_perdu/i,
  /deal closé[^\n]{0,180}changer_etape/i,
  /reçoit un lead[^\n]{0,180}creer_deal/i,
];
for (const re of autonomousCrmPatterns) {
  if (re.test(code)) errors.push(`Instruction autonome Pipedrive détectée dans prompt/tool description: ${re}`);
}

// Central guards must be wired into the real bot.
if (!code.includes("require('./lib/email_send_guard')")) {
  errors.push('bot.js n’importe pas lib/email_send_guard.');
}
if (!code.includes("require('./lib/pipedrive_write_guard')")) {
  errors.push('bot.js n’importe pas lib/pipedrive_write_guard.');
}
if (!code.includes('requirePipedriveWriteIntent(')) {
  errors.push('bot.js n’invoque pas requirePipedriveWriteIntent avant les écritures Pipedrive.');
}

// Inventory direct provider send surfaces. Every occurrence must be wrapped centrally.
const gmailDirect = count(/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/g);
const brevoDirect = count(/api\.brevo\.com\/v3\/(?:smtp\/email|emailCampaigns)/g);
if (gmailDirect > 0) warnings.push(`${gmailDirect} surface(s) Gmail messages/send directe(s) détectée(s) — vérifier wrapper central.`);
if (brevoDirect > 0) warnings.push(`${brevoDirect} surface(s) Brevo potentiellement mutative(s) détectée(s) — vérifier wrapper central.`);

// Inventory Pipedrive mutating helpers/endpoints for manual review until guard is fully centralized.
const pdMutations = count(/(?:pdPost|pdPut|pdDelete)\s*\(/g);
if (pdMutations > 0) warnings.push(`${pdMutations} appel(s) helper Pipedrive mutatif(s) détecté(s) — tous doivent passer par le write guard.`);

// Persistence: /tmp may exist as emergency fallback, but business state must not silently rely on it.
if (/const\s+DATA_DIR\s*=\s*fs\.existsSync\('\/data'\)\s*\?\s*'\/data'\s*:\s*'\/tmp'/.test(code)) {
  warnings.push('DATA_DIR peut retomber sur /tmp — exiger alerte/fail-closed pour les écritures business critiques avant production.');
}

// Crash reports must use the canonical repository only.
if (/repos\/signaturesb\/kira-bot\//.test(code) || /repo='kira-bot'/.test(code)) {
  errors.push('Crash reporting référence encore l’ancien repo kira-bot au lieu de bot-assistant.');
}

// Admin secrets in query strings leak more easily through logs/history/proxies.
if (/searchParams\.get\('token'\)/.test(code)) {
  warnings.push('Admin token lu depuis query string — migrer vers Authorization header.');
}

console.log('=== KIRA DANGEROUS SURFACE AUDIT ===');
for (const w of warnings) console.log(`WARN: ${w}`);
for (const e of errors) console.error(`ERROR: ${e}`);

if (errors.length) process.exit(1);
console.log('OK: aucune violation critique détectée');
