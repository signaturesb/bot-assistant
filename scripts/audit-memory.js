'use strict';

const fs = require('fs');

const code = fs.readFileSync('bot.js', 'utf8');
const issues = [];
const warnings = [];

function readDefault(name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*parseInt\\(process\\.env\\.${name}\\s*\\|\\|\\s*['\"](\\d+)['\"]\\)`);
  const m = code.match(re);
  return m ? Number(m[1]) : null;
}

const maxHist = readDefault('MAX_HIST');
const summaryAt = readDefault('SUMMARY_AT');
const summaryKeep = readDefault('SUMMARY_KEEP');

if (maxHist == null || summaryAt == null || summaryKeep == null) {
  warnings.push('Impossible de lire une ou plusieurs valeurs mémoire dans bot.js');
} else {
  if (summaryAt >= maxHist) {
    issues.push(`Résumé longue durée impossible avec les defaults actuels: SUMMARY_AT=${summaryAt} >= MAX_HIST=${maxHist}. L\'historique est coupé avant le déclenchement.`);
  }
  if (summaryKeep >= summaryAt) {
    issues.push(`SUMMARY_KEEP=${summaryKeep} doit être inférieur à SUMMARY_AT=${summaryAt} pour compacter réellement.`);
  }
  if (summaryKeep < 50) {
    warnings.push(`SUMMARY_KEEP=${summaryKeep} paraît très faible pour conserver du contexte récent.`);
  }
}

if (/DATA_DIR\s*=\s*fs\.existsSync\('\/data'\)\s*\?\s*'\/data'\s*:\s*'\/tmp'/.test(code)) {
  warnings.push('La persistance locale retombe sur /tmp si aucun disque Render /data n’est attaché. /tmp est éphémère.');
}

if (/saveHistoryToGist\s*\(/.test(code)) {
  warnings.push('L’historique Telegram est sauvegardé vers GitHub Gist. À remplacer par un stockage business privé/persistant avant archivage complet.');
}

if (!/SIGTERM/.test(code)) {
  issues.push('Aucune gestion SIGTERM détectée; risque de perte d’état pendant les deploys Render.');
}

if (!/\/health/.test(code)) {
  warnings.push('Aucun endpoint /health clairement détecté.');
}

console.log('=== KIRA MEMORY/PERSISTENCE AUDIT ===');
console.log(`MAX_HIST=${maxHist ?? '?'} SUMMARY_AT=${summaryAt ?? '?'} SUMMARY_KEEP=${summaryKeep ?? '?'}`);
for (const w of warnings) console.log(`WARN: ${w}`);
for (const i of issues) console.error(`ERROR: ${i}`);

if (issues.length) process.exit(1);
console.log('OK: invariants critiques mémoire valides');
