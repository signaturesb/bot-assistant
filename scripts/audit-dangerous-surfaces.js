'use strict';

const fs = require('fs');

const code = fs.readFileSync('bot.js', 'utf8');
const lines = code.split('\n');
const errors = [];
const warnings = [];

function count(re) {
  return (code.match(re) || []).length;
}

function locations(re, label) {
  const out = [];
  lines.forEach((line, idx) => {
    const test = new RegExp(re.source, re.flags.replace('g', ''));
    if (test.test(line)) {
      out.push({ line: idx + 1, text: line.trim().slice(0, 220), label });
    }
  });
  return out;
}

function reportLocations(title, entries) {
  if (!entries.length) return;
  console.log(`\n-- ${title} (${entries.length}) --`);
  for (const e of entries) console.log(`L${e.line}: ${e.text}`);
}

// EMAIL CONSENT — vague confirmations must never authorize sends.
const confirmLine = code.match(/const\s+CONFIRM_REGEX\s*=.*$/m)?.[0] || '';
if (/(?:parfait|oui|\bok\b|\bgo\b|ça marche|d'accord|c'est bon)/i.test(confirmLine)) {
  errors.push('CONFIRM_REGEX contient encore des confirmations vagues pour email.');
}

const hardcodedConsentRe = /shawnConsent\s*:\s*true/;
const hardcodedPrivateConsentRe = /_shawnConsent\b/;
const hardcodedConsentLocs = locations(hardcodedConsentRe, 'shawnConsent:true');
const hardcodedPrivateConsentLocs = locations(hardcodedPrivateConsentRe, '_shawnConsent');
if (hardcodedConsentLocs.length > 0) {
  errors.push(`${hardcodedConsentLocs.length} occurrence(s) de shawnConsent:true détectée(s). Remplacer par une autorisation one-shot vérifiable.`);
}
if (hardcodedPrivateConsentLocs.length > 0) {
  errors.push(`${hardcodedPrivateConsentLocs.length} occurrence(s) de _shawnConsent détectée(s). Le booléen hérité est interdit, quelle que soit sa valeur.`);
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

const webhookBlock = code.match(/async function handleWebhook[\s\S]*?\/\/ ─── Arrêt propre/)?.[0] || '';
if (/\b(?:pdPost|pdPut|pdDelete)\s*\(/.test(webhookBlock)) {
  errors.push('Un webhook entrant effectue encore une mutation Pipedrive automatique.');
}
const leadPollerBlock = code.match(/async function traiterNouveauLead[\s\S]*?async function sendTelegramWithFallback/)?.[0] || '';
if (/\b(?:pdPost|pdPut|pdDelete)\s*\(/.test(leadPollerBlock)) {
  errors.push('Le poller de leads effectue encore une mutation Pipedrive automatique.');
}
const callResumeStart = code.indexOf('async function enregistrerResumeAppel');
const callResumeGuarded = callResumeStart >= 0 && code.slice(callResumeStart, callResumeStart + 900).includes('requirePipedriveWriteIntent(');
if (!callResumeGuarded) {
  errors.push('enregistrerResumeAppel n’est pas protégé localement par le current-message guard.');
}

// Inventory direct provider send surfaces. Every occurrence must be wrapped centrally.
const gmailRe = /gmail\.googleapis\.com\/gmail\/v1\/users\/me\/messages\/send/;
const brevoRe = /api\.brevo\.com\/v3\/(?:smtp\/email|emailCampaigns)/;
const gmailLocs = locations(gmailRe, 'gmail send');
const brevoLocs = locations(brevoRe, 'brevo mutative');
if (gmailLocs.length > 0) warnings.push(`${gmailLocs.length} surface(s) Gmail messages/send directe(s) détectée(s) — vérifier wrapper central.`);
if (brevoLocs.length > 0) warnings.push(`${brevoLocs.length} surface(s) Brevo potentiellement mutative(s) détectée(s) — vérifier wrapper central.`);

// Tous les MIME Gmail construits par le bot doivent être attribuables. Le cron
// Sent-folder ignore volontairement les courriels manuels sans ce marqueur.
const mimeCount = count(/MIME-Version: 1\.0/g);
const automationMarkerCount = count(/X-SignatureSB-Automation: kira-bot/g);
if (mimeCount !== automationMarkerCount) {
  errors.push(`Attribution Gmail incomplète: ${mimeCount} MIME mais ${automationMarkerCount} marqueur(s) kira-bot.`);
}

// Inventory Pipedrive mutating helpers/endpoints.
const pdMutationRe = /(?:pdPost|pdPut|pdDelete)\s*\(/;
const pdMutationLocs = locations(pdMutationRe, 'Pipedrive mutation');
if (pdMutationLocs.length > 0) warnings.push(`${pdMutationLocs.length} appel(s) helper Pipedrive mutatif(s) détecté(s) — tous doivent passer par le write guard.`);

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

reportLocations('HARDCODED EMAIL CONSENT', hardcodedConsentLocs);
reportLocations('HARDCODED PRIVATE EMAIL CONSENT', hardcodedPrivateConsentLocs);
reportLocations('DIRECT GMAIL SEND SURFACES', gmailLocs);
reportLocations('BREVO MUTATIVE SURFACES', brevoLocs);
reportLocations('PIPEDRIVE MUTATIONS', pdMutationLocs);

if (errors.length) process.exit(1);
console.log('OK: aucune violation critique détectée');
