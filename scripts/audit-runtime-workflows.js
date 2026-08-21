'use strict';

const fs = require('fs');

const bot = fs.readFileSync('bot.js', 'utf8');
const resilience = fs.readFileSync('resilience.js', 'utf8');
const errors = [];

function block(start, end) {
  const from = bot.indexOf(start);
  const to = bot.indexOf(end, from + start.length);
  if (from < 0 || to < 0) return '';
  return bot.slice(from, to);
}

function requireText(text, message) {
  if (!bot.includes(text)) errors.push(message);
}

// Les boucles async principales doivent toutes passer par un mutex/non-overlap.
if (/setInterval\s*\(\s*async\b/.test(bot)) {
  errors.push('setInterval(async ...) brut détecté dans bot.js; utiliser safeCron.');
}
if (!resilience.includes("startNonOverlappingInterval('self-recovery'")) {
  errors.push('Self-recovery n’utilise pas le garde non-overlap.');
}
if (!resilience.includes("startNonOverlappingInterval('github-heartbeat'")) {
  errors.push('Heartbeat GitHub n’utilise pas le garde non-overlap.');
}
if (!resilience.includes("process.env.ENABLE_GITHUB_RUNTIME_WRITES === 'true'")) {
  errors.push('Écritures heartbeat GitHub non protégées par opt-in.');
}
requireText("process.env.ENABLE_GITHUB_RUNTIME_WRITES === 'true'", 'Sync statut GitHub non protégée par opt-in.');
if (!/async function reportCrashToGitHub[\s\S]*?ENABLE_GITHUB_RUNTIME_WRITES !== 'true'/.test(bot)) {
  errors.push('Rapports de crash GitHub non protégés par opt-in.');
}
if (!/async function reportBug[\s\S]*?ENABLE_GITHUB_RUNTIME_WRITES !== 'true'/.test(bot)) {
  errors.push('Bug tracker GitHub non protégé par opt-in.');
}
if (!/ENABLE_GITHUB_RUNTIME_WRITES === 'true' && process\.env\.GITHUB_TOKEN[\s\S]{0,800}# ✅ Boot réussi/.test(bot)) {
  errors.push('Rapport de boot GitHub non protégé par opt-in.');
}
if (bot.includes("safeCron('bot-activity-write'")) {
  errors.push('Boucle historique BOT_ACTIVITY GitHub encore enregistrée.');
}
if (!resilience.includes('lastAutoRestartAt') || !resilience.includes('restartInProgress')) {
  errors.push('Auto-restart Render sans cooldown/in-flight guard.');
}
if (!resilience.includes('highMemoryStreak >= 2')) {
  errors.push('Détection mémoire soutenue absente.');
}

// Un seul keepalive Render, et aucun nettoyage Gmail destructif automatique.
if ((bot.match(/safeCron\('render-keepalive'/g) || []).length !== 1) {
  errors.push('Le keepalive Render doit être unique.');
}
if (/setTimeout\([^\n]*autoTrashGitHubNoise|setInterval\([^\n]*autoTrashGitHubNoise/.test(bot)) {
  errors.push('Nettoyage Gmail automatique détecté; /cleanemail doit rester manuel.');
}
if (/callClaude\([^\n]*Cr[eé]e le deal dans Pipedrive imm[eé]diatement/i.test(bot)) {
  errors.push('Une commande synthétise encore elle-même une autorisation Pipedrive.');
}
requireText('const pipedriveWriteScope = new AsyncLocalStorage()', 'Scope central des mutations Pipedrive absent.');
requireText("err.code = 'PIPEDRIVE_WRITE_SCOPE_REQUIRED'", 'pdRequest ne bloque pas centralement les mutations hors scope.');
requireText('pendingPipedriveActivityActions', 'Transaction de confirmation des activités Pipedrive absente.');
requireText('pipedriveActionSnapshot', 'Aperçu Pipedrive non lié au contenu exact.');
requireText('normalizeScheduledAction', 'Garde calendrier Pipedrive absent.');
requireText('PIPEDRIVE_ACTIVITY_CONFIRM_REGEX', 'Confirmation exacte des activités Pipedrive absente.');
requireText("const PD_V2_BASE = 'https://api.pipedrive.com/api/v2'", 'Lectures activités Pipedrive v2 absentes.');
requireText('async function pdGetActivities(', 'Helper central activités Pipedrive absent.');
if (/pdGet\(`\/deals\/\$\{[^}]+\}\/activities|pdGet\(`\/persons\/\$\{[^}]+\}\/activities/.test(bot)) {
  errors.push('Ancien endpoint imbriqué Pipedrive activities encore utilisé.');
}

// Les routines Pipedrive de fond doivent être 100 % lecture seule.
const pdAudit = block('async function auditPipedriveUltra()', '// ─── Audit hebdo doublons');
if (!pdAudit) errors.push('Bloc auditPipedriveUltra introuvable.');
if (/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\b(?:pdPost|pdPut|pdDelete)\s*\(/.test(pdAudit)) {
  errors.push('Mutation Pipedrive détectée dans auditPipedriveUltra.');
}
const weeklyDedup = block('async function runDedupHebdo()', '// ─── REGISTRE D\'APPROBATION');
if (!weeklyDedup) errors.push('Bloc runDedupHebdo introuvable.');
if (/nettoyerDoublonsActivites\s*\(|method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/.test(weeklyDedup)) {
  errors.push('Mutation Pipedrive détectée dans l’audit hebdo.');
}

// Le safety check Brevo alerte, mais ne suspend et n’envoie jamais.
const brevoSafety = block('async function safetyCheckCampagnes()', '// ─── Veille J-1 backup');
if (!brevoSafety) errors.push('Bloc safetyCheckCampagnes introuvable.');
if (/method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\/sendTest\b/.test(brevoSafety)) {
  errors.push('Mutation Brevo détectée dans safetyCheckCampagnes.');
}

// Les anciennes portes admin mutatives doivent rester explicitement bloquées.
for (const route of [
  '/admin/cleanup-activities-by-subject',
  '/admin/delete-deals-stage',
  '/admin/cleanup-activity-dups',
  '/admin/brevo-send-now',
  '/admin/brevo-send-preview',
  '/admin/brevo-cancel',
  '/admin/brevo-send-raw',
]) {
  requireText(`'${route}'`, `Route admin mutative non verrouillée: ${route}`);
}
requireText("auditLogEvent('admin', 'legacy-mutation-blocked'", 'Audit des routes admin bloquées absent.');
requireText("process.env.ENABLE_BREVO_SYSTEM_EMAILS !== 'true'", 'Fallback email Brevo interne non verrouillé par défaut.');
requireText("process.env.ENABLE_BREVO_SYSTEM_SMS === 'true'", 'Fallback SMS Brevo interne non verrouillé par défaut.');
requireText("name === 'ajouter_brevo'", 'Mutation contact Brevo non bloquée en mode lecture seule.');
requireText('Ce lien de campagne est désactivé pour sécurité', 'Anciens liens GET confirm/cancel encore actifs.');
requireText("'duplicate-confirm-blocked'", 'Blocage anti-rejeu des confirmations de campagne absent.');

// Email: le wrapper central consomme l'autorisation et les providers externes
// passent par un état pending anti-chevauchement.
if (bot.includes('shawnConsent')) errors.push('Ancien consentement email réutilisable encore présent.');
requireText('consumeOneShotAuthorization(opts.authorization, emailPayload)', 'Wrapper email central non fail-closed.');
requireText('pendingExternalEmailActions', 'File pending des providers email externes absente.');
requireText('if (external.inFlight)', 'Garde anti-doublon des confirmations email absente.');
requireText('PENDING_EMAILS_FILE', 'Persistance des brouillons email absente.');
requireText('queuePendingEmailDraft', 'File non destructive des brouillons email absente.');
requireText('deliveryUncertain', 'Blocage anti-doublon après résultat fournisseur incertain absent.');
requireText('Envoi multi-courriels désactivé', 'Une confirmation peut encore déclencher plusieurs emails.');
requireText('function validateMasterEmailTemplate(html)', 'Validation structurelle du template actif absente.');
requireText('TEMPLATE_VALIDATION_FILE', 'Empreinte persistante du template actif absente.');
requireText("label: 'HMAC SMS bridge'", 'Auto-test HMAC absent du preflight.');

// Persistance: écriture atomique, snapshot local vérifié et Gist opt-in.
const saveJson = block('function saveJSON(file, data)', '// ─── Clients');
if (!/writeFileSync\(tmp/.test(saveJson) || !/renameSync\(tmp, file\)/.test(saveJson)) {
  errors.push('saveJSON n’est plus atomique tmp + rename.');
}
requireText('function createRuntimeSnapshot()', 'Snapshot runtime local absent.');
requireText("safeCron('runtime-disk-snapshot'", 'Boucle de snapshot runtime absente.');
requireText("if (GIST_WRITES_ENABLED) safeCron('gist-optional-backup'", 'Backup Gist non conditionné par opt-in.');

console.log('=== KIRA RUNTIME WORKFLOW AUDIT ===');
for (const error of errors) console.error(`ERROR: ${error}`);
if (errors.length) process.exit(1);
console.log('OK: boucles non chevauchantes, CRM/campagnes lecture seule, backups vérifiés');
