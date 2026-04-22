#!/usr/bin/env node
// ─── Validation pré-commit ───────────────────────────────────────────────────
// Prévient les erreurs découvertes dans cette session:
//   1. Noms de tools avec accents (Opus 4.7 rejette)
//   2. Noms de tools dupliqués
//   3. temperature/top_p non-default (Opus 4.7 rejette)
//   4. startCommand manquant dans render.yaml
//   5. Incohérence package.json main vs render.yaml startCommand

'use strict';
const fs = require('fs');

const issues = [];
const warnings = [];

// ── 1. Syntaxe bot.js ────────────────────────────────────────────────────────
try {
  require('child_process').execSync('node --check bot.js', { stdio: 'pipe' });
} catch (e) {
  issues.push('❌ Syntaxe bot.js invalide');
  console.error(e.stderr?.toString() || e.message);
}

const code = fs.readFileSync('./bot.js', 'utf8');

// ── 2. Tool names (regex Opus 4.7) ──────────────────────────────────────────
const toolsStart = code.indexOf('const TOOLS = [');
const toolsEnd   = code.indexOf('\n];\n', toolsStart);
if (toolsStart < 0 || toolsEnd < 0) {
  issues.push('❌ Bloc TOOLS introuvable dans bot.js');
} else {
  const toolsBlock = code.substring(toolsStart, toolsEnd);
  const validName  = /^[a-zA-Z0-9_-]{1,128}$/;
  const names      = [];
  const nameRe     = /name:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = nameRe.exec(toolsBlock)) !== null) {
    names.push(m[1]);
    if (!validName.test(m[1])) {
      issues.push(`❌ Tool name INVALIDE pour Opus 4.7: "${m[1]}"`);
      issues.push(`   → Doit matcher /^[a-zA-Z0-9_-]{1,128}$/ (pas d'accents/espaces/caractères spéciaux)`);
    }
  }
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) issues.push(`❌ Tools dupliqués: ${[...new Set(dupes)].join(', ')}`);
  console.log(`  ✓ ${names.length} tools scannés`);
}

// ── 3. temperature/top_p/top_k (Opus 4.7 breaking) ──────────────────────────
// Chercher les appels claude.messages.create avec temperature
const apiCallRe = /claude\.messages\.create\(\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;
let apiMatch;
while ((apiMatch = apiCallRe.exec(code)) !== null) {
  const params = apiMatch[1];
  if (/\btemperature\s*:/.test(params)) {
    issues.push(`❌ temperature: détecté dans claude.messages.create — Opus 4.7 rejette si non-default`);
  }
  if (/\btop_p\s*:/.test(params)) {
    issues.push(`❌ top_p: détecté dans claude.messages.create — Opus 4.7 rejette`);
  }
  if (/\btop_k\s*:/.test(params)) {
    issues.push(`❌ top_k: détecté dans claude.messages.create — Opus 4.7 rejette`);
  }
}

// ── 4. Cohérence package.json vs render.yaml ────────────────────────────────
try {
  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  const mainFile = pkg.main || 'index.js';
  if (!fs.existsSync(mainFile)) {
    issues.push(`❌ package.json main = "${mainFile}" mais fichier inexistant`);
  }
  if (fs.existsSync('./render.yaml')) {
    const renderYaml = fs.readFileSync('./render.yaml', 'utf8');
    const startMatch = renderYaml.match(/startCommand:\s*(.+)/);
    if (startMatch) {
      const cmd = startMatch[1].trim();
      const expectedFile = cmd.replace(/^node\s+/, '');
      if (!fs.existsSync(expectedFile)) {
        issues.push(`❌ render.yaml startCommand "${cmd}" pointe vers "${expectedFile}" inexistant`);
      }
      if (!cmd.includes(mainFile)) {
        warnings.push(`⚠️ render.yaml startCommand "${cmd}" ≠ package.json main "${mainFile}"`);
      }
    }
  }
} catch (e) { warnings.push(`⚠️ Impossible valider package.json/render.yaml: ${e.message}`); }

// ── 5. process.exit inattendus (pattern dangereux) ──────────────────────────
const exitLines = code.split('\n').filter((l, i) => /process\.exit\(1\)/.test(l) && !/^\s*\/\//.test(l));
if (exitLines.length > 3) {
  warnings.push(`⚠️ ${exitLines.length} process.exit(1) trouvés — vérifier qu'aucun n'est appelé par un event handler transient`);
}

// ── Résultat ─────────────────────────────────────────────────────────────────
console.log('');
if (warnings.length) {
  console.log('⚠️  WARNINGS:');
  warnings.forEach(w => console.log('  ' + w));
  console.log('');
}

if (issues.length) {
  console.error('🚨 VALIDATION ÉCHOUÉE — NE PAS COMMITER:\n');
  issues.forEach(i => console.error('  ' + i));
  console.error('');
  process.exit(1);
}

console.log('✅ Validation OK — safe to commit');
